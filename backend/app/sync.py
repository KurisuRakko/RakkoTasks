"""单轮同步：逐账户 IMAP 拉取入库（去重）+ 处理 llm_state=pending 队列。"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Callable

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.config import Settings, get_settings
from app.imap import client as imap_client
from app.imap.parser import parse_message
from app.models import Account, Email, Item

FIXED_CATEGORIES = {"学业", "工作", "个人", "账单", "其他"}

# imap_factory(account, settings) -> 协议类实例（duck-typing：select_inbox/search_uids/fetch_uid/logout）
ImapFactory = Callable[[Account, Settings], Any]


def _default_imap_factory(account: Account, settings: Settings):
    return imap_client.connect_account(account, settings)[0]


def _sync_account(session: Session, account: Account, imap: Any, settings: Settings) -> None:
    """拉取一个账户的增量邮件并入库存。"""
    uidvalidity = imap.select_inbox()
    if account.uidvalidity is not None and account.uidvalidity != uidvalidity:
        # UIDVALIDITY 变化：旧 UID 全部失效，重置游标全量回补
        account.uidvalidity = uidvalidity
        account.last_uid = 0
    elif account.uidvalidity is None:
        account.uidvalidity = uidvalidity

    criteria = imap_client.build_search_criteria(account.last_uid, settings.initial_backfill_days)
    uids = imap.search_uids(criteria)
    # UID 序列查询是闭区间：过滤掉等于 last_uid 的最后一封
    uids = [u for u in uids if u > account.last_uid]
    if not uids:
        return

    for uid in uids:
        raw = imap.fetch_uid(uid)
        parsed = parse_message(raw)
        exists = session.execute(
            select(Email.id).where(
                Email.account_id == account.id, Email.message_id == parsed["message_id"]
            )
        ).first()
        if exists:
            continue  # 去重 (account_id, message_id)
        session.add(
            Email(
                account_id=account.id,
                message_id=parsed["message_id"],
                subject=parsed["subject"],
                sender=parsed["sender"],
                recipients=parsed["recipients"],
                sent_at=parsed["sent_at"],
                text_body=parsed["text_body"],
                html_body=parsed["html_body"],
                attachments_json=json.dumps(parsed["attachments"], ensure_ascii=False),
                llm_state="pending",
            )
        )
    account.last_uid = max(account.last_uid, max(uids))


def _process_pending(session: Session, llm: Any, rows: list[Email]) -> None:
    """逐封分类待处理邮件（pending 首次 / error 下轮重试）：过滤则标记，否则建 item。"""
    for email in rows:
        info = {
            "subject": email.subject,
            "sender": email.sender,
            "sent_at": email.sent_at,
            "text_body": email.text_body,
        }
        try:
            result = llm.classify_email(info)
        except Exception as exc:
            email.llm_state = "error"
            email.filter_reason = f"LLM 处理失败: {exc}"
            continue
        if result.get("filtered"):
            email.filtered = True
            email.filter_reason = result.get("filter_reason") or "被过滤"
        else:
            category = result.get("category") or "其他"
            if category not in FIXED_CATEGORIES:
                category = "其他"  # 分类不在固定集时归“其他”
            due_date = result.get("due_date")
            due = None
            if due_date:
                try:
                    due = datetime.strptime(str(due_date), "%Y-%m-%d").date()
                except ValueError:
                    due = None  # 非法日期置 null
            importance = result.get("importance") or "normal"
            if importance not in ("high", "normal", "low"):
                importance = "normal"  # 与 _normalize_classify 同款白名单，防 FakeLLM/异常输出
            session.add(
                Item(
                    email_id=email.id,
                    title=(result.get("title") or "")[:30] or "未命名任务",
                    summary=result.get("summary") or "",
                    category=category,
                    due_date=due,
                    importance=importance,
                    actionable=bool(result.get("actionable", True)),
                    status="open",
                )
            )
        email.llm_state = "done"


def run_once(
    session_factory: sessionmaker[Session],
    imap_factory: ImapFactory | None = None,
    llm: Any = None,
    settings: Settings | None = None,
) -> dict:
    """执行一轮同步：逐账户 try/except，成功 ok，异常 error + last_error。返回汇总。

    LLM 处理与 IMAP 同步解耦：LLM 不可用（未配置/未注入）不阻塞拉取入库，
    pending 邮件标记 error，待下轮重试。
    """
    settings = settings or get_settings()
    imap_factory = imap_factory or _default_imap_factory
    if llm is None:
        try:
            from app.llm import get_llm

            llm = get_llm(settings)
        except RuntimeError:
            llm = None  # 未配置 LLM：跳过分类阶段
    summary: dict[str, Any] = {"accounts": {}, "pending_llm": 0}
    with session_factory() as session:
        # 只同步启用中的账户；enabled=0（软删除）的账户跳过，其邮件与任务保留
        accounts = session.execute(select(Account).where(Account.enabled.is_(True))).scalars().all()
        for account in accounts:
            imap = None
            try:
                imap = imap_factory(account, settings)
                _sync_account(session, account, imap, settings)
                session.commit()
                account.status = "ok"
                account.last_sync_at = datetime.now()
                account.last_error = None
                summary["accounts"][account.email] = {"status": "ok", "error": None}
            except Exception as exc:
                session.rollback()
                account.status = "error"
                account.last_error = str(exc)
                summary["accounts"][account.email] = {"status": "error", "error": str(exc)}
            finally:
                if imap is not None:
                    imap.logout()
            session.commit()
        # LLM 队列：pending 计数 + 处理（含 error 重试）
        queue = session.execute(
            select(Email).where(Email.llm_state.in_(("pending", "error")))
        ).scalars().all()
        summary["pending_llm"] = len([e for e in queue if e.llm_state == "pending"])
        if llm is not None:
            _process_pending(session, llm, queue)
        else:
            for email in queue:
                if email.llm_state == "pending":
                    email.llm_state = "error"
                    email.filter_reason = "LLM 未配置，下轮重试"
        session.commit()
    return summary
