"""mstoken 常量离线断言：钉死 OAuth 资源域名与 IMAP 主机名的区别。"""
from __future__ import annotations

import types

from app.config import Settings
from app.imap import mstoken
from app.imap.client import MS_IMAP_HOST
from app.imap.mstoken import MS_SCOPE


def test_ms_scope_uses_resource_domain_outlook_office_com():
    # 资源域名写错成 IMAP 主机名 outlook.office365.com 会被微软拒为
    # AADSTS70011 invalid_scope，设备码流程无法启动。
    assert MS_SCOPE == ["https://outlook.office.com/IMAP.AccessAsUser.All"]
    assert "outlook.office365.com" not in MS_SCOPE[0]


def test_ms_imap_host_stays_outlook_office365_com():
    # IMAP 服务器主机名与 OAuth 资源域名不是一回事，防止被"顺手统一"。
    assert MS_IMAP_HOST == "outlook.office365.com"


def test_ms_default_client_id_is_thunderbird():
    # Thunderbird 注册的公共客户端，第三方应用，可用于 IMAP。
    assert Settings().ms_default_client_id == "9e5f94bc-e8a4-4e73-b8be-63364c29d753"


def test_ms_default_client_id_not_microsoft_office():
    # 不要改回 d3590ed6-52b3-4102-aeff-aad2292ab01c（Microsoft Office）：
    # 那是第一方应用，访问 Exchange Online 必须经预授权，会报
    # AADSTS65002，拿不到 IMAP token。
    assert (
        Settings().ms_default_client_id
        != "d3590ed6-52b3-4102-aeff-aad2292ab01c"
    ), "默认 client_id 不能是 Microsoft Office 的 d3590ed6：第一方应用访问 Exchange Online 需要预授权，会报 AADSTS65002，IMAP 拿不到 token"


# ── acquire_token_silent：msal 的 account 参数必须是账户字典，传邮箱字符串会 AttributeError ──


def _account() -> types.SimpleNamespace:
    return types.SimpleNamespace(token_cache=None, ms_client_id=None, email="m@example.com")


def _settings() -> Settings:
    return Settings(ms_default_client_id="test-client")


class _FakeMsalApp:
    """替身 msal app：get_accounts 按 username 过滤，acquire_token_silent 行为可配。

    token_cache.serialize 返回固定串，让真实的 _save_cache 能跑通
    （_save_cache 本身只做序列化写回 account.token_cache）。
    """

    def __init__(self, by_username=None, all_accounts=None, acquire=None):
        self.by_username = list(by_username or [])
        self.all_accounts = list(all_accounts or [])
        self._acquire = acquire
        self.acquired_with = []  # 记录每次 acquire_token_silent 收到的 account 实参
        self.token_cache = types.SimpleNamespace(serialize=lambda: "cache-serialized")

    def get_accounts(self, username=None):
        if username is None:
            return list(self.all_accounts)
        return list(self.by_username)

    def acquire_token_silent(self, scopes, account):
        self.acquired_with.append(account)
        if self._acquire:
            return self._acquire(account)
        return {"access_token": "at-1"}


def _patch_app(monkeypatch, app) -> None:
    monkeypatch.setattr(mstoken, "_app", lambda account, settings: app)


def _raise_on_str(account):
    # 模拟真实 msal：account 是字符串时在内部 .get() 上直接 AttributeError
    if isinstance(account, str):
        raise AttributeError("'str' object has no attribute 'get'")
    return {"access_token": "at-1"}


def test_silent_never_passes_email_string_to_msal(monkeypatch):
    """回归钉死：真实 msal 对字符串 account 抛 AttributeError。

    修复前 acquire_token_silent 把 account.email（str）直接传给 msal，
    AttributeError 会从第一行就炸出来（兜底重试代码根本执行不到），
    本测试在修复前必须失败。
    """
    account = _account()
    matched = {"home_account_id": "h1", "username": account.email}
    app = _FakeMsalApp(by_username=[matched], all_accounts=[matched], acquire=_raise_on_str)
    _patch_app(monkeypatch, app)
    assert mstoken.acquire_token_silent(account, _settings()) == "at-1"
    assert app.acquired_with == [matched]  # 传给 msal 的是账户字典，且只调了一次


def test_silent_uses_username_matched_account_dict(monkeypatch):
    """get_accounts(username=...) 命中时，传给 msal 的是该账户字典（dict 且内容正确）。"""
    account = _account()
    matched = {"home_account_id": "h1", "username": account.email}
    app = _FakeMsalApp(by_username=[matched], all_accounts=[{"home_account_id": "other"}])
    _patch_app(monkeypatch, app)
    assert mstoken.acquire_token_silent(account, _settings()) == "at-1"
    assert len(app.acquired_with) == 1
    assert isinstance(app.acquired_with[0], dict)
    assert app.acquired_with[0] == matched


def test_silent_falls_back_to_first_cached_account(monkeypatch):
    """按用户名匹配不到时退回 get_accounts() 的第一个账户。

    微软返回的 username 大小写/形式可能与我们存的邮箱不一致
    （如 UNSW 的 zID@ad.unsw.edu.au），不能因为对不上就放弃。
    """
    account = _account()
    first = {"home_account_id": "h1", "username": "Z1234567@ad.unsw.edu.au"}
    app = _FakeMsalApp(by_username=[], all_accounts=[first, {"home_account_id": "h2"}])
    _patch_app(monkeypatch, app)
    assert mstoken.acquire_token_silent(account, _settings()) == "at-1"
    assert app.acquired_with == [first]


def test_silent_empty_cache_returns_none_without_raising(monkeypatch):
    """缓存为空时返回 None 不抛异常；调用方 connect_account 会把账户标记为 error。"""
    app = _FakeMsalApp(by_username=[], all_accounts=[])
    _patch_app(monkeypatch, app)
    assert mstoken.acquire_token_silent(_account(), _settings()) is None
    assert app.acquired_with == []


def test_silent_acquire_error_dict_returns_none(monkeypatch):
    """msal 返回错误 dict（无 access_token）时返回 None，不落库。"""
    app = _FakeMsalApp(
        by_username=[{"home_account_id": "h1"}],
        all_accounts=[{"home_account_id": "h1"}],
        acquire=lambda acc: {"error": "invalid_grant", "error_description": "AADSTS70008: expired"},
    )
    _patch_app(monkeypatch, app)
    assert mstoken.acquire_token_silent(_account(), _settings()) is None


def test_silent_success_saves_cache(monkeypatch):
    """成功路径必须 _save_cache：msal 静默刷新会轮转 refresh token，不落库下次就失效。"""
    account = _account()
    app = _FakeMsalApp(by_username=[{"home_account_id": "h1"}], all_accounts=[{"home_account_id": "h1"}])
    _patch_app(monkeypatch, app)
    calls = []
    monkeypatch.setattr(mstoken, "_save_cache", lambda acct, a: calls.append((acct, a)))
    assert mstoken.acquire_token_silent(account, _settings()) == "at-1"
    assert len(calls) == 1
    assert calls[0][0] is account
    assert calls[0][1] is app
