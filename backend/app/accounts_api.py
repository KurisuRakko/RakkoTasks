"""/api/accounts* REST 端点（DESIGN.md 第 6 节）：薄路由层，校验与状态机全在 accounts 服务层。

不直接 import app.api（循环导入）：get_db 由 create_app 在调用 register_accounts 时传入；
{id} 不属于当前用户一律 404（多用户隔离策略，不暴露资源是否存在）。
"""
from __future__ import annotations

import logging

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.accounts import (
    AccountError,
    account_info,
    add_account,
    delete_account,
    finish_ms_auth,
    get_owned_account,
    list_accounts,
    rename_account,
    set_app_password,
    set_enabled,
    start_ms_auth,
)
from app.auth import CurrentUser, require_auth
from app.config import Settings
from app.models import Account
from app.ratelimit import RateLimiter

# 操作日志只记归属与账户标识，绝不记录密码 / token / auth_response
logger = logging.getLogger("rakkotasks.accounts")

# 每用户滑动窗口限流（次数, 窗口秒）。口径与 api.py 的 LLM 端点一致：超出回
# 429 {"code": "rate_limited"}。写操作会改库；微软授权那两个更贵——auth-url 每次
# 都往磁盘写一份 flow 文件、auth-code 直接打微软的 token 端点。GET 列表是纯读，不限。
# 常量放模块级而不是写死在函数里，测试才能不靠打满真实次数来验。
WRITE_RATE_LIMIT = (20, 60.0)
AUTH_RATE_LIMIT = (10, 60.0)

# 校验统一在服务层做（错误码一致）；pydantic 只兜底「非法 JSON / 缺必填字段」，
# 因此请求体模型不写 max_length 之类约束（那会引入契约外的 422）
class AccountCreate(BaseModel):
    name: str
    kind: str
    email: str
    app_password: str | None = None
    ms_client_id: str | None = None


class AccountPatch(BaseModel):
    name: str | None = None
    app_password: str | None = None
    enabled: bool | None = None


class AuthUrlRequest(BaseModel):
    redirect_uri: str | None = None


class AuthCodeRequest(BaseModel):
    auth_response: str


def register_accounts(app: FastAPI, settings: Settings, get_db) -> None:
    """把账户端点与 AccountError 统一处理器挂到 app 上；get_db 由 api.py 注入。"""

    write_limiter = RateLimiter(*WRITE_RATE_LIMIT)
    auth_limiter = RateLimiter(*AUTH_RATE_LIMIT)

    @app.exception_handler(AccountError)
    async def _account_error_handler(_request, exc: AccountError):
        return JSONResponse(status_code=exc.status, content={"code": exc.code, **exc.extra})

    def _limit(limiter: RateLimiter, user: CurrentUser) -> None:
        if not limiter.allow(user.sub):
            raise HTTPException(status_code=429, detail={"code": "rate_limited"})

    def _owned_or_404(db: Session, user: CurrentUser, account_id: int) -> Account:
        account = get_owned_account(db, user.sub, account_id)
        if account is None:
            raise HTTPException(status_code=404, detail={"code": "not_found"})
        return account

    @app.get("/api/accounts")
    def list_endpoint(
        user: CurrentUser = Depends(require_auth), db: Session = Depends(get_db),
    ) -> dict:
        """当前用户全部账户（含已停用），按 id 升序。"""
        return {"accounts": [account_info(a) for a in list_accounts(db, user.sub)]}

    @app.post("/api/accounts", status_code=201)
    def create_endpoint(
        body: AccountCreate,
        user: CurrentUser = Depends(require_auth),
        db: Session = Depends(get_db),
    ) -> dict:
        _limit(write_limiter, user)
        account = add_account(
            db,
            user.sub,
            name=body.name,
            kind=body.kind,
            email=body.email,
            app_password=body.app_password,
            ms_client_id=body.ms_client_id,
        )
        logger.info(
            "添加账户 user=%s account_id=%d kind=%s email=%s",
            user.sub, account.id, account.kind, account.email,
        )
        return account_info(account)

    @app.patch("/api/accounts/{account_id}")
    def patch_endpoint(
        account_id: int,
        body: AccountPatch,
        user: CurrentUser = Depends(require_auth),
        db: Session = Depends(get_db),
    ) -> dict:
        _limit(write_limiter, user)
        account = _owned_or_404(db, user, account_id)
        if not any(v is not None for v in (body.name, body.app_password, body.enabled)):
            # 请求体三字段全缺省或全为 null → 400；enabled=false 是合法值
            raise HTTPException(status_code=400, detail={"code": "bad_request"})
        if body.name is not None:
            rename_account(account, body.name)
        if body.app_password is not None:
            set_app_password(account, body.app_password)
        if body.enabled is not None:
            set_enabled(account, body.enabled)
            logger.info(
                "账户启停变更 user=%s account_id=%d kind=%s email=%s",
                user.sub, account.id, account.kind, account.email,
            )
        return account_info(account)

    @app.delete("/api/accounts/{account_id}", status_code=204)
    def delete_endpoint(
        account_id: int,
        user: CurrentUser = Depends(require_auth),
        db: Session = Depends(get_db),
    ) -> Response:
        _limit(write_limiter, user)
        account = _owned_or_404(db, user, account_id)
        delete_account(db, account, settings)
        logger.info(
            "删除账户 user=%s account_id=%d kind=%s email=%s",
            user.sub, account.id, account.kind, account.email,
        )
        return Response(status_code=204)

    @app.post("/api/accounts/{account_id}/auth-url")
    def auth_url_endpoint(
        account_id: int,
        body: AuthUrlRequest | None = None,  # redirect_uri 可选，请求体整体可缺省
        user: CurrentUser = Depends(require_auth),
        db: Session = Depends(get_db),
    ) -> dict:
        """生成微软授权链接（授权码 + PKCE，flow 落盘由 mstoken 完成）。"""
        _limit(auth_limiter, user)
        account = _owned_or_404(db, user, account_id)
        return {"auth_uri": start_ms_auth(account, settings, body.redirect_uri if body else None)}

    @app.post("/api/accounts/{account_id}/auth-code")
    def auth_code_endpoint(
        account_id: int,
        body: AuthCodeRequest,
        user: CurrentUser = Depends(require_auth),
        db: Session = Depends(get_db),
    ) -> dict:
        """用粘贴回的完整回调 URL 或授权码换 token；成功后 status=ok。"""
        _limit(auth_limiter, user)
        account = _owned_or_404(db, user, account_id)
        finish_ms_auth(account, settings, body.auth_response)
        logger.info(
            "授权完成 user=%s account_id=%d kind=%s email=%s",
            user.sub, account.id, account.kind, account.email,
        )
        return account_info(account)
