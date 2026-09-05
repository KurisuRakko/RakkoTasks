"""CalDAV 集合的数据访问：成员枚举（保留窗口）、按名/UID 定位、PUT/DELETE 落库、ETag/ctag。

单一集合、单一所有者：所有查询都以鉴权用户的 sub 过滤，跨用户的资源对外一律
「不存在」（404），与 REST 侧的 IDOR 策略一致。
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.caldav.vtodo import ParsedTodo, etag_for, serialize
from app.itemrules import set_status
from app.models import Item

# iPhone 上新建的任务没有分类信息可依（单列表），固定归入「个人」
DEFAULT_CATEGORY = "个人"


def stem_of(item: Item) -> str:
    """资源名（不含 .ics）：客户端另起过文件名就用它，否则就是 UID。"""
    return item.caldav_name or item.caldav_uid or ""


def retention_cutoff(now: datetime, days: int) -> datetime:
    return now - timedelta(days=days)


def list_members(session: Session, user_sub: str, *, now: datetime, retention_days: int) -> list[Item]:
    """集合成员：未完成的全部 + 最近 retention_days 天内完成的。

    done_at 为 NULL 的 done 条目按「久远」排除，落进常规条件不另分支。
    只用于枚举（PROPFIND Depth:1 / calendar-query）；单个对象按名寻址不受窗口影响。
    """
    cutoff = retention_cutoff(now, retention_days)
    stmt = (
        select(Item)
        .where(
            Item.user_sub == user_sub,
            or_(Item.status == "open", (Item.status == "done") & (Item.done_at >= cutoff)),
        )
        .order_by(Item.id)
    )
    return list(session.execute(stmt).scalars().all())


def find_by_stem(session: Session, user_sub: str, stem: str) -> Item | None:
    """coalesce(caldav_name, caldav_uid) == stem 是唯一寻址规则，不派生别的名字。"""
    stmt = select(Item).where(
        Item.user_sub == user_sub,
        func.coalesce(Item.caldav_name, Item.caldav_uid) == stem,
    )
    return session.execute(stmt).scalars().first()


def find_by_uid(session: Session, user_sub: str, uid: str) -> Item | None:
    stmt = select(Item).where(Item.user_sub == user_sub, Item.caldav_uid == uid)
    return session.execute(stmt).scalars().first()


def body_and_etag(item: Item, zone: ZoneInfo) -> tuple[str, str]:
    body = serialize(item, local_zone=zone)
    return body, etag_for(body)


def ctag(items: list[Item], zone: ZoneInfo) -> str:
    """集合变更标记：成员按 stem 排序后对 (stem, etag) 取哈希。增删改任一都会变，纯读不变。

    O(n) 序列化在百级条目下是毫秒级；上千条时再考虑把 etag 落列。
    """
    rows = sorted((stem_of(i), body_and_etag(i, zone)[1]) for i in items)
    digest = hashlib.sha256("\n".join(f"{s}\t{e}" for s, e in rows).encode("utf-8"))
    return digest.hexdigest()[:32]


def apply_put(
    session: Session,
    user_sub: str,
    item: Item | None,
    stem: str,
    parsed: ParsedTodo,
    raw_body: str,
    *,
    now: datetime,
) -> tuple[Item, bool, list[str]]:
    """把客户端 PUT 的字段写进条目；返回 (条目, 是否新建, 被忽略的字段名)。

    唯一一条可编辑规则：邮件条目只接受状态；手动条目接受标题/摘要/截止日/重要度/状态。
    两者都更新 CalDAV 身份列与透传体。被忽略的字段不报错——客户端下一轮同步会看到
    服务端值恢复，这比 4xx 让那条提醒永远同步失败要好。
    """
    created = item is None
    if item is None:
        item = Item(
            user_sub=user_sub,
            email_id=None,
            category=DEFAULT_CATEGORY,
            importance="normal",
            actionable=True,
            status="open",
            title=parsed.title,
            summary=parsed.summary,
        )
        session.add(item)
    ignored: list[str] = []
    if item.email_id is None:
        item.title = parsed.title
        item.summary = parsed.summary
        item.due_date = parsed.due_date
        item.importance = parsed.importance
    else:
        ignored = [
            name
            for name, changed in (
                ("title", parsed.title != item.title),
                ("summary", parsed.summary != (item.summary or "")),
                ("due_date", parsed.due_date != item.due_date),
                ("importance", parsed.importance != item.importance),
            )
            if changed
        ]
    if parsed.done:
        # 已完成条目再次 PUT 且客户端没给 COMPLETED：保留原完成时刻，不要每轮同步都刷新
        keep = item.done_at if (item.status == "done" and parsed.done_at is None) else parsed.done_at
        set_status(item, "done", now=now, done_at=keep)
    else:
        set_status(item, "open", now=now)
    item.caldav_uid = parsed.uid or stem
    item.caldav_name = stem if stem != item.caldav_uid else None
    item.caldav_ics = raw_body
    session.flush()
    return item, created, ignored


def apply_delete(session: Session, item: Item, *, now: datetime) -> None:
    """手动条目真删；邮件条目按产品决策视为「完成」（iPhone 上划掉 = 做完了）。"""
    if item.email_id is None:
        session.delete(item)
    else:
        set_status(item, "done", now=now)
    session.flush()
