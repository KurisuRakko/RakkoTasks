"""CalDAV 协议层测试：鉴权与限流、发现与属性、枚举与保留窗口、GET/PUT/DELETE、REPORT、
拒绝类方法、多用户隔离、永不返回 JSON、SPA fallback 不吞路由。

全部经 TestClient.request(<方法>, ...) 走真实路由；Basic 凭据用真实的应用密码 hash。
"""
from __future__ import annotations

import base64
from datetime import date, datetime, timedelta
from pathlib import Path

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
