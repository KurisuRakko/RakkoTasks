"""iCalendar（RFC 5545）订阅源生成：全天事件（due_date）+ 当天 10:00 提醒。纯函数，无 DB 依赖。

VALARM 用相对 TRIGGER（RELATED=START:PT10H）而不写绝对时间：全天事件的
START 由日历客户端按本地零点解释，服务端不应假设用户时区；绝对时间会把
提醒时刻绑死在服务端时区上，跨时区用户会收到错误时间的提醒。
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Iterable

from app.models import Item

# RFC 5545 折行上限：内容行不超过 75 字节（不含行终止符），续行以单空格开头
_MAX_LINE_BYTES = 75
_CONTINUATION_PREFIX = " "

# 日历头字段（契约固定，不改）
_CALENDAR_HEADER = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//RakkoTasks//CN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:RakkoTasks",
    "X-PUBLISHED-TTL:PT1H",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
]


def _escape_text(value: str) -> str:
    """RFC 5545 TEXT 值转义：反斜杠、分号、逗号、换行（回车先归一化掉）。"""
    return (
        value.replace("\r\n", "\n")
        .replace("\r", "\n")
        .replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\n", "\\n")
    )


def _fold(text: str) -> list[str]:
    """把一条内容行折成若干 ≤75 字节的段（按 UTF-8 字节数计）。

    折点只在字符边界上：逐字符累加其 UTF-8 字节数，绝不在多字节字符
    中间截断。首个段 ≤75 字节，其余段 ≤74 字节（加上续行前缀空格正好 75）。
    """
    segments: list[str] = []
    buf = ""
    buf_bytes = 0
    for ch in text:
        ch_bytes = len(ch.encode("utf-8"))
        limit = _MAX_LINE_BYTES if not segments else _MAX_LINE_BYTES - 1
        if buf and buf_bytes + ch_bytes > limit:
            segments.append(buf)
            buf = ch
            buf_bytes = ch_bytes
        else:
            buf += ch
            buf_bytes += ch_bytes
    if buf:
        segments.append(buf)
    return segments


def _property(name: str, value: str) -> list[str]:
    """组装一条属性并折行：返回物理行（续行已带前缀空格）。"""
    segments = _fold(f"{name}:{value}")
    out = [segments[0]]
    for seg in segments[1:]:
        out.append(_CONTINUATION_PREFIX + seg)
    return out


def build_ics(items: Iterable[Item], now: datetime) -> str:
    """生成 iCalendar 文本（CRLF 换行）。

    每个 item 一条全天 VEVENT（due_date 当天，DTEND 为次日），importance=high
    时 SUMMARY 加「[重要] 」前缀；summary 为空则不输出 DESCRIPTION 行。
    每条带 VALARM：ACTION:DISPLAY，当天 10:00（TRIGGER;RELATED=START:PT10H）提醒。
    调用方保证 items 已按 due_date 排序、只含 open 且有日期的条目。
    """
    lines: list[str] = []
    lines.extend(_CALENDAR_HEADER)
    stamp = now.strftime("%Y%m%dT%H%M%SZ")
    for item in items:
        d: date = item.due_date
        start = d.strftime("%Y%m%d")
        end = (d + timedelta(days=1)).strftime("%Y%m%d")
        summary = (f"[重要] {item.title}" if item.importance == "high" else item.title)
        escaped_summary = _escape_text(summary)
        lines.append("BEGIN:VEVENT")
        lines.extend(_property("UID", f"item-{item.id}@rakkotasks"))
        lines.extend(_property("DTSTAMP", stamp))
        lines.extend(_property("DTSTART;VALUE=DATE", start))
        lines.extend(_property("DTEND;VALUE=DATE", end))
        lines.extend(_property("SUMMARY", escaped_summary))
        if item.summary:
            lines.extend(_property("DESCRIPTION", _escape_text(item.summary)))
        lines.extend(_property("CATEGORIES", _escape_text(item.category)))
        lines.append("BEGIN:VALARM")
        lines.extend(_property("ACTION", "DISPLAY"))
        lines.extend(_property("DESCRIPTION", escaped_summary))
        lines.extend(_property("TRIGGER;RELATED=START", "PT10H"))
        lines.append("END:VALARM")
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    return "\r\n".join(lines) + "\r\n"
