"""Phainon introspection 鉴权：Bearer token → /auth/priestess/oidc/me → 白名单校验，60s 内存缓存。"""
from __future__ import annotations

import hashlib
import time

import httpx
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import Settings, get_settings

# (token_sha256, ok, expires_at) 进程内缓存，仅进程存活期内有效
_cache: dict[str, tuple[bool, float]] = {}
CACHE_TTL = 60.0

_bearer = HTTPBearer(auto_error=False)


def _get_http_client() -> httpx.Client:
    """模块级工厂：测试中替换 app.auth._get_http_client 注入 respx mock。"""
    return httpx.Client(timeout=10.0)


def _check_token(token: str, settings: Settings) -> bool:
    """向 Phainon 校验 token 并检查 app_id 与 user.sub 白名单。失败一律 False。"""
    try:
        with _get_http_client() as client:
            resp = client.get(
                f"{settings.phainon_api_base}/auth/priestess/oidc/me",
                headers={"Authorization": f"Bearer {token}", "Origin": settings.frontend_origin},
            )
        if resp.status_code != 200:
            return False
        data = resp.json()
        if data.get("app_id") != settings.phainon_app_id:
            return False
        sub = (data.get("user") or {}).get("sub")
        if not sub or sub not in settings.allowed_sub_set():
            return False
        return True
    except Exception:
        return False


def verify_token(token: str, settings: Settings | None = None) -> bool:
    """带 60s 进程内缓存的校验。"""
    settings = settings or get_settings()
    digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
    now = time.monotonic()
    cached = _cache.get(digest)
    if cached and cached[1] > now:
        return cached[0]
    ok = _check_token(token, settings)
    _cache[digest] = (ok, now + CACHE_TTL)
    return ok


async def require_auth(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> None:
    """FastAPI 依赖：校验失败一律 401 {"code": "unauthorized"}。

    settings 优先取 app.state（create_app 注入），回退全局 get_settings()。
    """
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail={"code": "unauthorized"})
    settings = getattr(request.app.state, "settings", None) or get_settings()
    if not verify_token(credentials.credentials, settings):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail={"code": "unauthorized"})
