"""单轮同步：逐账户 IMAP 拉取入库（去重）+ 处理 llm_state=pending 队列。"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from typing import Any, Callable

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.accounts import has_credentials
from app.archive import EmailArchive
from app.config import Settings, get_settings
from app.detail import apply_detail, generate_item_detail
from app.emailtext import email_plain_text
from app.imap import client as imap_client
from app.imap.parser import parse_message
from app.itemrules import CATEGORIES
from app.models import Account, Email, Item, SyncRun
from app.sync_state import SyncProgress

# worker 与 API 触发同步共用：进度日志只含计数，不写邮件内容
logger = logging.getLogger("rakkotasks.sync")

# imap_factory(account, settings) -> 协议类实例（duck-typing：select_inbox/search_uids/fetch_uid/logout）
ImapFactory = Callable[[Account, Settings], Any]


def _default_imap_factory(account: Account, settings: Settings):
    return imap_client.connect_account(account, settings)[0]


def _sync_account(
    session: Session, account: Account, imap: Any, settings: Settings, archive: EmailArchive | None = None
) -> int:
    """拉取一个账户的增量邮件并入库存，返回本轮新入库的邮件数。

    返回的是「新入库」而不是「拉到的」：去重命中的 UID 不计数，调用方拿它
    填前端进度里的 new_count。提交由调用方负责——提交失败会整批回滚并把该
    账户标 error，此时这个计数也就不会被采用。
    """
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
        return 0

    new_count = 0
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
        if archive is not None:
            # 写在去重之后：已入库的邮件不重写（UIDVALIDITY 重置会整批重拉）。
            # 回滚后重拉同一批 UID 时由 mbox 索引去重；归档失败已在 store 内吞掉，
            # 不影响入库与游标推进。
            archive.store(account.email, parsed["message_id"], parsed["sent_at"], raw)
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
        new_count += 1
    account.last_uid = max(account.last_uid, max(uids))
    return new_count


def _archive_uids(account: Account, imap: Any, archive: EmailArchive, uids: list[int]) -> None:
    """逐封 PEEK 拉取（`BODY.PEEK[]`，不设置 \\Seen）→ 解析 → 追加进 mbox；不碰数据库。"""
    for uid in uids:
        raw = imap.fetch_uid(uid)
        parsed = parse_message(raw)
        archive.store(account.email, parsed["message_id"], parsed["sent_at"], raw)


def _archive_sent(account: Account, imap: Any, settings: Settings, archive: EmailArchive) -> None:
    """发件箱只归档：邮件进 mbox，不入库、不跑 LLM、不建待办。

    游标与收件箱分开（sent_last_uid / sent_uidvalidity）：发件箱文件夹的
    UIDVALIDITY 变化时只重置自己这一份，不影响收件箱。
    """
    name = imap.find_sent_folder()
    if name is None:
        return  # 没有 \Sent 标记的文件夹：该账户没有可归档的发件箱
    uidvalidity = imap.select_folder_readonly(name)
    if account.sent_uidvalidity != uidvalidity:
        # UIDVALIDITY 变化：旧 UID 全部失效，游标重置后按日期回补
        account.sent_uidvalidity = uidvalidity
        account.sent_last_uid = 0
    criteria = imap_client.build_search_criteria(account.sent_last_uid, settings.initial_backfill_days)
    # UID 序列查询是闭区间：过滤掉等于 sent_last_uid 的最后一封
    uids = [u for u in imap.search_uids(criteria) if u > account.sent_last_uid]
    _archive_uids(account, imap, archive, uids)
    if uids:
        account.sent_last_uid = max(account.sent_last_uid, max(uids))


def backfill_archive(account: Account, imap: Any, archive: EmailArchive, days: int) -> None:
    """按 SINCE 回补历史原件：收件箱 + 发件箱，只追加进 mbox。

    不碰 emails 表、不动任何游标（所以不收 session，也不收 settings）；
    归档专用的拉取走 PEEK，不改动邮箱的已读状态。
    """
    criteria = f"SINCE {imap_client._since_date(days)}"
    imap.select_folder_readonly("INBOX")
    _archive_uids(account, imap, archive, imap.search_uids(criteria))

    sent = imap.find_sent_folder()
    if sent is None:
        return
    imap.select_folder_readonly(sent)
    _archive_uids(account, imap, archive, imap.search_uids(criteria))


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
    session: Session,
    llm: Any,
    rows: list[Email],
    logger: logging.Logger | None = None,
    *,
    progress: SyncProgress | None = None,
) -> dict:
    """逐封分类待处理邮件（pending 首次 / error 下轮重试）：过滤则标记，否则建 item。

    每封处理完立即逐封提交（见 _commit_email）；错误标记同样要落盘，
    否则下轮会重复调用 LLM 重试同一封。传入 logger 时每处理 10 封输出
    一条只含计数的进度日志，不输出邮件主题/正文。传入 progress 时逐封推进
    分类阶段计数，返回本轮的计数汇总（total/filtered/created/failed），
    调用方据此判断阶段成败。
    """
    total = len(rows)
    filtered = 0
    created = 0
    failed = 0
    for index, email in enumerate(rows, start=1):
        made_item = False  # 这一封是否产出了新 Item，决定进度里的 created 加不加
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
                if category not in CATEGORIES:
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
                made_item = True
            email.llm_state = "done"
            if not _commit_email(session, email):
                failed += 1  # 提交失败转 error 的封计入失败
        if progress is not None:
            # 失败封也算处理过一封（与详情阶段同款）：done 与 total 对齐，
            # 阶段是否 failed 由调用方按失败数决定
            progress.step("classify", created=1 if made_item else 0)
        if logger is not None and index % 10 == 0:
            logger.info(
                "分类进度：%d/%d（过滤 %d / 建任务 %d / 失败 %d）",
                index,
                total,
                filtered,
                created,
                failed,
            )
    return {"total": total, "filtered": filtered, "created": created, "failed": failed}


def _prefill_details(
    session: Session,
    llm: Any,
    items: list[Item],
    settings: Settings,
    logger: logging.Logger | None = None,
    *,
    progress: SyncProgress | None = None,
) -> dict:
    """为 detail_md 为空的条目预生成详情（agentic，含关联邮件检索），逐条提交，返回计数汇总。

    详情原本只在用户首次点开时现场生成（api.py），首开要同步等完
    LLM 推理，体验差；改为分类落库后在 worker 里统一补齐，点开即读缓存。
    API 的现场生成保留为兜底：本轮尚未补到的条目点开仍可用。
    详情现会检索关联邮件，一条可能是多轮 LLM 调用。
    单条失败只记日志并跳过，detail_md 保持 NULL 由下轮重试；
    逐条提交的理由同 _commit_email：中途崩溃不丢已完成的结果。
    传入 progress 时逐条推进详情阶段计数。
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
        if progress is not None:
            progress.step("detail")  # 成功与失败都算处理过一条
        if logger is not None and index % 10 == 0:
            logger.info("详情进度：%d/%d（生成 %d / 失败 %d）", index, total, generated, failed)
    return {"total": total, "generated": generated, "failed": failed}


def run_once(
    session_factory: sessionmaker[Session],
    imap_factory: ImapFactory | None = None,
    llm: Any = None,
    settings: Settings | None = None,
    *,
    trigger: str = "scheduled",
    run_id: int | None = None,
    detail_window_days: int | None = None,
) -> dict:
    """执行一轮同步：逐账户 try/except，成功 ok，异常 error + last_error。返回汇总。

    LLM 处理与 IMAP 同步解耦：LLM 不可用（未配置/未注入）不阻塞拉取入库，
    pending 邮件标记 error，待下轮重试。
    轮次本身与三个阶段（fetch/classify/detail）的进度都写进 sync_runs，供
    /api/sync/status 读取。worker 认领手动请求后带着 run_id 调用，定时轮次
    自己建行；detail_window_days 非空时详情只回填最近这么多天的邮件。
    """
    settings = settings or get_settings()
    imap_factory = imap_factory or _default_imap_factory
    archive = EmailArchive.from_settings(settings)
    if llm is None:
        try:
            from app.llm import get_llm

            llm = get_llm(settings)
        except RuntimeError:
            llm = None  # 未配置 LLM：跳过分类阶段
    summary: dict[str, Any] = {"accounts": {}, "pending_llm": 0}
    with session_factory() as session:
        run = session.get(SyncRun, run_id) if run_id is not None else None
        if run is None:
            run = SyncRun(trigger=trigger, state="running", started_at=datetime.now())
            session.add(run)
        else:
            # 认领过的请求行已是 running 且 started_at 已填；这里只兜底补齐
            # （手工传 run_id 或将来别的调用方漏填 started_at 时）
            run.state = "running"
            if run.started_at is None:
                run.started_at = datetime.now()
        session.commit()
        summary["run_id"] = run.id
        # 只同步启用中的账户；enabled=0（软删除）的账户跳过，其邮件与任务保留
        accounts = session.execute(select(Account).where(Account.enabled.is_(True))).scalars().all()
        progress = SyncProgress(session, run, [account.email for account in accounts])
        try:
            progress.stage("fetch", "running")
            fetch_failed = 0
            for account in accounts:
                if not has_credentials(account):
                    # 刚添加/停用后尚未设置凭据（gmail 未录应用密码、微软未完成授权）的账户：
                    # 跳过不同步，也不标 error——连不上是预期状态，凭据就绪后下一轮自动开始回补
                    summary["accounts"][account.email] = {"status": "pending", "error": None}
                    progress.account(account.email, "skipped")
                    continue
                imap = None
                try:
                    progress.account(account.email, "running")
                    imap = imap_factory(account, settings)
                    new_count = _sync_account(session, account, imap, settings, archive)
                    session.commit()
                    account.status = "ok"
                    account.last_sync_at = datetime.now()
                    account.last_error = None
                    summary["accounts"][account.email] = {"status": "ok", "error": None}
                    if archive is not None:
                        # 先提交收件箱成果与账户状态，发件箱失败时回滚的只有发件箱游标
                        session.commit()
                        try:
                            _archive_sent(account, imap, settings, archive)
                            session.commit()
                        except Exception as exc:
                            session.rollback()
                            logger.warning("发件箱归档失败（account %d）：%s", account.id, type(exc).__name__)
                    progress.account(account.email, "done", new_count=new_count)
                except Exception as exc:
                    session.rollback()
                    account.status = "error"
                    account.last_error = str(exc)
                    summary["accounts"][account.email] = {"status": "error", "error": str(exc)}
                    fetch_failed += 1
                    # 上面的 rollback 连同本账户期间的进度 JSON 一起丢了，
                    # account() 的整段重写会把完整骨架补回来（见 SyncProgress 注释）
                    progress.account(account.email, "failed", error=str(exc))
                finally:
                    if imap is not None:
                        imap.logout()
                session.commit()
            progress.stage(
                "fetch",
                "failed" if fetch_failed else "done",
                error=f"{fetch_failed} 个邮箱拉取失败" if fetch_failed else None,
            )
            # LLM 队列：pending 计数 + 处理（含 error 重试）
            queue = session.execute(
                select(Email).where(Email.llm_state.in_(("pending", "error")))
            ).scalars().all()
            summary["pending_llm"] = len([e for e in queue if e.llm_state == "pending"])
            progress.stage("classify", "running", total=len(queue), done=0, created=0)
            if llm is not None:
                classified = _process_pending(
                    session, llm, queue, logger=logger, progress=progress
                )
                if classified["failed"]:
                    progress.stage("classify", "failed", error=f"{classified['failed']} 封分类失败")
                else:
                    progress.stage("classify", "done")
            else:
                for email in queue:
                    if email.llm_state == "pending":
                        email.llm_state = "error"
                        email.filter_reason = "LLM 未配置，下轮重试"
                progress.stage("classify", "failed", error="LLM 未配置")
            session.commit()
            # 详情预生成：分类之后补齐 detail_md 为空的条目（本轮新建 + 历史回填），
            # 新条目在前——越新越可能被点开；只处理邮件条目——手动条目没有邮件正文，
            # 不生成 AI 详情
            if llm is not None:
                stmt = select(Item).where(Item.detail_md.is_(None), Item.email_id.is_not(None))
                if detail_window_days is not None:
                    # 只看最近 N 天收到的邮件：手动点刷新时用户等的是刚到的邮件，
                    # 把时间花在历史积压上会让这一轮久久不结束。sent_at 为空的
                    # 邮件没有时间可比，一并排除。
                    stmt = stmt.join(Email, Item.email_id == Email.id).where(
                        Email.sent_at >= datetime.now() - timedelta(days=detail_window_days)
                    )
                todo = session.execute(stmt.order_by(Item.id.desc())).scalars().all()
                progress.stage("detail", "running", total=len(todo), done=0)
                details = _prefill_details(
                    session, llm, todo, settings, logger=logger, progress=progress
                )
                summary["details"] = details
                if details["failed"]:
                    progress.stage("detail", "failed", error=f"{details['failed']} 条详情生成失败")
                else:
                    progress.stage("detail", "done")
            else:
                progress.stage("detail", "failed", error="LLM 未配置")
        except Exception as exc:
            # 整轮级异常（如库不可用）：先落盘成败再原样抛出，worker 会记录日志并
            # 继续下一轮，否则这一行会一直停在 running。先 rollback 是因为异常
            # 可能就来自失败的 commit（事务已失效），不 rollback 的话 finish 里的
            # commit 会立刻再抛一次，把原始异常盖掉。
            session.rollback()
            progress.finish(error=str(exc))
            raise
        progress.finish()
    if archive is not None:
        summary["archive"] = archive.summary()
    return summary
