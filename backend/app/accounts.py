"""账户管理服务层：CLI 与 /api/accounts* REST 端点共用同一套校验与状态机（DESIGN.md 第 2/6 节）。

约定：本模块的函数一律不 commit，事务由调用方管理（API 层依赖 _get_db 结束时
提交，CLI 自己提交）；对外的业务错误抛 AccountError，HTTP 语义由 code/status 表达。
凭据（app_password / token_cache）绝不进入 account_info 序列化。
"""
from __future__ import annotations

import json

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.config import Settings
from app.imap import mstoken
from app.models import Account, Email, Item

KINDS = ("gmail", "microsoft")
# 服务端生成的授权链接只允许这两个重定向地址：公共客户端 Thunderbird 的回跳页
# 与 oob 形态（两者对微软 authorize 端点实测均被接受，见 mstoken.py）
ALLOWED_REDIRECT_URIS = (mstoken.DEFAULT_REDIRECT_URI, "urn:ietf:wg:oauth:2.0:oob")

# AccountError code → HTTP 状态；默认 400
_STATUS_BY_CODE = {
    "account_exists": 409,
    "no_pending_flow": 409,
}


class AccountError(Exception):
    """业务错误：code 对外即 {"code": code}；status 是 HTTP 状态；extra 合并进响应体（auth_failed 用）。"""

    def __init__(self, code: str, status: int | None = None, **extra) -> None:
        super().__init__(code)
        self.code = code
        self.status = status or _STATUS_BY_CODE.get(code, 400)
        self.extra = extra


def has_credentials(account) -> bool:
    """凭据是否已就绪：gmail 看应用专用密码，microsoft 看 token cache。"""
    if account.kind == "gmail":
        return bool(account.app_password)
    return bool(account.token_cache)


def account_info(account) -> dict:
    """AccountInfo 序列化（DESIGN.md 第 6 节）：/api/status 与 /api/accounts* 共用。

    任何 API 响应都不含 app_password / token_cache，只给 has_credentials 布尔。
    """
    return {
        "id": account.id,
        "name": account.name,
        "kind": account.kind,
        "email": account.email,
        "status": account.status,
        "enabled": bool(account.enabled),
        "has_credentials": has_credentials(account),
        "ms_client_id": account.ms_client_id,
        "last_sync_at": account.last_sync_at.isoformat() if account.last_sync_at else None,
        "last_error": account.last_error,
    }


def list_accounts(session: Session, user_sub: str) -> list[Account]:
    """该用户的全部账户（含已停用），按 id 升序。"""
    return list(
        session.execute(select(Account).where(Account.user_sub == user_sub).order_by(Account.id)).scalars().all()
    )


def get_owned_account(session: Session, user_sub: str, account_id: int) -> Account | None:
    """按 id 取属于该用户的账户；不属于该用户返回 None（对外按 404 处理）。"""
    return session.execute(
        select(Account).where(Account.id == account_id, Account.user_sub == user_sub)
    ).scalars().first()


def add_account(
    session: Session,
    user_sub: str,
    *,
    name: str,
    kind: str,
    email: str,
    app_password: str | None = None,
    ms_client_id: str | None = None,
) -> Account:
    """添加账户：校验失败抛 AccountError；成功则落库（flush，不 commit）并置 status=pending。"""
    if kind not in KINDS:
        raise AccountError("bad_kind")
    name = name.strip()
    if not 1 <= len(name) <= 128:
        raise AccountError("bad_name")
    email = email.strip()
    if "@" not in email or len(email) > 256:
        raise AccountError("bad_email")
    if kind == "gmail":
        if not app_password or not app_password.strip():
            raise AccountError("password_required")
    else:
        app_password = None  # microsoft 不用应用专用密码，提交了也忽略
    ms_client_id = (ms_client_id or "").strip() or None
    dup = session.execute(
        select(Account.id).where(
            Account.user_sub == user_sub, Account.email == email, Account.kind == kind
        )
    ).scalars().first()
    if dup is not None:
        raise AccountError("account_exists")
    account = Account(
        user_sub=user_sub,
        name=name,
        kind=kind,
        email=email,
        ms_client_id=ms_client_id,
        app_password=app_password,
        status="pending",  # 尚未验证凭据/完成授权的账户一律先置 pending
    )
    session.add(account)
    session.flush()  # 让调用方拿到 account.id（flow 文件路径等按账户隔离）
    return account


def rename_account(session: Session, account: Account, name: str) -> None:
    name = name.strip()
    if not 1 <= len(name) <= 128:
        raise AccountError("bad_name")
    account.name = name


def set_app_password(session: Session, account: Account, password: str | None) -> None:
    """重录 Gmail 应用专用密码：成功后 status 回 pending（下次同步重新验证）、清掉旧错误。"""
    if account.kind != "gmail":
        raise AccountError("invalid_kind")
    if not password or not password.strip():
        raise AccountError("password_required")
    account.app_password = password
    account.status = "pending"
    account.last_error = None


def set_enabled(session: Session, account: Account, enabled: bool) -> None:
    """停用 = 软删除：清空全部凭据、status 回 pending，邮件与任务保留可重新启用；启用只置位。"""
    if not enabled:
        account.enabled = False
        account.app_password = None
        account.token_cache = None
        account.status = "pending"
        account.last_error = None
    else:
        account.enabled = True  # 凭据需另行设置（停用已被清空）


def delete_account(session: Session, account: Account, settings: Settings) -> None:
    """彻底删除账户及其全部邮件、由邮件生成的任务；手动条目（email_id 为 NULL）不受影响。

    顺序依赖：必须先删 items 再删 emails——items.email_id 外键指向 emails，
    emails 还在时删 item 不冲突，反之删 emails 会因引用行存在而失败。
    emails 上的 FTS 触发器按行同步 emails_fts，因此邮件必须走 SQL 语句整体删除
    （触发器逐行触发），不能绕过触发器直接清虚表。
    """
    session.execute(
        delete(Item).where(
            Item.email_id.in_(select(Email.id).where(Email.account_id == account.id))
        )
    )
    session.execute(delete(Email).where(Email.account_id == account.id))
    try:
        mstoken.flow_file_path(account, settings).unlink(missing_ok=True)
    except OSError:
        pass  # 清理失败不阻断删除：陈旧 flow 文件没有数据价值
    session.delete(account)


def start_ms_auth(account, settings: Settings, redirect_uri: str | None = None) -> str:
    """授权码流程第一步：生成授权链接并把 flow 落盘（mstoken 内部做），返回 auth_uri。"""
    if account.kind != "microsoft":
        raise AccountError("invalid_kind")
    if redirect_uri is None:
        redirect_uri = mstoken.DEFAULT_REDIRECT_URI
    if redirect_uri not in ALLOWED_REDIRECT_URIS:
        raise AccountError("bad_redirect")
    return mstoken.initiate_auth_code_flow(account, settings, redirect_uri)["auth_uri"]


def finish_ms_auth(account, settings: Settings, auth_response: str) -> None:
    """授权码流程第二步：读回第一步落盘的 flow 换 token；成功后 status 置 ok。"""
    if account.kind != "microsoft":
        raise AccountError("invalid_kind")
    if not auth_response or not auth_response.strip():
        raise AccountError("bad_request")
    flow_path = mstoken.flow_file_path(account, settings)
    if not flow_path.exists():
        raise AccountError("no_pending_flow")
    try:
        flow = json.loads(flow_path.read_text())
    except (OSError, ValueError):
        # 文件损坏留着只会让后续每次 auth-code 都撞 no_pending_flow，删掉让用户重走 auth-url
        try:
            flow_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise AccountError("no_pending_flow") from None
    try:
        mstoken.complete_auth_code_flow(account, flow, auth_response, settings)
    except mstoken.DeviceFlowError as exc:
        # kind/detail 与设备码流程同一套分类（AADSTS 码），原样透传给 API 响应与 CLI 提示
        raise AccountError("auth_failed", kind=exc.kind, detail=exc.detail) from None
    account.status = "ok"
    account.last_error = None
