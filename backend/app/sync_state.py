"""同步轮次的状态与唤醒请求：sync.py / worker.py / api.py 只经这里读写。

分工：web 进程只写请求（request_sync）与读状态（status_payload），
worker 进程只认领请求（claim_request）并写进度（SyncProgress）。
两边只通过 sync_runs 表通信，不需要额外的 IPC 通道。
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.models import Account, SyncRun

# 手动触发的轮次只回填最近这么多天的详情：点刷新的人等的是刚收到的邮件，
# 历史积压的 NULL 详情留给定时轮次慢慢补，别让手动轮次一直跑不结束。
MANUAL_DETAIL_WINDOW_DAYS = 7

# worker 被 kill -9 / 崩溃时来不及写 finished_at，行会永远停在 running：
# 前端就会一直显示「同步中」而且再也点不动刷新（有 current 就不写新请求）。
# 超过这个时长还没结束的一律按中断处理，让状态能自愈。
STALE_AFTER = timedelta(minutes=30)

_STAGE_NAMES = ("fetch", "classify", "detail")


def _skeleton(account_emails: list[str]) -> dict[str, Any]:
    """整轮进度的初始骨架：与前端契约的 stages 结构一一对应。"""
    return {
        "fetch": {
            "state": "pending",
            "error": None,
            "accounts": [
                {"email": email, "state": "pending", "new_count": 0, "error": None}
                for email in account_emails
            ],
        },
        "classify": {"state": "pending", "error": None, "total": 0, "done": 0, "created": 0},
        "detail": {"state": "pending", "error": None, "total": 0, "done": 0},
    }


def _load_stages(raw: str | None) -> dict[str, Any]:
    """解析库里的进度 JSON；缺键按 pending 兜底，字段只保留契约里有的。

    兜底不是防御性编程：请求行被认领后、SyncProgress 构造前也可能被读到，
    老库里的行更是可能没有 stages。多出来的键（早期版本写的）一律丢掉，
    保证响应结构与契约完全一致。
    """
    try:
        stored = json.loads(raw) if raw else {}
    except ValueError:
        stored = {}
    if not isinstance(stored, dict):
        stored = {}
    stages = _skeleton([])
    for name in _STAGE_NAMES:
        stage = stages[name]
        saved = stored.get(name) or {}
        for key in stage:
            if key == "accounts":
                stage["accounts"] = [
                    {
                        "email": acct.get("email"),
                        "state": acct.get("state", "pending"),
                        "new_count": acct.get("new_count", 0),
                        "error": acct.get("error"),
                    }
                    for acct in (saved.get("accounts") or [])
                ]
            elif key in saved:
                stage[key] = saved[key]
    return stages


def _iso(value: datetime | None) -> str | None:
    """时间序列化与 api.py 的 email_sent_at 同口径：库内 naive UTC 显式补 +00:00。"""
    return value.replace(tzinfo=timezone.utc).isoformat() if value else None


def expire_stale_runs(session: Session) -> None:
    """把卡死的 running 行标成 failed（STALE_AFTER 的用途见上）。"""
    cutoff = datetime.now() - STALE_AFTER
    stale = (
        session.execute(
            select(SyncRun).where(SyncRun.state == "running", SyncRun.started_at < cutoff)
        )
        .scalars()
        .all()
    )
    if not stale:
        return
    finished = datetime.now()
    for run in stale:
        run.state = "failed"
        run.error = "worker 未在 30 分钟内完成，视为中断"
        run.finished_at = finished
    session.commit()


def request_sync(session: Session) -> bool:
    """写一条手动唤醒请求；已有请求或已有轮次在跑则返回 False（不重复写）。"""
    expire_stale_runs(session)
    active = session.execute(
        select(SyncRun.id).where(SyncRun.state.in_(("requested", "running"))).limit(1)
    ).first()
    if active is not None:
        return False
    session.add(SyncRun(trigger="manual", state="requested", requested_at=datetime.now()))
    session.commit()
    return True


def has_request(session_factory: sessionmaker[Session]) -> bool:
    """是否有 worker 还没认领的请求（worker 分块睡眠时用它决定要不要提前醒）。"""
    with session_factory() as session:
        return (
            session.execute(select(SyncRun.id).where(SyncRun.state == "requested").limit(1)).first()
            is not None
        )


def claim_request(session_factory: sessionmaker[Session]) -> int | None:
    """认领最早的请求：置 running 并补 started_at，返回轮次 id；没有则返回 None。"""
    with session_factory() as session:
        run = (
            session.execute(
                select(SyncRun).where(SyncRun.state == "requested").order_by(SyncRun.id).limit(1)
            )
            .scalars()
            .first()
        )
        if run is None:
            return None
        run_id = run.id
        run.state = "running"
        run.started_at = datetime.now()
        session.commit()
        return run_id


class SyncProgress:
    """一轮同步的进度写入器：内存里的 self.stages 是权威副本，落库时整段重写。

    为什么要内存副本：账户异常时 sync.run_once 会 session.rollback()，把该账户
    期间写进 run.stages 的内容一起丢掉；rollback 能回滚数据库，回滚不了这里的
    字典。之后任意一次 _flush（如 account(email, "failed")）都会把完整骨架重新
    写回，因此进度不会因为中途 rollback 变成半截 JSON，也不需要为进度另开一个
    session。
    """

    def __init__(self, session: Session, run: SyncRun, account_emails: list[str]) -> None:
        self.session = session
        self.run = run
        self.stages = _skeleton(account_emails)
        self._flush()

    def _flush(self) -> None:
        self.run.stages = json.dumps(self.stages, ensure_ascii=False)
        self.session.commit()

    def account(
        self, email: str, state: str, new_count: int | None = None, error: str | None = None
    ) -> None:
        """更新某个邮箱的拉取状态；new_count / error 传 None 表示不改这两项。"""
        for acct in self.stages["fetch"]["accounts"]:
            if acct["email"] == email:
                acct["state"] = state
                if new_count is not None:
                    acct["new_count"] = new_count
                if error is not None:
                    acct["error"] = error
                break
        self._flush()

    def stage(self, name: str, state: str, error: str | None = None, **counters: int) -> None:
        """更新阶段状态；counters 只认骨架里已有的键，免得往契约外多写字段。"""
        target = self.stages[name]
        target["state"] = state
        if error is not None:
            target["error"] = error
        for key, value in counters.items():
            if key in target:
                target[key] = value
        self._flush()

    def step(self, name: str, created: int = 0) -> None:
        """该阶段又处理完一条（成功或失败都算处理过）。"""
        target = self.stages[name]
        target["done"] += 1
        if created and "created" in target:
            target["created"] += created
        self._flush()

    def finish(self, error: str | None = None) -> None:
        """收尾：任一账户 failed、任一阶段 failed 或整轮级 error 都算 failed。"""
        failed = any(
            acct["state"] == "failed" for acct in self.stages["fetch"]["accounts"]
        ) or any(self.stages[name]["state"] == "failed" for name in _STAGE_NAMES)
        self.run.state = "failed" if failed or error else "done"
        self.run.error = error
        self.run.finished_at = datetime.now()
        self._flush()


def serialize_run(run: SyncRun, allowed_emails: set[str]) -> dict:
    """按前端契约序列化一轮；fetch.accounts 只留该用户自己的邮箱。

    classify / detail 的计数是全库口径（阶段本身不分用户），只有逐账户的
    fetch 明细涉及「别人的邮箱」，必须过滤掉。
    """
    stages = _load_stages(run.stages)
    fetch = stages["fetch"]
    return {
        "id": run.id,
        "trigger": run.trigger,
        "state": run.state,
        "started_at": _iso(run.started_at),
        "finished_at": _iso(run.finished_at),
        "error": run.error,
        "stages": {
            "fetch": {
                "state": fetch["state"],
                "error": fetch["error"],
                "accounts": [
                    account for account in fetch["accounts"] if account["email"] in allowed_emails
                ],
            },
            "classify": dict(stages["classify"]),
            "detail": dict(stages["detail"]),
        },
    }


def _latest(session: Session, states: tuple[str, ...]) -> SyncRun | None:
    return (
        session.execute(
            select(SyncRun).where(SyncRun.state.in_(states)).order_by(SyncRun.id.desc()).limit(1)
        )
        .scalars()
        .first()
    )


def status_payload(session: Session, user_sub: str) -> dict:
    """GET /api/sync/status 的响应体；顺手清理卡死的 running 行。"""
    expire_stale_runs(session)
    allowed = set(
        session.execute(select(Account.email).where(Account.user_sub == user_sub)).scalars().all()
    )
    current = _latest(session, ("running",))
    last = _latest(session, ("done", "failed"))
    pending = session.execute(select(SyncRun.id).where(SyncRun.state == "requested").limit(1)).first()
    return {
        "current": serialize_run(current, allowed) if current is not None else None,
        "last": serialize_run(last, allowed) if last is not None else None,
        "pending_request": pending is not None,
    }
