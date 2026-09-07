"""REST 与 CalDAV 共用的条目规则：唯一来源，不依赖 fastapi。

手动条目的字段校验、标题/摘要归一化与状态切换逻辑原先散在 api.py
（_validate_item_fields）里；CalDAV 方向（vtodo 解析、下一任务的 PUT 处理）
需要同一套规则，抽到这里避免两处各写一份后行为漂移。这里抛/定义的错误
与异常全部与 HTTP 层解耦：HTTPException 的转换只发生在 api.py。
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

CATEGORIES: tuple[str, ...] = ("学业", "工作", "个人", "账单", "其他")
# 重要度白名单：与 models.Item.importance 默认值、llm._normalize_classify 的归一化同源
IMPORTANCES: tuple[str, ...] = ("high", "normal", "low")
TITLE_MAX = 128
SUMMARY_MAX = 5000
DEFAULT_TITLE = "未命名任务"
# 每个条目最多挂几个提醒。有上限是为了防滥用（每个提醒都会变成一条 VALARM 发给
# 客户端），5 个足够覆盖「周二提一次、周五提一次」这类真实用法。
REMINDERS_MAX = 5
# 用户只说「明天提醒我」没说几点时用的默认时刻（本地时间）。取 10 点与
# calendar.py 的 iCal 订阅源（TRIGGER;RELATED=START:PT10H）同口径，两条通道
# 对「没指定时刻」的解释保持一致。
DEFAULT_REMIND_HOUR = 10


class ItemFieldError(Exception):
    """条目字段非法；code 与 REST 错误码一致（bad_title/bad_summary/bad_category/
    bad_due_date/bad_importance/bad_reminders/too_many_reminders）。"""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def validate_item_fields(
    title: str,
    summary: str,
    category: str,
    due_date: str | None,
    importance: str | None = None,
) -> date | None:
    """手动条目字段校验（POST 与 PATCH 共用）：非法抛 ItemFieldError；返回解析后的 date 或 None。

    逻辑与 api.py 现 _validate_item_fields 完全一致，只是抛 ItemFieldError
    而非 HTTPException（HTTP 层由调用方捕获后转 400，错误码不变）。

    importance 为 None 表示调用方不打算改这个字段（不校验、不参与判定），
    与「传了个空串」区分开：后者是非法值，要报 bad_importance。
    """
    title = title.strip()
    if not title or len(title) > TITLE_MAX:
        raise ItemFieldError("bad_title")
    if len(summary or "") > SUMMARY_MAX:
        raise ItemFieldError("bad_summary")
    if category not in CATEGORIES:
        raise ItemFieldError("bad_category")
    if importance is not None and importance not in IMPORTANCES:
        raise ItemFieldError("bad_importance")
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


def validate_reminders(raw: object) -> list[datetime] | None:
    """REST 传来的提醒列表 → 升序去重的 naive UTC datetime 列表。

    入参是**带 UTC 偏移的 ISO 8601 字符串**列表（如 "2026-09-08T10:00:00+10:00"）。
    要求带偏移：不带偏移的时刻是歧义的（服务端不知道用户在哪个时区），宁可报错
    也不替他猜——浏览器手上永远有真实偏移，让它写进请求里。LLM 那条路输出的是
    本地墙上时刻、没有偏移，走 local_wall_to_utc，不走这里。

    raw 为 None 表示调用方不打算改这个字段（与传 [] 清空区分开），返回 None。
    过去的时刻允许通过：补记一条已经错过的提醒是合理操作，客户端自己会忽略。
    """
    if raw is None:
        return None
    if not isinstance(raw, list):
        raise ItemFieldError("bad_reminders")
    if len(raw) > REMINDERS_MAX:
        raise ItemFieldError("too_many_reminders")
    out: set[datetime] = set()
    for value in raw:
        if not isinstance(value, str):
            raise ItemFieldError("bad_reminders")
        try:
            parsed = datetime.fromisoformat(value)
        except ValueError:
            raise ItemFieldError("bad_reminders") from None
        if parsed.tzinfo is None:
            raise ItemFieldError("bad_reminders")  # 无偏移 = 歧义时刻，不接
        out.add(parsed.astimezone(timezone.utc).replace(tzinfo=None, microsecond=0))
    return sorted(out)


def local_wall_to_utc(values: object, zone: ZoneInfo) -> list[datetime]:
    """LLM 输出的本地墙上时刻 → 升序去重的 naive UTC datetime 列表。

    LLM 只知道「几月几号几点」，不知道偏移，所以它给的是墙上时刻
    （"2026-09-08T10:00"，也容忍 "2026-09-08" —— 补 DEFAULT_REMIND_HOUR 点）。
    偏移由调用方给的 zone 补上，zone 来自前端上报的 IANA 时区名、缺省时回落到
    Settings.local_timezone。

    与 validate_reminders 不同，这里**不抛异常**：模型输出不可信，非法项直接
    丢弃（口径与 llm.normalize_parsed_task 对 due_date 的处理一致——宁可少一个
    提醒也不要让整次解析失败）。超出 REMINDERS_MAX 的部分按时间升序截断。
    """
    if not isinstance(values, list):
        return []
    out: set[datetime] = set()
    for value in values:
        if not isinstance(value, str):
            continue
        text = value.strip()
        try:
            naive = datetime.fromisoformat(text)
        except ValueError:
            continue
        if naive.tzinfo is not None:
            continue  # 墙上时刻不该带偏移；带了说明模型没照格式走，丢弃
        if len(text) <= 10:  # 只给了日期 → 补默认时刻
            naive = naive.replace(hour=DEFAULT_REMIND_HOUR, minute=0)
        local = naive.replace(tzinfo=zone)
        out.add(local.astimezone(timezone.utc).replace(tzinfo=None, microsecond=0))
    return sorted(out)[:REMINDERS_MAX]
