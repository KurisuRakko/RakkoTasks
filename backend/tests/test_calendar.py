"""日历订阅测试：build_ics 纯函数（结构/转义/折行）+ 三个日历端点（令牌/rotate/公开 .ics 内容）。"""
from datetime import date, datetime, timezone

from fastapi.testclient import TestClient

from app.api import create_app
from app.auth import CurrentUser, require_auth
from app.calendar import build_ics
from app.config import Settings
from app.models import Account, Email, Item, User

HEADER_LINES = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//RakkoTasks//CN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:RakkoTasks",
    "X-PUBLISHED-TTL:PT1H",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
]


def _settings() -> Settings:
    return Settings(database_path=":memory:", llm_base_url="http://x", llm_api_key="k")


def _item(item_id: int, title: str, due: str, *, summary: str = "", category: str = "学业",
          importance: str = "normal") -> Item:
    """脱离 DB 构造 Item 实例（build_ics 只读属性，不需要落库）。"""
    it = Item(
        title=title, summary=summary, category=category, importance=importance,
        due_date=date.fromisoformat(due) if due else None,
    )
    it.id = item_id
    return it


def _seed_calendar(session_factory) -> tuple[str, dict]:
    """user-1 带已知令牌 + 四个条目（含日期的手动/邮件/无日期/done）+ user-2 一条。

    返回 (token, {"open_manual": id, "open_email": id, "done": id, "nodate": id})。
    """
    token = "tok-abc-123"
    with session_factory() as s:
        s.add(User(sub="user-1", email="a@example.com", calendar_token=token))
        s.add(User(sub="user-2", email="b@example.com", calendar_token="tok-user2"))
        s.commit()
        acc = Account(user_sub="user-1", name="邮箱", kind="gmail", email="a@example.com", status="ok")
        s.add(acc)
        s.commit()
        em = Email(account_id=acc.id, message_id="<m1>", subject="通知", sender="x@x.com", llm_state="done")
        s.add(em)
        s.commit()
        open_manual = Item(user_sub="user-1", email_id=None, title="手动待办", summary="带日期的手动条目",
                           category="个人", due_date=date(2026, 9, 4), importance="high", status="open")
        open_email = Item(user_sub="user-1", email_id=em.id, title="邮件待办", summary="", category="学业",
                          due_date=date(2026, 9, 5), importance="normal", status="open")
        done = Item(user_sub="user-1", email_id=None, title="已完成", summary="", category="个人",
                    due_date=date(2026, 9, 6), importance="normal", status="done")
        nodate = Item(user_sub="user-1", email_id=None, title="无日期", summary="", category="个人",
                      due_date=None, importance="normal", status="open")
        b_item = Item(user_sub="user-2", email_id=None, title="乙的私事", summary="", category="个人",
                      due_date=date(2026, 9, 7), importance="normal", status="open")
        s.add_all([open_manual, open_email, done, nodate, b_item])
        s.commit()
        ids = {"open_manual": open_manual.id, "open_email": open_email.id,
               "done": done.id, "nodate": nodate.id}
        return token, ids


def _client(session_factory, monkeypatch, sub: str = "user-1"):
    app = create_app(settings=_settings(), session_factory=session_factory)
    app.dependency_overrides[require_auth] = lambda: CurrentUser(sub=sub, email=f"{sub}@example.com", name="甲")
    return TestClient(app)


# ── build_ics 纯函数 ─────────────────────────────────────────────


def test_build_ics_empty_skeleton():
    ics = build_ics([], now=datetime(2026, 9, 4, 1, 2, 3, tzinfo=timezone.utc))
    assert ics.endswith("\r\n")
    lines = ics.split("\r\n")
    assert lines[-2] == "END:VCALENDAR"  # 末尾空串由结尾 CRLF 产生
    assert lines[: len(HEADER_LINES)] == HEADER_LINES
    assert "VEVENT" not in ics


def test_build_ics_event_structure_and_escape():
    now = datetime(2026, 9, 4, 1, 2, 3, tzinfo=timezone.utc)
    item = _item(7, "买书;提交,报告\n第二行", "2026-09-04", summary="摘要,含逗号", category="工作", importance="high")
    ics = build_ics([item], now=now)
    assert "UID:item-7@rakkotasks" in ics
    assert "DTSTAMP:20260904T010203Z" in ics
    assert "DTSTART;VALUE=DATE:20260904" in ics
    assert "DTEND;VALUE=DATE:20260905" in ics
    assert "SUMMARY:[重要] 买书\\;提交\\,报告\\n第二行" in ics
    assert "DESCRIPTION:摘要\\,含逗号" in ics
    assert "CATEGORIES:工作" in ics
    assert "BEGIN:VALARM" in ics
    assert "ACTION:DISPLAY" in ics
    assert "TRIGGER;RELATED=START:PT10H" in ics
    assert ics.count("DESCRIPTION:") == 2  # VEVENT 级 + VALARM 级
    assert ics.count("END:VALARM") == 1
    assert ics.count("END:VEVENT") == 1
    # 结束前有 END:VEVENT → END:VCALENDAR 收尾
    assert ics.rstrip("\r\n").endswith("END:VEVENT\r\nEND:VCALENDAR")


def test_build_ics_empty_summary_omits_description_line():
    item = _item(8, "没有摘要", "2026-09-10", summary="", importance="normal")
    ics = build_ics([item], now=datetime(2026, 9, 4, tzinfo=timezone.utc))
    assert "SUMMARY:没有摘要" in ics
    assert ics.count("DESCRIPTION:") == 1  # 只剩 VALARM 里那条（与 SUMMARY 相同），VEVENT 级省略
    desc_lines = [ln for ln in ics.split("\r\n") if ln.startswith("DESCRIPTION:")]
    assert desc_lines == ["DESCRIPTION:没有摘要"]


def test_build_ics_normal_importance_no_prefix_and_order():
    a = _item(1, "普通任务", "2026-09-20", importance="normal")
    b = _item(2, "低重要", "2026-09-21", importance="low")
    ics = build_ics([a, b], now=datetime(2026, 9, 4, tzinfo=timezone.utc))
    assert "SUMMARY:普通任务" in ics
    assert "SUMMARY:低重要" in ics
    assert "[重要] " not in ics


def test_build_ics_long_chinese_title_folded_within_75_bytes():
    title = "今天要完成的事项清单" * 12  # 120 个中文字 ≈ 360 字节，远超 75
    item = _item(9, title, "2026-09-30", summary="", importance="normal")
    ics = build_ics([item], now=datetime(2026, 9, 4, tzinfo=timezone.utc))
    lines = ics.split("\r\n")
    # 每个物理行 ≤75 UTF-8 字节（RFC 5545 折行上限）
    for ln in [x for x in lines if x]:
        assert len(ln.encode("utf-8")) <= 75, ln
    # 折行拼回与原文一致：SUMMARY: 起到下一个非续行（空格开头=续行）为止
    start = next(i for i, ln in enumerate(lines) if ln.startswith("SUMMARY:"))
    end = next(i for i in range(start + 1, len(lines)) if lines[i] and not lines[i].startswith(" "))
    joined = lines[start] + "".join(lines[i][1:] for i in range(start + 1, end))
    assert joined == f"SUMMARY:{title}"
    assert end - start > 1  # 确实发生了折行


# ── 端点 ─────────────────────────────────────────────────────────


def test_get_calendar_token_generates_and_keeps(session_factory, monkeypatch):
    token, _ids = _seed_calendar(session_factory)
    # 先清掉 user-1 的令牌，验证「无令牌时生成并落库」路径
    with session_factory() as s:
        s.get(User, "user-1").calendar_token = None
        s.commit()
    client = _client(session_factory, monkeypatch)

    resp = client.get("/api/calendar")
    assert resp.status_code == 200
    new_token = resp.json()["token"]
    assert isinstance(new_token, str) and len(new_token) >= 32 and new_token != token

    # 已落库，且再次调用返回同一令牌
    with session_factory() as s:
        stored = s.get(User, "user-1").calendar_token
    assert stored == new_token
    assert client.get("/api/calendar").json()["token"] == new_token


def test_rotate_calendar_token_invalidates_old(session_factory, monkeypatch):
    token, _ids = _seed_calendar(session_factory)
    client = _client(session_factory, monkeypatch)

    old_feed = client.get(f"/api/calendar/{token}.ics")
    assert old_feed.status_code == 200

    resp = client.post("/api/calendar/rotate")
    assert resp.status_code == 200
    new_token = resp.json()["token"]
    assert new_token != token
    with session_factory() as s:
        assert s.get(User, "user-1").calendar_token == new_token

    # 旧令牌立即失效，新令牌可用
    assert client.get(f"/api/calendar/{token}.ics").status_code == 404
    assert client.get(f"/api/calendar/{new_token}.ics").status_code == 200


def test_ics_public_without_bearer_but_others_authed(session_factory, monkeypatch):
    token, _ids = _seed_calendar(session_factory)
    plain = TestClient(create_app(settings=_settings(), session_factory=session_factory))

    # 无任何鉴权覆盖：.ics 可匿名访问（令牌即凭据）
    resp = plain.get(f"/api/calendar/{token}.ics")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/calendar")
    assert "filename=\"rakkotasks.ics\"" in resp.headers["content-disposition"]

    # 其余 /api 端点仍要求 Bearer
    assert plain.get("/api/items").status_code == 401
    assert plain.get("/api/calendar").status_code == 401

    # 未知令牌 404
    resp = plain.get("/api/calendar/nope.ics")
    assert resp.status_code == 404
    assert resp.json() == {"code": "not_found"}


def test_ics_contains_open_dated_items_including_manual(session_factory, monkeypatch):
    token, ids = _seed_calendar(session_factory)
    client = _client(session_factory, monkeypatch)
    resp = client.get(f"/api/calendar/{token}.ics")
    assert resp.status_code == 200

    text = resp.text
    assert f"UID:item-{ids['open_manual']}@rakkotasks" in text  # 手动条目进订阅
    assert f"UID:item-{ids['open_email']}@rakkotasks" in text  # 邮件条目也进订阅
    assert f"UID:item-{ids['done']}@rakkotasks" not in text  # done 不进
    assert f"UID:item-{ids['nodate']}@rakkotasks" not in text  # 无日期不进
    assert "SUMMARY:[重要] 手动待办" in text  # high 前缀
    assert "SUMMARY:邮件待办" in text  # summary 为空 → VEVENT 无 DESCRIPTION，但 VALARM 有
    assert "DTSTART;VALUE=DATE:20260904" in text
    assert "DTEND;VALUE=DATE:20260905" in text
    assert text.count("END:VEVENT") == 2

    # 用户隔离：user-2 的条目不在 user-1 的订阅里
    assert "乙的私事" not in text
