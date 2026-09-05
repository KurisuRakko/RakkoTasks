"""REST 与 CalDAV 共用的条目规则：唯一来源，不依赖 fastapi。

手动条目的字段校验、标题/摘要归一化与状态切换逻辑原先散在 api.py
（_validate_item_fields）里；CalDAV 方向（vtodo 解析、下一任务的 PUT 处理）
需要同一套规则，抽到这里避免两处各写一份后行为漂移。这里抛/定义的错误
与异常全部与 HTTP 层解耦：HTTPException 的转换只发生在 api.py。
"""
from __future__ import annotations

from datetime import date, datetime

CATEGORIES: tuple[str, ...] = ("学业", "工作", "个人", "账单", "其他")
TITLE_MAX = 128
SUMMARY_MAX = 5000
DEFAULT_TITLE = "未命名任务"


class ItemFieldError(Exception):
    """条目字段非法；code 与 REST 错误码一致（bad_title/bad_summary/bad_category/bad_due_date）。"""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def validate_item_fields(title: str, summary: str, category: str, due_date: str | None) -> date | None:
    """手动条目字段校验（POST 与 PATCH 共用）：非法抛 ItemFieldError；返回解析后的 date 或 None。

    逻辑与 api.py 现 _validate_item_fields 完全一致，只是抛 ItemFieldError
    而非 HTTPException（HTTP 层由调用方捕获后转 400，错误码不变）。
    """
    title = title.strip()
    if not title or len(title) > TITLE_MAX:
        raise ItemFieldError("bad_title")
    if len(summary or "") > SUMMARY_MAX:
        raise ItemFieldError("bad_summary")
    if category not in CATEGORIES:
        raise ItemFieldError("bad_category")
    if due_date is None:
        return None
    try:
        parsed = date.fromisoformat(due_date)
    except ValueError:
        raise ItemFieldError("bad_due_date") from None
    if parsed.isoformat() != due_date:  # fromisoformat 容忍带时间/偏移的串，这里只收 YYYY-MM-DD
        raise ItemFieldError("bad_due_date")
    return parsed


def normalize_title(raw: str | None) -> str:
    """标题归一化：去首尾空白；空 → DEFAULT_TITLE；超长截到 TITLE_MAX。"""
    value = (raw or "").strip()
    if not value:
        return DEFAULT_TITLE
    return value[:TITLE_MAX]


def normalize_summary(raw: str | None) -> str:
    """摘要归一化：None → ""；去行尾空白；超长截到 SUMMARY_MAX。"""
    value = (raw or "").rstrip()
    return value[:SUMMARY_MAX]


def set_status(item, status: str, *, now: datetime, done_at: datetime | None = None) -> None:
    """切换条目状态（open|done）并同步 done_at；status 非法抛 ValueError。

    done → done_at = done_at or now；open → done_at 清空。REST 与 CalDAV
    落库共用，保证两侧对「完成时间」的语义一致。
    """
    if status not in ("open", "done"):
        raise ValueError(f"非法状态: {status}")
    if status == "done":
        item.status = "done"
        item.done_at = done_at or now
    else:
        item.status = "open"
        item.done_at = None
