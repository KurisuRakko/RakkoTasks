"""微软 OAuth2 device code flow：msal PublicClientApplication + SerializableTokenCache 落库。"""
from __future__ import annotations

import json

from msal import PublicClientApplication, SerializableTokenCache

from app.config import Settings, get_settings

MS_AUTHORITY = "https://login.microsoftonline.com/common"
# OAuth 资源域名是 outlook.office.com，与 IMAP 服务器主机名 outlook.office365.com
# 不是一回事——写成后者会被微软拒为 AADSTS70011 invalid_scope。
MS_SCOPE = ["https://outlook.office.com/IMAP.AccessAsUser.All"]


def _app(account, settings: Settings) -> PublicClientApplication:
    """按账户重建 msal 应用；token_cache 序列化内容来自 DB。"""
    cache = SerializableTokenCache()
    if account.token_cache:
        cache.deserialize(account.token_cache)
    client_id = account.ms_client_id or settings.ms_default_client_id
    return PublicClientApplication(client_id=client_id, authority=MS_AUTHORITY, token_cache=cache)


def _save_cache(account, app: PublicClientApplication) -> None:
    """把 token cache 序列化写回 DB 对应列。"""
    account.token_cache = app.token_cache.serialize()


def initiate_device_flow(account, settings: Settings | None = None) -> dict:
    """启动 device code flow，返回 {verification_uri, user_code, message} 供 CLI 打印。

    调用方应打印 message 后调用 wait_for_device_completion 阻塞直至完成。
    """
    settings = settings or get_settings()
    app = _app(account, settings)
    flow = app.initiate_device_flow(scopes=MS_SCOPE)
    if "user_code" not in flow:
        raise RuntimeError(f"设备码流程启动失败: {flow.get('error_description') or flow}")
    return {
        "verification_uri": flow["verification_uri"],
        "user_code": flow["user_code"],
        "message": f"请在浏览器打开 {flow['verification_uri']} 并输入代码 {flow['user_code']}",
        "_flow": flow,
    }


class DeviceFlowError(RuntimeError):
    """设备码授权失败。kind 取值：expired / declined / admin_required / other。"""

    def __init__(self, kind: str, detail: str) -> None:
        super().__init__(detail)
        self.kind = kind
        self.detail = detail


def _classify_device_error(result: dict) -> DeviceFlowError:
    """按 msal 返回的 AADSTS 码把失败归类，供 CLI 输出针对性的人话提示。

    超时/拒绝是预期结果而非崩溃；detail 保留原始 error_description 供排查。
    """
    error = result.get("error") or ""
    desc = result.get("error_description") or ""
    if "AADSTS70016" in desc or error in ("expired_token", "authorization_pending"):
        kind = "expired"  # 用户没在 15 分钟有效期内输入代码
    elif "AADSTS65004" in desc or error == "authorization_declined":
        kind = "declined"  # 用户在授权页点了拒绝
    elif "AADSTS65001" in desc or "AADSTS90094" in desc:
        kind = "admin_required"  # 租户要求管理员同意
    else:
        kind = "other"
    return DeviceFlowError(kind, desc)


def wait_for_device_completion(account, flow: dict, settings: Settings | None = None) -> dict:
    """阻塞轮询直至用户完成授权；成功后将 token cache 落库。返回 token 结果 dict。"""
    settings = settings or get_settings()
    app = _app(account, settings)
    result = app.acquire_token_by_device_flow(flow)
    if "access_token" not in result:
        raise _classify_device_error(result)
    _save_cache(account, app)
    return result


def acquire_token_silent(account, settings: Settings | None = None) -> str | None:
    """同步期静默取 access token；失败返回 None（调用方负责标记账户错误）。"""
    settings = settings or get_settings()
    app = _app(account, settings)
    result = app.acquire_token_silent(scopes=MS_SCOPE, account=account.email)
    if result is None or "access_token" not in result:
        # 账户参数不符时按 msal 惯例尝试用缓存账户重试
        accounts = app.get_accounts()
        if accounts:
            result = app.acquire_token_silent(scopes=MS_SCOPE, account=accounts[0])
    if result and "access_token" in result:
        _save_cache(account, app)
        return result["access_token"]
    return None


def token_cache_json(account) -> str | None:
    """调试/测试辅助：返回当前账户的 token cache 序列化 JSON。"""
    if not account.token_cache:
        return None
    try:
        json.loads(account.token_cache)
        return account.token_cache
    except ValueError:
        return None
