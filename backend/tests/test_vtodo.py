"""CalDAV VTODO 解析/序列化纯函数测试：结构、转义折行、DUE 四形态、状态判定、
优先级分档、透传（拥有属性覆盖 + 时间簇三态 + 客户端行原样保留）。"""
from datetime import date, datetime
from zoneinfo import ZoneInfo

import pytest

from app.caldav.vtodo import (
    VTodoError,
    etag_for,
    master_vtodo,
    parse_calendar,
    read_fields,
    serialize,
    unfold,
    unescape_text,
)
from app.models import Item

SYDNEY = ZoneInfo("Australia/Sydney")

UID = "0123456789ABCDEF0123456789ABCDEF"


def _item(
    *,
    uid: str = UID,
    title: str = "买书",
    summary: str = "",
    category: str = "学业",
    due: date | None = None,
    status: str = "open",
    done_at: datetime | None = None,
    importance: str = "normal",
    created: datetime | None = None,
    updated: datetime | None | str = "default",
    ics: str | None = None,
) -> Item:
    """脱离 DB 构造 Item（serialize 只读属性；时间列手动给，保证确定性）。

    updated 不传 → 2026-09-04 01:02:03；传 None → 真的 None（测 created_at 回退）。
    """
    created_at = created or datetime(2026, 9, 1, 0, 0, 0)
    if updated == "default":
        updated_at = datetime(2026, 9, 4, 1, 2, 3)
    else:
        updated_at = updated  # type: ignore[assignment]
    it = Item(
        caldav_uid=uid,
        caldav_name=None,
        caldav_ics=ics,
        title=title,
        summary=summary,
        category=category,
        due_date=due,
        status=status,
        done_at=done_at,
        importance=importance,
        created_at=created_at,
        updated_at=updated_at,
    )
    return it


def _vtodo(calendar_text: str):
    """解析完整 VCALENDAR 文档并取主 VTODO。"""
    return master_vtodo(parse_calendar(calendar_text))


# ── 无透传体序列化：固定结构 ──────────────────────────────────────


def test_serialize_fresh_exact_structure():
    """无透传体：固定顺序输出；DTSTAMP 精确等于 updated_at 推出的 Z 串；不含 METHOD:/X-WR-CALNAME。"""
    it = _item(title="买书", category="学业")
    expected = (
        "BEGIN:VCALENDAR\r\n"
        "VERSION:2.0\r\n"
        "PRODID:-//RakkoTasks//CN\r\n"
        "CALSCALE:GREGORIAN\r\n"
        "BEGIN:VTODO\r\n"
        f"UID:{UID}\r\n"
        "DTSTAMP:20260904T010203Z\r\n"
        "CREATED:20260901T000000Z\r\n"
        "LAST-MODIFIED:20260904T010203Z\r\n"
        "SUMMARY:买书\r\n"
        "STATUS:NEEDS-ACTION\r\n"
        "CATEGORIES:学业\r\n"
        "END:VTODO\r\n"
        "END:VCALENDAR\r\n"
    )
    body = serialize(it)
    assert body == expected
    assert body.endswith("\r\n")
    assert "METHOD:" not in body
    assert "X-WR-CALNAME" not in body
    assert "DESCRIPTION:" not in body
    assert "DUE" not in body
    assert "PRIORITY" not in body


def test_serialize_fresh_done_item():
    """done 条目：STATUS:COMPLETED + PERCENT-COMPLETE:100 + COMPLETED 时间。"""
    it = _item(status="done", done_at=datetime(2026, 9, 5, 6, 7, 8), due=date(2026, 9, 10))
    body = serialize(it)
    assert "STATUS:COMPLETED" in body
    assert "PERCENT-COMPLETE:100" in body
    assert "COMPLETED:20260905T060708Z" in body
    assert "DUE;VALUE=DATE:20260910" in body
    assert "STATUS:NEEDS-ACTION" not in body
    # 顺序：STATUS → PERCENT-COMPLETE → COMPLETED
    assert body.index("STATUS:COMPLETED") < body.index("PERCENT-COMPLETE:100") < body.index("COMPLETED:2026")


def test_serialize_fresh_done_without_done_at_omits_completed():
    it = _item(status="done", done_at=None)
    body = serialize(it)
    assert "STATUS:COMPLETED" in body
    assert "PERCENT-COMPLETE:100" in body
    assert "COMPLETED:" not in body


def test_serialize_fresh_priority_buckets():
    """PRIORITY：high→1、low→9、normal 不输出。"""
    high = serialize(_item(importance="high"))
    low = serialize(_item(importance="low"))
    normal = serialize(_item(importance="normal"))
    assert "PRIORITY:1" in high and "PRIORITY:9" not in high
    assert "PRIORITY:9" in low
    assert "PRIORITY" not in normal


def test_serialize_fresh_summary_and_escape():
    it = _item(title="交报告;周一,截止\n急", summary="含,逗号;分号\n与换行", due=date(2026, 9, 9))
    body = serialize(it)
    assert "SUMMARY:交报告\\;周一\\,截止\\n急" in body
    assert "DESCRIPTION:含\\,逗号\\;分号\\n与换行" in body
    assert "DUE;VALUE=DATE:20260909" in body


def test_serialize_fresh_long_chinese_title_folded_and_unfoldable():
    """长中文标题折行：每物理行 ≤75 UTF-8 字节，解折后与原文一致。"""
    title = "今天要完成的事项清单" * 12  # 120 汉字 ≈ 360 字节
    body = serialize(_item(title=title))
    lines = body.split("\r\n")
    assert all(len(ln.encode("utf-8")) <= 75 for ln in lines)
    start = next(i for i, ln in enumerate(lines) if ln.startswith("SUMMARY:"))
    end = next(i for i in range(start + 1, len(lines)) if lines[i] and not lines[i].startswith(" "))
    joined = lines[start] + "".join(lines[i][1:] for i in range(start + 1, end))
    assert joined == f"SUMMARY:{title}"
    assert end - start > 1  # 确实发生了折行


def test_serialize_fresh_deterministic_bytes_and_etag():
    """同一条目两次序列化字节相同 → ETag 相同（无 datetime.now() 的体现）。"""
    it = _item(title="不动的内容", due=date(2026, 9, 4), status="done", done_at=datetime(2026, 9, 4, 2, 3, 4))
    b1 = serialize(it)
    b2 = serialize(it)
    assert b1 == b2
    assert etag_for(b1) == etag_for(b2)


def test_serialize_changes_etag_on_title_due_status():
    base = serialize(_item(title="原题", due=date(2026, 9, 4)))
    changed_title = serialize(_item(title="改题", due=date(2026, 9, 4)))
    changed_due = serialize(_item(title="原题", due=date(2026, 9, 5)))
    changed_status = serialize(_item(title="原题", due=date(2026, 9, 4), status="done", done_at=None))
    etags = {etag_for(b) for b in (base, changed_title, changed_due, changed_status)}
    assert len(etags) == 4  # 各自改变内容 → ETag 各自改变
    assert etag_for(base).startswith('"') and etag_for(base).endswith('"')
    assert len(etag_for(base)) == 2 + 32


def test_serialize_fresh_updated_at_none_falls_back_to_created_at():
    """updated_at 为 None（如迁移回填前/手工对象）→ DTSTAMP 与 LAST-MODIFIED 用 created_at。"""
    it = _item(created=datetime(2026, 8, 30, 12, 0, 0), updated=None)
    body = serialize(it)
    assert "DTSTAMP:20260830T120000Z" in body
    assert "LAST-MODIFIED:20260830T120000Z" in body
    assert "CREATED:20260830T120000Z" in body


def test_serialize_fresh_requires_flushed_item():
    """created_at/updated_at 全空（未落库条目）：报错而不是产出不确定时间戳。"""
    with pytest.raises(ValueError):
        serialize(Item(caldav_uid=UID, title="x", category="学业", status="open"))


# ── 解析：unfold / split / read_fields ────────────────────────────


def test_unfold_handles_crlf_lf_and_continuations():
    folded = "BEGIN:VCALENDAR\nSUMMARY:第一段\n 第二段续行\n\t第三段续行\nEND:VCALENDAR\n"
    assert unfold(folded) == [
        "BEGIN:VCALENDAR",
        "SUMMARY:第一段第二段续行第三段续行",
        "END:VCALENDAR",
    ]
    crlf = "SUMMARY:a\r\n b\r\nEND:VCALENDAR\r\n"
    assert unfold(crlf) == ["SUMMARY:ab", "END:VCALENDAR"]


def test_unescape_text_roundtrip():
    assert unescape_text(r"a\nb\,c\;d\\e\Nf") == "a\nb,c;d\\e\nf"
    assert unescape_text(r"未知\x转义") == r"未知\x转义"  # 非标准转义原样保留
    assert unescape_text("带\r\n回车") == "带\n回车"


def test_parse_apple_shape_payload():
    """Apple 形态载荷：VALARM/X-APPLE-* 与折行 DESCRIPTION 与 TZID DUE 都能读。"""
    text = (
        "BEGIN:VCALENDAR\r\n"
        "VERSION:2.0\r\n"
        "PRODID:-//Apple Inc.//iOS 17.5//EN\r\n"
        "CALSCALE:GREGORIAN\r\n"
        "BEGIN:VTODO\r\n"
        "UID:8F2A1C5E-4B3D-4A6F-9C2E-1D0B7A8F9C01\r\n"
        "DTSTAMP:20260909T010203Z\r\n"
        "SUMMARY:交报告\r\n"
        "DESCRIPTION:交报告前先读一遍\r\n"
        " 实验室安全手册全文\r\n"
        "DUE;TZID=Australia/Sydney:20260910T090000\r\n"
        "STATUS:NEEDS-ACTION\r\n"
        "PRIORITY:1\r\n"
        "X-APPLE-SORT-ORDER:0\r\n"
        "BEGIN:VALARM\r\n"
        "ACTION:DISPLAY\r\n"
        "DESCRIPTION:提醒\r\n"
        "TRIGGER;VALUE=DATE-TIME:20260910T083000Z\r\n"
        "END:VALARM\r\n"
        "END:VTODO\r\n"
        "END:VCALENDAR\r\n"
    )
    parsed = read_fields(_vtodo(text), local_zone=SYDNEY)
    assert parsed.uid == "8F2A1C5E-4B3D-4A6F-9C2E-1D0B7A8F9C01"
    assert parsed.title == "交报告"
    assert parsed.summary == "交报告前先读一遍实验室安全手册全文"  # 折行 DESCRIPTION 解折后读
    assert parsed.due_date == date(2026, 9, 10)  # TZID 形态取字面日期
    assert parsed.done is False
    assert parsed.importance == "high"  # PRIORITY:1


@pytest.mark.parametrize(
    "due_line, expected",
    [
        ("DUE;VALUE=DATE:20260911", date(2026, 9, 11)),  # VALUE=DATE 字面日期
        ("DUE:20260911T120000", date(2026, 9, 11)),  # 浮动 DATE-TIME：字面日期
        ("DUE;TZID=Australia/Sydney:20260911T120000", date(2026, 9, 11)),  # TZID：字面日期
        ("DUE:20260909T230000Z", date(2026, 9, 10)),  # UTC 23:00 → 悉尼本地 09:10 次日
        ("DUE:20260909T133000Z", date(2026, 9, 9)),  # UTC → 悉尼同日
        ("DUE;VALUE=DATE:20260909", date(2026, 9, 9)),
    ],
)
def test_read_fields_due_four_forms(due_line: str, expected: date):
    text = f"BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nSUMMARY:x\r\n{due_line}\r\nEND:VTODO\r\nEND:VCALENDAR\r\n"
    parsed = read_fields(_vtodo(text), local_zone=SYDNEY)
    assert parsed.due_date == expected


def test_read_fields_malformed_due_raises():
    for bad in (
        "DUE:banana",
        "DUE;VALUE=DATE:20260230",  # 不存在的日期
        "DUE:20260910 乱",  # 时间形态带垃圾
    ):
        text = f"BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nSUMMARY:x\r\n{bad}\r\nEND:VTODO\r\nEND:VCALENDAR\r\n"
        with pytest.raises(VTodoError) as exc:
            read_fields(_vtodo(text), local_zone=SYDNEY)
        assert exc.value.code == "valid-calendar-data"


def test_read_fields_no_due_missing_fields_defaults():
    text = "BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nEND:VTODO\r\nEND:VCALENDAR\r\n"
    parsed = read_fields(_vtodo(text), local_zone=SYDNEY)
    assert parsed.due_date is None
    assert parsed.title == "未命名任务"  # 无 SUMMARY → 默认标题
    assert parsed.summary == ""
    assert parsed.done is False
    assert parsed.importance == "normal"


@pytest.mark.parametrize(
    "lines, expect_done",
    [
        (["STATUS:COMPLETED"], True),
        (["STATUS:CANCELLED"], True),
        (["STATUS:NEEDS-ACTION"], False),
        (["PERCENT-COMPLETE:100"], True),
        (["PERCENT-COMPLETE:50"], False),
        (["COMPLETED:20260901T020304Z"], True),
        (["STATUS:COMPLETED", "PERCENT-COMPLETE:100", "COMPLETED:20260901T020304Z"], True),
    ],
)
def test_read_fields_done_variants(lines, expect_done):
    inner = "\r\n".join(["SUMMARY:x", *lines])
    text = f"BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\n{inner}\r\nEND:VTODO\r\nEND:VCALENDAR\r\n"
    parsed = read_fields(_vtodo(text), local_zone=SYDNEY)
    assert parsed.done is expect_done
    if "COMPLETED:" in inner:
        assert parsed.done_at == datetime(2026, 9, 1, 2, 3, 4)  # naive UTC
    else:
        assert parsed.done_at is None


def test_read_fields_completed_malformed_value_done_but_no_done_at():
    text = "BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nSUMMARY:x\r\nCOMPLETED:garbage\r\nEND:VTODO\r\nEND:VCALENDAR\r\n"
    parsed = read_fields(_vtodo(text), local_zone=SYDNEY)
    assert parsed.done is True
    assert parsed.done_at is None


@pytest.mark.parametrize(
    "priority, expected",
    [
        ("1", "high"),
        ("4", "high"),
        ("0", "normal"),
        ("5", "normal"),
        ("9", "low"),
        ("6", "low"),
        ("banana", "normal"),
        ("12", "normal"),  # 越界 → normal
    ],
)
def test_read_fields_priority_buckets(priority: str, expected: str):
    text = f"BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nSUMMARY:x\r\nPRIORITY:{priority}\r\nEND:VTODO\r\nEND:VCALENDAR\r\n"
    assert read_fields(_vtodo(text), local_zone=SYDNEY).importance == expected


def test_read_fields_categories_ignored():
    """CATEGORIES 被忽略：客户端分类不会覆盖服务端分类（服务端分类来自 REST 侧）。"""
    text = (
        "BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nSUMMARY:改论文\r\n"
        "CATEGORIES:家庭,假期\r\nSTATUS:NEEDS-ACTION\r\nEND:VTODO\r\nEND:VCALENDAR\r\n"
    )
    parsed = read_fields(_vtodo(text), local_zone=SYDNEY)
    assert parsed.title == "改论文"
    assert parsed.done is False  # 与分类无关
    assert parsed.uid is None


def test_parse_calendar_bare_lf_and_unescape_inside():
    """裸 LF 文本（无 CRLF）可解析；值内转义在读取时逆转义。"""
    text = (
        "BEGIN:VCALENDAR\n"
        "BEGIN:VTODO\n"
        "SUMMARY:写\\,报告\\;提交\n"
        "DESCRIPTION:第一行\\n第二行\n"
        "END:VTODO\n"
        "END:VCALENDAR\n"
    )
    parsed = read_fields(_vtodo(text), local_zone=SYDNEY)
    assert parsed.title == "写,报告;提交"
    assert parsed.summary == "第一行\n第二行"


def test_parse_calendar_unbalanced_raises():
    with pytest.raises(VTodoError):
        parse_calendar("BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nSUMMARY:x\r\nEND:VCALENDAR\r\n")
    with pytest.raises(VTodoError):
        parse_calendar("BEGIN:VCALENDAR\r\nEND:VTODO\r\n")
    with pytest.raises(VTodoError):
        parse_calendar("SUMMARY:没有外壳的孤儿行\r\n")


def test_master_vtodo_none_raises():
    """只有 VEVENT / 空日历：找不到主 VTODO → VTodoError。"""
    cal = parse_calendar("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")
    with pytest.raises(VTodoError) as exc:
        master_vtodo(cal)
    assert exc.value.code == "valid-calendar-data"


def test_master_vtodo_skips_recurrence_instances():
    """带 RECURRENCE-ID 的重复实例不是主体：主体取首个无 RECURRENCE-ID 的 VTODO。"""
    text = (
        "BEGIN:VCALENDAR\r\n"
        "BEGIN:VTODO\r\n"
        "UID:abc\r\n"
        "RECURRENCE-ID;VALUE=DATE:20260917\r\n"
        "SUMMARY:重复实例\r\n"
        "END:VTODO\r\n"
        "BEGIN:VTODO\r\n"
        "UID:abc\r\n"
        "SUMMARY:主体\r\n"
        "END:VTODO\r\n"
        "END:VCALENDAR\r\n"
    )
    vtodo = _vtodo(text)
    assert any(ln.value == "主体" for ln in vtodo.lines)


# ── 透传序列化（caldav_ics 非空） ─────────────────────────────────


_PASSTHROUGH = (
    "BEGIN:VCALENDAR\r\n"
    "VERSION:2.0\r\n"
    "PRODID:-//Apple Inc.//iOS 17.5//EN\r\n"
    "BEGIN:VTODO\r\n"
    "UID:client-uid-1\r\n"
    "DTSTAMP:20260909T010203Z\r\n"
    "SUMMARY:客户端标题\r\n"
    "DESCRIPTION:客户端描述\r\n"
    "DUE;VALUE=DATE:20260910\r\n"
    "STATUS:NEEDS-ACTION\r\n"
    "PRIORITY:5\r\n"
    "CATEGORIES:家庭\r\n"
    "X-APPLE-SORT-ORDER:3\r\n"
    "LOCATION:某地\r\n"
    "BEGIN:VALARM\r\n"
    "ACTION:DISPLAY\r\n"
    "DESCRIPTION:提醒\r\n"
    "TRIGGER;RELATED=START:PT10H\r\n"
    "END:VALARM\r\n"
    "END:VTODO\r\n"
    "END:VCALENDAR\r\n"
)


def test_passthrough_preserves_client_lines_and_overrides_owned():
    """透传：VALARM/X-APPLE-*/LOCATION 与客户端 VCALENDAR 头保留，SUMMARY 等服务端属性覆盖。"""
    it = _item(title="服务端标题", summary="服务端描述", category="工作", due=date(2026, 9, 10), ics=_PASSTHROUGH)
    body = serialize(it)
    assert body.endswith("\r\n")
    # 客户端独有内容原样保留
    assert "PRODID:-//Apple Inc.//iOS 17.5//EN" in body
    assert "VERSION:2.0" in body
    assert "X-APPLE-SORT-ORDER:3" in body
    assert "LOCATION:某地" in body
    assert "BEGIN:VALARM" in body and "END:VALARM" in body and "TRIGGER;RELATED=START:PT10H" in body
    # 服务端属性被覆盖
    assert "SUMMARY:服务端标题" in body
    assert "DESCRIPTION:服务端描述" in body
    assert "CATEGORIES:工作" in body
    assert "UID:" + UID in body  # 客户端 UID 被服务端 caldav_uid 覆盖
    assert "SUMMARY:客户端标题" not in body
    assert "CATEGORIES:家庭" not in body
    # 时间簇同日期 → DUE 行原样（同一行被服务端 DUE 覆盖成同值，见时间簇保留测试）
    assert "DUE;VALUE=DATE:20260910" in body


def test_passthrough_open_item_removes_client_completion_markers():
    """客户端把条目标成已完成，服务端状态为 open → COMPLETED/PERCENT-COMPLETE/STATUS 全部按服务端重写。"""
    payload = (
        "BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\n"
        "SUMMARY:已被客户端勾掉\r\nSTATUS:COMPLETED\r\nPERCENT-COMPLETE:100\r\n"
        "COMPLETED:20260905T010203Z\r\nEND:VTODO\r\nEND:VCALENDAR\r\n"
    )
    it = _item(title="服务端仍是待办", status="open", ics=payload)
    body = serialize(it)
    assert "STATUS:NEEDS-ACTION" in body
    assert "SUMMARY:服务端仍是待办" in body
    assert "PERCENT-COMPLETE" not in body
    assert "COMPLETED:" not in body


def test_passthrough_done_item_replaces_status_fields():
    payload = (
        "BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nSUMMARY:x\r\nSTATUS:NEEDS-ACTION\r\n"
        "END:VTODO\r\nEND:VCALENDAR\r\n"
    )
    it = _item(status="done", done_at=datetime(2026, 9, 6, 8, 0, 0), ics=payload)
    body = serialize(it)
    assert "STATUS:COMPLETED" in body
    assert "PERCENT-COMPLETE:100" in body
    assert "COMPLETED:20260906T080000Z" in body
    assert "STATUS:NEEDS-ACTION" not in body


def test_passthrough_keeps_client_folding_of_unowned_lines():
    """未拥有属性的原始折行保留（raw 行原样重发，不重新折叠）。"""
    payload = (
        "BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nSUMMARY:x\r\n"
        "LOCATION:这是一个很长很长需要被客户端折行的地点名称\r\n"
        " 这是续行第二段内容\r\nEND:VTODO\r\nEND:VCALENDAR\r\n"
    )
    body = serialize(_item(title="y", ics=payload))
    assert "这是续行第二段内容" in body
    assert "LOCATION:这是一个很长很长需要被客户端折行的地点名称" in body


def test_passthrough_time_cluster_kept_when_due_matches():
    """时间簇保留：透传体 DUE 与库内 due_date 同日 → RRULE/DTSTART/重复实例全部原样保留。"""
    payload = (
        "BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\n"
        "SUMMARY:每周买菜\r\nDUE;VALUE=DATE:20260910\r\nDTSTART;VALUE=DATE:20260910\r\n"
        "RRULE:FREQ=WEEKLY;COUNT=4\r\nEND:VTODO\r\n"
        "BEGIN:VTODO\r\nUID:abc\r\nRECURRENCE-ID;VALUE=DATE:20260917\r\nSUMMARY:买菜(2)\r\n"
        "DUE;VALUE=DATE:20260917\r\nEND:VTODO\r\n"
        "END:VCALENDAR\r\n"
    )
    body = serialize(_item(title="每周买菜", due=date(2026, 9, 10), ics=payload))
    assert "RRULE:FREQ=WEEKLY;COUNT=4" in body
    assert "DTSTART;VALUE=DATE:20260910" in body
    assert "RECURRENCE-ID;VALUE=DATE:20260917" in body
    assert "SUMMARY:买菜(2)" in body  # 重复实例整体保留
    assert "DUE;VALUE=DATE:20260910" in body


def test_passthrough_time_cluster_rewritten_when_due_differs():
    """时间簇重写：客户端 DUE 与库内日期不同 → 整簇删除，只写服务端 DUE。"""
    payload = (
        "BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\n"
        "SUMMARY:改期\r\nDUE;VALUE=DATE:20260910\r\nRRULE:FREQ=WEEKLY;COUNT=4\r\n"
        "END:VTODO\r\nBEGIN:VTODO\r\nUID:abc\r\nRECURRENCE-ID;VALUE=DATE:20260917\r\n"
        "SUMMARY:x\r\nEND:VTODO\r\nEND:VCALENDAR\r\n"
    )
    body = serialize(_item(title="改期", due=date(2026, 9, 20), ics=payload))
    assert "DUE;VALUE=DATE:20260920" in body
    assert "RRULE" not in body
    assert "RECURRENCE-ID" not in body
    assert "DTSTART" not in body
    lines = body.split("\r\n")
    assert not any(ln.startswith("DUE") and "20260910" in ln for ln in lines)


def test_passthrough_time_cluster_cleared_when_no_due():
    """时间簇清空：库内无日期 → 簇删除且不写任何 DUE。"""
    payload = (
        "BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\n"
        "SUMMARY:无限期\r\nDUE;VALUE=DATE:20260910\r\nRRULE:FREQ=DAILY\r\n"
        "END:VTODO\r\nEND:VCALENDAR\r\n"
    )
    body = serialize(_item(title="无限期", due=None, ics=payload))
    assert "RRULE" not in body
    assert not any(ln.startswith("DUE") for ln in body.split("\r\n"))


def test_passthrough_normal_priority_deleted_but_non_owned_kept():
    """服务端 normal（不输出 PRIORITY）→ 客户端 PRIORITY 行被删；X-APPLE-* 不受影响。"""
    payload = (
        "BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nSUMMARY:x\r\nPRIORITY:5\r\n"
        "X-APPLE-SORT-ORDER:0\r\nEND:VTODO\r\nEND:VCALENDAR\r\n"
    )
    body = serialize(_item(title="x", importance="normal", ics=payload))
    assert "PRIORITY" not in body
    assert "X-APPLE-SORT-ORDER:0" in body


def test_passthrough_empty_summary_deletes_client_description():
    """服务端摘要为空 → 客户端 DESCRIPTION 行被删（服务端不输出空 DESCRIPTION）。"""
    payload = (
        "BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nSUMMARY:x\r\nDESCRIPTION:客户端写了但服务端没有\r\n"
        "END:VTODO\r\nEND:VCALENDAR\r\n"
    )
    body = serialize(_item(title="x", summary="", ics=payload))
    assert "DESCRIPTION" not in body


def test_passthrough_corrupt_payload_raises():
    with pytest.raises(VTodoError):
        serialize(_item(title="x", ics="这不是日历\r\n"))
    with pytest.raises(VTodoError):
        serialize(_item(title="x", ics="BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"))


def test_etag_for_shape_and_stability():
    e1 = etag_for("body\r\n")
    e2 = etag_for("body\r\n")
    e3 = etag_for("body2\r\n")
    assert e1 == e2
    assert e1 != e3
    assert e1[0] == '"' and e1[-1] == '"'
    assert len(e1) == 34  # 引号 + 32 hex
