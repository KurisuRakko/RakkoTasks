"""内网 feed（app/feed.py）：令牌鉴权、用户隔离、紧凑文本 / JSON、增量、截断、写待办。"""
from datetime import date, datetime

from fastapi.testclient import TestClient

from app.caldav.auth import hash_app_password
from app.config import Settings
from app.feed import create_feed_app
from app.models import Account, Email, Item, User

TOKEN_A = "token-a-xxxxxxxxxxxxxxxxxxxxxxxxxx"
TOKEN_B = "token-b-xxxxxxxxxxxxxxxxxxxxxxxxxx"


def _seed(session_factory) -> dict:
    with session_factory() as s:
        s.add(User(sub="user-A", email="a@x.com", feed_token_hash=hash_app_password(TOKEN_A)))
        s.add(User(sub="user-B", email="b@x.com", feed_token_hash=hash_app_password(TOKEN_B)))
        s.commit()
        acc_a = Account(user_sub="user-A", name="A", kind="gmail", email="a@x.com", status="ok")
        acc_b = Account(user_sub="user-B", name="B", kind="gmail", email="b@x.com", status="ok")
        s.add_all([acc_a, acc_b])
        s.commit()
        em_a = Email(
            account_id=acc_a.id, message_id="<a1>", subject="作业 | 截止通知", sender='"张老师" <t@unsw.edu.au>',
            text_body="正文" * 3000, sent_at=datetime(2026, 10, 10, 1, 0), llm_state="done",
        )
        ad_a = Email(
            account_id=acc_a.id, message_id="<a2>", subject="限时折扣", sender="ads@shop.com",
            text_body="广告", sent_at=datetime(2026, 10, 9), filtered=True, llm_state="done",
        )
        em_b = Email(
            account_id=acc_b.id, message_id="<b1>", subject="B 的秘密", sender="y@y.com",
            text_body="B 的机密正文", sent_at=datetime(2026, 10, 10), llm_state="done",
        )
        s.add_all([em_a, ad_a, em_b])
        s.commit()
        it_a = Item(
            email_id=em_a.id, user_sub="user-A", title="交作业", summary="第一行\n第二行", category="学业",
            due_date=date(2026, 10, 14), importance="high", status="open",
        )
        it_b = Item(email_id=em_b.id, user_sub="user-B", title="B 的任务", category="其他", status="open")
        s.add_all([it_a, it_b])
        s.commit()
        return {"em_a": em_a.id, "ad_a": ad_a.id, "em_b": em_b.id, "it_a": it_a.id, "it_b": it_b.id}


def _client(session_factory, token: str | None = TOKEN_A) -> TestClient:
    app = create_feed_app(settings=Settings(database_path=":memory:"), session_factory=session_factory)
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return TestClient(app, headers=headers)


def test_usage_is_public_and_short(session_factory):
    r = _client(session_factory, None).get("/")
    assert r.status_code == 200
    assert "GET  /items" in r.text and len(r.text) < 2000


def test_requires_valid_token(session_factory):
    _seed(session_factory)
    assert _client(session_factory, None).get("/items").status_code == 401
    assert _client(session_factory, "wrong").get("/items").status_code == 401
    r = _client(session_factory, "").get("/emails")
    assert r.status_code == 401 and r.text == "error: unauthorized\n"


def test_null_hash_user_never_matches_empty_token(session_factory):
    with session_factory() as s:
        s.add(User(sub="no-feed", email="n@x.com"))
        s.commit()
    assert _client(session_factory, "").get("/items").status_code == 401


def test_items_text_is_one_line_per_item(session_factory):
    ids = _seed(session_factory)
    r = _client(session_factory).get("/items")
    lines = r.text.strip().split("\n")
    assert lines[0] == "# items status=open n=1"
    assert lines[1] == f"t{ids['it_a']} open 2026-10-14 high [学业] 交作业 | 第一行 第二行 | m{ids['em_a']}"
    assert "B 的任务" not in r.text


def test_items_json_omits_detail(session_factory):
    _seed(session_factory)
    data = _client(session_factory).get("/items?format=json").json()
    assert [i["title"] for i in data["items"]] == ["交作业"]
    assert "detail_md" not in data["items"][0]


def test_items_since_filters_by_update_time(session_factory):
    _seed(session_factory)
    c = _client(session_factory)
    assert "n=1" in c.get("/items?since=2000-01-01").text
    assert "n=0" in c.get("/items?since=2999-01-01T00:00:00").text
    assert c.get("/items?since=yesterday").status_code == 400


def test_item_detail_and_isolation(session_factory):
    ids = _seed(session_factory)
    c = _client(session_factory)
    r = c.get(f"/items/{ids['it_a']}")
    assert "source: m" in r.text and "张老师" in r.text
    assert c.get(f"/items/{ids['it_b']}").status_code == 404


def test_emails_hide_noise_and_other_users(session_factory):
    ids = _seed(session_factory)
    c = _client(session_factory)
    text = c.get("/emails").text
    lines = text.strip().split("\n")
    assert lines[0] == "# emails n=1"
    # 主题里的「|」换成全角，不串列；发件人只给显示名；时间按悉尼本地
    assert lines[1] == f"m{ids['em_a']} 2026-10-10 12:00 张老师 | 作业 ｜ 截止通知 | t{ids['it_a']}"
    assert "B 的秘密" not in text
    assert "n=2" in c.get("/emails?all=1").text


def test_emails_search(session_factory):
    _seed(session_factory)
    c = _client(session_factory)
    assert "n=1" in c.get("/emails?q=作业").text
    assert "n=0" in c.get("/emails?q=秘密").text  # B 的邮件，A 搜不到


def test_email_body_is_clipped(session_factory):
    ids = _seed(session_factory)
    c = _client(session_factory)
    r = c.get(f"/emails/{ids['em_a']}")
    assert "[clipped 2000/6000 chars" in r.text
    assert len(r.text) < 2600
    full = c.get(f"/emails/{ids['em_a']}?max=0&format=json").json()
    assert full["body_total_chars"] == 6000 and not full["clipped"]
    assert c.get(f"/emails/{ids['em_b']}").status_code == 404


def test_create_patch_done_open(session_factory):
    ids = _seed(session_factory)
    c = _client(session_factory)
    r = c.post("/items", json={"title": "买牛奶", "category": "个人", "due_date": "2026-10-12"})
    assert r.status_code == 201
    new_id = int(r.text.split()[0][1:])
    assert r.text.endswith("| manual\n")
    assert c.post("/items", json={"title": "x", "category": "乱写"}).status_code == 400

    r = c.patch(f"/items/{new_id}", json={"importance": "high"})
    assert " high " in r.text
    assert c.post(f"/items/{new_id}/done").text.startswith(f"t{new_id} done ")
    assert c.post(f"/items/{new_id}/open").text.startswith(f"t{new_id} open ")
    assert c.post(f"/items/{new_id}/zap").status_code == 404
    # 改不了别人的
    assert c.post(f"/items/{ids['it_b']}/done").status_code == 404
    assert c.patch(f"/items/{ids['it_b']}", json={"title": "hack"}).status_code == 404
    with session_factory() as s:
        assert s.get(Item, ids["it_b"]).status == "open"
        assert s.get(Item, new_id).user_sub == "user-A"


def test_hostile_inputs_are_4xx_not_500(session_factory):
    _seed(session_factory)
    c = _client(session_factory)
    assert c.get("/items?since=0001-01-01").status_code == 400
    assert c.get("/emails?since=9999-12-31T23:59:59-10:00").status_code == 400
    assert c.get("/emails?q=a%00b").status_code == 200
    assert c.get("/items/99999999999999999999").status_code == 422
    assert c.get("/emails/99999999999999999999").status_code == 422
    assert c.post("/items/99999999999999999999/done").status_code == 422
