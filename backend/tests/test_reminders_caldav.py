"""提醒 → VALARM（DESIGN.md 11.12 双车道）测试：服务端车道生成/排序/ETag 稳定性、
替换不累加、绝对 TRIGGER 不受时间簇连坐、两条序列化路径逐字节一致、客户端车道
（不带标记的 VALARM）原样透传、read_fields 不读闹钟、长标题折行、caldav_uid 回退。

构造方式照 tests/test_vtodo.py：直接造 ORM 对象、不必落库；需要提醒时给
Item 挂 Reminder(remind_at=...) 实例列表。
"""
from datetime import date, datetime
from zoneinfo import ZoneInfo

from app.caldav.vtodo import REMINDER_MARKER, etag_for, parse_calendar, master_vtodo, read_fields, serialize, unfold
from app.models import Item, Reminder

SYDNEY = ZoneInfo("Australia/Sydney")

UID = "0123456789ABCDEF0123456789ABCDEF"

# 透传用的最小 VCALENDAR：无任何 VALARM，DUE 与 item.due_date 同日
MIN_ICS = (
    "BEGIN:VCALENDAR\r\n"
    "VERSION:2.0\r\n"
    "PRODID:-//Apple Inc.//iOS 17.5//EN\r\n"
    "BEGIN:VTODO\r\n"
    "UID:client-1\r\n"
    "DTSTAMP:20260909T010203Z\r\n"
    "SUMMARY:x\r\n"
    "DUE;VALUE=DATE:20260910\r\n"
    "STATUS:NEEDS-ACTION\r\n"
    "END:VTODO\r\n"
    "END:VCALENDAR\r\n"
)


def _item(
    *,
    uid: str | None = UID,
    title: str = "买书",
    due: date | None = date(2026, 9, 10),
    created: datetime | None = None,
    updated: datetime | None = datetime(2026, 9, 4, 1, 2, 3),
    ics: str | None = None,
    reminders: list[Reminder] | None = None,
) -> Item:
    """脱离 DB 构造 Item（serialize 只读属性；时间列手动给，保证确定性）。"""
    it = Item(
        caldav_uid=uid,
        caldav_name=None,
        caldav_ics=ics,
        title=title,
        summary="",
        category="学业",
        due_date=due,
        status="open",
        done_at=None,
        importance="normal",
        created_at=created or datetime(2026, 9, 1, 0, 0, 0),
        updated_at=updated,
    )
    if reminders is not None:
        it.reminders = reminders
    return it


def _valarm_blocks(body: str) -> list[str]:
    """从序列化文本抽出全部 VALARM 块（物理行按 CRLF 还原，含 BEGIN/END）。"""
    blocks: list[str] = []
    cur: list[str] | None = None
    for ln in body.split("\r\n"):
        if ln == "BEGIN:VALARM":
            cur = [ln]
        elif cur is not None:
            cur.append(ln)
            if ln == "END:VALARM":
                blocks.append("\r\n".join(cur))
                cur = None
    return blocks


def _marked_blocks(body: str) -> list[str]:
    """只留服务端车道（带 REMINDER_MARKER）的 VALARM 块。"""
    return [blk for blk in _valarm_blocks(body) if REMINDER_MARKER in blk]


# ── 服务端车道：生成与排序 ─────────────────────────────────────────


def test_no_reminders_outputs_no_marker():
    """无提醒 → 输出里没有任何 REMINDER_MARKER（现状行为不变，两条路径都查）。"""
    fresh = serialize(_item(ics=None, reminders=[]), local_zone=SYDNEY)
    assert REMINDER_MARKER not in fresh
    assert "BEGIN:VALARM" not in fresh
    passthrough = serialize(_item(ics=MIN_ICS, reminders=[]), local_zone=SYDNEY)
    assert REMINDER_MARKER not in passthrough


def test_one_reminder_fresh_emits_single_exact_valarm():
    """一个提醒 → 恰好一个 VALARM，六行内容与顺序全对（块文本逐字节锁死）。"""
    at = datetime(2026, 9, 10, 8, 30, 0)
    body = serialize(_item(title="买书", reminders=[Reminder(remind_at=at)]), local_zone=SYDNEY)
    blocks = _valarm_blocks(body)
    assert len(blocks) == 1
    assert blocks[0] == (
        "BEGIN:VALARM\r\n"
        f"UID:{UID}-R1\r\n"
        "ACTION:DISPLAY\r\n"
        "DESCRIPTION:买书\r\n"
        "TRIGGER;VALUE=DATE-TIME:20260910T083000Z\r\n"
        "X-RAKKOTASKS-REMINDER:1\r\n"
        "END:VALARM"
    )
    # TRIGGER 是绝对时刻且等于 remind_at 的 Z 形态（naive UTC 直接加 Z）
    assert "TRIGGER;VALUE=DATE-TIME:20260910T083000Z" in body
    assert body.index("BEGIN:VALARM") < body.index("END:VTODO") < body.index("END:VCALENDAR")


def test_three_reminders_out_of_order_sorted_with_r_index():
    """三个提醒故意乱序挂上 → 输出按 remind_at 升序，UID 后缀 -R1/-R2/-R3
    与升序位置对应（index 来自排序位置，不是插入顺序、不是 Reminder.id）。"""
    late = Reminder(remind_at=datetime(2026, 9, 10, 12, 0, 0))
    early = Reminder(remind_at=datetime(2026, 9, 10, 8, 0, 0))
    middle = Reminder(remind_at=datetime(2026, 9, 10, 10, 0, 0))
    assert late.id is None and early.id is None and middle.id is None  # 未落库：id 全空
    body = serialize(_item(reminders=[late, early, middle]), local_zone=SYDNEY)
    lines = body.split("\r\n")
    # 每个 -R<n> 之后第 3 行必须是它自己的 TRIGGER（行序固定）
    got: list[tuple[str, str]] = []
    for i, ln in enumerate(lines):
        if ln.startswith(f"UID:{UID}-R"):
            got.append((ln, lines[i + 3]))
    assert got == [
        (f"UID:{UID}-R1", "TRIGGER;VALUE=DATE-TIME:20260910T080000Z"),
        (f"UID:{UID}-R2", "TRIGGER;VALUE=DATE-TIME:20260910T100000Z"),
        (f"UID:{UID}-R3", "TRIGGER;VALUE=DATE-TIME:20260910T120000Z"),
    ]
    assert len(_valarm_blocks(body)) == 3


def test_serialize_deterministic_bytes_and_etag_with_reminders():
    """同一条目（带提醒）连续 serialize 两次 → 字节完全相同；etag_for 两次相同。"""
    it = _item(
        title="不动的内容",
        reminders=[
            Reminder(remind_at=datetime(2026, 9, 10, 9, 0, 0)),
            Reminder(remind_at=datetime(2026, 9, 10, 18, 30, 0)),
        ],
    )
    b1 = serialize(it, local_zone=SYDNEY)
    b2 = serialize(it, local_zone=SYDNEY)
    assert b1 == b2
    assert etag_for(b1) == etag_for(b2)


def test_changing_reminders_changes_etag():
    """加一个提醒 → 内容与 ETag 都变（客户端据此重下，而不是无限空转）。"""
    base = serialize(_item(title="买书", reminders=[]), local_zone=SYDNEY)
    grown = _item(title="买书")
    grown.reminders = [Reminder(remind_at=datetime(2026, 9, 10, 9, 0, 0))]
    after = serialize(grown, local_zone=SYDNEY)
    assert etag_for(base) != etag_for(after)


# ── 双车道：客户端闹钟存活 + 服务端闹钟替换 ────────────────────────


def test_client_alarm_survives_and_server_alarm_present():
    """（最重要）不带标记的客户端 VALARM 原样透传（连 X-APPLE-* 一起），
    服务端车道的 VALARM 同时在输出里——两条车道互不干扰。"""
    payload = (
        "BEGIN:VCALENDAR\r\n"
        "VERSION:2.0\r\n"
        "PRODID:-//Apple Inc.//iOS 17.5//EN\r\n"
        "BEGIN:VTODO\r\n"
        "UID:client-1\r\n"
        "SUMMARY:x\r\n"
        "DUE;VALUE=DATE:20260910\r\n"
        "STATUS:NEEDS-ACTION\r\n"
        "BEGIN:VALARM\r\n"
        "ACTION:DISPLAY\r\n"
        "DESCRIPTION:手设闹钟\r\n"
        "TRIGGER:-PT15M\r\n"
        "X-APPLE-DEFAULT-ALARM:TRUE\r\n"
        "END:VALARM\r\n"
        "END:VTODO\r\n"
        "END:VCALENDAR\r\n"
    )
    body = serialize(
        _item(ics=payload, reminders=[Reminder(remind_at=datetime(2026, 9, 10, 9, 0, 0))]),
        local_zone=SYDNEY,
    )
    # 客户端闹钟原样还在（块文本逐字节保留，含 X-APPLE-DEFAULT-ALARM）
    assert (
        "BEGIN:VALARM\r\n"
        "ACTION:DISPLAY\r\n"
        "DESCRIPTION:手设闹钟\r\n"
        "TRIGGER:-PT15M\r\n"
        "X-APPLE-DEFAULT-ALARM:TRUE\r\n"
        "END:VALARM"
    ) in body
    # 服务端车道闹钟也在，且两个 VALARM 互不干扰
    assert _marked_blocks(body) == [
        "BEGIN:VALARM\r\n"
        f"UID:{UID}-R1\r\n"
        "ACTION:DISPLAY\r\n"
        "DESCRIPTION:买书\r\n"
        "TRIGGER;VALUE=DATE-TIME:20260910T090000Z\r\n"
        "X-RAKKOTASKS-REMINDER:1\r\n"
        "END:VALARM"
    ]
    assert len(_valarm_blocks(body)) == 2


def test_marked_old_alarms_replaced_not_accumulated():
    """透传体里已有 2 个带标记的旧闹钟、库里只有 1 个提醒 → 输出恰好 1 个
    带标记的 VALARM（旧的被剥掉重写，不是 3 个累加）。"""
    stale = (
        "BEGIN:VALARM\r\n"
        "UID:client-1-R1\r\n"
        "ACTION:DISPLAY\r\n"
        "TRIGGER;VALUE=DATE-TIME:20260505T000000Z\r\n"
        "X-RAKKOTASKS-REMINDER:1\r\n"
        "END:VALARM"
    )
    payload = (
        "BEGIN:VCALENDAR\r\n"
        "VERSION:2.0\r\n"
        "BEGIN:VTODO\r\n"
        "UID:client-1\r\n"
        "SUMMARY:x\r\n"
        "DUE;VALUE=DATE:20260910\r\n"
        "STATUS:NEEDS-ACTION\r\n"
        f"{stale}\r\n"
        f"{stale}\r\n"
        "END:VTODO\r\n"
        "END:VCALENDAR\r\n"
    )
    body = serialize(
        _item(ics=payload, reminders=[Reminder(remind_at=datetime(2026, 9, 10, 9, 0, 0))]),
        local_zone=SYDNEY,
    )
    assert body.count(REMINDER_MARKER) == 1
    assert len(_marked_blocks(body)) == 1
    assert "20260505T000000Z" not in body  # 旧闹钟的 TRIGGER 已被剥掉


def test_absolute_trigger_survives_time_cluster_rewrite():
    """透传体 DUE 与库内 due_date 不同日 → 时间簇整簇删除重写；服务端车道
    VALARM 用绝对 TRIGGER，锚不在簇上，仍在输出里。"""
    payload = (
        "BEGIN:VCALENDAR\r\n"
        "VERSION:2.0\r\n"
        "BEGIN:VTODO\r\n"
        "UID:client-1\r\n"
        "SUMMARY:改期\r\n"
        "DUE;VALUE=DATE:20260910\r\n"
        "DTSTART;VALUE=DATE:20260910\r\n"
        "RRULE:FREQ=WEEKLY;COUNT=4\r\n"
        "STATUS:NEEDS-ACTION\r\n"
        "END:VTODO\r\n"
        "END:VCALENDAR\r\n"
    )
    body = serialize(
        _item(ics=payload, due=date(2026, 9, 20), reminders=[Reminder(remind_at=datetime(2026, 9, 20, 9, 0, 0))]),
        local_zone=SYDNEY,
    )
    assert "DUE;VALUE=DATE:20260920" in body  # 簇被重写成服务端日期
    assert "DUE;VALUE=DATE:20260910" not in body and "20260910" not in body
    assert "RRULE" not in body and "DTSTART" not in body
    assert _marked_blocks(body) == [
        "BEGIN:VALARM\r\n"
        f"UID:{UID}-R1\r\n"
        "ACTION:DISPLAY\r\n"
        "DESCRIPTION:买书\r\n"
        "TRIGGER;VALUE=DATE-TIME:20260920T090000Z\r\n"
        "X-RAKKOTASKS-REMINDER:1\r\n"
        "END:VALARM"
    ]


# ── 两条路径一致性 ────────────────────────────────────────────────


def test_fresh_and_passthrough_marked_blocks_byte_identical():
    """同一条目分别走 _serialize_fresh（无透传体）与透传路径：抽出的带标记
    VALARM 块文本逐字节一致（多提醒 + 长标题都覆盖）。"""
    reminders = [
        Reminder(remind_at=datetime(2026, 9, 10, 8, 0, 0)),
        Reminder(remind_at=datetime(2026, 9, 10, 21, 30, 0)),
    ]
    title = "今天要完成的事项清单" * 6
    fresh = serialize(_item(title=title, ics=None, reminders=reminders), local_zone=SYDNEY)
    passthrough = serialize(_item(title=title, ics=MIN_ICS, reminders=reminders), local_zone=SYDNEY)
    assert _marked_blocks(fresh) == _marked_blocks(passthrough)
    assert len(_marked_blocks(fresh)) == 2
    assert fresh != passthrough  # 其余部分不同（各自头部）才说明抽取有意义


def test_read_fields_ignores_valarm():
    """read_fields 不读 VALARM：含服务端 VALARM 的文本与不含时的 ParsedTodo 一致。"""
    with_alarm = (
        "BEGIN:VCALENDAR\r\n"
        "BEGIN:VTODO\r\n"
        "UID:abc\r\n"
        "SUMMARY:交报告\r\n"
        "DUE;VALUE=DATE:20260910\r\n"
        "STATUS:NEEDS-ACTION\r\n"
        "BEGIN:VALARM\r\n"
        f"UID:abc-R1\r\n"
        "ACTION:DISPLAY\r\n"
        "TRIGGER;VALUE=DATE-TIME:20260910T083000Z\r\n"
        "X-RAKKOTASKS-REMINDER:1\r\n"
        "END:VALARM\r\n"
        "END:VTODO\r\n"
        "END:VCALENDAR\r\n"
    )
    without_alarm = with_alarm.replace(
        "BEGIN:VALARM\r\n"
        f"UID:abc-R1\r\n"
        "ACTION:DISPLAY\r\n"
        "TRIGGER;VALUE=DATE-TIME:20260910T083000Z\r\n"
        "X-RAKKOTASKS-REMINDER:1\r\n"
        "END:VALARM\r\n",
        "",
    )

    def parsed(text):
        return read_fields(master_vtodo(parse_calendar(text)), local_zone=SYDNEY)

    assert parsed(with_alarm) == parsed(without_alarm)


# ── 折行与回退 ────────────────────────────────────────────────────


def test_long_title_description_folded_and_unfoldable():
    """标题长到让 VALARM 的 DESCRIPTION 超 75 字节 → 正确折行：每物理行
    ≤75 字节、续行以单空格开头，unfold 反解后内容完整。"""
    title = "今天要完成的事项清单" * 8  # 96 汉字 ≈ 288 字节
    body = serialize(_item(title=title, reminders=[Reminder(remind_at=datetime(2026, 9, 10, 9, 0, 0))]), local_zone=SYDNEY)
    lines = body.split("\r\n")
    assert all(len(ln.encode("utf-8")) <= 75 for ln in lines)
    start = next(i for i, ln in enumerate(lines) if ln.startswith("DESCRIPTION:"))
    # 找到 DESCRIPTION 开头的物理行，其后以单空格开头的都是续行
    end = next(i for i in range(start + 1, len(lines)) if lines[i] and not lines[i].startswith(" "))
    physical = lines[start:end]
    assert len(physical) > 1  # 确实发生了折行
    assert all(ln.startswith(" ") for ln in physical[1:])  # 续行以单空格开头
    unfolded = [ln for ln in unfold("\r\n".join(physical)) if ln.startswith("DESCRIPTION:")]
    assert unfolded == [f"DESCRIPTION:{title}"]


def test_caldav_uid_none_uid_falls_back_to_rakkotasks():
    """caldav_uid 为 None 不崩：VALARM UID 退化成 RAKKOTASKS-R1。"""
    body = serialize(
        _item(uid=None, reminders=[Reminder(remind_at=datetime(2026, 9, 10, 9, 0, 0))]),
        local_zone=SYDNEY,
    )
    assert "BEGIN:VALARM" in body
    assert "UID:RAKKOTASKS-R1" in body
