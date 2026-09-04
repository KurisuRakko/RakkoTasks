"""单轮同步：逐账户 IMAP 拉取入库（去重）+ 处理 llm_state=pending 队列。"""
from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any, Callable

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.config import Settings, get_settings
from app.detail import apply_detail, generate_item_detail
from app.emailtext import email_plain_text
from app.imap import client as imap_client
from app.imap.parser import parse_message
from app.models import Account, Email, Item

FIXED_CATEGORIES = {"学业", "工作", "个人", "账单", "其他"}

# worker 与 API 触发同步共用：进度日志只含计数，不写邮件内容
logger = logging.getLogger("rakkotasks.sync")

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


def _commit_email(session: Session, email: Email) -> bool:
    """提交单封的处理结果；commit 失败（如约束冲突）则回滚并把该封标为 error 后再次提交。

    必须逐封提交：整轮可达数百封，若攒批到最后一次性提交，中途任何
    崩溃/重启都会把已完成的结果全部回滚，已消耗的 LLM 调用全部白费。
    commit 失败后事务已失效，必须 rollback 才能继续使用 session；
    rollback 会同时撤销对 email 的改动，所以要重新标记 error 再提交。
    二次提交仍失败则放弃该封（库中保持原状态待下轮重试），不让整轮挂掉。
    """
    try:
        session.commit()
        return True
    except Exception as exc:
        session.rollback()
        email.llm_state = "error"
        email.filter_reason = f"写入失败: {exc}"
        try:
            session.commit()
            return True
        except Exception:
            session.rollback()
            return False


def _process_pending(
    session: Session, llm: Any, rows: list[Email], logger: logging.Logger | None = None
) -> None:
    """逐封分类待处理邮件（pending 首次 / error 下轮重试）：过滤则标记，否则建 item。

    每封处理完立即逐封提交（见 _commit_email）；错误标记同样要落盘，
    否则下轮会重复调用 LLM 重试同一封。传入 logger 时每处理 10 封输出
    一条只含计数的进度日志，不输出邮件主题/正文。
    """
    total = len(rows)
    filtered = 0
    created = 0
    failed = 0
    for index, email in enumerate(rows, start=1):
        info = {
            "subject": email.subject,
            "sender": email.sender,
            "sent_at": email.sent_at,
            # 正文必须回退到 HTML：纯 HTML 邮件（无 text/plain 分段）约占生产四成，
            # 不回退则 LLM 只看到主题行，正文不可见。
            "text_body": email_plain_text(email.text_body, email.html_body),
        }
        try:
            result = llm.classify_email(info)
        except Exception as exc:
            email.llm_state = "error"
            email.filter_reason = f"LLM 处理失败: {exc}"
            _commit_email(session, email)
            failed += 1
        else:
            if result.get("filtered"):
                email.filtered = True
                email.filter_reason = result.get("filter_reason") or "被过滤"
                filtered += 1
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
                        user_sub=email.account.user_sub,
                        title=(result.get("title") or "")[:30] or "未命名任务",
                        summary=result.get("summary") or "",
                        category=category,
                        due_date=due,
                        importance=importance,
                        actionable=bool(result.get("actionable", True)),
                        status="open",
                    )
                )
                created += 1
            email.llm_state = "done"
            if not _commit_email(session, email):
                failed += 1  # 提交失败转 error 的封计入失败
        if logger is not None and index % 10 == 0:
            logger.info(
                "分类进度：%d/%d（过滤 %d / 建任务 %d / 失败 %d）",
                index,
                total,
                filtered,
                created,
                failed,
            )


def _prefill_details(
    session: Session, llm: Any, items: list[Item], settings: Settings, logger: logging.Logger | None = None
) -> dict:
    """为 detail_md 为空的条目预生成详情（agentic，含关联邮件检索），逐条提交，返回计数汇总。

    详情原本只在用户首次点开时现场生成（api.py），首开要同步等完
    LLM 推理，体验差；改为分类落库后在 worker 里统一补齐，点开即读缓存。
    API 的现场生成保留为兜底：本轮尚未补到的条目点开仍可用。
    详情现会检索关联邮件，一条可能是多轮 LLM 调用。
    单条失败只记日志并跳过，detail_md 保持 NULL 由下轮重试；
    逐条提交的理由同 _commit_email：中途崩溃不丢已完成的结果。
    """
    total = len(items)
    generated = 0
    failed = 0
    for index, item in enumerate(items, start=1):
        try:
            md, related = generate_item_detail(session, llm, item, settings)
            apply_detail(item, md, related)
            session.commit()
            generated += 1
        except Exception as exc:
            session.rollback()
            failed += 1
            if logger is not None:
                # 只输出条目 id 与异常，不输出邮件主题/正文
                logger.warning("详情生成失败（item %d）：%s", item.id, exc)
        if logger is not None and index % 10 == 0:
            logger.info("详情进度：%d/%d（生成 %d / 失败 %d）", index, total, generated, failed)
    return {"total": total, "generated": generated, "failed": failed}


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
            _process_pending(session, llm, queue, logger=logger)
        else:
            for email in queue:
                if email.llm_state == "pending":
                    email.llm_state = "error"
                    email.filter_reason = "LLM 未配置，下轮重试"
        session.commit()
        # 详情预生成：分类之后补齐 detail_md 为空的条目（本轮新建 + 历史回填），
        # 新条目在前——越新越可能被点开；只处理邮件条目——手动条目没有邮件正文，
        # 不生成 AI 详情
        if llm is not None:
            todo = (
                session.execute(
                    select(Item)
                    .where(Item.detail_md.is_(None), Item.email_id.is_not(None))
                    .order_by(Item.id.desc())
                )
                .scalars()
                .all()
            )
            summary["details"] = _prefill_details(session, llm, todo, settings, logger=logger)
    return summary
