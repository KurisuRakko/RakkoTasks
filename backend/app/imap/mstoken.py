"""微软 OAuth2 接入：device code flow 与 authorization code + PKCE 双路径，token cache 落库。

为什么要有第二条路：设备码流程被启用条件访问的学校租户（如 UNSW）以
「身份验证流」为由直接拒绝（设备码钓鱼是已知攻击手法，租户禁掉属标准加固），
而授权码流程走标准浏览器交互，是这类租户官方文档认可的接入方式。
"""
from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from msal import PublicClientApplication, SerializableTokenCache

from app.config import Settings, get_settings

MS_AUTHORITY = "https://login.microsoftonline.com/common"
# OAuth 资源域名是 outlook.office.com，与 IMAP 服务器主机名 outlook.office365.com
# 不是一回事——写成后者会被微软拒为 AADSTS70011 invalid_scope。
MS_SCOPE = ["https://outlook.office.com/IMAP.AccessAsUser.All"]
# 公共客户端默认重定向 URI；备选 urn:ietf:wg:oauth:2.0:oob（UNSW 官方文档采用），
# 两者对微软 authorize 端点实测均被接受。
DEFAULT_REDIRECT_URI = "https://login.microsoftonline.com/common/oauth2/nativeclient"


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

    设备码与授权码两条流程共用（命名沿用历史）；超时/拒绝是预期结果而非
    崩溃，detail 保留原始 error_description 供排查。
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


def flow_file_path(account, settings: Settings) -> Path:
    """进行中授权流程的落盘位置：数据库同目录（/data 卷），按账户隔离。"""
    return Path(settings.database_path).parent / (".auth_flow_%d.json" % account.id)


def _write_flow_file(account, flow: dict, settings: Settings) -> None:
    """把一次性 flow（PKCE code_verifier 与 state）落盘，权限 0600。

    两步授权之间是两次独立的 docker compose run 进程，进程内存带不走 flow，
    只能靠文件接力；放数据库同目录随 /data 卷一起备份。授权码只能换一次 token，
    第二步完成后即删，见 complete_auth_code_flow。
    """
    path = flow_file_path(account, settings)
    path.write_text(json.dumps(flow))
    path.chmod(0o600)


def initiate_auth_code_flow(
    account, settings: Settings | None = None, redirect_uri: str = DEFAULT_REDIRECT_URI
) -> dict:
    """发起授权码流程（msal 的 initiate_auth_code_flow 自带 PKCE）。

    返回 {"auth_uri": ..., "flow": <完整 flow dict>}，并把 flow 写入
    .auth_flow_<account_id>.json（0600）。flow 含 PKCE code_verifier 与 state，
    必须持久化到第二步：complete_auth_code_flow 要用它校验 state 并取回
    verifier 换 token，因此函数内部直接落盘，调用方无需再存。
    """
    settings = settings or get_settings()
    app = _app(account, settings)
    flow = app.initiate_auth_code_flow(scopes=MS_SCOPE, redirect_uri=redirect_uri)
    if "auth_uri" not in flow:
        raise RuntimeError(f"授权码流程启动失败: {flow.get('error_description') or flow}")
    _write_flow_file(account, flow, settings)
    return {"auth_uri": flow["auth_uri"], "flow": flow}


def _parse_auth_response(auth_response: str, flow: dict) -> dict:
    """把用户带回的授权响应解析成 msal 期望的 dict。

    完整回调 URL（query 或 fragment 里的 code/state）与裸授权码两种形态；
    回调 URL 本身就是授权错误页（含 error 参数）时按 AADSTS 码归类抛出。
    """
    if "://" in auth_response:
        parsed = urlparse(auth_response)
        params = parse_qs(parsed.query) or parse_qs(parsed.fragment)
        if "error" in params:
            raise _classify_device_error(
                {
                    "error": params["error"][0],
                    "error_description": params.get("error_description", [""])[0],
                }
            )
        code = params.get("code")
        if not code:
            raise DeviceFlowError("other", "回调 URL 中没有授权码（code）参数，请确认复制的是完整 URL")
        response = {"code": code[0]}
        if "state" in params:
            response["state"] = params["state"][0]
        else:
            # oob 等重定向形态可能不带 state：与裸授权码一致用 flow 里的 state 兜底，
            # 让 msal 的 state 校验能通过（URL 里带 state 时仍以 URL 为准）
            response["state"] = flow["state"]
        return response
    return {"code": auth_response, "state": flow["state"]}


def complete_auth_code_flow(
    account, flow: dict, auth_response: str, settings: Settings | None = None
) -> dict:
    """用用户带回的授权响应换 token，成功后把 token cache 落库。

    auth_response 接受两种形态，函数内部自行判别：
    - 完整回调 URL（含 ?code=...&state=...）→ 解析 query 参数；
    - 裸的授权码字符串 → 组装成 {"code": <它>, "state": flow["state"]}。

    无论成功失败都会清理 .auth_flow_<id>.json：授权码一次性有效，留着陈旧
    文件只会让下一次 auth-code 拿过期 verifier 撞 CSRF。失败语义与设备码
    流程一致（复用同一套 AADSTS 分类逻辑抛 DeviceFlowError）。
    """
    settings = settings or get_settings()
    try:
        app = _app(account, settings)
        auth_response_dict = _parse_auth_response(auth_response, flow)
        result = app.acquire_token_by_auth_code_flow(flow, auth_response_dict)
        if "access_token" not in result:
            raise _classify_device_error(result)
        _save_cache(account, app)
        return result
    except ValueError as exc:
        # msal 对 state 不匹配等客户端数据错误抛 ValueError（OAuth2 的 CSRF 防护），
        # 统一归为 other，让 CLI 打友好提示而不是冒 traceback
        raise _classify_device_error(
            {"error": "invalid_state", "error_description": f"回调参数校验失败: {exc}"}
        ) from exc
    finally:
        try:
            flow_file_path(account, settings).unlink(missing_ok=True)
        except OSError:
            pass


def acquire_token_silent(account, settings: Settings | None = None) -> str | None:
    """同步期静默取 access token；失败返回 None（调用方负责标记账户错误）。

    注意：msal 的 account 参数必须是 get_accounts() 返回的账户字典，
    传邮箱字符串会在 msal 内部 AttributeError。
    """
    settings = settings or get_settings()
    app = _app(account, settings)
    # 优先按用户名精确匹配；匹配不到就退回缓存里的第一个账户
    cached = app.get_accounts(username=account.email) or app.get_accounts()
    if not cached:
        return None
    result = app.acquire_token_silent(scopes=MS_SCOPE, account=cached[0])
    if result and "access_token" in result:
        _save_cache(account, app)   # 刷新后的 cache 要落库，refresh token 会轮转
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
