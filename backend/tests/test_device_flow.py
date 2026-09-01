"""设备码授权失败分类与 CLI 友好输出：全部离线（monkeypatch msal 调用）。"""
from __future__ import annotations

import argparse
import types

import pytest

from app import cli
from app.config import Settings
from app.db import init_db, make_engine, make_session_factory
from app.imap import mstoken
from app.imap.mstoken import DeviceFlowError
from app.models import Account, User


def _account() -> types.SimpleNamespace:
    return types.SimpleNamespace(token_cache=None, ms_client_id=None)


def _settings() -> Settings:
    return Settings(ms_default_client_id="test-client")


def _fail_result(error: str, desc: str) -> dict:
    return {"error": error, "error_description": desc, "correlation_id": "xxx"}


@pytest.mark.parametrize(
    "error,desc,expected",
    [
        ("expired_token", "AADSTS70016: The request has not yet been authorized.", "expired"),
        ("authorization_pending", "AADSTS70016: still waiting for user input.", "expired"),
        ("invalid_grant", "AADSTS65004: User declined to consent.", "declined"),
        ("authorization_declined", "AADSTS65004: declined.", "declined"),
        ("invalid_grant", "AADSTS65001: The user or administrator has not consented.", "admin_required"),
        ("unauthorized_client", "AADSTS90094: Admin consent required.", "admin_required"),
        ("server_error", "AADSTS50013: unexpected.", "other"),
    ],
)
def test_wait_for_device_completion_classifies(monkeypatch, error, desc, expected):
    result = _fail_result(error, desc)
    monkeypatch.setattr(
        mstoken.PublicClientApplication, "acquire_token_by_device_flow", lambda self, flow: result
    )
    with pytest.raises(DeviceFlowError) as ei:
        mstoken.wait_for_device_completion(_account(), {}, _settings())
    assert ei.value.kind == expected
    assert ei.value.detail == desc


def _connect_ctx(tmp_path):
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


@pytest.mark.parametrize(
    "kind,detail,needle",
    [
        ("expired", "AADSTS70016: not yet authorized. Trace ID: abc", "授权超时"),
        ("declined", "AADSTS65004: declined.", "授权被拒绝"),
        ("admin_required", "AADSTS65001: no consent. Trace ID: abc", "该租户要求管理员同意此应用"),
        ("other", "AADSTS50013: unexpected. Trace ID: abc", "设备码授权失败"),
    ],
)
def test_connect_device_flow_error_is_friendly(monkeypatch, tmp_path, capsys, kind, detail, needle):
    settings = _connect_ctx(tmp_path)

    def fake_initiate(account, settings=None):
        return {"message": "请在浏览器打开 …", "_flow": {"device_code": "d"}}

    def fail_wait(account, flow, settings=None):
        raise DeviceFlowError(kind, detail)

    monkeypatch.setattr(mstoken, "initiate_device_flow", fake_initiate)
    monkeypatch.setattr(mstoken, "wait_for_device_completion", fail_wait)

    args = argparse.Namespace(user="sub-1", email="m@example.com")
    with pytest.raises(SystemExit) as ei:
        cli._cmd_accounts_connect(args, settings)
    assert ei.value.code == 1

    captured = capsys.readouterr()
    assert "Traceback" not in captured.out
    assert "Traceback" not in captured.err
    assert needle in captured.out


def test_connect_expired_prints_copyable_retry_with_actual_email(monkeypatch, tmp_path, capsys):
    settings = _connect_ctx(tmp_path)

    def fake_initiate(account, settings=None):
        return {"message": "请在浏览器打开 …", "_flow": {"device_code": "d"}}

    def fail_wait(account, flow, settings=None):
        raise DeviceFlowError("expired", "AADSTS70016: ... Trace ID: abc")

    monkeypatch.setattr(mstoken, "initiate_device_flow", fake_initiate)
    monkeypatch.setattr(mstoken, "wait_for_device_completion", fail_wait)

    args = argparse.Namespace(user="sub-1", email="m@example.com")
    with pytest.raises(SystemExit) as ei:
        cli._cmd_accounts_connect(args, settings)
    assert ei.value.code == 1

    out = capsys.readouterr().out
    assert "授权超时" in out
    # 重试命令可直接复制：填的是本次实际传入的 --user 与 email
    assert "python -m app.cli accounts connect --user sub-1 m@example.com" in out
    assert out.count("python -m app.cli accounts connect") == 1
