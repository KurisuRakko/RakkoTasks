"""CalDAV VTODO 解析与序列化纯函数：iPhone 提醒事项载荷 ↔ 服务端条目字段。

本模块不碰 DB、不 import fastapi——输入是文本/组件树与 ORM 条目的属性值，
输出是文本，全部可离线单测。下一任务的 PUT/GET 处理器直接复用这里：
- read_fields：把客户端 PUT 的 VTODO 翻译成服务端字段（标题/摘要/DUE/状态）；
- serialize：把库内条目写成客户端可读的 VTODO，并在有客户端原文（caldav_ics）
  时做「透传」——只覆盖服务端拥有的属性，VALARM / X-APPLE-* / 时间簇等原样保留。
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

from app.calendar import content_line, escape_text
from app.itemrules import normalize_summary, normalize_title
from app.models import Item


class VTodoError(Exception):
    """载荷不是可接受的 VTODO 日历数据；code 与 CalDAV 错误响应码一致。"""

    def __init__(self, code: str = "valid-calendar-data"):
        super().__init__(code)
        self.code = code


@dataclass
class Line:
    """一条内容行（已解折的逻辑行）：名字大写，params 为参数表，raw 保留原始折行。

    raw = 该逻辑行对应的全部原始物理行以 CRLF 连接（续行前缀保留）——
    透传重发时逐行原样输出，不改写客户端的折行。
    """

    name: str
    params: dict[str, str]
    value: str
    raw: str


@dataclass
class Component:
    """组件（BEGIN/END 包裹）：属性行 lines 与子组件 children 分开存放。"""

    name: str
    lines: list[Line]
    children: list["Component"]


def _unfold_pairs(text: str) -> list[tuple[str, list[str]]]:
    """切 (逻辑行, 原始物理行列表)：CRLF/LF 都吃；续行前缀为空格或制表符。

    续行并入上一逻辑行时去掉单个前缀空白；物理行原样留档（透传重发用）。
    空行忽略（合法 iCalendar 不允许空行，容忍之）。
    """
    pairs: list[tuple[str, list[str]]] = []
    for phys in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if not phys:
            continue
        if phys[0] in " \t" and pairs:
            logical, physical = pairs[-1]
            pairs[-1] = (logical + phys[1:], physical + [phys])
        else:
            pairs.append((phys, [phys]))
    return pairs


def unfold(text: str) -> list[str]:
    """解折文本为逻辑行列表（续行已并入；raw 细节由 parse_calendar 使用）。"""
    return [logical for logical, _physical in _unfold_pairs(text)]


def _add_param(chunk: str, params: dict[str, str]) -> None:
    """解析一个 KEY[=VAL] 参数段；带引号的值去引号（引号内可含冒号/分号）。"""
    chunk = chunk.strip(";")
    if not chunk:
        return
    key, sep, val = chunk.partition("=")
    key = key.strip().upper()
    if not key:
        return
    if not sep:
        params[key] = ""
    else:
        val = val.strip()
        if len(val) >= 2 and val.startswith('"') and val.endswith('"'):
            val = val[1:-1]
        params[key] = val


def split_line(line: str) -> Line:
    """拆一条逻辑行：名字大写；值从首个未被引号包裹的冒号处切分。"""
    length = len(line)
    pos = 0
    while pos < length and line[pos] not in ";:":
        pos += 1
    name = line[:pos].upper()
    params: dict[str, str] = {}
    in_quotes = False
    seg_start = pos
    colon_at = -1
    i = pos
    while i < length:
        ch = line[i]
        if ch == '"':
            in_quotes = not in_quotes
        elif ch == ";" and not in_quotes:
            _add_param(line[seg_start:i], params)
            seg_start = i + 1
        elif ch == ":" and not in_quotes:
            colon_at = i
            break
        i += 1
    if colon_at == -1:
        value = ""
    else:
        _add_param(line[seg_start:colon_at], params)
        value = line[colon_at + 1:]
    return Line(name=name, params=params, value=value, raw="")


def parse_calendar(text: str) -> Component:
    """解析日历文本（CRLF/LF 均可）为组件树；BEGIN/END 不配对 → VTodoError。"""
    root: Component | None = None
    stack: list[Component] = []
    for logical, physical in _unfold_pairs(text):
        line = split_line(logical)
        line.raw = "\r\n".join(physical)
        if line.name == "BEGIN":
            comp = Component(name=line.value.upper(), lines=[], children=[])
            if stack:
                stack[-1].children.append(comp)
            elif root is None:
                root = comp
            else:
                raise VTodoError("valid-calendar-data")
            stack.append(comp)
        elif line.name == "END":
            if not stack or stack[-1].name != line.value.upper():
                raise VTodoError("valid-calendar-data")
            stack.pop()
        else:
            if not stack:
                raise VTodoError("valid-calendar-data")
            stack[-1].lines.append(line)
    if root is None or stack:
        raise VTodoError("valid-calendar-data")
    return root


def master_vtodo(cal: Component) -> Component:
    """主 VTODO：自身（若为 VTODO）或顶层子组件中首个不带 RECURRENCE-ID 的
    VTODO；没有 → VTodoError。带 RECURRENCE-ID 的是重复实例，不是主体。"""
    if cal.name == "VTODO":
        pool = [cal, *cal.children]
    else:
        pool = list(cal.children)
    for comp in pool:
        if comp.name != "VTODO":
            continue
        if any(ln.name == "RECURRENCE-ID" for ln in comp.lines):
            continue
        return comp
    raise VTodoError("valid-calendar-data")


def unescape_text(v: str) -> str:
    """RFC 5545 TEXT 值逆转义：\\n \\N → 换行，\\, \\; \\\\ → 字面字符。

    回车先归一化（\\r\\n/\\r → \\n），避免值里出现双重换行；其余 \\x 原样保留。
    """
    v = v.replace("\r\n", "\n").replace("\r", "\n")
    out: list[str] = []
    i = 0
    n = len(v)
    while i < n:
        ch = v[i]
        if ch == "\\" and i + 1 < n:
            nxt = v[i + 1]
            if nxt in ("n", "N"):
                out.append("\n")
                i += 2
                continue
            if nxt in (",", ";", "\\"):
                out.append(nxt)
                i += 2
                continue
        out.append(ch)
        i += 1
    return "".join(out)


def _parse_utc_z(v: str) -> datetime:
    """解析 "YYYYMMDDTHHMM[SS]Z" → naive UTC datetime（不带 tzinfo，按 UTC 解释）；非法抛 VTodoError。"""
    for fmt in ("%Y%m%dT%H%M%SZ", "%Y%m%dT%H%MZ"):
        try:
            return datetime.strptime(v.strip(), fmt)
        except ValueError:
            continue
    raise VTodoError("valid-calendar-data")


def _due_from_value(value: str, params: dict[str, str], *, zone_for_z: ZoneInfo) -> date:
    """把 DUE 值解析成日期（read_fields 与 serialize 共用同一套规则）：

    - VALUE=DATE（或裸 8 位数字）：字面日期；
    - DATE-TIME 无 Z（浮动时间或带 TZID）：取字面日期（客户端给的是其本地时间）；
    - 以 Z 结尾：UTC 时刻，经 local_zone 转成本地日取日期——读载荷与透传
      比较必须用同一个时区，否则同一 Z 时刻会算出两个日期，导致客户端设的
      时刻/依赖 DTSTART 的闹钟被误删；
    - 其余形态 → VTodoError。
    """
    v = value.strip()
    is_date = params.get("VALUE", "").upper() == "DATE" or (len(v) == 8 and v.isdigit())
    if is_date:
        try:
            return datetime.strptime(v, "%Y%m%d").date()
        except ValueError:
            raise VTodoError("valid-calendar-data") from None
    if v.endswith("Z"):
        utc = _parse_utc_z(v)
        return utc.replace(tzinfo=timezone.utc).astimezone(zone_for_z).date()
    for fmt in ("%Y%m%dT%H%M%S", "%Y%m%dT%H%M"):
        try:
            return datetime.strptime(v, fmt).date()
        except ValueError:
            continue
    raise VTodoError("valid-calendar-data")


def _priority_to_importance(raw: str | None) -> str:
    """PRIORITY → importance：1–4 high；6–9 low；0/5/缺失/非法 → normal。"""
    if raw is None:
        return "normal"
    try:
        p = int(raw.strip())
    except ValueError:
        return "normal"
    if 1 <= p <= 4:
        return "high"
    if 6 <= p <= 9:
        return "low"
    return "normal"


@dataclass
class ParsedTodo:
    """客户端 VTODO 里服务端认的字段（CATEGORIES 等其余全部忽略）。"""

    uid: str | None
    title: str
    summary: str
    due_date: date | None
    done: bool
    done_at: datetime | None
    importance: str


def read_fields(vtodo: Component, *, local_zone: ZoneInfo) -> ParsedTodo:
    """读主 VTODO 的服务端字段。CATEGORIES 忽略：服务端分类来自 REST 侧，不被客户端覆盖。

    - SUMMARY → normalize_title；DESCRIPTION → normalize_summary；
    - DUE 按 _due_from_value 规则（Z 形态经 local_zone 反算本地日）；
    - done：STATUS ∈ {COMPLETED, CANCELLED} 或 PERCENT-COMPLETE == 100 或
      存在 COMPLETED 属性；done_at = COMPLETED 值（naive UTC）或 None；
    - PRIORITY 分档见 _priority_to_importance。
    """
    uid: str | None = None
    summary_raw: str | None = None
    description_raw: str | None = None
    due_value: str | None = None
    due_params: dict[str, str] = {}
    status: str | None = None
    percent_raw: str | None = None
    completed_raw: str | None = None
    priority_raw: str | None = None
    for ln in vtodo.lines:
        if ln.name == "UID" and uid is None:
            uid = unescape_text(ln.value).strip() or None
        elif ln.name == "SUMMARY" and summary_raw is None:
            summary_raw = ln.value
        elif ln.name == "DESCRIPTION" and description_raw is None:
            description_raw = ln.value
        elif ln.name == "DUE" and due_value is None:
            due_value = ln.value
            due_params = ln.params
        elif ln.name == "STATUS" and status is None:
            status = ln.value.strip().upper()
        elif ln.name == "PERCENT-COMPLETE" and percent_raw is None:
            percent_raw = ln.value
        elif ln.name == "COMPLETED" and completed_raw is None:
            completed_raw = ln.value
        elif ln.name == "PRIORITY" and priority_raw is None:
            priority_raw = ln.value
    title = normalize_title(unescape_text(summary_raw) if summary_raw is not None else None)
    summary = normalize_summary(unescape_text(description_raw) if description_raw is not None else None)
    due_date = (
        _due_from_value(due_value, due_params, zone_for_z=local_zone) if due_value is not None else None
    )
    done_at: datetime | None = None
    if completed_raw is not None:
        try:
            done_at = _parse_utc_z(completed_raw)
        except VTodoError:
            done_at = None  # 有 COMPLETED 但值畸形：done 仍成立，只是没有完成时刻
    percent: int | None = None
    if percent_raw is not None:
        try:
            percent = int(percent_raw.strip())
        except ValueError:
            percent = None
    done = status in ("COMPLETED", "CANCELLED") or percent == 100 or completed_raw is not None
    return ParsedTodo(
        uid=uid,
        title=title,
        summary=summary,
        due_date=due_date,
        done=done,
        done_at=done_at,
        importance=_priority_to_importance(priority_raw),
    )


# ── 序列化 ──────────────────────────────────────────────────────────

# 服务端「拥有」的属性：透传时逐个替换/删除；其余属性行一律原样保留
_OWNED_NAMES = (
    "UID",
    "DTSTAMP",
    "CREATED",
    "LAST-MODIFIED",
    "SUMMARY",
    "DESCRIPTION",
    "STATUS",
    "PERCENT-COMPLETE",
    "COMPLETED",
    "PRIORITY",
    "CATEGORIES",
)

# 时间簇：透传体的日期/重复规则行；DUE 与库内 due_date 不同日时整体删除重写
_CLUSTER_NAMES = frozenset({"DTSTART", "DUE", "DURATION", "RRULE", "RDATE", "EXDATE"})


def _fmt_z(dt: datetime) -> str:
    """naive datetime 按 UTC 解释 → "YYYYMMDDTHHMMSSZ"（库内值恒为 UTC，直接加 Z）。"""
    return dt.strftime("%Y%m%dT%H%M%SZ")


def _stamp(item: Item) -> datetime:
    """ETag 源时间戳：updated_at（ORM 每次变更自动刷新）→ created_at。"""
    stamp = item.updated_at or item.created_at
    if stamp is None:
        raise ValueError("条目未落库：created_at/updated_at 为空，无法生成 DTSTAMP/CREATED")
    return stamp


def _folded_line(name: str, value: str) -> Line:
    """由名称+值生成已折行内容行（content_line 折叠，≤75 字节/物理行）。"""
    physical = content_line(name, value)
    return Line(name=name, params={}, value=value, raw="\r\n".join(physical))


def _serialize_fresh(item: Item) -> str:
    """无透传体：固定顺序输出完整 VCALENDAR（CRLF，末尾换行）。

    DTSTAMP/LAST-MODIFIED 取 updated_at（无则 created_at）；库里 naive
    datetime 一律按 UTC 解释直接加 Z。这里不允许出现 datetime.now()——
    理由见 serialize docstring。
    """
    stamp = _stamp(item)
    lines: list[str] = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//RakkoTasks//CN",
        "CALSCALE:GREGORIAN",
        "BEGIN:VTODO",
    ]
    lines.extend(content_line("UID", item.caldav_uid or ""))
    lines.extend(content_line("DTSTAMP", _fmt_z(stamp)))
    lines.extend(content_line("CREATED", _fmt_z(item.created_at or stamp)))
    lines.extend(content_line("LAST-MODIFIED", _fmt_z(stamp)))
    lines.extend(content_line("SUMMARY", escape_text(item.title)))
    if item.summary:
        lines.extend(content_line("DESCRIPTION", escape_text(item.summary)))
    if item.due_date is not None:
        lines.extend(content_line("DUE;VALUE=DATE", item.due_date.strftime("%Y%m%d")))
    lines.append("STATUS:COMPLETED" if item.status == "done" else "STATUS:NEEDS-ACTION")
    if item.status == "done":
        lines.append("PERCENT-COMPLETE:100")
        if item.done_at is not None:
            lines.extend(content_line("COMPLETED", _fmt_z(item.done_at)))
    if item.importance == "high":
        lines.extend(content_line("PRIORITY", "1"))
    elif item.importance == "low":
        lines.extend(content_line("PRIORITY", "9"))
    lines.extend(content_line("CATEGORIES", escape_text(item.category)))
    lines.append("END:VTODO")
    lines.append("END:VCALENDAR")
    return "\r\n".join(lines) + "\r\n"


def _apply_owned(vtodo: Component, item: Item) -> None:
    """用服务端值原位替换主 VTODO 的「拥有属性」行（存在则替换首个、删多余，
    不存在则插到 END:VTODO 之前）；服务端不输出的（normal 的 PRIORITY、空
    DESCRIPTION、open 的 COMPLETED/PERCENT-COMPLETE）则删除同名行。"""
    stamp = _stamp(item)
    wanted: dict[str, Line] = {}

    def put(name: str, value: str) -> None:
        wanted[name] = _folded_line(name, value)

    put("UID", item.caldav_uid or "")
    put("DTSTAMP", _fmt_z(stamp))
    put("CREATED", _fmt_z(item.created_at or stamp))
    put("LAST-MODIFIED", _fmt_z(stamp))
    put("SUMMARY", escape_text(item.title))
    if item.summary:
        put("DESCRIPTION", escape_text(item.summary))
    put("STATUS", "COMPLETED" if item.status == "done" else "NEEDS-ACTION")
    if item.status == "done":
        put("PERCENT-COMPLETE", "100")
        if item.done_at is not None:
            put("COMPLETED", _fmt_z(item.done_at))
    if item.importance == "high":
        put("PRIORITY", "1")
    elif item.importance == "low":
        put("PRIORITY", "9")
    put("CATEGORIES", escape_text(item.category))

    for name in _OWNED_NAMES:
        wanted_line = wanted.get(name)
        replaced = False
        out: list[Line] = []
        for ln in vtodo.lines:
            if ln.name != name:
                out.append(ln)
                continue
            if wanted_line is not None and not replaced:
                out.append(wanted_line)  # 原位替换首个
                replaced = True
            # 其余同名行（客户端重复输出）删除
        if wanted_line is not None and not replaced:
            out.append(wanted_line)  # 客户端没写 → 插在 END:VTODO 之前
        vtodo.lines = out


def _payload_due(vtodo: Component, local_zone: ZoneInfo) -> date | None:
    """透传体主 VTODO 的 DUE 日期（首个 DUE 行，按与 read_fields 相同的规则
    用 local_zone 反算本地日）；没有 → None。比较两侧时区必须一致，否则 Z
    形态的 DUE 会算出与落库 due_date 不同的日期，整簇被误删重写。

    畸形 DUE 返回 None 并走整体重写分支（把客户端坏行删掉换成服务端日期）。
    """
    for ln in vtodo.lines:
        if ln.name == "DUE":
            try:
                return _due_from_value(ln.value, ln.params, zone_for_z=local_zone)
            except VTodoError:
                return None
    return None


def _apply_time_cluster(cal: Component, vtodo: Component, item: Item, local_zone: ZoneInfo) -> None:
    """时间簇规则：透传体 DUE 解析出的日期（local_zone 反算）== item.due_date →
    簇原样保留；否则删除簇（主 VTODO 的 DTSTART/DUE/DURATION/RRULE/RDATE/
    EXDATE 行 + 顶层与主 VTODO 同级的带 RECURRENCE-ID 的重复实例组件），按
    item.due_date 只写 DUE;VALUE=DATE（due_date 为 None 则不写）。"""
    if _payload_due(vtodo, local_zone) == item.due_date:
        return
    vtodo.lines = [ln for ln in vtodo.lines if ln.name not in _CLUSTER_NAMES]
    if cal.name == "VCALENDAR":
        cal.children = [
            child
            for child in cal.children
            if not (child.name == "VTODO" and any(ln.name == "RECURRENCE-ID" for ln in child.lines))
        ]
    if item.due_date is not None:
        vtodo.lines.append(_folded_line("DUE;VALUE=DATE", item.due_date.strftime("%Y%m%d")))


def _render(comp: Component) -> str:
    """组件树 → 文本（CRLF，末尾换行）：BEGIN/END 由组件名生成，行原样输出。"""
    out: list[str] = []

    def walk(c: Component) -> None:
        out.append(f"BEGIN:{c.name}")
        for ln in c.lines:
            out.append(ln.raw)  # raw 自带原始折行（含 CRLF），不重新折叠
        for child in c.children:
            walk(child)
        out.append(f"END:{c.name}")

    walk(comp)
    return "\r\n".join(out) + "\r\n"


def serialize(item: Item, *, local_zone: ZoneInfo) -> str:
    """把条目序列化成 VCALENDAR 文本（CRLF，末尾换行）。

    local_zone 必填：时间簇比较要把透传体 Z 形态的 DUE 反算成本地日，与
    read_fields 落库用的是同一时区（配置项 Settings.local_timezone），否则
    同一 Z 时刻会算出两个日期，导致客户端设的时刻与闹钟在每轮同步被误删。

    无透传体（caldav_ics 为空）：固定结构输出（见 _serialize_fresh）。
    有透传体：解析客户端最近一次 PUT 的原文，主 VTODO 的「拥有属性」逐个
    覆盖（见 _apply_owned），其余行（VALARM、X-APPLE-*、LOCATION、URL、
    VTIMEZONE 等）用原始 raw 行原样输出、保留客户端折行，VCALENDAR 层的
    VERSION/PRODID/CALSCALE 也保留客户端的；时间簇见 _apply_time_cluster。

    硬约束：本函数任何位置不许出现 datetime.now()——DTSTAMP 一变内容 ETag
    就变，客户端会误以为有更新而无限重下。DTSTAMP/LAST-MODIFIED 只派生自
    库内时间戳：条目不变 → 字节不变 → ETag 不变。
    """
    if not item.caldav_ics:
        return _serialize_fresh(item)
    cal = parse_calendar(item.caldav_ics)
    vtodo = master_vtodo(cal)
    _apply_owned(vtodo, item)
    _apply_time_cluster(cal, vtodo, item, local_zone)
    return _render(cal)


def etag_for(body: str) -> str:
    """内容 ETag：'"' + sha256(body) 前 32 位 hex + '"'。字节相同 → ETag 相同。"""
    return '"' + hashlib.sha256(body.encode("utf-8")).hexdigest()[:32] + '"'
