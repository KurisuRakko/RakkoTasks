"""待办写入服务层：条目查询、创建与修改编排，REST 与 AI 工具共用。

原先 POST/PATCH 的写入编排内联在 create_app 闭包里，外部拿不到：AI 写工具若
自己重写一套校验与写入，两侧必然漂移（CalDAV 的 ETag/DTSTAMP 依赖 ORM 的
updated_at，漏经一次赋值就少一次 onupdate 刷新）。

服务函数一律**不 commit**，由调用方决定提交时机；校验失败抛 ItemFieldError，
HTTP 层的 400/错误码映射留在 api.py。
"""
from __future__ import annotations

from collections.abc import Mapping
from datetime import date, datetime, timezone
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.itemrules import ItemFieldError, set_status, validate_item_fields, validate_reminders
from app.models import Item, Reminder

# PATCH 里「条目内容字段」的集合：走「现值合并 + 整体校验」这条路径。
# reminders 不在这里——它的写入语义是整体替换 + 差集计算，单独处理。
_EDITABLE_FIELDS = {"title", "summary", "category", "due_date", "importance", "actionable"}


def owned_item(db: Session, item_id: int, user_sub: str) -> Item | None:
    """按归属直挂字段取属于该用户的条目；不属于返回 None（对外按 404 处理）。"""
    return db.execute(
        select(Item).where(Item.id == item_id, Item.user_sub == user_sub)
    ).scalars().first()


def item_dict(item: Item, related: list[dict]) -> dict:
    email = item.email
    return {
        "id": item.id,
        "email_id": item.email_id,
        # DB 存 naive UTC，显式补 +00:00 偏移，前端 new Date() 才不会按本地时区误读
        "email_sent_at": (
            email.sent_at.replace(tzinfo=timezone.utc).isoformat() if email and email.sent_at else None
        ),
        "email_subject": email.subject if email else None,
        "email_sender": email.sender if email else None,
        "title": item.title,
        "summary": item.summary,
        "category": item.category,
        "due_date": item.due_date.isoformat() if item.due_date else None,
        "importance": item.importance,
        "actionable": item.actionable,
        "status": item.status,
        "detail_md": item.detail_md,
        "related": related,
        "created_at": item.created_at.isoformat() if item.created_at else None,
        "done_at": item.done_at.isoformat() if item.done_at else None,
        # 显式按 remind_at 升序排序，不依赖关系上 order_by 的隐式行为；
        # 序列化与 email_sent_at 同款：库内 naive UTC 显式补 +00:00，前端
        # new Date() 才不会按本地时区误读
        "reminders": [
            {"id": r.id, "remind_at": r.remind_at.replace(tzinfo=timezone.utc).isoformat()}
            for r in sorted(item.reminders, key=lambda r: r.remind_at)
        ],
    }


def query_items(
    db: Session,
    user_sub: str,
    *,
    status: str | None,
    category: str | None = None,
    keyword: str | None = None,
    limit: int | None = None,
) -> list[Item]:
    """该用户的条目列表，按「有截止日期的在前、日期升序、新条目在前」排序。

    status 为 None 表示不限状态；category / keyword 为假值（None 与空串）
    表示不过滤；limit 为 None 表示不限条数。
    """
    stmt = select(Item).where(Item.user_sub == user_sub)
    if status is not None:
        stmt = stmt.where(Item.status == status)
    if category:
        stmt = stmt.where(Item.category == category)
    if keyword:
        stmt = stmt.where(
            or_(
                Item.title.contains(keyword, autoescape=True),
                Item.summary.contains(keyword, autoescape=True),
            )
        )
    stmt = stmt.order_by(Item.due_date.is_(None), Item.due_date.asc(), Item.created_at.desc())
    if limit is not None:
        stmt = stmt.limit(limit)
    return list(db.execute(stmt).scalars().all())


def create_manual_item(
    db: Session,
    user_sub: str,
    *,
    title: str,
    summary: str,
    category: str,
    due_date: str | None,
    importance: str | None,
    actionable: bool | None,
    reminders: list[str] | None,
) -> Item:
    """新建手动条目（无源邮件，email_id 为 null）：importance/actionable 省略时默认落
    normal / True，status=open。返回未 commit 的 item。

    校验先于任何 add：两个 validate 都通过后才构造对象，失败时 session 里不留半成品。
    """
    due = validate_item_fields(title, summary, category, due_date, importance)
    parsed_reminders = validate_reminders(reminders)  # None = 没传；list = 升序去重 naive UTC
    item = Item(
        user_sub=user_sub,
        email_id=None,
        title=title.strip(),
        summary=summary,
        category=category,
        due_date=due,
        importance=importance or "normal",
        actionable=True if actionable is None else actionable,
        status="open",
    )
    db.add(item)
    if parsed_reminders is not None:
        for dt in parsed_reminders:
            item.reminders.append(Reminder(remind_at=dt))  # 关系 append，ORM 自己填 item_id
    return item


def apply_item_patch(item: Item, changes: Mapping[str, Any], *, now: datetime) -> None:
    """把 PATCH 语义的 changes 应用到 item，语义与 PATCH /api/items/{id} 一致。

    与老实现唯一的差别是**先完成全部校验、再改写**：校验失败时条目保持原样，
    调用方不必 rollback 或担心半截修改被后续 flush 写出去。

    changes 的键与值类型与 ItemPatch 字段一致：due_date 是 YYYY-MM-DD 串，
    reminders 是带 UTC 偏移的 ISO 8601 串列表。
    """
    if not changes:
        raise ItemFieldError("bad_request")
    if "status" in changes and changes["status"] not in ("done", "open"):
        raise ItemFieldError("bad_status")
    new_reminders: list[datetime] | None = None
    if "reminders" in changes:
        # 整体替换（不是增量）：传 [] 清空全部；传 null 与 [] 同义，都清空
        # （list[str] | None 的 null 在这里没有第三种含义，统一成清空）。
        new_reminders = validate_reminders(changes["reminders"])
    # 邮件条目与手动条目在 PATCH 上同权（产品决策）：条目内容字段谁都能改，
    # 下面统一走「现值合并 + 整体校验」这一条路径。
    editable = set(changes) & _EDITABLE_FIELDS
    due: date | None = None
    if editable:
        # 未给出的字段用现值合并后整体校验一次（校验语义与 POST 一致）；
        # actionable 由 Pydantic 保证 bool 类型，不进 validate_item_fields
        title = changes["title"] if "title" in changes else item.title
        summary = changes["summary"] if "summary" in changes else item.summary
        category = changes["category"] if "category" in changes else item.category
        due_raw = (
            changes["due_date"]
            if "due_date" in changes
            else (item.due_date.isoformat() if item.due_date else None)
        )
        importance = changes["importance"] if "importance" in changes else item.importance
        due = validate_item_fields(title, summary, category, due_raw, importance)
    # 以下才开始改写：走到这里说明上面每一步都通过了
    if "status" in changes:
        set_status(item, changes["status"], now=now)
    if "reminders" in changes:
        # 实现上算差集而不是 clear()+重建：同一时刻的行若先删后插，会在同一次
        # flush 里先 INSERT 再 DELETE（unit-of-work 顺序），新行撞上还没删掉的
        # 旧行命中 UNIQUE(item_id, remind_at) → 500。差集只删多余、只加新增，
        # 交集行原样保留（id 稳定，也少写库）。
        wanted = set(new_reminders or [])
        existing = {r.remind_at: r for r in item.reminders}
        for at, row in existing.items():
            if at not in wanted:
                item.reminders.remove(row)  # delete-orphan 负责真删
        for at in sorted(wanted - existing.keys()):
            item.reminders.append(Reminder(remind_at=at))
    if editable:
        item.title = title.strip()
        item.summary = summary
        item.category = category
        item.due_date = due
        item.importance = importance
        if "actionable" in changes:
            # 只认键是否出现判断字段是否给出：actionable 是布尔，显式 false 是
            # 合法修改，写成真值判断会让「改成 false」静默失效
            item.actionable = bool(changes["actionable"])
