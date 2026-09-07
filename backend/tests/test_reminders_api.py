"""提醒（reminders）REST API 测试：POST/PATCH/DELETE 的提醒读写、级联、多用户隔离，
以及 /api/items/parse 与 /quick 的提醒换算与落库。

打桩口径照 test_manual_items.py / test_ai_parse.py 的 _settings/_seed/_client：
依赖覆盖指定当前用户，内存库；get_llm 用 monkeypatch 注入 FakeLLM。
"""
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.api import create_app
from app.auth import CurrentUser, require_auth
from app.config import Settings
from app.models import Account, Email, Item, Reminder, User


def _settings(**over) -> Settings:
    kw = dict(database_path=":memory:", llm_base_url="http://x", llm_api_key="k")
    kw.update(over)
    return Settings(**kw)


def _seed(session_factory) -> int:
    """user-1 一账户一邮件 + 一条邮件条目；user-2 无内容。返回邮件条目 id。"""
    with session_factory() as s:
        s.add(User(sub="user-1", email="a@example.com", name="甲"))
        s.add(User(sub="user-2", email="b@example.com", name="乙"))
        s.commit()
        acc = Account(user_sub="user-1", name="学校邮箱", kind="microsoft", email="a@example.com", status="ok")
        s.add(acc)
        s.commit()
        em = Email(
            account_id=acc.id, message_id="<m1>", subject="开学通知", sender="b@example.com",
            sent_at=datetime(2026, 9, 4, 1, 2, 3), text_body="九月一号开学", llm_state="done",
        )
        s.add(em)
        s.commit()
        it = Item(email_id=em.id, user_sub="user-1", title="交学费", summary="s", category="学业", status="open")
        s.add(it)
        s.commit()
        return it.id


def _add_manual(session_factory, *, sub: str = "user-1", title: str = "手动任务",
                remind_at: list[datetime] | None = None) -> int:
    with session_factory() as s:
        it = Item(
            user_sub=sub, email_id=None, title=title, summary="手写摘要", category="个人",
            importance="normal", actionable=True, status="open",
        )
        s.add(it)
        s.commit()
        for dt in remind_at or []:
            it.reminders.append(Reminder(remind_at=dt))
        s.commit()
        return it.id


def _client(session_factory, monkeypatch, llm=None, sub: str = "user-1", settings=None):
    if llm is not None:
        monkeypatch.setattr("app.llm.get_llm", lambda settings=None: llm)
    app = create_app(settings=settings or _settings(), session_factory=session_factory)
    app.dependency_overrides[require_auth] = lambda: CurrentUser(
        sub=sub, email=f"{sub}@example.com", name="甲"
    )
    return TestClient(app)


def _reminder_rows(session_factory, item_id: int) -> list[Reminder]:
    with session_factory() as s:
        return list(
            s.execute(
                select(Reminder).where(Reminder.item_id == item_id).order_by(Reminder.remind_at)
            ).scalars().all()
        )


class FakeLLM:
    """LLMClient 替身：记录每次 parse_task 的 (text, today)，返回预设结果或抛预设异常。"""

    def __init__(self, result: dict | None = None, exc: Exception | None = None):
        self.result = result
        self.exc = exc
        self.calls: list[tuple[str, str]] = []

    def parse_task(self, text: str, today: str) -> dict:
        self.calls.append((text, today))
        if self.exc is not None:
            raise self.exc
        if self.result is None:
            raise AssertionError("FakeLLM 未预设 result")
        return dict(self.result)


def _parse_result(**over) -> dict:
    out = {
        "title": "修空调",
        "summary": "",
        "category": "个人",
        "due_date": None,
        "reminders": [],
        "actionable": True,
        "importance": "normal",
    }
    out.update(over)
    return out


def _offset_naive_utc(iso_with_offset: str) -> datetime:
    """带偏移 ISO 串 → 库里的 naive UTC datetime（与 itemrules.validate_reminders 同口径）。"""
    return datetime.fromisoformat(iso_with_offset).astimezone(timezone.utc).replace(tzinfo=None, microsecond=0)


def _wall_to_naive_utc(wall: str, zone: str) -> datetime:
    """本地墙上时刻 + IANA 时区名 → naive UTC datetime（与 itemrules.local_wall_to_utc 同口径）。"""
    return (
        datetime.fromisoformat(wall).replace(tzinfo=ZoneInfo(zone)).astimezone(timezone.utc)
        .replace(tzinfo=None, microsecond=0)
    )


def _naive_to_iso(dt: datetime) -> str:
    return dt.replace(tzinfo=timezone.utc).isoformat()


# ── POST /api/items ────────────────────────────────────────────


def test_create_with_two_reminders_converted_and_sorted(session_factory, monkeypatch):
    _seed(session_factory)
    client = _client(session_factory, monkeypatch)

    later = "2026-09-08T22:30:00+10:00"
    earlier = "2026-09-08T10:00:00+10:00"
    resp = client.post(
        "/api/items",
        json={"title": "去机场", "category": "个人", "reminders": [later, earlier]},
    )
    assert resp.status_code == 201
    data = resp.json()
    # 响应里两项、按时间升序、remind_at 带 +00:00
    assert [r["remind_at"] for r in data["reminders"]] == [
        _naive_to_iso(_offset_naive_utc(earlier)),
        _naive_to_iso(_offset_naive_utc(later)),
    ]
    # 库里 remind_at 是正确的 naive UTC：+10:00 输入 → 前推 10 小时的 UTC 时刻（不是原样存）
    rows = _reminder_rows(session_factory, data["id"])
    assert [r.remind_at for r in rows] == [
        _offset_naive_utc(earlier),
        _offset_naive_utc(later),
    ]


def test_create_without_reminders_is_empty_list(session_factory, monkeypatch):
    """回归：不带 reminders 的 POST，响应里 reminders 为 []（不是缺键）。"""
    _seed(session_factory)
    client = _client(session_factory, monkeypatch)

    resp = client.post("/api/items", json={"title": "平凡小事", "category": "个人"})
    assert resp.status_code == 201
    assert resp.json()["reminders"] == []
    assert _reminder_rows(session_factory, resp.json()["id"]) == []


def test_create_reminder_without_offset_is_400(session_factory, monkeypatch):
    _seed(session_factory)
    client = _client(session_factory, monkeypatch)

    resp = client.post(
        "/api/items", json={"title": "修空调", "category": "个人", "reminders": ["2026-09-08T10:00"]}
    )
    assert resp.status_code == 400
    assert resp.json() == {"code": "bad_reminders"}
    with session_factory() as s:  # 没有写进库
        assert s.execute(select(Item).where(Item.email_id.is_(None))).scalars().all() == []


def test_create_too_many_reminders_is_400(session_factory, monkeypatch):
    _seed(session_factory)
    client = _client(session_factory, monkeypatch)

    many = [f"2026-09-0{i}T10:00:00+10:00" for i in range(1, 7)]  # 6 个 > REMINDERS_MAX=5
    resp = client.post("/api/items", json={"title": "修空调", "category": "个人", "reminders": many})
    assert resp.status_code == 400
    assert resp.json() == {"code": "too_many_reminders"}


def test_create_duplicate_instants_deduped(session_factory, monkeypatch):
    """同一绝对时刻用两种偏移表达 → 落库去重成 1 个（UNIQUE 约束的兜底口径）。"""
    _seed(session_factory)
    client = _client(session_factory, monkeypatch)

    resp = client.post(
        "/api/items",
        json={
            "title": "修空调", "category": "个人",
            "reminders": ["2026-09-08T10:00:00+10:00", "2026-09-08T00:00:00+00:00"],
        },
    )
    assert resp.status_code == 201
    data = resp.json()
    assert len(data["reminders"]) == 1
    rows = _reminder_rows(session_factory, data["id"])
    assert len(rows) == 1
    assert rows[0].remind_at == _offset_naive_utc("2026-09-08T10:00:00+10:00")


# ── PATCH /api/items/{id} ──────────────────────────────────────


def test_patch_replaces_reminders_entirely(session_factory, monkeypatch):
    _seed(session_factory)
    item_id = _add_manual(
        session_factory,
        remind_at=[datetime(2026, 9, 8, 0, 0), datetime(2026, 9, 9, 0, 0), datetime(2026, 9, 10, 0, 0)],
    )
    client = _client(session_factory, monkeypatch)
    assert len(_reminder_rows(session_factory, item_id)) == 3

    resp = client.patch(f"/api/items/{item_id}", json={"reminders": ["2026-10-01T08:00:00+10:00"]})
    assert resp.status_code == 200
    assert [r["remind_at"] for r in resp.json()["reminders"]] == ["2026-09-30T22:00:00+00:00"]
    # 整体替换：库里恰好 1 个，被移除的两行真的从 reminders 表消失了
    rows = _reminder_rows(session_factory, item_id)
    assert len(rows) == 1
    assert rows[0].remind_at == datetime(2026, 9, 30, 22, 0)


# 回归：PATCH 的新集合与旧集合有交集时，只动差集（先 INSERT 后 DELETE 会撞
# UNIQUE(item_id, remind_at) 直接 500）；无交集的整体替换走的是另一条路径，上面
# 的 test_patch_replaces_reminders_entirely 已覆盖。时刻取终审原场景：
_TUE = "2026-09-08T10:00:00+10:00"   # → naive UTC 2026-09-08 00:00
_FRI = "2026-09-11T10:00:00+10:00"   # → naive UTC 2026-09-11 00:00
_WED = "2026-09-09T10:00:00+10:00"   # → naive UTC 2026-09-09 00:00


def test_patch_shrinks_overlapping_reminders(session_factory, monkeypatch):
    """原有 [周二, 周五] → PATCH [周二] → 200，库里恰好 1 行且是周二。

    本次缺陷的直接回归：新集合 ⊂ 旧集合（删掉其中一个），clear+重建会 500。
    """
    _seed(session_factory)
    item_id = _add_manual(
        session_factory,
        remind_at=[_offset_naive_utc(_TUE), _offset_naive_utc(_FRI)],
    )
    client = _client(session_factory, monkeypatch)

    resp = client.patch(f"/api/items/{item_id}", json={"reminders": [_TUE]})
    assert resp.status_code == 200
    assert [r["remind_at"] for r in resp.json()["reminders"]] == ["2026-09-08T00:00:00+00:00"]
    rows = _reminder_rows(session_factory, item_id)
    assert len(rows) == 1
    assert rows[0].remind_at == _offset_naive_utc(_TUE)


def test_patch_identical_reminders_keeps_ids_stable(session_factory, monkeypatch):
    """原有 [周二, 周五] → PATCH [周二, 周五]（完全相同）→ 200，库里仍是 2 行，
    且两行的 id 与 PATCH 前相同（没有无谓的删了重建）。"""
    _seed(session_factory)
    item_id = _add_manual(
        session_factory,
        remind_at=[_offset_naive_utc(_TUE), _offset_naive_utc(_FRI)],
    )
    client = _client(session_factory, monkeypatch)
    before = {r.remind_at: r.id for r in _reminder_rows(session_factory, item_id)}

    resp = client.patch(f"/api/items/{item_id}", json={"reminders": [_TUE, _FRI]})
    assert resp.status_code == 200
    rows = _reminder_rows(session_factory, item_id)
    assert len(rows) == 2
    assert {r.remind_at: r.id for r in rows} == before


def test_patch_grows_overlapping_reminders(session_factory, monkeypatch):
    """原有 [周二] → PATCH [周二, 周五] → 200，库里 2 行，周二那行 id 不变。"""
    _seed(session_factory)
    item_id = _add_manual(session_factory, remind_at=[_offset_naive_utc(_TUE)])
    client = _client(session_factory, monkeypatch)
    tue_id = _reminder_rows(session_factory, item_id)[0].id

    resp = client.patch(f"/api/items/{item_id}", json={"reminders": [_TUE, _FRI]})
    assert resp.status_code == 200
    rows = _reminder_rows(session_factory, item_id)
    assert len(rows) == 2
    assert [r.remind_at for r in rows] == [_offset_naive_utc(_TUE), _offset_naive_utc(_FRI)]
    assert rows[0].id == tue_id  # 交集的周二行原样保留，id 稳定


def test_patch_disjoint_reminders_replaces_all(session_factory, monkeypatch):
    """原有 [周二, 周五] → PATCH [周三]（完全不相交）→ 200，库里 1 行。"""
    _seed(session_factory)
    item_id = _add_manual(
        session_factory,
        remind_at=[_offset_naive_utc(_TUE), _offset_naive_utc(_FRI)],
    )
    client = _client(session_factory, monkeypatch)

    resp = client.patch(f"/api/items/{item_id}", json={"reminders": [_WED]})
    assert resp.status_code == 200
    assert [r["remind_at"] for r in resp.json()["reminders"]] == ["2026-09-09T00:00:00+00:00"]
    rows = _reminder_rows(session_factory, item_id)
    assert len(rows) == 1
    assert rows[0].remind_at == _offset_naive_utc(_WED)


def test_patch_empty_clears_and_missing_key_keeps(session_factory, monkeypatch):
    _seed(session_factory)
    client = _client(session_factory, monkeypatch)

    # PATCH 传 [] → 清空
    item_id = _add_manual(session_factory, remind_at=[datetime(2026, 9, 8, 0, 0)])
    resp = client.patch(f"/api/items/{item_id}", json={"reminders": []})
    assert resp.status_code == 200
    assert resp.json()["reminders"] == []
    assert _reminder_rows(session_factory, item_id) == []

    # PATCH 不传 reminders 键 → 提醒一个都不动（没给的字段不受影响）
    other_id = _add_manual(session_factory, remind_at=[datetime(2026, 9, 8, 0, 0)])
    resp = client.patch(f"/api/items/{other_id}", json={"title": "只改标题"})
    assert resp.status_code == 200
    rows = _reminder_rows(session_factory, other_id)
    assert len(rows) == 1
    assert rows[0].remind_at == datetime(2026, 9, 8, 0, 0)

    # PATCH 传 null 与传 [] 同义：清空（pydantic 的 list[str] | None，null 没有第三种含义）
    resp = client.patch(f"/api/items/{other_id}", json={"reminders": None})
    assert resp.status_code == 200
    assert resp.json()["reminders"] == []
    assert _reminder_rows(session_factory, other_id) == []


def test_patch_email_item_reminders_ok_but_title_still_not(session_factory, monkeypatch):
    """reminders 不受 not_editable 限制：邮件条目也能加/改提醒；改 title 仍是 400。"""
    email_item_id = _seed(session_factory)
    client = _client(session_factory, monkeypatch)

    resp = client.patch(
        f"/api/items/{email_item_id}", json={"reminders": ["2026-09-08T10:00:00+10:00"]}
    )
    assert resp.status_code == 200
    assert [r["remind_at"] for r in resp.json()["reminders"]] == ["2026-09-08T00:00:00+00:00"]
    rows = _reminder_rows(session_factory, email_item_id)
    assert len(rows) == 1

    # 同一个邮件条目改 title 仍然 not_editable（证明只放开了提醒）
    resp = client.patch(f"/api/items/{email_item_id}", json={"title": "改邮件任务"})
    assert resp.status_code == 400
    assert resp.json() == {"code": "not_editable"}
    assert len(_reminder_rows(session_factory, email_item_id)) == 1  # 提醒没被动


def test_patch_other_users_item_reminders_404(session_factory, monkeypatch):
    """多用户隔离：A 的条目 B 改不了提醒（404，不暴露存在性）。"""
    _seed(session_factory)
    a_id = _add_manual(session_factory, sub="user-1", remind_at=[datetime(2026, 9, 8, 0, 0)])
    client_b = _client(session_factory, monkeypatch, sub="user-2")

    resp = client_b.patch(f"/api/items/{a_id}", json={"reminders": ["2026-10-01T08:00:00+10:00"]})
    assert resp.status_code == 404
    assert resp.json() == {"code": "not_found"}
    assert len(_reminder_rows(session_factory, a_id)) == 1  # A 的提醒没被动


# ── DELETE /api/items/{id} ─────────────────────────────────────


def test_delete_manual_item_cascades_reminders(session_factory, monkeypatch):
    _seed(session_factory)
    item_id = _add_manual(
        session_factory, remind_at=[datetime(2026, 9, 8, 0, 0), datetime(2026, 9, 9, 0, 0)]
    )
    client = _client(session_factory, monkeypatch)
    assert len(_reminder_rows(session_factory, item_id)) == 2

    resp = client.delete(f"/api/items/{item_id}")
    assert resp.status_code == 204
    assert _reminder_rows(session_factory, item_id) == []  # 提醒行跟着条目一起消失
    with session_factory() as s:  # 整表没有残留
        assert s.execute(select(Reminder)).scalars().all() == []


# ── GET /api/items ─────────────────────────────────────────────


def test_list_items_each_carries_reminders(session_factory, monkeypatch):
    _seed(session_factory)
    manual_id = _add_manual(session_factory, remind_at=[datetime(2026, 9, 8, 0, 0)])
    client = _client(session_factory, monkeypatch)

    items = client.get("/api/items").json()["items"]
    assert {i["title"] for i in items} == {"交学费", "手动任务"}
    for item in items:  # 每项都带 reminders 键（空则 []）
        assert "reminders" in item
        assert isinstance(item["reminders"], list)
    by_id = {i["id"]: i for i in items}
    assert by_id[manual_id]["reminders"] == [
        {"id": by_id[manual_id]["reminders"][0]["id"], "remind_at": "2026-09-08T00:00:00+00:00"}
    ]
    assert by_id[[i for i in by_id if i != manual_id][0]]["reminders"] == []


# ── /api/items/parse 与 /quick ─────────────────────────────────


def test_parse_returns_absolute_instants_converted_by_tz(session_factory, monkeypatch):
    """FakeLLM 给本地墙上时刻、请求带 tz → 响应里是换算后的带偏移绝对时刻。"""
    _seed(session_factory)
    fake = FakeLLM(result=_parse_result(reminders=["2026-09-08T10:00"]))
    client = _client(session_factory, monkeypatch, llm=fake)

    resp = client.post("/api/items/parse", json={"text": "周二提一次、周五再提一次", "tz": "Australia/Sydney"})
    assert resp.status_code == 200
    expected = _wall_to_naive_utc("2026-09-08T10:00", "Australia/Sydney")
    assert resp.json()["reminders"] == [_naive_to_iso(expected)]


@pytest.mark.parametrize("bad_tz", ["", "Nope/Nope", "/etc/localtime"])
def test_parse_invalid_tz_falls_back_to_settings_zone(session_factory, monkeypatch, bad_tz):
    """非法 tz 不报错、回落 settings.local_timezone。三种都测：空串与绝对路径抛的是
    ValueError 而不是 ZoneInfoNotFoundError，只 catch 后者会 500。"""
    _seed(session_factory)
    fake = FakeLLM(result=_parse_result(reminders=["2026-09-08T10:00"]))
    # Kiritimati = UTC+14：与 UTC 差出跨天，能证明真的按配置时区换算而非 UTC
    client = _client(
        session_factory, monkeypatch, llm=fake,
        settings=_settings(local_timezone="Pacific/Kiritimati"),
    )

    resp = client.post("/api/items/parse", json={"text": "周五叫我", "tz": bad_tz})
    assert resp.status_code == 200, bad_tz
    expected = _wall_to_naive_utc("2026-09-08T10:00", "Pacific/Kiritimati")
    assert resp.json()["reminders"] == [_naive_to_iso(expected)], bad_tz


def test_quick_persists_reminders_when_ai_parsed(session_factory, monkeypatch):
    """/quick 解析出提醒 → 提醒一起落库（naive UTC），响应带偏移。"""
    _seed(session_factory)
    fake = FakeLLM(result=_parse_result(reminders=["2026-09-08T10:00"]))
    client = _client(session_factory, monkeypatch, llm=fake)

    resp = client.post(
        "/api/items/quick", json={"text": "周二提醒我去修空调", "tz": "Australia/Sydney"}
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["ai_parsed"] is True
    expected = _wall_to_naive_utc("2026-09-08T10:00", "Australia/Sydney")
    assert data["item"]["reminders"] == [
        {"id": data["item"]["reminders"][0]["id"], "remind_at": _naive_to_iso(expected)}
    ]
    rows = _reminder_rows(session_factory, data["item"]["id"])
    assert len(rows) == 1
    assert rows[0].remind_at == expected


def test_quick_fallback_path_has_no_reminders(session_factory, monkeypatch):
    """兜底路径（LLM 挂）：原文建条目，不挂任何提醒。"""
    _seed(session_factory)
    fake = FakeLLM(exc=RuntimeError("LLM 挂了"))
    client = _client(session_factory, monkeypatch, llm=fake)

    resp = client.post("/api/items/quick", json={"text": "周四去银行换卡"})
    assert resp.status_code == 201
    data = resp.json()
    assert data["ai_parsed"] is False
    assert data["item"]["reminders"] == []
    assert _reminder_rows(session_factory, data["item"]["id"]) == []


def test_quick_dirty_reminders_keeps_only_valid(session_factory, monkeypatch):
    """FakeLLM 返回脏 reminders（非串/不可解析）→ 归一化只留合法那一项并落库。"""
    _seed(session_factory)
    fake = FakeLLM(result=_parse_result(reminders=["明天", 123, "2026-09-08T10:00"]))
    client = _client(session_factory, monkeypatch, llm=fake)

    resp = client.post(
        "/api/items/quick", json={"text": "周二提醒我去修空调", "tz": "Australia/Sydney"}
    )
    assert resp.status_code == 201
    assert resp.json()["ai_parsed"] is True
    expected = _wall_to_naive_utc("2026-09-08T10:00", "Australia/Sydney")
    reminders = resp.json()["item"]["reminders"]
    assert len(reminders) == 1
    assert reminders[0]["remind_at"] == _naive_to_iso(expected)
    rows = _reminder_rows(session_factory, resp.json()["item"]["id"])
    assert len(rows) == 1
    assert rows[0].remind_at == expected
