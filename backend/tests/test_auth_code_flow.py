"""授权码流程（authorization code + PKCE）：flow 落盘/清理、回调解析、失败分类与 CLI 输出。

全部离线：monkeypatch msal 的 initiate/acquire，不触网。
"""
from __future__ import annotations

import argparse
import json
import types
from pathlib import Path

import pytest
from sqlalchemy import select

from app import cli
from app.config import Settings
from app.db import init_db, make_engine, make_session_factory
from app.imap import mstoken
from app.models import Account, User

FAKE_AUTH_URI = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x"


def _account() -> types.SimpleNamespace:
    return types.SimpleNamespace(id=7, token_cache=None, ms_client_id=None)


def _settings(tmp_path) -> Settings:
    return Settings(database_path=str(tmp_path / "rakkotasks.db"))


def _fake_initiate_flow(self, scopes, redirect_uri=None):
    return {
        "auth_uri": FAKE_AUTH_URI,
        "state": "state-1",
        "code_verifier": "verifier-1",
        "redirect_uri": redirect_uri or mstoken.DEFAULT_REDIRECT_URI,
    }


def _initiate(monkeypatch, account, settings, redirect_uri: str | None = None) -> dict:
    """走真实 initiate_auth_code_flow（msal 已打桩），返回 flow dict 并留下落盘文件。"""
    monkeypatch.setattr(mstoken.PublicClientApplication, "initiate_auth_code_flow", _fake_initiate_flow)
    return mstoken.initiate_auth_code_flow(account, settings, redirect_uri)["flow"]


def _cli_ctx(tmp_path) -> Settings:
    db = str(tmp_path / "cli.db")
    engine = make_engine(db)
    init_db(engine)
    with make_session_factory(engine)() as session:
        session.add(User(sub="sub-1", email="u@example.com", name="甲"))
        session.add(
            Account(user_sub="sub-1", name="邮箱", kind="microsoft", email="m@example.com", status="pending")
        )
        session.commit()  # session 上下文退出只 close 不提交，必须显式 commit
    return Settings(database_path=db)


def _account_id(settings: Settings) -> int:
    with make_session_factory(make_engine(settings.database_path))() as session:
        return session.execute(select(Account).where(Account.email == "m@example.com")).scalars().first().id


def _acquire_ok(self, auth_code_flow, auth_response, scopes=None):
    return {"access_token": "at-1", "expires_in": 3600}


def test_initiate_returns_auth_uri_and_writes_0600_flow_file(monkeypatch, tmp_path):
    """测试点 1：返回 dict 含 auth_uri；flow 文件写到预期路径、权限 0600。"""
    settings = _settings(tmp_path)
    account = _account()
    captured = {}

    def fake_initiate(self, scopes, redirect_uri=None):
        captured["scopes"] = scopes
        captured["redirect_uri"] = redirect_uri
        return _fake_initiate_flow(self, scopes, redirect_uri)

    monkeypatch.setattr(mstoken.PublicClientApplication, "initiate_auth_code_flow", fake_initiate)
    out = mstoken.initiate_auth_code_flow(account, settings)
    assert out["auth_uri"] == FAKE_AUTH_URI
    assert out["flow"]["state"] == "state-1"
    assert captured["scopes"] == mstoken.MS_SCOPE
    assert captured["redirect_uri"] == mstoken.DEFAULT_REDIRECT_URI
    path = mstoken.flow_file_path(account, settings)
    assert path == Path(settings.database_path).parent / ".auth_flow_7.json"  # 数据库同目录，按账户隔离
    assert path.exists()
    assert path.stat().st_mode & 0o777 == 0o600
    saved = json.loads(path.read_text())
    assert saved["state"] == "state-1"
    assert saved["code_verifier"] == "verifier-1"  # PKCE verifier 随 flow 落盘，第二步换 token 要用


def test_initiate_forwards_custom_redirect_uri(monkeypatch, tmp_path):
    settings = _settings(tmp_path)
    account = _account()
    captured = {}

    def fake_initiate(self, scopes, redirect_uri=None):
        captured["redirect_uri"] = redirect_uri
        return _fake_initiate_flow(self, scopes, redirect_uri)

    monkeypatch.setattr(mstoken.PublicClientApplication, "initiate_auth_code_flow", fake_initiate)
    mstoken.initiate_auth_code_flow(account, settings, "urn:ietf:wg:oauth:2.0:oob")
    assert captured["redirect_uri"] == "urn:ietf:wg:oauth:2.0:oob"


def test_complete_parses_full_callback_url(monkeypatch, tmp_path):
    """测试点 2：完整回调 URL → 传给 msal 的 dict 正确解析出 code 与 state。"""
    settings = _settings(tmp_path)
    account = _account()
    flow = _initiate(monkeypatch, account, settings)
    captured = {}

    def fake_acquire(self, auth_code_flow, auth_response, scopes=None):
        captured["auth_code_flow"] = auth_code_flow
        captured["auth_response"] = auth_response
        return _acquire_ok(self, auth_code_flow, auth_response, scopes)

    monkeypatch.setattr(mstoken.PublicClientApplication, "acquire_token_by_auth_code_flow", fake_acquire)
    url = (
        "https://login.microsoftonline.com/common/oauth2/nativeclient"
        "?code=THE-CODE-123&state=state-1&session_state=abc"
    )
    result = mstoken.complete_auth_code_flow(account, flow, url, settings)
    assert result["access_token"] == "at-1"
    assert captured["auth_code_flow"] is flow
    assert captured["auth_response"] == {"code": "THE-CODE-123", "state": "state-1"}
    assert account.token_cache  # token cache 已落库


def test_complete_assembles_bare_code_with_flow_state(monkeypatch, tmp_path):
    """测试点 3：裸授权码 → 组装成 {"code": ..., "state": flow["state"]}。"""
    settings = _settings(tmp_path)
    account = _account()
    flow = _initiate(monkeypatch, account, settings)
    captured = {}

    def fake_acquire(self, auth_code_flow, auth_response, scopes=None):
        captured["auth_response"] = auth_response
        return _acquire_ok(self, auth_code_flow, auth_response, scopes)

    monkeypatch.setattr(mstoken.PublicClientApplication, "acquire_token_by_auth_code_flow", fake_acquire)
    result = mstoken.complete_auth_code_flow(account, flow, "0.AXYz-ABC.def", settings)
    assert result["access_token"] == "at-1"
    assert captured["auth_response"] == {"code": "0.AXYz-ABC.def", "state": "state-1"}


def test_complete_deletes_flow_file_on_success(monkeypatch, tmp_path):
    """测试点 4a：成功后 flow 文件被删除。"""
    settings = _settings(tmp_path)
    account = _account()
    flow = _initiate(monkeypatch, account, settings)
    assert mstoken.flow_file_path(account, settings).exists()
    monkeypatch.setattr(mstoken.PublicClientApplication, "acquire_token_by_auth_code_flow", _acquire_ok)
    mstoken.complete_auth_code_flow(account, flow, "the-code", settings)
    assert not mstoken.flow_file_path(account, settings).exists()


@pytest.mark.parametrize(
    "result,expected_kind",
    [
        # 测试点 6：AADSTS65001 → admin_required，与设备码流程分类一致
        (
            {"error": "invalid_grant", "error_description": "AADSTS65001: The user or administrator has not consented."},
            "admin_required",
        ),
        (
            {"error": "invalid_grant", "error_description": "AADSTS70008: The provided authorization code has expired."},
            "other",
        ),
        ({"error": "authorization_declined", "error_description": "AADSTS65004: User declined."}, "declined"),
    ],
)
def test_complete_failure_classified_and_deletes_flow_file(monkeypatch, tmp_path, result, expected_kind):
    """测试点 4b+6：失败按 AADSTS 码分类，且失败同样删除 flow 文件。"""
    settings = _settings(tmp_path)
    account = _account()
    flow = _initiate(monkeypatch, account, settings)
    assert mstoken.flow_file_path(account, settings).exists()

    def fake_acquire(self, auth_code_flow, auth_response, scopes=None):
        return result

    monkeypatch.setattr(mstoken.PublicClientApplication, "acquire_token_by_auth_code_flow", fake_acquire)
    with pytest.raises(mstoken.DeviceFlowError) as ei:
        mstoken.complete_auth_code_flow(account, flow, "the-code", settings)
    assert ei.value.kind == expected_kind
    assert not mstoken.flow_file_path(account, settings).exists()


def test_complete_error_page_url_classified(monkeypatch, tmp_path):
    """用户把授权错误页 URL 整段粘贴回来时，按 error_description 里的 AADSTS 码分类。"""
    settings = _settings(tmp_path)
    account = _account()
    flow = _initiate(monkeypatch, account, settings)
    url = "https://login.microsoftonline.com/common/oauth2/nativeclient?error=invalid_grant&error_description=AADSTS65001%3A+no+consent"
    with pytest.raises(mstoken.DeviceFlowError) as ei:
        mstoken.complete_auth_code_flow(account, flow, url, settings)
    assert ei.value.kind == "admin_required"
    assert not mstoken.flow_file_path(account, settings).exists()


def test_complete_state_mismatch_valueerror_is_friendly(monkeypatch, tmp_path):
    """msal 对 state 不匹配抛 ValueError（CSRF 防护）：归类 other 而不是冒 traceback。"""
    settings = _settings(tmp_path)
    account = _account()
    flow = _initiate(monkeypatch, account, settings)

    def fake_acquire(self, auth_code_flow, auth_response, scopes=None):
        raise ValueError("state mismatch")

    monkeypatch.setattr(mstoken.PublicClientApplication, "acquire_token_by_auth_code_flow", fake_acquire)
    with pytest.raises(mstoken.DeviceFlowError) as ei:
        mstoken.complete_auth_code_flow(account, flow, "the-code", settings)
    assert ei.value.kind == "other"
    assert "state" in ei.value.detail
    assert not mstoken.flow_file_path(account, settings).exists()


def test_auth_url_prints_link_and_step2_template(monkeypatch, tmp_path, capsys):
    """auth-url 输出：授权链接单独一行便于复制；第二步模板填好实际 --user 与邮箱。"""
    settings = _cli_ctx(tmp_path)
    monkeypatch.setattr(mstoken.PublicClientApplication, "initiate_auth_code_flow", _fake_initiate_flow)
    args = argparse.Namespace(user="sub-1", email="m@example.com", redirect_uri=mstoken.DEFAULT_REDIRECT_URI)
    cli._cmd_accounts_auth_url(args, settings)
    out = capsys.readouterr().out
    link_lines = [line for line in out.splitlines() if line.startswith(FAKE_AUTH_URI)]
    assert len(link_lines) == 1  # 授权链接独占一行，便于复制
    assert "python -m app.cli accounts auth-code --user sub-1 m@example.com" in out


def test_auth_code_without_flow_file_is_friendly(monkeypatch, tmp_path, capsys):
    """测试点 5：flow 文件不存在 → 明确中文错误、退出码 1、无 traceback。"""
    settings = _cli_ctx(tmp_path)
    args = argparse.Namespace(user="sub-1", email="m@example.com", auth_response="code-xyz")
    with pytest.raises(SystemExit) as ei:
        cli._cmd_accounts_auth_code(args, settings)
    assert ei.value.code == 1
    captured = capsys.readouterr()
    assert "未找到进行中的授权流程，请先运行 accounts auth-url" in captured.out + captured.err
    assert "Traceback" not in captured.out + captured.err


def test_auth_code_success_sets_status_ok(monkeypatch, tmp_path, capsys):
    """auth-code 成功后：打印「授权成功：<邮箱>，token 已保存」，status 与设备码成功一致。"""
    settings = _cli_ctx(tmp_path)
    account = types.SimpleNamespace(id=_account_id(settings), token_cache=None, ms_client_id=None)
    _initiate(monkeypatch, account, settings)  # 落盘 flow 文件，供 CLI 读回
    monkeypatch.setattr(mstoken.PublicClientApplication, "acquire_token_by_auth_code_flow", _acquire_ok)
    args = argparse.Namespace(user="sub-1", email="m@example.com", auth_response="the-code")
    cli._cmd_accounts_auth_code(args, settings)
    out = capsys.readouterr().out
    assert "授权成功：m@example.com，token 已保存" in out
    assert not mstoken.flow_file_path(account, settings).exists()
    with make_session_factory(make_engine(settings.database_path))() as session:
        acc = session.execute(select(Account).where(Account.email == "m@example.com")).scalars().first()
        assert acc.status == "ok"
        assert acc.last_error is None
        assert acc.token_cache


def test_auth_code_cli_failure_is_friendly(monkeypatch, tmp_path, capsys):
    """auth-code 失败：按 DeviceFlowError.kind 输出友好提示、退出码 1、无 traceback。"""
    settings = _cli_ctx(tmp_path)
    account = types.SimpleNamespace(id=_account_id(settings), token_cache=None, ms_client_id=None)
    _initiate(monkeypatch, account, settings)  # 落盘 flow 文件，供 CLI 读回

    def fake_acquire(self, auth_code_flow, auth_response, scopes=None):
        return {"error": "invalid_grant", "error_description": "AADSTS65001: no consent. Trace ID: abc"}

    monkeypatch.setattr(mstoken.PublicClientApplication, "acquire_token_by_auth_code_flow", fake_acquire)
    args = argparse.Namespace(user="sub-1", email="m@example.com", auth_response="the-code")
    with pytest.raises(SystemExit) as ei:
        cli._cmd_accounts_auth_code(args, settings)
    assert ei.value.code == 1
    captured = capsys.readouterr()
    assert "该租户要求管理员同意此应用" in captured.out
    assert "Traceback" not in captured.out + captured.err
    assert not mstoken.flow_file_path(account, settings).exists()
