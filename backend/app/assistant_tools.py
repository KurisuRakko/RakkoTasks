"""AI 助理的待办工具：list_items / create_item / set_item_done / update_item。

写操作直接调 items_service 的同一套校验与写入编排（与 REST 严格同源），按
user_sub 隔离；**没有删除工具**——删除是不可逆操作，留在待办页由用户手动做。

工具失败一律返回 {"ok": False, "error": "<code>"} 而不是抛异常：模型看到 error
才能修正参数重试，回执也才与用户看到的事实一致。只有 ItemFieldError 被转成
错误结果，其它异常照常冒泡（真 bug 不允许被吞）。
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from app.itemrules import CATEGORIES, DEFAULT_REMIND_HOUR, ItemFieldError
from app.items_service import apply_item_patch, create_manual_item, item_dict, owned_item, query_items
from app.models import Item
from app.promptguard import strip_sentinels

# 每轮对话允许落地的写操作条数。有上限是为了挡住被注入的模型在一轮里批量改库，
# 也让用户一次看到的回执卡不至于刷屏；超限后模型会被告知请用户分批再说。
MAX_WRITES_PER_TURN = 10
LIST_LIMIT_DEFAULT = 20
LIST_LIMIT_MAX = 50
# 摘要只回前若干字：模型多数时候只需要判断「这条是不是用户在说的那件事」
SUMMARY_PREVIEW_CHARS = 200

# 回执里 updated 的字段顺序：与前端回执卡的展示顺序一致，取子集时按此顺序输出
_ACTION_FIELD_ORDER = ("title", "category", "due_date", "reminders")

# 用户本地墙上时刻：日期，或日期 + 时刻（分隔符容忍空格与 T）
_WALL_TIME = re.compile(r"^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})?$")


ITEM_TOOLS: list[dict] = [
    {"type": "function", "function": {
        "name": "list_items",
        "description": "列出用户自己的待办（有截止日期的按日期升序在前）。完成、重新打开或修改已有待办前，先用它确认 id。",
        "parameters": {"type": "object", "properties": {
            "status": {"type": "string", "enum": ["open", "done", "all"], "description": "open=未完成（默认），done=已完成，all=全部"},
            "category": {"type": "string", "enum": CATEGORIES, "description": "只看某个分类"},
            "keyword": {"type": "string", "description": "标题或摘要包含的关键词"},
            "limit": {"type": "integer", "description": "最多返回条数，默认 20，不超过 50"}},
            "required": []}}},
    {"type": "function", "function": {
        "name": "create_item",
        "description": "新建一条待办。只有用户本人在对话中明确要求时才调用。",
        "parameters": {"type": "object", "properties": {
            "title": {"type": "string", "description": "待办标题：简短的动作描述，不超过 128 字"},
            "category": {"type": "string", "enum": CATEGORIES, "description": "分类，不传则为 其他"},
            "due_date": {"type": "string", "description": "截止日期 YYYY-MM-DD；没有截止日期就不传"},
            "reminders": {"type": "array", "items": {"type": "string"}, "description": "提醒时刻，用户本地时间 YYYY-MM-DD HH:MM；只给日期时按当天 10:00；最多 5 个"}},
            "required": ["title"]}}},
    {"type": "function", "function": {
        "name": "set_item_done",
        "description": "把一条待办标记为已完成（done=true）或重新打开（done=false）。只有用户本人在对话中明确要求时才调用。",
        "parameters": {"type": "object", "properties": {
            "id": {"type": "integer", "description": "待办 id（来自 list_items）"},
            "done": {"type": "boolean", "description": "true=完成，false=重新打开"}},
            "required": ["id", "done"]}}},
    {"type": "function", "function": {
        "name": "update_item",
        "description": "修改一条待办的标题、分类、截止日期或提醒，只传要改的字段。只有用户本人在对话中明确要求时才调用。",
        "parameters": {"type": "object", "properties": {
            "id": {"type": "integer", "description": "待办 id（来自 list_items）"},
            "title": {"type": "string", "description": "新标题，不超过 128 字"},
            "category": {"type": "string", "enum": CATEGORIES},
            "due_date": {"type": "string", "description": "新的截止日期 YYYY-MM-DD；传空字符串表示去掉截止日期"},
            "reminders": {"type": "array", "items": {"type": "string"}, "description": "整体替换提醒（用户本地时间 YYYY-MM-DD HH:MM，最多 5 个）；传空数组表示清空提醒"}},
            "required": ["id"]}}},
]

_TOOL_NAMES = frozenset(tool["function"]["name"] for tool in ITEM_TOOLS)


def _wall_times_to_iso(values: object, zone: ZoneInfo) -> list[str]:
    """用户本地墙上时刻列表 → 带偏移的 ISO 8601 串列表（交给 validate_reminders 收口）。

    与 itemrules.local_wall_to_utc 刻意不同：这里非法项**报错而不是静默丢弃**。
    这是交互场景——报错才能让模型看到 bad_reminders 后自纠，回执里的提醒条数也才
    与用户说的话对得上；local_wall_to_utc 用在无人交互的解析兜底路径上，那里宁可
    少一个提醒也不要让整次解析失败。

    条数上限、去重、转 UTC 一律交给服务层的 validate_reminders（超 5 个 →
    too_many_reminders），这里只负责补偏移。
    """
    if not isinstance(values, list):
        raise ItemFieldError("bad_reminders")
    out: list[str] = []
    for value in values:
        if not isinstance(value, str):
            raise ItemFieldError("bad_reminders")
        text = value.strip()
        if not _WALL_TIME.fullmatch(text):
            raise ItemFieldError("bad_reminders")
        try:
            naive = datetime.fromisoformat(text)
        except ValueError:  # 形状对但值非法（如 2026-13-45）
            raise ItemFieldError("bad_reminders") from None
        if len(text) <= 10:  # 只给了日期 → 补默认时刻
            naive = naive.replace(hour=DEFAULT_REMIND_HOUR, minute=0)
        out.append(naive.replace(tzinfo=zone).isoformat())
    return out


class ItemTools:
    """一轮对话内的待办工具执行器：持有 db/session 与归属，累积写操作回执。"""

    def __init__(self, db: Session, user_sub: str, zone: ZoneInfo):
        self._db = db
        self._user_sub = user_sub
        self._zone = zone
        self.actions: list[dict] = []

    def handles(self, name: str) -> bool:
        """是否是本执行器负责的工具名（其余交给邮件工具 dispatch）。"""
        return name in _TOOL_NAMES

    def run(self, name: str, args: dict[str, Any]) -> dict:
        """执行一个待办工具；参数非法或操作失败都返回 {"ok": False, "error": code}。"""
        if not isinstance(args, dict):  # 模型可能吐出数组或裸串当 arguments
            return {"ok": False, "error": "bad_request"}
        try:
            if name == "list_items":
                return self._list_items(args)
            if name == "create_item":
                return self._create_item(args)
            if name == "set_item_done":
                return self._set_item_done(args)
            if name == "update_item":
                return self._update_item(args)
        except ItemFieldError as e:
            return {"ok": False, "error": e.code}
        return {"ok": False, "error": f"未知工具 {name}"}

    def _list_items(self, args: dict[str, Any]) -> dict:
        status = args.get("status", "open")
        if status == "all":
            status = None  # None = 不限状态
        elif status not in ("open", "done"):
            raise ItemFieldError("bad_status")
        category = args.get("category")
        if category is not None and category not in CATEGORIES:
            raise ItemFieldError("bad_category")
        keyword = args.get("keyword")
        keyword = keyword.strip() if isinstance(keyword, str) else None
        limit = args.get("limit")
        if not isinstance(limit, int) or isinstance(limit, bool):
            limit = LIST_LIMIT_DEFAULT
        else:
            limit = min(max(limit, 1), LIST_LIMIT_MAX)
        items = query_items(
            self._db, self._user_sub, status=status, category=category, keyword=keyword or None, limit=limit
        )
        return {"ok": True, "items": [self._view(item) for item in items]}

    def _create_item(self, args: dict[str, Any]) -> dict:
        if len(self.actions) >= MAX_WRITES_PER_TURN:
            return {"ok": False, "error": "write_limit"}
        title = args.get("title")
        if not isinstance(title, str):
            raise ItemFieldError("bad_title")
        category = args.get("category")
        if category is None:
            category = "其他"
        elif not isinstance(category, str):
            raise ItemFieldError("bad_category")
        due_date = args.get("due_date")
        if due_date is None or due_date == "":
            due_date = None
        elif not isinstance(due_date, str):
            raise ItemFieldError("bad_due_date")
        reminders = args.get("reminders")
        item = create_manual_item(
            self._db, self._user_sub,
            title=title,
            summary="",
            category=category,
            due_date=due_date,
            importance=None,
            actionable=None,
            reminders=None if reminders is None else _wall_times_to_iso(reminders, self._zone),
        )
        self._db.commit()
        self._record("created", item)
        return {"ok": True, "item": self._view(item)}

    def _set_item_done(self, args: dict[str, Any]) -> dict:
        if len(self.actions) >= MAX_WRITES_PER_TURN:
            return {"ok": False, "error": "write_limit"}
        item = self._owned(args)
        done = args.get("done")
        if not isinstance(done, bool):
            raise ItemFieldError("bad_done")
        # now 口径与 REST 的 PATCH 相同：done_at 是服务端本地时间
        apply_item_patch(item, {"status": "done" if done else "open"}, now=datetime.now())
        self._db.commit()
        self._record("completed" if done else "reopened", item)
        return {"ok": True, "item": self._view(item)}

    def _update_item(self, args: dict[str, Any]) -> dict:
        if len(self.actions) >= MAX_WRITES_PER_TURN:
            return {"ok": False, "error": "write_limit"}
        item = self._owned(args)
        changes: dict[str, Any] = {}
        if "title" in args:
            if not isinstance(args["title"], str):
                raise ItemFieldError("bad_title")
            changes["title"] = args["title"]
        if "category" in args:
            if not isinstance(args["category"], str):
                raise ItemFieldError("bad_category")
            changes["category"] = args["category"]
        if "due_date" in args:
            due_date = args["due_date"]
            if not isinstance(due_date, str):
                raise ItemFieldError("bad_due_date")
            changes["due_date"] = due_date or None  # "" = 去掉截止日期
        if "reminders" in args:
            changes["reminders"] = _wall_times_to_iso(args["reminders"], self._zone)
        if not changes:
            raise ItemFieldError("bad_request")
        apply_item_patch(item, changes, now=datetime.now())
        self._db.commit()
        self._record("updated", item, fields=[name for name in _ACTION_FIELD_ORDER if name in changes])
        return {"ok": True, "item": self._view(item)}

    def _owned(self, args: dict[str, Any]) -> Item:
        """按 id 取属于当前用户的条目；越权与不存在同样回 not_found（不泄露 id 是否存在）。"""
        item_id = args.get("id")
        if not isinstance(item_id, int) or isinstance(item_id, bool):
            raise ItemFieldError("bad_id")
        item = owned_item(self._db, item_id, self._user_sub)
        if item is None:
            raise ItemFieldError("not_found")
        return item

    def _record(self, kind: str, item: Item, *, fields: list[str] | None = None) -> None:
        """记一条写操作回执；必须在 commit 之后调用，快照才带最终 id 与 updated_at。"""
        self.actions.append({"kind": kind, "item": item_dict(item, []), "fields": fields or []})

    def _view(self, item: Item) -> dict:
        """给模型看的精简视图（不是 REST 的 item_dict）。

        待办标题/摘要多由 LLM 从不可信邮件生成，与邮件 subject 同样剥掉伪造哨兵：
        否则攻击者能在邮件正文里埋哨兵，借待办内容回显再次闭合数据块。
        """
        email = item.email
        return {
            "id": item.id,
            "title": strip_sentinels(item.title),
            "summary": strip_sentinels(item.summary or "")[:SUMMARY_PREVIEW_CHARS],
            "category": item.category,
            "due_date": item.due_date.isoformat() if item.due_date else None,
            "status": item.status,
            # 回给模型的是用户本地墙上时刻（与它给的入参同一口径），按时刻升序
            "reminders": [
                remind_at.replace(tzinfo=timezone.utc).astimezone(self._zone).strftime("%Y-%m-%d %H:%M")
                for remind_at in sorted(r.remind_at for r in item.reminders)
            ],
            "from_email": item.email_id is not None,
            "email_subject": strip_sentinels(email.subject) if email is not None else None,
        }
