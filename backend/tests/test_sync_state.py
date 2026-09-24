"""同步状态（sync_runs 进度 + 手动唤醒请求）与 /api/sync/* 的测试：假 IMAP / 假 LLM，不触网。"""
import json
from datetime import datetime, timedelta
from email.message import EmailMessage
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app import worker
from app.api import create_app
from app.auth import CurrentUser, require_auth
from app.config import Settings
from app.models import Account, Email, Item, SyncRun, User
from app.sync import run_once
from app.sync_state import (
    MANUAL_DETAIL_WINDOW_DAYS,
    STALE_AFTER,
    claim_request,
    has_request,
    request_sync,
    serialize_run,
    status_payload,
)


def _settings() -> Settings:
    return Settings(database_path=":memory:")


def make_raw(subject="主题", message_id="<m@example.com>", body="正文", sender="a@example.com"):
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = "me@example.com"
    msg["Date"] = "Tue, 26 Aug 2026 10:00:00 +0800"
    if message_id:
        msg["Message-ID"] = message_id
    msg.set_content(body)
    return msg.as_bytes()


class FakeImap:
    """duck-typing 协议类：select_inbox / search_uids / fetch_uid / logout。"""

    def __init__(self, uidvalidity: int = 1):
        self.uidvalidity = uidvalidity
        self.mails: dict[int, bytes] = {}
        self.logged_out = False

    def select_inbox(self) -> int:
        return self.uidvalidity

    def search_uids(self, criteria: str) -> list[int]:
        return list(self.mails)

    def fetch_uid(self, uid: int) -> bytes:
        return self.mails[uid]

    def logout(self) -> None:
        self.logged_out = True


def _ok_result(title):
    return {
        "filtered": False,
        "filter_reason": None,
        "title": title,
        "summary": "s",
        "category": "学业",
        "due_date": None,
        "actionable": True,
    }


def _subject_of(user_content: str) -> str:
    """从详情 prompt 的「主题：」行解析当前邮件主题。"""
    for line in user_content.splitlines():
        if line.startswith("主题："):
            return line[len("主题：") :]
    return ""


class FakeLLM:
    """分类返回预设结果、详情直接返回合法 JSON 的替身（写法同 test_sync.py）。"""

    def __init__(self, results=None):
        self.results = list(results or [])

    def classify_email(self, info: dict) -> dict:
        return self.results.pop(0)

    def chat_completion(self, messages, tools=None, json_mode=False):
        for m in reversed(messages):
            if m.get("role") == "user":
                subject = _subject_of(m.get("content") or "")
                break
        else:
            subject = ""
        return {
            "role": "assistant",
            "content": json.dumps({"detail_md": f"详情：{subject}", "related": []}, ensure_ascii=False),
        }


def _seed_account(session_factory, user_sub: str, email: str) -> None:
    with session_factory() as s:
        s.add(User(sub=user_sub))
        s.commit()
        s.add(
            Account(
                user_sub=user_sub,
                name=f"{user_sub} 的邮箱",
                kind="gmail",
                email=email,
                app_password="app-pw",  # 有凭据才会真正走 IMAP 路径
                status="pending",
            )
        )
        s.commit()


def _run(session_factory, imap, llm, **kwargs):
    return run_once(
        session_factory,
        imap_factory=lambda account, settings: imap,
        llm=llm,
        settings=_settings(),
        **kwargs,
    )


def _load_payload(session_factory, run_id: int, allowed: set[str]) -> dict:
    """按接口契约读出这一轮的序列化结果（在 session 内取，避免脱离后懒加载）。"""
    with session_factory() as s:
        return serialize_run(s.get(SyncRun, run_id), allowed)


def test_request_sync_and_claim_roundtrip(session_factory):
    """请求去重、认领置 running、认领后不再有待认领请求。"""
    with session_factory() as s:
        assert request_sync(s) is True
        assert request_sync(s) is False  # 已有未消费请求：不重复写
        run = s.execute(select(SyncRun)).scalars().one()
        assert run.trigger == "manual"
        assert run.state == "requested"
        assert run.requested_at is not None

    assert has_request(session_factory) is True
    run_id = claim_request(session_factory)
    assert run_id is not None

    with session_factory() as s:
        row = s.get(SyncRun, run_id)
        assert row.state == "running"
        assert row.started_at is not None
        assert row.finished_at is None
        assert row.error is None
    assert has_request(session_factory) is False
    assert claim_request(session_factory) is None  # 已被认领，没有第二个请求


def test_status_shows_current_after_claim(session_factory):
    """认领后 status.current 非空（前端据此开始轮询）；此时还没写进度，骨架用默认值兜底。"""
    _seed_account(session_factory, "user-1", "t@example.com")
    with session_factory() as s:
        assert request_sync(s) is True
    run_id = claim_request(session_factory)

    with session_factory() as s:
        payload = status_payload(s, "user-1")
    assert payload["pending_request"] is False
    assert payload["last"] is None
    current = payload["current"]
    assert current["id"] == run_id
    assert current["trigger"] == "manual"
    assert current["state"] == "running"
    assert current["finished_at"] is None
    assert current["stages"]["fetch"] == {"state": "pending", "error": None, "accounts": []}
    assert current["stages"]["classify"] == {
        "state": "pending", "error": None, "total": 0, "done": 0, "created": 0,
    }
    assert current["stages"]["detail"] == {"state": "pending", "error": None, "total": 0, "done": 0}


def test_sync_endpoints_not_shadowed_by_spa_fallback(session_factory, tmp_path):
    """挂了 SPA fallback 时 /api/sync/* 仍是接口：注册顺序错了这里会拿到 index.html。"""
    (tmp_path / "index.html").write_text("<html>spa</html>", encoding="utf-8")
    app = create_app(
        settings=Settings(database_path=":memory:", frontend_dist=str(tmp_path)),
        session_factory=session_factory,
    )
    app.dependency_overrides[require_auth] = lambda: CurrentUser(sub="user-1", email=None, name=None)
    client = TestClient(app)

    resp = client.get("/api/sync/status")
    assert resp.status_code == 200
    assert resp.json() == {"current": None, "last": None, "pending_request": False}
    assert client.post("/api/sync/trigger").status_code == 202


def test_run_once_records_full_progress(session_factory):
    """一轮成功同步：轮次 done，fetch 逐账户计数、classify/detail 计数都对得上。"""
    _seed_account(session_factory, "user-1", "t@example.com")
    imap = FakeImap()
    imap.mails = {
        1: make_raw(message_id="<a1>", subject="任务一"),
        2: make_raw(message_id="<a2>", subject="任务二"),
    }
    summary = _run(session_factory, imap, FakeLLM(results=[_ok_result("任务一"), _ok_result("任务二")]))

    payload = _load_payload(session_factory, summary["run_id"], {"t@example.com"})
    assert payload["trigger"] == "scheduled"
    assert payload["state"] == "done"
    assert payload["error"] is None
    assert payload["finished_at"] is not None
    # 时间口径与 api.py 的 email_sent_at 一致：naive UTC 补显式 +00:00
    assert payload["started_at"].endswith("+00:00")
    assert payload["finished_at"].endswith("+00:00")

    fetch = payload["stages"]["fetch"]
    assert fetch["state"] == "done"
    assert fetch["error"] is None
    assert len(fetch["accounts"]) == 1
    assert fetch["accounts"][0]["email"] == "t@example.com"
    assert fetch["accounts"][0]["state"] == "done"
    assert fetch["accounts"][0]["new_count"] == 2
    assert fetch["accounts"][0]["error"] is None

    classify = payload["stages"]["classify"]
    assert classify["state"] == "done"
    assert classify["total"] == 2
    assert classify["done"] == 2
    assert classify["created"] == 2

    detail = payload["stages"]["detail"]
    assert detail["state"] == "done"
    assert detail["total"] == 2
    assert detail["done"] == 2
    assert set(detail) == {"state", "error", "total", "done"}  # 不多写契约外的键


def test_account_failure_marks_run_failed_and_keeps_stages_complete(session_factory):
    """账户拉取抛异常：rollback 之后 stages 仍是完整 JSON，整轮判 failed。"""
    _seed_account(session_factory, "user-1", "t@example.com")

    def bad_factory(account, settings):
        raise RuntimeError("连接失败")

    summary = run_once(
        session_factory, imap_factory=bad_factory, llm=FakeLLM(), settings=_settings()
    )
    with session_factory() as s:
        run = s.get(SyncRun, summary["run_id"])
        payload = serialize_run(run, {"t@example.com"})
        raw = json.loads(run.stages)

    assert payload["state"] == "failed"
    assert payload["error"] is None  # 单邮箱失败只记在 stages 里，不填整轮 error
    fetch = payload["stages"]["fetch"]
    assert fetch["state"] == "failed"
    assert fetch["error"] == "1 个邮箱拉取失败"
    acct = fetch["accounts"][0]
    assert acct["state"] == "failed"
    assert "连接失败" in acct["error"]

    # 关键：账户异常触发的 session.rollback() 之后，进度 JSON 依然完整
    assert set(raw) == {"fetch", "classify", "detail"}
    assert set(raw["classify"]) == {"state", "error", "total", "done", "created"}
    assert set(raw["detail"]) == {"state", "error", "total", "done"}
    assert set(raw["fetch"]["accounts"][0]) == {"email", "state", "new_count", "error"}


def _seed_history(session_factory) -> None:
    """直接塞两封历史邮件 + 两条没有详情的条目：一封 10 天前、一封 1 天前。"""
    now = datetime.now()
    with session_factory() as s:
        s.add(User(sub="user-1"))
        s.commit()
        account = Account(
            user_sub="user-1", name="测试邮箱", kind="gmail", email="t@example.com",
            app_password="app-pw", status="ok",
        )
        s.add(account)
        s.commit()
        old = Email(
            account_id=account.id, message_id="<old>", subject="十天前", sender="a@example.com",
            sent_at=now - timedelta(days=10), text_body="正文", html_body=None, llm_state="done",
        )
        recent = Email(
            account_id=account.id, message_id="<recent>", subject="一天前", sender="a@example.com",
            sent_at=now - timedelta(days=1), text_body="正文", html_body=None, llm_state="done",
        )
        s.add_all([old, recent])
        s.commit()
        s.add_all(
            [
                Item(email_id=old.id, user_sub="user-1", title="十天前的条目", category="其他"),
                Item(email_id=recent.id, user_sub="user-1", title="一天前的条目", category="其他"),
            ]
        )
        s.commit()


def _items_by_title(session_factory) -> dict:
    with session_factory() as s:
        return {i.title: i for i in s.execute(select(Item)).scalars().all()}


def test_manual_window_limits_detail_backfill(session_factory):
    """手动轮次只回填窗口内的详情；不带窗口的一轮把历史 NULL 也补上。"""
    assert MANUAL_DETAIL_WINDOW_DAYS == 7
    _seed_history(session_factory)
    imap = FakeImap()  # 没有新邮件：这一轮只走详情回填

    manual = _run(
        session_factory,
        imap,
        FakeLLM(),
        trigger="manual",
        detail_window_days=MANUAL_DETAIL_WINDOW_DAYS,
    )
    items = _items_by_title(session_factory)
    assert items["一天前的条目"].detail_md == "详情：一天前"
    assert items["十天前的条目"].detail_md is None  # 窗口外不动
    payload = _load_payload(session_factory, manual["run_id"], {"t@example.com"})
    assert payload["trigger"] == "manual"
    assert payload["state"] == "done"
    assert payload["stages"]["detail"]["total"] == 1  # 只把窗口内那条算进这一轮
    assert payload["stages"]["detail"]["done"] == 1

    _run(session_factory, FakeImap(), FakeLLM())  # 定时轮次默认全量回填
    items = _items_by_title(session_factory)
    assert items["十天前的条目"].detail_md == "详情：十天前"
    assert items["一天前的条目"].detail_md == "详情：一天前"


def _client(session_factory, user: CurrentUser) -> TestClient:
    app = create_app(settings=_settings(), session_factory=session_factory)
    app.dependency_overrides[require_auth] = lambda: user
    return TestClient(app)


def test_status_endpoint_contract_and_trigger(session_factory):
    """status 的键恰好是契约的三个；trigger 去重；A 的状态里看不到 B 的邮箱。"""
    _seed_account(session_factory, "user-A", "a@example.com")
    _seed_account(session_factory, "user-B", "b@example.com")
    client_a = _client(session_factory, CurrentUser(sub="user-A", email="a@example.com", name="甲"))

    resp = client_a.get("/api/sync/status")
    assert resp.status_code == 200
    assert set(resp.json()) == {"current", "last", "pending_request"}
    assert resp.json() == {"current": None, "last": None, "pending_request": False}

    _run(session_factory, FakeImap(), FakeLLM())  # 两个账户都跑一轮（没有新邮件）

    first = client_a.post("/api/sync/trigger")
    assert first.status_code == 202
    assert first.json() == {"accepted": True, "already_running": False}
    second = client_a.post("/api/sync/trigger")
    assert second.status_code == 202
    assert second.json() == {"accepted": True, "already_running": True}  # 不重复写请求

    data = client_a.get("/api/sync/status").json()
    assert set(data) == {"current", "last", "pending_request"}
    assert data["pending_request"] is True  # 请求已写、worker 还没认领
    assert data["current"] is None
    assert data["last"]["state"] == "done"
    assert [a["email"] for a in data["last"]["stages"]["fetch"]["accounts"]] == ["a@example.com"]

    client_b = _client(session_factory, CurrentUser(sub="user-B", email="b@example.com", name="乙"))
    data_b = client_b.get("/api/sync/status").json()
    assert data_b["pending_request"] is True  # 请求是全局的（worker 只有一份）
    assert [a["email"] for a in data_b["last"]["stages"]["fetch"]["accounts"]] == ["b@example.com"]


def test_end_to_end_trigger_claim_manual_round(session_factory):
    """整条链路：POST 触发 → worker 认领 → 跑手动轮 → status 给出前端要的值。"""
    _seed_account(session_factory, "user-1", "t@example.com")
    client = _client(session_factory, CurrentUser(sub="user-1", email="t@example.com", name="甲"))
    assert client.post("/api/sync/trigger").json() == {"accepted": True, "already_running": False}

    run_id = claim_request(session_factory)  # worker 认领
    imap = FakeImap()
    imap.mails = {1: make_raw(message_id="<e2e>", subject="手动轮的邮件")}
    _run(
        session_factory,
        imap,
        FakeLLM(results=[_ok_result("手动轮的邮件")]),
        trigger="manual",
        run_id=run_id,
        detail_window_days=MANUAL_DETAIL_WINDOW_DAYS,
    )

    data = client.get("/api/sync/status").json()
    assert data["pending_request"] is False  # 请求已被消费
    assert data["current"] is None  # 轮次已结束：前端据此停止轮询
    assert data["last"]["id"] == run_id
    assert data["last"]["trigger"] == "manual"
    assert data["last"]["state"] == "done"
    assert data["last"]["finished_at"] is not None
    assert data["last"]["stages"]["classify"]["created"] == 1  # 前端显示的「新增 N 条待办」
    assert data["last"]["stages"]["fetch"]["accounts"][0]["new_count"] == 1


def test_stale_running_run_expires_on_new_request(session_factory):
    """worker 崩溃留下的 running 行：下一次请求时按中断处理，不挡住新请求。"""
    with session_factory() as s:
        stale = SyncRun(
            trigger="manual", state="running",
            started_at=datetime.now() - STALE_AFTER - timedelta(minutes=10),
        )
        s.add(stale)
        s.commit()
        stale_id = stale.id

    with session_factory() as s:
        assert request_sync(s) is True  # 旧行没挡住新请求

    with session_factory() as s:
        row = s.get(SyncRun, stale_id)
        assert row.state == "failed"
        assert row.error == "worker 未在 30 分钟内完成，视为中断"
        assert row.finished_at is not None


class FakeTime:
    """替身 time 模块：sleep 让假时钟前进，并记录每次调用。"""

    def __init__(self):
        self.now = 0.0
        self.sleeps = []

    def monotonic(self) -> float:
        return self.now

    def sleep(self, n: float) -> None:
        self.sleeps.append(n)
        self.now += n


def test_sleep_until_wakes_on_request(monkeypatch):
    """有待认领的请求时立刻结束睡眠，不再睡满整个间隔。"""
    fake = FakeTime()
    monkeypatch.setattr(worker, "time", fake)
    try:
        worker._sleep_until(fake.monotonic() + 900, wake=lambda: True)
    finally:
        worker._stop = False
    assert len(fake.sleeps) <= 1
    assert fake.now < 900


def test_main_loop_runs_manual_round_for_claimed_request(monkeypatch):
    """认领到请求时跑手动轮次：trigger=manual、带 run_id 与 7 天详情窗口。"""
    calls = []

    def fake_run_once(session_factory, settings=None, **kwargs):
        calls.append(kwargs)
        worker._stop = True  # 一轮即结束
        return {"accounts": {}, "pending_llm": 0}

    monkeypatch.setattr(worker, "run_once", fake_run_once)
    monkeypatch.setattr(worker, "claim_request", lambda session_factory: 42)
    monkeypatch.setattr(worker, "has_request", lambda session_factory: False)
    monkeypatch.setattr(
        worker, "get_settings",
        lambda: Settings(database_path=":memory:", sync_interval_minutes=15),
    )
    monkeypatch.setattr(worker, "make_engine", lambda path: object())
    monkeypatch.setattr(worker, "init_db", lambda engine: None)
    monkeypatch.setattr(worker, "make_session_factory", lambda engine: object())
    monkeypatch.setattr(worker, "signal", SimpleNamespace(SIGTERM=15, signal=lambda *a: None))
    monkeypatch.setattr(worker, "logging", SimpleNamespace(INFO=20, basicConfig=lambda **kw: None))
    monkeypatch.setattr(worker, "sys", SimpleNamespace(exit=lambda code: None))
    worker._stop = False
    try:
        worker.main()
    finally:
        worker._stop = False
    assert calls == [{"trigger": "manual", "run_id": 42, "detail_window_days": MANUAL_DETAIL_WINDOW_DAYS}]
