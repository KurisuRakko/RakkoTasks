"""账户服务层测试：校验分支、状态机、级联删除（FTS 同步）、微软授权码流程与同步跳过。

全部离线：msal 调用经 monkeypatch 替换 app.imap.mstoken 的入口（参考
test_auth_code_flow.py 的做法）；flow 文件路径 monkeypatch 到 tmp_path，避免
落进工作目录。
"""
from __future__ import annotations

import json

import pytest
from sqlalchemy import select, text

from app import accounts
from app.config import Settings
from app.imap import mstoken
from app.models import Account, Email, Item, User
from app.sync import run_once

DEFAULT_REDIRECT = "https://login.microsoftonline.com/common/oauth2/nativeclient"


def _seed_user(session_factory, sub: str = "user-1") -> None:
    with session_factory() as s:
        s.add(User(sub=sub))
        s.commit()


def _account_row(session_factory, email: str = "g@gmail.com", user_sub: str = "user-1") -> Account:
    with session_factory() as s:
        return s.execute(select(Account).where(Account.email == email, Account.user_sub == user_sub)).scalars().one()


def _err(ei: pytest.ExceptionInfo) -> accounts.AccountError:
    return ei.value


# ── add_account 校验分支与 409 ──────────────────────────────────────


def test_add_account_validation_branches(session_factory):
    _seed_user(session_factory)
    with session_factory() as s:
        with pytest.raises(accounts.AccountError) as ei:
            accounts.add_account(s, "user-1", name="x", kind="exchange", email="a@x.com")
        assert _err(ei).code == "bad_kind"

        with pytest.raises(accounts.AccountError) as ei:
            accounts.add_account(s, "user-1", name="  ", kind="gmail", email="a@x.com", app_password="pw")
        assert _err(ei).code == "bad_name"
        with pytest.raises(accounts.AccountError) as ei:
            accounts.add_account(s, "user-1", name="x" * 129, kind="gmail", email="a@x.com", app_password="pw")
        assert _err(ei).code == "bad_name"

        with pytest.raises(accounts.AccountError) as ei:
            accounts.add_account(s, "user-1", name="x", kind="gmail", email="no-at-sign", app_password="pw")
        assert _err(ei).code == "bad_email"
        with pytest.raises(accounts.AccountError) as ei:
            accounts.add_account(s, "user-1", name="x", kind="gmail", email="a@" + "b" * 300, app_password="pw")
        assert _err(ei).code == "bad_email"

        with pytest.raises(accounts.AccountError) as ei:
            accounts.add_account(s, "user-1", name="x", kind="gmail", email="a@x.com", app_password=None)
        assert _err(ei).code == "password_required"
        with pytest.raises(accounts.AccountError) as ei:
            accounts.add_account(s, "user-1", name="x", kind="gmail", email="a@x.com", app_password="   ")
        assert _err(ei).code == "password_required"


def test_add_account_success_trims_and_flushes(session_factory):
    _seed_user(session_factory)
    with session_factory() as s:
        acc = accounts.add_account(
            s, "user-1", name="  学校邮箱  ", kind="gmail",
            email="  a@x.com ", app_password="secret-123",
        )
        assert acc.status == "pending"
        assert acc.enabled is True
        assert acc.id is not None  # flush 过，id 可用（flow 文件路径等按账户隔离）
        assert acc.name == "学校邮箱"
        assert acc.email == "a@x.com"
        assert acc.app_password == "secret-123"
        s.commit()
    row = _account_row(session_factory, "a@x.com")
    assert row.app_password == "secret-123"


def test_add_account_microsoft_ignores_app_password_and_blank_client_id(session_factory):
    _seed_user(session_factory)
    with session_factory() as s:
        acc = accounts.add_account(
            s, "user-1", name="工作邮箱", kind="microsoft", email="m@x.com",
            app_password="ignored", ms_client_id="   ",
        )
        s.commit()
        assert acc.app_password is None
        assert acc.ms_client_id is None
    row = _account_row(session_factory, "m@x.com")
    assert row.app_password is None
    assert row.ms_client_id is None


def test_add_account_does_not_commit_itself(session_factory):
    _seed_user(session_factory)
    with session_factory() as s:  # 只 add 不 commit：退出即回滚
        accounts.add_account(s, "user-1", name="x", kind="gmail", email="a@x.com", app_password="pw")
    with session_factory() as s:
        assert s.execute(select(Account)).scalars().all() == []


def test_add_account_duplicate_409_including_disabled(session_factory):
    _seed_user(session_factory)
    with session_factory() as s:
        acc = accounts.add_account(s, "user-1", name="x", kind="microsoft", email="dup@x.com")
        s.commit()
        dup_id = acc.id
        # 相同 (email, kind) 且已停用（enabled=False）同样 409：含已停用账户
        acc.enabled = False
        s.commit()
        with pytest.raises(accounts.AccountError) as ei:
            accounts.add_account(s, "user-1", name="x", kind="microsoft", email="dup@x.com")
        assert _err(ei).code == "account_exists"
        assert _err(ei).status == 409
        # 同邮箱不同 kind、不同用户同 (email, kind) 都不冲突
        accounts.add_account(s, "user-1", name="x", kind="gmail", email="dup@x.com", app_password="pw")
        accounts.add_account(s, "user-2", name="x", kind="microsoft", email="dup@x.com")
        s.commit()
        with session_factory() as s2:
            assert len(s2.execute(select(Account)).scalars().all()) == 3
        assert dup_id is not None


def test_rename_account(session_factory):
    _seed_user(session_factory)
    with session_factory() as s:
        acc = accounts.add_account(s, "user-1", name="x", kind="gmail", email="a@x.com", app_password="pw")
        s.commit()
        with pytest.raises(accounts.AccountError) as ei:
            accounts.rename_account(s, acc, "  ")
        assert _err(ei).code == "bad_name"
        accounts.rename_account(s, acc, "  新名字  ")
        s.commit()
    assert _account_row(session_factory, "a@x.com").name == "新名字"


def test_set_app_password(session_factory):
    _seed_user(session_factory)
    with session_factory() as s:
        s.add(User(sub="user-2"))
        s.add(Account(user_sub="user-1", name="ms", kind="microsoft", email="m@x.com", status="ok"))
        gmail = Account(user_sub="user-1", name="gm", kind="gmail", email="g@x.com", status="ok", last_error="旧错误")
        s.add(gmail)
        s.commit()
        with pytest.raises(accounts.AccountError) as ei:
            accounts.set_app_password(s, gmail, "   ")
        assert _err(ei).code == "password_required"
        ms = _account_row(session_factory, "m@x.com", "user-1")
        with pytest.raises(accounts.AccountError) as ei:
            accounts.set_app_password(s, ms, "whatever")
        assert _err(ei).code == "invalid_kind"
        accounts.set_app_password(s, gmail, "new-pw")
        assert gmail.app_password == "new-pw"
        assert gmail.status == "pending"
        assert gmail.last_error is None
        s.commit()
    row = _account_row(session_factory, "g@x.com")
    assert row.app_password == "new-pw"
    assert row.status == "pending"


def test_set_enabled_false_clears_credentials_and_keeps_data(session_factory):
    _seed_user(session_factory)
    with session_factory() as s:
        acc = Account(
            user_sub="user-1", name="旧邮箱", kind="gmail", email="old@x.com", status="ok",
            app_password="pw", token_cache=None, last_error="x",
        )
        s.add(acc)
        s.commit()
        em = Email(account_id=acc.id, message_id="<m1>", subject="s", text_body="b", llm_state="done")
        s.add(em)
        s.commit()
        s.add(Item(email_id=em.id, user_sub="user-1", title="t", summary="", category="其他"))
        s.commit()
        acc_id = acc.id
        accounts.set_enabled(s, acc, False)
        assert acc.enabled is False
        assert acc.app_password is None
        assert acc.token_cache is None
        assert acc.status == "pending"
        assert acc.last_error is None
        s.commit()
        accounts.set_enabled(s, acc, True)
        assert acc.enabled is True
        assert acc.app_password is None  # 只置位，凭据需另行设置
        s.commit()
    with session_factory() as s:
        row = s.get(Account, acc_id)
        assert row.enabled is True
        assert row.app_password is None
        assert len(s.execute(select(Email)).scalars().all()) == 1  # 邮件与任务都保留
        assert len(s.execute(select(Item)).scalars().all()) == 1


def _fts_count(session_factory) -> int:
    with session_factory() as s:
        return s.execute(text("SELECT count(*) FROM emails_fts")).scalar_one()


def _seed_delete_tree(session_factory) -> tuple[Account, Account, Email, Item, Item]:
    """用户 A 两账户：a（2 邮件 2 邮件条目）、b（1 邮件 1 条目）+ 1 手动条目。返回相关对象。"""
    with session_factory() as s:
        s.add(User(sub="user-1"))
        s.commit()
        a = Account(user_sub="user-1", name="a", kind="gmail", email="a@x.com", app_password="pw", status="ok")
        b = Account(user_sub="user-1", name="b", kind="microsoft", email="b@x.com", status="ok", token_cache="tok")
        s.add_all([a, b])
        s.commit()
        ea1 = Email(account_id=a.id, message_id="<a1>", subject="a1", text_body="b", llm_state="done")
        ea2 = Email(account_id=a.id, message_id="<a2>", subject="a2", text_body="b", llm_state="done")
        eb = Email(account_id=b.id, message_id="<b1>", subject="b1", text_body="b", llm_state="done")
        s.add_all([ea1, ea2, eb])
        s.commit()
        ia1 = Item(email_id=ea1.id, user_sub="user-1", title="ia1", summary="", category="其他", status="open")
        ia2 = Item(email_id=ea2.id, user_sub="user-1", title="ia2", summary="", category="其他", status="open")
        ib = Item(email_id=eb.id, user_sub="user-1", title="ib", summary="", category="其他", status="open")
        manual = Item(email_id=None, user_sub="user-1", title="手动", summary="", category="其他", status="open")
        s.add_all([ia1, ia2, ib, manual])
        s.commit()
        return a, b, ea1, ib, manual


def test_delete_account_cascades_and_keeps_others(session_factory, tmp_path):
    settings = Settings(database_path=str(tmp_path / "rk.db"))
    a, _b, ea1, _ib, manual = _seed_delete_tree(session_factory)
    assert _fts_count(session_factory) == 3  # 3 封邮件全部进 FTS（手动条目无邮件不计）
    stale = tmp_path / (f".auth_flow_{a.id}.json")
    stale.write_text("{}")  # 陈旧 flow 文件应在删除时被清掉

    with session_factory() as s:
        row_a = s.get(Account, a.id)
        accounts.delete_account(s, row_a, settings)
        s.commit()

    with session_factory() as s:
        emails = s.execute(select(Email)).scalars().all()
        items = s.execute(select(Item)).scalars().all()
        rows = s.execute(select(Account)).scalars().all()
        assert [e.message_id for e in emails] == ["<b1>"]
        assert [i.title for i in items] == ["ib", "手动"]  # B 的条目与手动条目（email_id NULL）保留
        assert [r.email for r in rows] == ["b@x.com"]
        assert s.get(Email, ea1.id) is None
        assert s.get(Account, a.id) is None
        assert s.get(Item, manual.id) is not None
    assert not stale.exists()  # 陈旧 flow 文件被清理
    assert _fts_count(session_factory) == 1  # FTS 触发器随 emails 行删除同步


# ── 微软授权码流程（服务层） ────────────────────────────────────────


def _ms_account(session_factory, sub: str = "user-1", email: str = "m@x.com") -> Account:
    with session_factory() as s:
        acc = Account(user_sub=sub, name="ms", kind="microsoft", email=email, status="pending")
        s.add(acc)
        s.commit()
        return acc


def _gmail_account(session_factory, sub: str = "user-1", email: str = "g@x.com") -> Account:
    with session_factory() as s:
        acc = Account(user_sub=sub, name="g", kind="gmail", email=email, app_password="pw")
        s.add(acc)
        s.commit()
        return acc


def _patch_flow_path(monkeypatch, tmp_path, account_id: int) -> None:
    """把 flow 文件路径指到 tmp_path（服务层经 mstoken 模块属性调用，patch 模块即可）。"""
    target = tmp_path / (f".auth_flow_{account_id}.json")
    monkeypatch.setattr(mstoken, "flow_file_path", lambda account, settings: target)


def test_start_ms_auth_invalid_kind_and_bad_redirect(session_factory, tmp_path, monkeypatch):
    gmail = _gmail_account(session_factory)
    ms = _ms_account(session_factory)
    with session_factory() as s:
        with pytest.raises(accounts.AccountError) as ei:
            accounts.start_ms_auth(s.get(Account, gmail.id), Settings(database_path=":memory:"))
        assert _err(ei).code == "invalid_kind"
        with pytest.raises(accounts.AccountError) as ei:
            accounts.start_ms_auth(s.get(Account, ms.id), Settings(database_path=":memory:"), "https://evil.example/cb")
        assert _err(ei).code == "bad_redirect"


def test_start_ms_auth_returns_auth_uri(session_factory, tmp_path, monkeypatch):
    ms = _ms_account(session_factory)
    _patch_flow_path(monkeypatch, tmp_path, ms.id)
    captured = {}

    def fake_initiate(account, settings=None, redirect_uri=DEFAULT_REDIRECT):
        captured["redirect_uri"] = redirect_uri
        return {"auth_uri": "https://login.microsoftonline.com/.../authorize?x=1", "flow": {"state": "s"}}

    monkeypatch.setattr(mstoken, "initiate_auth_code_flow", fake_initiate)
    uri = accounts.start_ms_auth(ms, Settings(database_path=":memory:"), None)
    assert uri == "https://login.microsoftonline.com/.../authorize?x=1"
    assert captured["redirect_uri"] == DEFAULT_REDIRECT  # 缺省 = mstoken.DEFAULT_REDIRECT_URI
    uri2 = accounts.start_ms_auth(ms, Settings(database_path=":memory:"), "urn:ietf:wg:oauth:2.0:oob")
    assert captured["redirect_uri"] == "urn:ietf:wg:oauth:2.0:oob"
    assert uri2 == uri  # fake 只改 captured，两次返回相同


def test_finish_ms_auth_invalid_kind_blank_response(session_factory, tmp_path, monkeypatch):
    gmail = _gmail_account(session_factory)
    ms = _ms_account(session_factory)
    with session_factory() as s:
        with pytest.raises(accounts.AccountError) as ei:
            accounts.finish_ms_auth(s.get(Account, gmail.id), Settings(database_path=":memory:"), "the-code")
        assert _err(ei).code == "invalid_kind"
        with pytest.raises(accounts.AccountError) as ei:
            accounts.finish_ms_auth(s.get(Account, ms.id), Settings(database_path=":memory:"), "   ")
        assert _err(ei).code == "bad_request"


def test_finish_ms_auth_no_pending_flow_and_corrupt_file(session_factory, tmp_path, monkeypatch):
    ms = _ms_account(session_factory)
    _patch_flow_path(monkeypatch, tmp_path, ms.id)
    settings = Settings(database_path=":memory:")
    with pytest.raises(accounts.AccountError) as ei:
        accounts.finish_ms_auth(ms, settings, "code-1")
    assert _err(ei).code == "no_pending_flow"
    assert _err(ei).status == 409
    # 文件损坏：同样 no_pending_flow，且损坏文件被先删掉（避免每次重试都撞 409）
    (tmp_path / (f".auth_flow_{ms.id}.json")).write_text("{not-json")
    with pytest.raises(accounts.AccountError) as ei:
        accounts.finish_ms_auth(ms, settings, "code-1")
    assert _err(ei).code == "no_pending_flow"
    assert not (tmp_path / (f".auth_flow_{ms.id}.json")).exists()


def test_finish_ms_auth_auth_failed_kind_declined(session_factory, tmp_path, monkeypatch):
    ms = _ms_account(session_factory)
    _patch_flow_path(monkeypatch, tmp_path, ms.id)
    flow_file = tmp_path / (f".auth_flow_{ms.id}.json")
    flow_file.write_text(json.dumps({"state": "s", "code_verifier": "v"}))

    def fake_complete(account, flow, auth_response, settings=None):
        raise mstoken.DeviceFlowError("declined", "AADSTS65004: User declined.")

    monkeypatch.setattr(mstoken, "complete_auth_code_flow", fake_complete)
    with pytest.raises(accounts.AccountError) as ei:
        accounts.finish_ms_auth(ms, Settings(database_path=":memory:"), "the-code")
    err = _err(ei)
    assert err.code == "auth_failed"
    assert err.status == 400
    assert err.extra["kind"] == "declined"
    assert "AADSTS65004" in err.extra["detail"]


def test_finish_ms_auth_success_sets_status_ok(session_factory, tmp_path, monkeypatch):
    ms = _ms_account(session_factory)
    _patch_flow_path(monkeypatch, tmp_path, ms.id)
    flow_file = tmp_path / (f".auth_flow_{ms.id}.json")
    flow_file.write_text(json.dumps({"state": "s", "code_verifier": "v"}))
    captured = {}

    def fake_complete(account, flow, auth_response, settings=None):
        captured["auth_response"] = auth_response
        account.token_cache = "cache-json-1"  # 真实路径里由 msal 序列化写回
        return {"access_token": "at"}

    monkeypatch.setattr(mstoken, "complete_auth_code_flow", fake_complete)
    with session_factory() as s:
        row = s.get(Account, ms.id)
        accounts.finish_ms_auth(row, Settings(database_path=":memory:"), "code-1")
        assert row.status == "ok"
        assert row.last_error is None
        assert row.token_cache == "cache-json-1"
        s.commit()
    assert captured["auth_response"] == "code-1"
    row = _account_row(session_factory, "m@x.com")
    assert row.status == "ok"
    assert row.token_cache == "cache-json-1"


def test_account_info_never_leaks_credentials(session_factory):
    _seed_user(session_factory)
    with session_factory() as s:
        gmail = Account(user_sub="user-1", name="g", kind="gmail", email="g@x.com",
                        app_password="SECRET-PW", status="ok", ms_client_id="cid")
        ms = Account(user_sub="user-1", name="m", kind="microsoft", email="m@x.com",
                     token_cache="SECRET-CACHE", status="pending")
        s.add_all([gmail, ms])
        s.commit()
        info = accounts.account_info(gmail)
        assert info["has_credentials"] is True
        assert "app_password" not in info and "token_cache" not in info
        assert json.dumps(info, ensure_ascii=False).find("SECRET") == -1
        assert accounts.account_info(ms)["has_credentials"] is True
        ms.token_cache = None
        assert accounts.account_info(ms)["has_credentials"] is False


def test_has_credentials_by_kind(session_factory):
    _seed_user(session_factory)
    with session_factory() as s:
        gmail = Account(user_sub="user-1", name="g", kind="gmail", email="g@x.com")
        ms = Account(user_sub="user-1", name="m", kind="microsoft", email="m@x.com")
        s.add_all([gmail, ms])
        s.commit()
        assert accounts.has_credentials(gmail) is False
        assert accounts.has_credentials(ms) is False
        gmail.app_password = "pw"
        ms.token_cache = "{}"
        assert accounts.has_credentials(gmail) is True
        assert accounts.has_credentials(ms) is True


def test_list_and_get_owned(session_factory):
    _seed_user(session_factory)
    with session_factory() as s:
        s.add(User(sub="user-2"))
        a1 = Account(user_sub="user-1", name="b", kind="gmail", email="b@x.com", app_password="pw")
        a2 = Account(user_sub="user-1", name="a", kind="microsoft", email="a@x.com")
        a3 = Account(user_sub="user-2", name="c", kind="microsoft", email="c@x.com")
        s.add_all([a1, a2, a3])
        s.commit()
        rows = accounts.list_accounts(s, "user-1")
        assert [r.id for r in rows] == sorted([a1.id, a2.id])  # 按 id 升序、不含他人账户
        assert accounts.get_owned_account(s, "user-1", a3.id) is None
        assert accounts.get_owned_account(s, "user-1", a1.id).email == "b@x.com"


# ── sync.run_once：无凭据账户跳过 ───────────────────────────────────


def test_run_once_skips_account_without_credentials(session_factory):
    """enabled 但 token_cache=None 的 microsoft 账户：不建 IMAP、不改字段、summary 记 pending。"""
    with session_factory() as s:
        s.add(User(sub="user-1"))
        s.commit()
        acc = Account(user_sub="user-1", name="未授权", kind="microsoft", email="m@x.com", status="pending")
        s.add(acc)
        s.commit()
        acc_id = acc.id

    imap_calls: list[str] = []

    def factory(account, settings):
        imap_calls.append(account.email)
        raise AssertionError("无凭据账户不应建立 IMAP 连接")

    summary = run_once(session_factory, imap_factory=factory, llm=None)
    assert imap_calls == []
    assert summary["accounts"] == {"m@x.com": {"status": "pending", "error": None}}
    with session_factory() as s:
        row = s.get(Account, acc_id)
        assert row.status == "pending"  # 原字段未被改动（不被打成 error）
        assert row.last_error is None
        assert row.enabled is True
        assert row.last_sync_at is None
