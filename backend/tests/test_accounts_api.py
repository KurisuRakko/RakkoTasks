"""账户 REST 端点测试（/api/accounts*）：TestClient + require_auth 依赖覆盖。

模式照 tests/test_api.py；微软授权流程离线化：monkeypatch app.imap.mstoken 的
flow 文件路径与 initiate/complete 入口（msal 调用不触网）。
"""
from __future__ import annotations

import json

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.api import create_app
from app.auth import CurrentUser, require_auth
from app.config import Settings
from app.imap import mstoken
from app.models import Account, Email, Item, User

DEFAULT_REDIRECT = "https://login.microsoftonline.com/common/oauth2/nativeclient"
FAKE_AUTH_URI = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x"


def _settings() -> Settings:
    return Settings(database_path=":memory:")


def _client_as(session_factory, sub: str = "user-A", email: str | None = None, name: str | None = None) -> TestClient:
    app = create_app(settings=_settings(), session_factory=session_factory)
    app.dependency_overrides[require_auth] = lambda: CurrentUser(sub=sub, email=email, name=name)
    return TestClient(app)


def _seed_users(session_factory, subs: list[str]) -> None:
    with session_factory() as s:
        for sub in subs:
            s.add(User(sub=sub))
        s.commit()


def _seed_two_accounts(session_factory) -> dict:
    """A（gmail 带密码）/ B（microsoft 带 token_cache）各一个账户。"""
    _seed_users(session_factory, ["user-A", "user-B"])
    with session_factory() as s:
        acc_a = Account(
            user_sub="user-A", name="A 邮箱", kind="gmail", email="a@x.com", status="ok",
            app_password="pw-a",
        )
        acc_b = Account(
            user_sub="user-B", name="B 邮箱", kind="microsoft", email="b@x.com", status="ok",
            token_cache="cache-b",
        )
        s.add_all([acc_a, acc_b])
        s.commit()
        return {"a": acc_a.id, "b": acc_b.id}


def _gmail_payload(name="我的 Gmail", kind="gmail", email="me@gmail.com", **extra) -> dict:
    payload = {"name": name, "kind": kind, "email": email}
    payload.update(extra)
    return payload


def _account_of(session_factory, account_id: int) -> Account:
    with session_factory() as s:
        return s.get(Account, account_id)


def _flow_file(tmp_path, account_id: int):
    return tmp_path / (f".auth_flow_{account_id}.json")


# ── 列表 / 添加 ─────────────────────────────────────────────────────


def test_get_accounts_empty_list(session_factory):
    _seed_users(session_factory, ["user-A"])
    client = _client_as(session_factory, "user-A")
    resp = client.get("/api/accounts")
    assert resp.status_code == 200
    assert resp.json() == {"accounts": []}


def test_post_gmail_201_credentials_stored_never_returned(session_factory):
    _seed_users(session_factory, ["user-A"])
    client = _client_as(session_factory, "user-A", "a@x.com", "甲")
    resp = client.post("/api/accounts", json=_gmail_payload(app_password="s3cret"))
    assert resp.status_code == 201
    data = resp.json()
    assert data["kind"] == "gmail"
    assert data["status"] == "pending"
    assert data["enabled"] is True
    assert data["has_credentials"] is True
    assert data["ms_client_id"] is None
    assert data["last_sync_at"] is None
    assert data["last_error"] is None
    assert "app_password" not in resp.text
    assert "token_cache" not in resp.text
    assert "s3cret" not in resp.text
    with session_factory() as s:
        row = s.execute(select(Account).where(Account.email == "me@gmail.com")).scalars().one()
        assert row.app_password == "s3cret"  # 密码真实落库
        assert row.status == "pending"


def test_post_gmail_validation_errors(session_factory):
    _seed_users(session_factory, ["user-A"])
    client = _client_as(session_factory, "user-A")
    cases = [
        (_gmail_payload(kind="exchange", app_password="pw"), "bad_kind"),
        (_gmail_payload(name="   ", app_password="pw"), "bad_name"),
        (_gmail_payload(name="x" * 129, app_password="pw"), "bad_name"),
        (_gmail_payload(email="no-at-sign", app_password="pw"), "bad_email"),
        (_gmail_payload(app_password=None), "password_required"),
        (_gmail_payload(app_password="   "), "password_required"),
    ]
    for payload, code in cases:
        resp = client.post("/api/accounts", json=payload)
        assert resp.status_code == 400, payload
        assert resp.json() == {"code": code}, payload


def test_post_duplicate_409_and_disabled_counts(session_factory):
    _seed_users(session_factory, ["user-A"])
    client = _client_as(session_factory, "user-A")
    assert client.post("/api/accounts", json=_gmail_payload(app_password="pw")).status_code == 201
    # 同一 (email, kind) 再次提交 409（含已停用账户）
    resp = client.post("/api/accounts", json=_gmail_payload(app_password="pw"))
    assert resp.status_code == 409
    assert resp.json() == {"code": "account_exists"}
    # 同邮箱不同 kind 不冲突；停用后再 add 仍 409
    assert client.post(
        "/api/accounts", json={"name": "x", "kind": "microsoft", "email": "me@gmail.com"}
    ).status_code == 201
    acc_id = client.get("/api/accounts").json()["accounts"][0]["id"]
    client.patch(f"/api/accounts/{acc_id}", json={"enabled": False})
    resp = client.post("/api/accounts", json=_gmail_payload(app_password="pw2"))
    assert resp.status_code == 409


def test_post_microsoft_ignores_app_password_and_strips_client_id(session_factory):
    _seed_users(session_factory, ["user-A"])
    client = _client_as(session_factory, "user-A")
    resp = client.post(
        "/api/accounts",
        json={"name": " 工作邮箱 ", "kind": "microsoft", "email": " work@x.com ",
              "app_password": "ignored", "ms_client_id": "  cid-123  "},
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["has_credentials"] is False
    assert data["status"] == "pending"
    assert data["ms_client_id"] == "cid-123"
    assert data["name"] == "工作邮箱"
    assert data["email"] == "work@x.com"
    assert "app_password" not in resp.text
    with session_factory() as s:
        row = s.execute(select(Account).where(Account.email == "work@x.com")).scalars().one()
        assert row.app_password is None
        assert row.ms_client_id == "cid-123"


# ── PATCH ───────────────────────────────────────────────────────────


def test_patch_name_and_bad_request(session_factory):
    ids = _seed_two_accounts(session_factory)
    client = _client_as(session_factory, "user-A", "a@x.com")
    resp = client.patch(f"/api/accounts/{ids['a']}", json={"name": "  新名字  "})
    assert resp.status_code == 200
    assert resp.json()["name"] == "新名字"
    assert resp.json()["id"] == ids["a"]
    assert _account_of(session_factory, ids["a"]).name == "新名字"

    # 空请求体 / 全部字段为 null → 400 bad_request
    assert client.patch(f"/api/accounts/{ids['a']}", json={}).json() == {"code": "bad_request"}
    resp = client.patch(f"/api/accounts/{ids['a']}", json={"name": None, "app_password": None, "enabled": None})
    assert resp.status_code == 400
    assert resp.json() == {"code": "bad_request"}
    # 多字段按 name → app_password → enabled 顺序全部应用（enabled=false 最后清凭据）
    resp = client.patch(
        f"/api/accounts/{ids['a']}",
        json={"name": "甲", "app_password": "pw-new", "enabled": False},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["name"] == "甲"
    assert data["enabled"] is False
    assert data["has_credentials"] is False
    row = _account_of(session_factory, ids["a"])
    assert row.app_password is None  # 先设的密码被 enabled=false 清空
    assert row.enabled is False


def test_patch_app_password_on_microsoft_invalid_kind(session_factory):
    ids = _seed_two_accounts(session_factory)
    client = _client_as(session_factory, "user-A", "a@x.com")
    client_b = _client_as(session_factory, "user-B", "b@x.com")
    # B 的账户是 microsoft：改应用专用密码 → invalid_kind
    resp = client_b.patch(f"/api/accounts/{ids['b']}", json={"app_password": "x"})
    assert resp.status_code == 400
    assert resp.json() == {"code": "invalid_kind"}
    # A 的 gmail 账户改密码成功：status 回 pending、last_error 清空
    resp = client.patch(f"/api/accounts/{ids['a']}", json={"app_password": "pw-2"})
    assert resp.status_code == 200
    assert resp.json()["has_credentials"] is True
    assert resp.json()["status"] == "pending"
    assert _account_of(session_factory, ids["a"]).app_password == "pw-2"


def test_patch_partial_failure_rolls_back_whole_request(session_factory):
    """多字段 PATCH 中途失败（name 已改、app_password 抛 invalid_kind）→ 400，name 不得半途落库。"""
    ids = _seed_two_accounts(session_factory)
    client_b = _client_as(session_factory, "user-B", "b@x.com")
    resp = client_b.patch(f"/api/accounts/{ids['b']}", json={"name": "新名", "app_password": "x"})
    assert resp.status_code == 400
    assert resp.json() == {"code": "invalid_kind"}
    # AccountError 经 _get_db 回滚：rename 不落库，name 仍是旧值
    accs = client_b.get("/api/accounts").json()["accounts"]
    assert accs[0]["id"] == ids["b"]
    assert accs[0]["name"] == "B 邮箱"
    assert _account_of(session_factory, ids["b"]).name == "B 邮箱"


def test_patch_enabled_roundtrip(session_factory):
    ids = _seed_two_accounts(session_factory)
    client = _client_as(session_factory, "user-A", "a@x.com")
    # 停用：清凭据 + status pending
    resp = client.patch(f"/api/accounts/{ids['a']}", json={"enabled": False})
    assert resp.status_code == 200
    assert resp.json()["enabled"] is False
    assert resp.json()["has_credentials"] is False
    assert resp.json()["status"] == "pending"
    row = _account_of(session_factory, ids["a"])
    assert row.app_password is None
    assert row.enabled is False
    # GET 列表仍显示（软删除保留，含已停用）
    accs = client.get("/api/accounts").json()["accounts"]
    assert [a["id"] for a in accs] == [ids["a"]]
    assert accs[0]["enabled"] is False
    # 启用：只置位，凭据仍是空的
    resp = client.patch(f"/api/accounts/{ids['a']}", json={"enabled": True})
    assert resp.status_code == 200
    assert resp.json()["enabled"] is True
    assert resp.json()["has_credentials"] is False


# ── DELETE 级联 ─────────────────────────────────────────────────────


def test_delete_204_cascade_keeps_manual_and_other_accounts(session_factory):
    _seed_users(session_factory, ["user-A"])
    with session_factory() as s:
        acc = Account(user_sub="user-A", name="A 邮箱", kind="microsoft", email="a@x.com",
                      status="ok", token_cache="tok")
        keep = Account(user_sub="user-A", name="保留", kind="gmail", email="keep@x.com",
                       status="ok", app_password="pw")
        s.add_all([acc, keep])
        s.commit()
        em = Email(account_id=acc.id, message_id="<m1>", subject="s", text_body="b", llm_state="done")
        em_keep = Email(account_id=keep.id, message_id="<m2>", subject="s", text_body="b", llm_state="done")
        s.add_all([em, em_keep])
        s.commit()
        item = Item(email_id=em.id, user_sub="user-A", title="删除我", summary="", category="其他")
        item_keep = Item(email_id=em_keep.id, user_sub="user-A", title="保留我", summary="", category="其他")
        manual = Item(email_id=None, user_sub="user-A", title="手动", summary="", category="其他")
        s.add_all([item, item_keep, manual])
        s.commit()
        acc_id, em_id = acc.id, em.id

    client = _client_as(session_factory, "user-A", "a@x.com")
    resp = client.delete(f"/api/accounts/{acc_id}")
    assert resp.status_code == 204
    assert resp.content == b""  # 204 无正文
    # 彻底删除后：对 id 的写操作 404、列表不再包含（契约无 GET 单账户端点）
    assert client.patch(f"/api/accounts/{acc_id}", json={"name": "x"}).status_code == 404
    assert client.delete(f"/api/accounts/{acc_id}").status_code == 404

    with session_factory() as s:
        assert s.get(Account, acc_id) is None
        assert s.get(Email, em_id) is None
        emails = s.execute(select(Email)).scalars().all()
        items = s.execute(select(Item)).scalars().all()
        assert [e.message_id for e in emails] == ["<m2>"]  # 另一账户邮件保留
        assert [i.title for i in items] == ["保留我", "手动"]  # 邮件条目 + 手动条目保留
    # 列表只剩保留账户
    accs = client.get("/api/accounts").json()["accounts"]
    assert [a["id"] for a in accs] == [keep.id]


# ── 多用户隔离 ──────────────────────────────────────────────────────


def test_user_b_cannot_touch_user_a_accounts(session_factory):
    ids = _seed_two_accounts(session_factory)
    client_b = _client_as(session_factory, "user-B", "b@x.com")
    # 列表只见自己的
    assert [a["id"] for a in client_b.get("/api/accounts").json()["accounts"]] == [ids["b"]]
    # 对 A 的账户：PATCH/DELETE/auth-url/auth-code 一律 404（不暴露资源存在；
    # 契约无 GET 单账户端点，越权可见性由列表断言覆盖）
    resp = client_b.patch(f"/api/accounts/{ids['a']}", json={"name": "x"})
    assert resp.status_code == 404
    assert resp.json() == {"code": "not_found"}
    assert client_b.delete(f"/api/accounts/{ids['a']}").status_code == 404
    assert client_b.post(f"/api/accounts/{ids['a']}/auth-url", json={}).status_code == 404
    assert client_b.post(f"/api/accounts/{ids['a']}/auth-code", json={"auth_response": "c"}).status_code == 404


# ── 微软授权码流程（API 层） ────────────────────────────────────────


def _patch_flow(monkeypatch, tmp_path) -> None:
    """把 flow 文件路径指到 tmp_path（start/finish 的 msal 入口由各测试再单独打桩）。"""
    monkeypatch.setattr(
        mstoken, "flow_file_path",
        lambda account, settings: _flow_file(tmp_path, account.id),
    )


def test_auth_url_gmail_invalid_kind_and_bad_redirect(session_factory, tmp_path, monkeypatch):
    ids = _seed_two_accounts(session_factory)
    _patch_flow(monkeypatch, tmp_path)
    client = _client_as(session_factory, "user-A", "a@x.com")
    resp = client.post(f"/api/accounts/{ids['a']}/auth-url", json={})  # A 是 gmail
    assert resp.status_code == 400
    assert resp.json() == {"code": "invalid_kind"}

    client_b = _client_as(session_factory, "user-B", "b@x.com")
    resp = client_b.post(f"/api/accounts/{ids['b']}/auth-url", json={"redirect_uri": "https://evil.example/cb"})
    assert resp.status_code == 400
    assert resp.json() == {"code": "bad_redirect"}


def test_auth_url_microsoft_returns_auth_uri(session_factory, tmp_path, monkeypatch):
    ids = _seed_two_accounts(session_factory)
    _patch_flow(monkeypatch, tmp_path)
    captured = {}

    def fake_initiate(account, settings=None, redirect_uri=DEFAULT_REDIRECT):
        captured["redirect_uri"] = redirect_uri
        return {"auth_uri": FAKE_AUTH_URI, "flow": {"state": "s"}}

    monkeypatch.setattr(mstoken, "initiate_auth_code_flow", fake_initiate)
    client_b = _client_as(session_factory, "user-B", "b@x.com")
    resp = client_b.post(f"/api/accounts/{ids['b']}/auth-url", json={})
    assert resp.status_code == 200
    assert resp.json() == {"auth_uri": FAKE_AUTH_URI}
    assert captured["redirect_uri"] == DEFAULT_REDIRECT
    # 显式 oob 也被接受
    resp = client_b.post(f"/api/accounts/{ids['b']}/auth-url", json={"redirect_uri": "urn:ietf:wg:oauth:2.0:oob"})
    assert resp.status_code == 200
    assert captured["redirect_uri"] == "urn:ietf:wg:oauth:2.0:oob"


def test_auth_url_without_body_uses_default_redirect(session_factory, tmp_path, monkeypatch):
    """redirect_uri 可选：整个请求体都缺省时 POST auth-url 仍 200，用默认重定向地址。"""
    ids = _seed_two_accounts(session_factory)
    _patch_flow(monkeypatch, tmp_path)
    captured = {}

    def fake_initiate(account, settings=None, redirect_uri=DEFAULT_REDIRECT):
        captured["redirect_uri"] = redirect_uri
        return {"auth_uri": FAKE_AUTH_URI, "flow": {"state": "s"}}

    monkeypatch.setattr(mstoken, "initiate_auth_code_flow", fake_initiate)
    client_b = _client_as(session_factory, "user-B", "b@x.com")
    resp = client_b.post(f"/api/accounts/{ids['b']}/auth-url")  # 不带请求体
    assert resp.status_code == 200
    assert resp.json() == {"auth_uri": FAKE_AUTH_URI}
    assert captured["redirect_uri"] == DEFAULT_REDIRECT


def test_auth_code_no_pending_flow_409(session_factory, tmp_path, monkeypatch):
    ids = _seed_two_accounts(session_factory)
    _patch_flow(monkeypatch, tmp_path)
    client_b = _client_as(session_factory, "user-B", "b@x.com")
    resp = client_b.post(f"/api/accounts/{ids['b']}/auth-code", json={"auth_response": "code-1"})
    assert resp.status_code == 409
    assert resp.json() == {"code": "no_pending_flow"}


def test_auth_code_auth_failed_declined(session_factory, tmp_path, monkeypatch):
    ids = _seed_two_accounts(session_factory)
    _patch_flow(monkeypatch, tmp_path)
    _flow_file(tmp_path, ids["b"]).write_text(json.dumps({"state": "s", "code_verifier": "v"}))

    def fake_complete(account, flow, auth_response, settings=None):
        raise mstoken.DeviceFlowError("declined", "AADSTS65004: User declined.")

    monkeypatch.setattr(mstoken, "complete_auth_code_flow", fake_complete)
    client_b = _client_as(session_factory, "user-B", "b@x.com")
    resp = client_b.post(f"/api/accounts/{ids['b']}/auth-code", json={"auth_response": "code-1"})
    assert resp.status_code == 400
    body = resp.json()
    assert body["code"] == "auth_failed"
    assert body["kind"] == "declined"
    assert "AADSTS65004" in body["detail"]


def test_auth_code_success_sets_ok(session_factory, tmp_path, monkeypatch):
    ids = _seed_two_accounts(session_factory)
    _patch_flow(monkeypatch, tmp_path)
    _flow_file(tmp_path, ids["b"]).write_text(json.dumps({"state": "s", "code_verifier": "v"}))

    def fake_complete(account, flow, auth_response, settings=None):
        account.token_cache = "cache-after-auth"  # 真实路径由 msal 序列化写回
        return {"access_token": "at"}

    monkeypatch.setattr(mstoken, "complete_auth_code_flow", fake_complete)
    client_b = _client_as(session_factory, "user-B", "b@x.com")
    resp = client_b.post(f"/api/accounts/{ids['b']}/auth-code", json={"auth_response": "code-1"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert data["has_credentials"] is True
    assert "cache-after-auth" not in resp.text  # 响应绝不含 token
    row = _account_of(session_factory, ids["b"])
    assert row.status == "ok"
    assert row.last_error is None
    assert row.token_cache == "cache-after-auth"
    # 响应里也没有 app_password / token_cache 字段
    assert "app_password" not in resp.text and "token_cache" not in resp.text


# ── /api/status 共享序列化 ──────────────────────────────────────────


def test_status_uses_account_info_shape(session_factory):
    _seed_users(session_factory, ["user-A"])
    with session_factory() as s:
        acc = Account(user_sub="user-A", name="我的 Gmail", kind="gmail", email="me@gmail.com",
                      status="ok", app_password="pw", ms_client_id="cid-x")
        s.add(acc)
        s.commit()
        acc_id = acc.id
    client = _client_as(session_factory, "user-A", "a@x.com")
    data = client.get("/api/status").json()
    assert data["accounts"][0]["id"] == acc_id
    a0 = data["accounts"][0]
    # AccountInfo 与 /api/accounts* 同款字段：has_credentials / ms_client_id 必在
    assert a0["has_credentials"] is True
    assert a0["ms_client_id"] == "cid-x"
    assert a0["status"] == "ok"
    assert "app_password" not in json.dumps(data)
    assert "token_cache" not in json.dumps(data)
