"""CalDAV 协议层测试：鉴权与限流、发现与属性、枚举与保留窗口、GET/PUT/DELETE、REPORT、
拒绝类方法、多用户隔离、永不返回 JSON、SPA fallback 不吞路由。

全部经 TestClient.request(<方法>, ...) 走真实路由；Basic 凭据用真实的应用密码 hash。
"""
from __future__ import annotations

import base64
from datetime import date, datetime, timedelta
from pathlib import Path

from urllib.parse import quote

from fastapi.testclient import TestClient

from app.api import create_app
from app.auth import CurrentUser, require_auth
from app.caldav.auth import hash_app_password
from app.config import Settings
from app.models import Account, Email, Item, User

PW_A = "password-for-a"
PW_B = "password-for-b"
COLL = "/caldav/calendars/me/tasks/"

APPLE_BODY = (
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Apple Inc.//iOS 18.0//EN\r\n"
    "BEGIN:VTODO\r\nUID:{uid}\r\nSUMMARY:{summary}\r\nDESCRIPTION:第一行\\n第二行\r\n"
    "DUE;TZID=Australia/Sydney:20260910T090000\r\nX-APPLE-SORT-ORDER:12345\r\n{extra}"
    "BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER;RELATED=START:PT0S\r\nX-WR-ALARMUID:al-1\r\nEND:VALARM\r\n"
    "END:VTODO\r\nEND:VCALENDAR\r\n"
)


def _settings(**extra) -> Settings:
    return Settings(database_path=":memory:", llm_base_url="http://x", llm_api_key="k", **extra)


def _basic(user: str, pw: str) -> dict[str, str]:
    return {"Authorization": "Basic " + base64.b64encode(f"{user}:{pw}".encode()).decode()}


def _seed(session_factory) -> dict:
    """用户 A：邮件条目 + 手动条目 + 10 天前完成 + 60 天前完成；用户 B：一条手动条目。"""
    now = datetime.now()
    with session_factory() as s:
        s.add_all(
            [
                User(sub="sub-a", email="a@example.com", name="甲", caldav_password_hash=hash_app_password(PW_A)),
                User(sub="sub-b", email="b@example.com", name="乙", caldav_password_hash=hash_app_password(PW_B)),
                User(sub="sub-c", email="c@example.com", name="丙"),  # 未开通 CalDAV
            ]
        )
        s.commit()
        acc = Account(user_sub="sub-a", name="邮箱", kind="gmail", email="a@example.com", status="ok")
        s.add(acc)
        s.commit()
        em = Email(account_id=acc.id, message_id="<m1>", subject="通知", sender="x@y", text_body="", llm_state="done")
        s.add(em)
        s.commit()
        mail_item = Item(
            user_sub="sub-a", email_id=em.id, title="邮件任务", summary="来自邮件", category="学业",
            due_date=date(2026, 9, 20), status="open", caldav_uid="MAILUID",
        )
        manual = Item(
            user_sub="sub-a", email_id=None, title="手动任务", summary="", category="个人", status="open", caldav_uid="MANUALUID",
        )
        recent_done = Item(
            user_sub="sub-a", email_id=None, title="最近完成", summary="", category="个人", status="done",
            done_at=now - timedelta(days=10), caldav_uid="RECENTDONE",
        )
        old_done = Item(
            user_sub="sub-a", email_id=None, title="久远完成", summary="", category="个人", status="done",
            done_at=now - timedelta(days=60), caldav_uid="OLDDONE",
        )
        other = Item(user_sub="sub-b", email_id=None, title="乙的任务", summary="", category="个人", status="open", caldav_uid="BUID")
        s.add_all([mail_item, manual, recent_done, old_done, other])
        s.commit()
        return {"mail_id": mail_item.id, "manual_id": manual.id}


def _client(session_factory, settings: Settings | None = None) -> TestClient:
    app = create_app(settings=settings or _settings(), session_factory=session_factory)
    app.dependency_overrides[require_auth] = lambda: CurrentUser(sub="sub-a", email="a@example.com", name="甲")
    return TestClient(app)


def _propfind(client, path, depth="0", body=b"", auth=None):
    # auth 传空字典表示「不带凭据」，None 才回退到用户 A
    headers = _basic("a@example.com", PW_A) if auth is None else auth
    return client.request("PROPFIND", path, headers={**headers, "Depth": depth}, content=body)


PROP_CTAG = b'<?xml version="1.0"?><propfind xmlns="DAV:" xmlns:cs="http://calendarserver.org/ns/"><prop><cs:getctag/><getetag/></prop></propfind>'


def _ctag(client) -> str:
    text = _propfind(client, COLL, body=PROP_CTAG).text
    start = text.index("<cs:getctag>") + len("<cs:getctag>")
    return text[start:text.index("</cs:getctag>")]


# ── 鉴权 ────────────────────────────────────────────────────────────

def test_unauthenticated_propfind_401_with_basic_challenge(session_factory):
    _seed(session_factory)
    r = _propfind(_client(session_factory), "/caldav/", auth={})
    assert r.status_code == 401
    assert r.headers["www-authenticate"].startswith("Basic realm=")
    assert "json" not in r.headers.get("content-type", "")
    assert r.text == ""


def test_wrong_password_401_then_429_after_burst(session_factory):
    _seed(session_factory)
    client = _client(session_factory)
    codes = [_propfind(client, "/caldav/", auth=_basic("a@example.com", "nope")).status_code for _ in range(31)]
    assert codes[:30] == [401] * 30
    assert codes[30] == 429
    r = _propfind(client, "/caldav/", auth=_basic("a@example.com", "nope"))
    assert r.headers.get("retry-after") == "60"


def test_basic_auth_accepts_email_and_sub_as_username(session_factory):
    _seed(session_factory)
    client = _client(session_factory)
    assert _propfind(client, "/caldav/", auth=_basic("a@example.com", PW_A)).status_code == 207
    assert _propfind(client, "/caldav/", auth=_basic("sub-a", PW_A)).status_code == 207


def test_null_password_hash_never_authenticates(session_factory):
    _seed(session_factory)
    client = _client(session_factory)
    assert _propfind(client, "/caldav/", auth=_basic("c@example.com", "")).status_code == 401
    assert _propfind(client, "/caldav/", auth=_basic("c@example.com", "anything")).status_code == 401


def test_successful_requests_do_not_consume_rate_limit(session_factory):
    _seed(session_factory)
    client = _client(session_factory)
    for _ in range(40):
        assert _propfind(client, "/caldav/").status_code == 207


# ── 发现与属性 ──────────────────────────────────────────────────────

def test_well_known_redirects_301_for_get_and_propfind(session_factory):
    client = _client(session_factory)
    for method in ("GET", "PROPFIND"):
        r = client.request(method, "/.well-known/caldav", follow_redirects=False)
        assert r.status_code == 301
        assert r.headers["location"] == "/caldav/"


def test_options_advertises_dav_calendar_access(session_factory):
    _seed(session_factory)
    r = _client(session_factory).request("OPTIONS", "/caldav/", headers=_basic("a@example.com", PW_A))
    assert r.status_code == 200
    assert "calendar-access" in r.headers["dav"]
    for m in ("PROPFIND", "REPORT", "PUT", "DELETE"):
        assert m in r.headers["allow"]


def test_propfind_root_returns_current_user_principal(session_factory):
    _seed(session_factory)
    body = b'<?xml version="1.0"?><propfind xmlns="DAV:"><prop><current-user-principal/></prop></propfind>'
    r = _propfind(_client(session_factory), "/caldav/", body=body)
    assert r.status_code == 207
    assert "<d:current-user-principal><d:href>/caldav/principals/me/</d:href></d:current-user-principal>" in r.text


def test_propfind_principal_home_set_and_schedule_props_404(session_factory):
    _seed(session_factory)
    body = (
        b'<?xml version="1.0"?><propfind xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
        b"<prop><c:calendar-home-set/><c:schedule-inbox-URL/><c:calendar-user-address-set/></prop></propfind>"
    )
    r = _propfind(_client(session_factory), "/caldav/principals/me/", body=body)
    assert "<c:calendar-home-set><d:href>/caldav/calendars/me/</d:href></c:calendar-home-set>" in r.text
    assert "mailto:a@example.com" in r.text
    missing_block = r.text.split("HTTP/1.1 404 Not Found")[0].rsplit("<d:propstat>", 1)[1]
    assert "<c:schedule-inbox-URL/>" in missing_block


def test_propfind_home_depth1_lists_single_vtodo_collection(session_factory):
    _seed(session_factory)
    r = _propfind(_client(session_factory), "/caldav/calendars/me/", depth="1")
    assert r.status_code == 207
    assert r.text.count("<d:response>") == 2
    assert '<c:comp name="VTODO"/>' in r.text
    assert "<cs:getctag>" in r.text
    assert "<d:displayname>RakkoTasks</d:displayname>" in r.text
    assert "<ical:calendar-color>#1976D2FF</ical:calendar-color>" in r.text
    assert "<c:calendar/>" in r.text


def test_propfind_collection_depth1_lists_members_within_retention(session_factory):
    _seed(session_factory)
    r = _propfind(_client(session_factory), COLL, depth="1", body=PROP_CTAG)
    assert r.status_code == 207
    assert r.text.count(".ics</d:href>") == 3
    assert "MAILUID.ics" in r.text and "MANUALUID.ics" in r.text and "RECENTDONE.ics" in r.text
    assert "OLDDONE.ics" not in r.text
    assert "BUID.ics" not in r.text
    assert r.text.count("<d:getetag>") == 3


def test_propfind_unknown_props_get_404_propstat(session_factory):
    _seed(session_factory)
    body = (
        b'<?xml version="1.0"?><propfind xmlns="DAV:"><prop><sync-token/><quota-available-bytes/>'
        b"<displayname/></prop></propfind>"
    )
    r = _propfind(_client(session_factory), COLL, body=body)
    ok_block, missing_block = r.text.split("HTTP/1.1 200 OK")[0], r.text.split("HTTP/1.1 200 OK")[1]
    assert "<d:displayname>RakkoTasks</d:displayname>" in ok_block
    assert "<d:sync-token/>" in missing_block and "<d:quota-available-bytes/>" in missing_block
    assert "HTTP/1.1 404 Not Found" in missing_block


def test_propfind_allprop_and_propname(session_factory):
    _seed(session_factory)
    client = _client(session_factory)
    allprop = _propfind(client, COLL, body=b'<?xml version="1.0"?><propfind xmlns="DAV:"><allprop/></propfind>')
    assert allprop.status_code == 207 and "<cs:getctag>" in allprop.text
    propname = _propfind(client, COLL, body=b'<?xml version="1.0"?><propfind xmlns="DAV:"><propname/></propfind>')
    assert propname.status_code == 207
    assert "<cs:getctag/>" in propname.text and "<cs:getctag>" not in propname.text


def test_propfind_depth_infinity_403(session_factory):
    _seed(session_factory)
    r = _propfind(_client(session_factory), COLL, depth="infinity")
    assert r.status_code == 403
    assert "propfind-finite-depth" in r.text


def test_multistatus_is_207_xml_utf8(session_factory):
    _seed(session_factory)
    r = _propfind(_client(session_factory), "/caldav/")
    assert r.status_code == 207
    assert r.headers["content-type"] == "application/xml; charset=utf-8"
    assert r.text.startswith("<?xml")


def test_getctag_stable_then_changes_after_rest_patch(session_factory):
    ids = _seed(session_factory)
    client = _client(session_factory)
    first, second = _ctag(client), _ctag(client)
    assert first == second
    r = client.patch(f"/api/items/{ids['manual_id']}", json={"status": "done"})
    assert r.status_code == 200
    assert _ctag(client) != first


def test_aged_out_object_still_gettable_by_direct_href(session_factory):
    _seed(session_factory)
    r = _client(session_factory).get(f"{COLL}OLDDONE.ics", headers=_basic("a@example.com", PW_A))
    assert r.status_code == 200
    assert "STATUS:COMPLETED" in r.text


# ── GET / PUT / DELETE ──────────────────────────────────────────────

def test_get_object_returns_vtodo_with_etag_and_calendar_content_type(session_factory):
    _seed(session_factory)
    client = _client(session_factory)
    r = client.get(f"{COLL}MANUALUID.ics", headers=_basic("a@example.com", PW_A))
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/calendar")
    assert "BEGIN:VTODO" in r.text and "SUMMARY:手动任务" in r.text
    listing = _propfind(client, COLL, depth="1", body=PROP_CTAG).text
    assert f"<d:getetag>{r.headers['etag']}</d:getetag>".replace('"', "&quot;") in listing or r.headers["etag"] in listing


def test_head_object_has_etag_and_empty_body(session_factory):
    _seed(session_factory)
    r = _client(session_factory).head(f"{COLL}MANUALUID.ics", headers=_basic("a@example.com", PW_A))
    assert r.status_code == 200 and r.headers.get("etag") and r.content == b""


def test_get_on_collection_405_with_allow(session_factory):
    _seed(session_factory)
    r = _client(session_factory).get(COLL, headers=_basic("a@example.com", PW_A))
    assert r.status_code == 405 and "PROPFIND" in r.headers["allow"]


def test_put_creates_manual_item_with_personal_category_and_passthrough(session_factory):
    _seed(session_factory)
    client = _client(session_factory)
    body = APPLE_BODY.format(uid="NEW-1", summary="买牛奶", extra="")
    r = client.put(f"{COLL}NEW-1.ics", headers=_basic("a@example.com", PW_A), content=body.encode())
    assert r.status_code == 201 and r.headers.get("etag")
    with session_factory() as s:
        item = s.query(Item).filter(Item.caldav_uid == "NEW-1").one()
        assert item.email_id is None and item.user_sub == "sub-a" and item.category == "个人"
        assert item.title == "买牛奶" and item.summary == "第一行\n第二行" and item.due_date == date(2026, 9, 10)
        assert item.caldav_name is None and item.caldav_ics == body
    got = client.get(f"{COLL}NEW-1.ics", headers=_basic("a@example.com", PW_A))
    assert "BEGIN:VALARM" in got.text and "X-APPLE-SORT-ORDER:12345" in got.text
    assert "DUE;TZID=Australia/Sydney:20260910T090000" in got.text
    assert got.headers["etag"] == r.headers["etag"]


def test_put_with_different_filename_than_uid_stores_name(session_factory):
    _seed(session_factory)
    client = _client(session_factory)
    body = APPLE_BODY.format(uid="uid-inside", summary="改名", extra="")
    r = client.put(f"{COLL}file-name.ics", headers=_basic("a@example.com", PW_A), content=body.encode())
    assert r.status_code == 201
    with session_factory() as s:
        item = s.query(Item).filter(Item.caldav_uid == "uid-inside").one()
        assert item.caldav_name == "file-name"
    assert client.get(f"{COLL}file-name.ics", headers=_basic("a@example.com", PW_A)).status_code == 200


def test_put_if_none_match_star_on_existing_412(session_factory):
    _seed(session_factory)
    body = APPLE_BODY.format(uid="MANUALUID", summary="x", extra="")
    r = _client(session_factory).put(
        f"{COLL}MANUALUID.ics", headers={**_basic("a@example.com", PW_A), "If-None-Match": "*"}, content=body.encode()
    )
    assert r.status_code == 412


def test_put_stale_if_match_412_and_row_unchanged(session_factory):
    ids = _seed(session_factory)
    body = APPLE_BODY.format(uid="MANUALUID", summary="改坏了", extra="")
    r = _client(session_factory).put(
        f"{COLL}MANUALUID.ics", headers={**_basic("a@example.com", PW_A), "If-Match": '"stale"'}, content=body.encode()
    )
    assert r.status_code == 412
    with session_factory() as s:
        assert s.get(Item, ids["manual_id"]).title == "手动任务"


def test_put_matching_if_match_updates_and_returns_new_etag(session_factory):
    _seed(session_factory)
    client = _client(session_factory)
    auth = _basic("a@example.com", PW_A)
    current = client.get(f"{COLL}MANUALUID.ics", headers=auth).headers["etag"]
    body = APPLE_BODY.format(uid="MANUALUID", summary="改好了", extra="")
    r = client.put(f"{COLL}MANUALUID.ics", headers={**auth, "If-Match": current}, content=body.encode())
    assert r.status_code == 204
    assert r.headers["etag"] != current
    assert client.get(f"{COLL}MANUALUID.ics", headers=auth).headers["etag"] == r.headers["etag"]
    with session_factory() as s:
        assert s.query(Item).filter(Item.caldav_uid == "MANUALUID").one().title == "改好了"


def test_put_completed_marks_done_with_completed_timestamp(session_factory):
    ids = _seed(session_factory)
    body = APPLE_BODY.format(uid="MANUALUID", summary="做完", extra="STATUS:COMPLETED\r\nCOMPLETED:20260904T010000Z\r\nPERCENT-COMPLETE:100\r\n")
    r = _client(session_factory).put(f"{COLL}MANUALUID.ics", headers=_basic("a@example.com", PW_A), content=body.encode())
    assert r.status_code == 204
    with session_factory() as s:
        item = s.get(Item, ids["manual_id"])
        assert item.status == "done" and item.done_at == datetime(2026, 9, 4, 1, 0, 0)


def test_put_on_email_item_applies_status_only(session_factory):
    ids = _seed(session_factory)
    client = _client(session_factory)
    body = APPLE_BODY.format(uid="MAILUID", summary="改标题", extra="STATUS:COMPLETED\r\nPRIORITY:1\r\n")
    r = client.put(f"{COLL}MAILUID.ics", headers=_basic("a@example.com", PW_A), content=body.encode())
    assert r.status_code == 204
    with session_factory() as s:
        item = s.get(Item, ids["mail_id"])
        assert item.title == "邮件任务" and item.due_date == date(2026, 9, 20) and item.importance == "normal"
        assert item.status == "done" and item.done_at is not None
    got = client.get(f"{COLL}MAILUID.ics", headers=_basic("a@example.com", PW_A)).text
    assert "SUMMARY:邮件任务" in got and "STATUS:COMPLETED" in got


def test_put_priority_changes_manual_importance(session_factory):
    ids = _seed(session_factory)
    body = APPLE_BODY.format(uid="MANUALUID", summary="重要", extra="PRIORITY:1\r\n")
    _client(session_factory).put(f"{COLL}MANUALUID.ics", headers=_basic("a@example.com", PW_A), content=body.encode())
    with session_factory() as s:
        assert s.get(Item, ids["manual_id"]).importance == "high"


def test_put_body_without_vtodo_403_valid_calendar_data(session_factory):
    _seed(session_factory)
    r = _client(session_factory).put(
        f"{COLL}X.ics", headers=_basic("a@example.com", PW_A),
        content=b"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
    )
    assert r.status_code == 403 and "valid-calendar-data" in r.text


def test_put_oversized_body_413(session_factory):
    _seed(session_factory)
    r = _client(session_factory).put(f"{COLL}X.ics", headers=_basic("a@example.com", PW_A), content=b"A" * (256 * 1024 + 1))
    assert r.status_code == 413


def test_put_to_unknown_collection_404(session_factory):
    _seed(session_factory)
    body = APPLE_BODY.format(uid="Z", summary="z", extra="")
    r = _client(session_factory).put("/caldav/calendars/me/other/Z.ics", headers=_basic("a@example.com", PW_A), content=body.encode())
    assert r.status_code == 404


def test_delete_manual_item_204_and_row_removed(session_factory):
    ids = _seed(session_factory)
    r = _client(session_factory).delete(f"{COLL}MANUALUID.ics", headers=_basic("a@example.com", PW_A))
    assert r.status_code == 204
    with session_factory() as s:
        assert s.get(Item, ids["manual_id"]) is None


def test_delete_email_item_marks_done_and_keeps_row(session_factory):
    ids = _seed(session_factory)
    r = _client(session_factory).delete(f"{COLL}MAILUID.ics", headers=_basic("a@example.com", PW_A))
    assert r.status_code == 204
    with session_factory() as s:
        item = s.get(Item, ids["mail_id"])
        assert item is not None and item.status == "done" and item.done_at is not None


def test_delete_stale_if_match_412(session_factory):
    _seed(session_factory)
    r = _client(session_factory).delete(f"{COLL}MANUALUID.ics", headers={**_basic("a@example.com", PW_A), "If-Match": '"stale"'})
    assert r.status_code == 412


def test_delete_unknown_404(session_factory):
    _seed(session_factory)
    assert _client(session_factory).delete(f"{COLL}NOPE.ics", headers=_basic("a@example.com", PW_A)).status_code == 404


# ── REPORT ──────────────────────────────────────────────────────────

MULTIGET = (
    b'<?xml version="1.0"?><c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
    b"<d:prop><d:getetag/><c:calendar-data/></d:prop>"
    b"<d:href>/caldav/calendars/me/tasks/MANUALUID.ics</d:href><d:href>/caldav/calendars/me/tasks/NOPE.ics</d:href>"
    b"</c:calendar-multiget>"
)


def test_report_multiget_returns_calendar_data_and_404_for_unknown_href(session_factory):
    _seed(session_factory)
    r = _client(session_factory).request("REPORT", COLL, headers={**_basic("a@example.com", PW_A), "Depth": "1"}, content=MULTIGET)
    assert r.status_code == 207
    assert r.text.count("<d:response>") == 2
    assert "SUMMARY:手动任务" in r.text
    assert "<d:href>/caldav/calendars/me/tasks/NOPE.ics</d:href><d:status>HTTP/1.1 404 Not Found</d:status>" in r.text


def _query(comp: str) -> bytes:
    return (
        '<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
        '<d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR">'
        f'<c:comp-filter name="{comp}"/></c:comp-filter></c:filter></c:calendar-query>'
    ).encode()


def test_report_calendar_query_vtodo_returns_members_and_vevent_returns_none(session_factory):
    _seed(session_factory)
    client = _client(session_factory)
    r = client.request("REPORT", COLL, headers={**_basic("a@example.com", PW_A), "Depth": "1"}, content=_query("VTODO"))
    assert r.status_code == 207 and r.text.count("<d:response>") == 3 and "OLDDONE" not in r.text
    r = client.request("REPORT", COLL, headers={**_basic("a@example.com", PW_A), "Depth": "1"}, content=_query("VEVENT"))
    assert r.status_code == 207 and r.text.count("<d:response>") == 0


def test_report_sync_collection_403_supported_report(session_factory):
    _seed(session_factory)
    body = b'<?xml version="1.0"?><sync-collection xmlns="DAV:"><sync-token/><prop><getetag/></prop></sync-collection>'
    r = _client(session_factory).request("REPORT", COLL, headers=_basic("a@example.com", PW_A), content=body)
    assert r.status_code == 403 and "supported-report" in r.text


# ── 拒绝类方法 ──────────────────────────────────────────────────────

def test_proppatch_207_with_403_per_property(session_factory):
    _seed(session_factory)
    body = (
        b'<?xml version="1.0"?><propertyupdate xmlns="DAV:" xmlns:ical="http://apple.com/ns/ical/">'
        b"<set><prop><displayname>x</displayname><ical:calendar-color>#FFF</ical:calendar-color></prop></set></propertyupdate>"
    )
    r = _client(session_factory).request("PROPPATCH", COLL, headers=_basic("a@example.com", PW_A), content=body)
    assert r.status_code == 207
    assert r.text.count("HTTP/1.1 403 Forbidden") == 2
    assert "<d:displayname/>" in r.text and "<ical:calendar-color/>" in r.text


def test_mkcalendar_403_and_move_405(session_factory):
    _seed(session_factory)
    client = _client(session_factory)
    assert client.request("MKCALENDAR", "/caldav/calendars/me/new/", headers=_basic("a@example.com", PW_A)).status_code == 403
    r = client.request("MOVE", f"{COLL}MANUALUID.ics", headers=_basic("a@example.com", PW_A))
    assert r.status_code == 405 and "PROPFIND" in r.headers["allow"]


# ── 隔离与全局约束 ──────────────────────────────────────────────────

def test_other_user_object_and_listing_isolated(session_factory):
    _seed(session_factory)
    client = _client(session_factory)
    assert client.get(f"{COLL}MANUALUID.ics", headers=_basic("b@example.com", PW_B)).status_code == 404
    listing = _propfind(client, COLL, depth="1", auth=_basic("b@example.com", PW_B)).text
    assert "BUID.ics" in listing and "MANUALUID.ics" not in listing


def test_no_json_content_type_on_any_caldav_path(session_factory):
    _seed(session_factory)
    client = _client(session_factory)
    paths = ["/caldav/", COLL, f"{COLL}NOPE.ics", "/caldav/whatever/"]
    methods = ["OPTIONS", "PROPFIND", "REPORT", "GET", "PUT", "DELETE", "PROPPATCH", "MKCALENDAR", "MOVE"]
    for auth in ({}, _basic("a@example.com", PW_A)):
        for method in methods:
            for path in paths:
                r = client.request(method, path, headers=auth, content=b"")
                assert not r.headers.get("content-type", "").startswith("application/json"), (method, path, auth)


def test_spa_fallback_does_not_shadow_caldav(session_factory, tmp_path: Path):
    _seed(session_factory)
    (tmp_path / "index.html").write_text("<html>spa</html>", encoding="utf-8")
    client = _client(session_factory, _settings(frontend_dist=str(tmp_path)))
    assert client.get("/nowhere").text == "<html>spa</html>"
    r = client.request("PROPFIND", "/caldav/", headers={"Depth": "0"})
    assert r.status_code == 401
    assert client.get("/caldav/", headers=_basic("a@example.com", PW_A)).status_code == 405


def test_caldav_responses_have_no_store_cache_control(session_factory):
    _seed(session_factory)
    r = _propfind(_client(session_factory), "/caldav/")
    assert r.headers["cache-control"] == "no-store"


# ── 对抗核查 ────────────────────────────────────────────────────────
# 以下每一条先于任何实现改动写就：先跑出失败再修，修法保持契约不变。

def _tag_text(xml: str, tag: str) -> str:
    start = xml.index(f"<d:{tag}>") + len(f"<d:{tag}>")
    return xml[start:xml.index(f"</d:{tag}>")]


def test_if_match_multiple_tags_passes_when_one_matches(session_factory):
    _seed(session_factory)
    client = _client(session_factory)
    auth = _basic("a@example.com", PW_A)
    current = client.get(f"{COLL}MANUALUID.ics", headers=auth).headers["etag"]
    body = APPLE_BODY.format(uid="MANUALUID", summary="多 etag 命中", extra="")
    r = client.put(
        f"{COLL}MANUALUID.ics",
        headers={**auth, "If-Match": f'"bogus-1", "bogus-2", {current}'},
        content=body.encode(),
    )
    assert r.status_code == 204
    with session_factory() as s:
        assert s.query(Item).filter(Item.caldav_uid == "MANUALUID").one().title == "多 etag 命中"


def test_if_match_weak_etag_strips_w_prefix(session_factory):
    """If-Match 带 W/ 弱前缀：剥前缀后与强 ETag 按字面比较，命中即通过。"""
    _seed(session_factory)
    client = _client(session_factory)
    auth = _basic("a@example.com", PW_A)
    current = client.get(f"{COLL}MANUALUID.ics", headers=auth).headers["etag"]
    r = client.put(
        f"{COLL}MANUALUID.ics",
        headers={**auth, "If-Match": f"W/{current}"},
        content=APPLE_BODY.format(uid="MANUALUID", summary="弱 etag", extra="").encode(),
    )
    assert r.status_code == 204


def test_delete_if_match_weak_etag_matches(session_factory):
    _seed(session_factory)
    client = _client(session_factory)
    auth = _basic("a@example.com", PW_A)
    current = client.get(f"{COLL}MANUALUID.ics", headers=auth).headers["etag"]
    r = client.delete(f"{COLL}MANUALUID.ics", headers={**auth, "If-Match": f"W/{current}"})
    assert r.status_code == 204


def test_put_if_none_match_weak_etag_412(session_factory):
    """If-None-Match 的 W/ 弱形式与现有强 ETag 弱比较命中 → 412。"""
    _seed(session_factory)
    client = _client(session_factory)
    auth = _basic("a@example.com", PW_A)
    current = client.get(f"{COLL}MANUALUID.ics", headers=auth).headers["etag"]
    r = client.put(
        f"{COLL}MANUALUID.ics",
        headers={**auth, "If-None-Match": f"W/{current}"},
        content=APPLE_BODY.format(uid="MANUALUID", summary="x", extra="").encode(),
    )
    assert r.status_code == 412


def test_encoded_stem_roundtrip_put_propfind_get_multiget(session_factory):
    """stem 含空格与中文（'买 牛奶'）：客户端以百分号编码 URL 交互，全程编码形态往返。"""
    _seed(session_factory)
    client = _client(session_factory)
    auth = _basic("a@example.com", PW_A)
    stem = "买 牛奶"
    enc = quote(stem, safe="")
    body = APPLE_BODY.format(uid="uid-milk", summary="买牛奶", extra="")
    r = client.put(f"{COLL}{enc}.ics", headers=auth, content=body.encode())
    assert r.status_code == 201
    with session_factory() as s:
        item = s.query(Item).filter(Item.caldav_uid == "uid-milk").one()
        assert item.caldav_name == stem  # 落库的是解码后的真实名称
    # PROPFIND Depth:1 的 href 是编码形态
    listing = _propfind(client, COLL, depth="1", body=PROP_CTAG).text
    assert f"{enc}.ics</d:href>" in listing and f"{stem}.ics" not in listing
    # 用该编码 href 原样 GET 能 200
    got = client.get(f"{COLL}{enc}.ics", headers=auth)
    assert got.status_code == 200 and "SUMMARY:买牛奶" in got.text
    # multiget 用编码 href 能命中
    multiget = (
        b'<?xml version="1.0"?><c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
        b'<d:prop><d:getetag/><c:calendar-data/></d:prop>'
        + f"<d:href>{COLL}{enc}.ics</d:href>".encode()
        + b"</c:calendar-multiget>"
    )
    m = client.request("REPORT", COLL, headers={**auth, "Depth": "1"}, content=multiget)
    assert m.status_code == 207 and "SUMMARY:买牛奶" in m.text
    assert "HTTP/1.1 200 OK" in m.text and "HTTP/1.1 404 Not Found" not in m.text


def test_multiget_absolute_url_href_hits(session_factory):
    """multiget 的 href 可以是绝对 URL：只看路径部分，host 无所谓。"""
    _seed(session_factory)
    href = "https://tasks.rakko.cn/caldav/calendars/me/tasks/MANUALUID.ics"
    multiget = (
        b'<?xml version="1.0"?><c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
        b'<d:prop><d:getetag/><c:calendar-data/></d:prop>'
        + f"<d:href>{href}</d:href>".encode()
        + b"</c:calendar-multiget>"
    )
    r = _client(session_factory).request(
        "REPORT", COLL, headers={**_basic("a@example.com", PW_A), "Depth": "1"}, content=multiget
    )
    assert r.status_code == 207
    assert r.text.count("<d:response>") == 1
    assert "SUMMARY:手动任务" in r.text and "HTTP/1.1 200 OK" in r.text


def test_multiget_foreign_and_root_hrefs_404_alone(session_factory):
    """href 指向别的集合或根路径：该 href 单独 404，其余照常命中。"""
    _seed(session_factory)
    hrefs = [
        "/caldav/calendars/me/tasks/MANUALUID.ics",
        "/caldav/",
        "/caldav/calendars/me/other/X.ics",
        "/caldav/principals/me/",
    ]
    body = (
        b'<?xml version="1.0"?><c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
        b'<d:prop><d:getetag/><c:calendar-data/></d:prop>'
        + b"".join(f"<d:href>{h}</d:href>".encode() for h in hrefs)
        + b"</c:calendar-multiget>"
    )
    r = _client(session_factory).request(
        "REPORT", COLL, headers={**_basic("a@example.com", PW_A), "Depth": "1"}, content=body
    )
    assert r.status_code == 207
    assert r.text.count("<d:response>") == 4
    assert r.text.count("HTTP/1.1 404 Not Found") == 3
    assert "SUMMARY:手动任务" in r.text  # 好 href 仍带出数据


def test_calendar_query_without_filter_returns_all_members(session_factory):
    _seed(session_factory)
    body = (
        b'<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
        b'<d:prop><d:getetag/><c:calendar-data/></d:prop></c:calendar-query>'
    )
    r = _client(session_factory).request(
        "REPORT", COLL, headers={**_basic("a@example.com", PW_A), "Depth": "1"}, content=body
    )
    assert r.status_code == 207
    assert r.text.count("<d:response>") == 3  # 保留窗口内的全部成员
    assert "OLDDONE" not in r.text


def test_put_rename_via_body_uid_updates_name_not_rowcount(session_factory):
    """重命名：PUT 到新文件名但 body UID 已存在 → 不新建、行数不变、caldav_name 换成新 stem。"""
    ids = _seed(session_factory)
    client = _client(session_factory)
    auth = _basic("a@example.com", PW_A)
    body = APPLE_BODY.format(uid="MANUALUID", summary="换了文件名", extra="")
    r = client.put(f"{COLL}renamed-1.ics", headers=auth, content=body.encode())
    assert r.status_code == 204
    with session_factory() as s:
        assert s.query(Item).filter(Item.user_sub == "sub-a").count() == 4
        item = s.get(Item, ids["manual_id"])
        assert item.caldav_uid == "MANUALUID" and item.caldav_name == "renamed-1"
    assert client.get(f"{COLL}MANUALUID.ics", headers=auth).status_code == 404
    assert client.get(f"{COLL}renamed-1.ics", headers=auth).status_code == 200


def test_put_z_due_stored_as_sydney_date_and_kept_in_get(session_factory):
    """DUE 为 Z 形态：20260909T230000Z → Sydney 本地日 2026-09-10；GET 透传不重写时间簇。"""
    _seed(session_factory)
    client = _client(session_factory)
    body = (
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//x//EN\r\nBEGIN:VTODO\r\n"
        "UID:ZUID-1\r\nSUMMARY:时区任务\r\nDUE:20260909T230000Z\r\nX-NOTE:keep\r\n"
        "END:VTODO\r\nEND:VCALENDAR\r\n"
    )
    r = client.put(f"{COLL}ZUID-1.ics", headers=_basic("a@example.com", PW_A), content=body.encode())
    assert r.status_code == 201
    with session_factory() as s:
        assert s.query(Item).filter(Item.caldav_uid == "ZUID-1").one().due_date == date(2026, 9, 10)
    got = client.get(f"{COLL}ZUID-1.ics", headers=_basic("a@example.com", PW_A))
    assert got.status_code == 200
    assert "DUE:20260909T230000Z" in got.text
    assert "DUE;VALUE=DATE" not in got.text and "X-NOTE:keep" in got.text


def test_propfind_depth_header_case_insensitive(session_factory):
    _seed(session_factory)
    client = _client(session_factory)
    auth = _basic("a@example.com", PW_A)
    up = client.request("PROPFIND", COLL, headers={**auth, "Depth": "INFINITY"}, content=PROP_CTAG)
    assert up.status_code == 403 and "propfind-finite-depth" in up.text
    low = client.request("PROPFIND", COLL, headers={**auth, "depth": "1"}, content=PROP_CTAG)
    assert low.status_code == 207 and low.text.count(".ics</d:href>") == 3


def test_put_non_utf8_bytes_403_valid_calendar_data(session_factory):
    _seed(session_factory)
    r = _client(session_factory).put(
        f"{COLL}BAD.ics", headers=_basic("a@example.com", PW_A), content=b"\xff\xfe\x00\x41"
    )
    assert r.status_code == 403
    assert "valid-calendar-data" in r.text and r.status_code != 500


def test_propfind_object_depth1_single_response(session_factory):
    _seed(session_factory)
    r = _propfind(_client(session_factory), f"{COLL}MANUALUID.ics", depth="1")
    assert r.status_code == 207
    assert r.text.count("<d:response>") == 1
    assert r.text.count("MANUALUID.ics</d:href>") == 1  # 只回该对象自己，不带集合响应


def test_object_getcontentlength_matches_get_and_lastmodified_http_date(session_factory):
    _seed(session_factory)
    client = _client(session_factory)
    auth = _basic("a@example.com", PW_A)
    body = (
        b'<?xml version="1.0"?><propfind xmlns="DAV:"><prop>'
        b"<getcontentlength/><getlastmodified/></prop></propfind>"
    )
    r = _propfind(client, f"{COLL}MANUALUID.ics", body=body)
    assert r.status_code == 207
    got = client.get(f"{COLL}MANUALUID.ics", headers=auth)
    assert int(_tag_text(r.text, "getcontentlength")) == len(got.content)
    assert _tag_text(r.text, "getlastmodified").endswith(" GMT")


def test_well_known_redirects_always_301_and_never_rate_limited(session_factory):
    """/.well-known/caldav 不鉴权不计数：连发 40 次任意方法仍 301，随后一次真失败鉴权也不 429。"""
    _seed(session_factory)
    client = _client(session_factory)
    methods = ("GET", "PROPFIND", "PUT", "DELETE", "REPORT", "POST")
    for _ in range(40):
        r = client.request(methods[_ % len(methods)], "/.well-known/caldav", follow_redirects=False)
        assert r.status_code == 301 and r.headers["location"] == "/caldav/"
    r = _propfind(client, "/caldav/", auth={})
    assert r.status_code == 401  # 限流配额没被 well-known 流量吃掉


def test_put_stem_update_with_foreign_body_uid_keeps_row_reachable(session_factory):
    """PUT 到已存在对象、body UID 却对不上任何行 → 按 URL stem 更新该行。

    语义（当前实现，测试锁定）：caldav_uid 被改成 body 的 UID，caldav_name 承接
    URL stem，保证 coalesce(caldav_name, caldav_uid) 恒等于 PUT 的目标 stem——
    行不会因改名而「消失」，旧 href 依旧可 GET；body UID 作为新 URL 暂不可达，
    直到客户端真以该文件名 PUT 一次（届时 find_by_uid 兜底命中同一行）。
    """
    ids = _seed(session_factory)
    client = _client(session_factory)
    auth = _basic("a@example.com", PW_A)
    body = APPLE_BODY.format(uid="REWRITTEN-UID", summary="按 stem 更新", extra="")
    r = client.put(f"{COLL}MANUALUID.ics", headers=auth, content=body.encode())
    assert r.status_code == 204
    with session_factory() as s:
        assert s.query(Item).filter(Item.user_sub == "sub-a").count() == 4  # 没新建
        item = s.get(Item, ids["manual_id"])
        assert item.caldav_uid == "REWRITTEN-UID" and item.caldav_name == "MANUALUID"
        assert item.title == "按 stem 更新"
    assert client.get(f"{COLL}MANUALUID.ics", headers=auth).status_code == 200  # 旧 href 仍可达
    assert "SUMMARY:按 stem 更新" in client.get(f"{COLL}MANUALUID.ics", headers=auth).text


def test_other_user_put_same_stem_creates_own_row(session_factory):
    """用户 B 用 A 的 stem 发 PUT → B 名下新建一行（同名不同 owner），A 的行分毫未动。"""
    ids = _seed(session_factory)
    client = _client(session_factory)
    body = APPLE_BODY.format(uid="MANUALUID", summary="乙的覆盖", extra="")
    r = client.put(f"{COLL}MANUALUID.ics", headers=_basic("b@example.com", PW_B), content=body.encode())
    assert r.status_code == 201  # B 名下没有该 stem，按新建处理
    with session_factory() as s:
        assert s.get(Item, ids["manual_id"]).title == "手动任务"
        assert s.query(Item).filter(Item.user_sub == "sub-b", Item.caldav_uid == "MANUALUID").count() == 1
    auth_a = _basic("a@example.com", PW_A)
    assert client.get(f"{COLL}MANUALUID.ics", headers=auth_a).status_code == 200
    assert "SUMMARY:手动任务" in client.get(f"{COLL}MANUALUID.ics", headers=auth_a).text
    b_got = client.get(f"{COLL}MANUALUID.ics", headers=_basic("b@example.com", PW_B))
    assert b_got.status_code == 200 and "SUMMARY:乙的覆盖" in b_got.text


def test_post_patch_lock_405_with_allow_and_no_json(session_factory):
    _seed(session_factory)
    client = _client(session_factory)
    auth = _basic("a@example.com", PW_A)
    for method in ("POST", "PATCH", "LOCK"):
        for path in ("/caldav/", COLL, f"{COLL}MANUALUID.ics"):
            r = client.request(method, path, headers=auth, content=b"")
            assert r.status_code == 405, (method, path, r.status_code)
            assert "PROPFIND" in r.headers["allow"] and "PUT" in r.headers["allow"]
            assert not r.headers.get("content-type", "").startswith("application/json")


def test_put_empty_body_403_valid_calendar_data(session_factory):
    _seed(session_factory)
    r = _client(session_factory).put(
        f"{COLL}X.ics", headers=_basic("a@example.com", PW_A), content=b""
    )
    assert r.status_code == 403
    assert "valid-calendar-data" in r.text


def test_propfind_malformed_xml_400_not_json(session_factory):
    _seed(session_factory)
    r = _propfind(_client(session_factory), COLL, body=b'<propfind xmlns="DAV:"><prop><getetag/></prop>')
    assert r.status_code == 400
    assert not r.headers.get("content-type", "").startswith("application/json")


def test_put_412_leaves_caldav_ics_and_title_unchanged(session_factory):
    """If-Match 不匹配 → 412 在写入前抛出：行完全没变，含 caldav_ics 透传体。"""
    _seed(session_factory)
    client = _client(session_factory)
    auth = _basic("a@example.com", PW_A)
    v1 = APPLE_BODY.format(uid="TX-1", summary="第一版", extra="")
    assert client.put(f"{COLL}TX-1.ics", headers=auth, content=v1.encode()).status_code == 201
    v2 = APPLE_BODY.format(uid="TX-1", summary="第二版", extra="")
    r = client.put(
        f"{COLL}TX-1.ics", headers={**auth, "If-Match": '"stale"'}, content=v2.encode()
    )
    assert r.status_code == 412
    with session_factory() as s:
        item = s.query(Item).filter(Item.caldav_uid == "TX-1").one()
        assert item.title == "第一版" and item.caldav_ics == v1
