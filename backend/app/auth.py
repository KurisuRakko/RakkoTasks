"""Phainon introspection 鉴权：Bearer token → /auth/priestess/oidc/me → 合法即自动开通用户，60s 内存缓存。

准入规则：token 经 /me 校验通过且 app_id 匹配即为合法用户（不再有 sub 白名单）。
"""
from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass
from datetime import datetime

import httpx
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import update
from sqlalchemy.exc import IntegrityError

from app.config import Settings, get_settings
from app.models import User

CACHE_TTL = 60.0
# 缓存条数上限：防未鉴权请求用随机 token 撑爆进程内存
_CACHE_MAX = 1024


@dataclass(frozen=True)
class CurrentUser:
    """通过鉴权的当前用户（来自 /me 的 user 字段）。"""

    sub: str
    email: str | None
    name: str | None


# (token_sha256, user, expires_at) 进程内缓存；只缓存成功结果，失败不入缓存
_cache: dict[str, tuple[CurrentUser, float]] = {}

_bearer = HTTPBearer(auto_error=False)


def _get_http_client() -> httpx.Client:
    """模块级工厂：测试中替换 app.auth._get_http_client 注入 respx mock。"""
    return httpx.Client(timeout=10.0)


def _check_token(token: str, settings: Settings) -> CurrentUser | None:
    """向 Phainon 校验 token 并检查 app_id。校验失败返回 None。"""
    try:
        with _get_http_client() as client:
            resp = client.get(
                f"{settings.phainon_api_base}/auth/priestess/oidc/me",
                headers={"Authorization": f"Bearer {token}", "Origin": settings.frontend_origin},
            )
        if resp.status_code != 200:
            return None
        data = resp.json()
        if data.get("app_id") != settings.phainon_app_id:
            return None
        u = data.get("user") or {}
        sub = u.get("sub")
        if not sub:
            return None
        return CurrentUser(sub=sub, email=u.get("email"), name=u.get("name"))
    except Exception:
        return None


def _trim_cache(now: float) -> None:
    """写入新条目前的容量控制：先清全部过期条目；仍达上限则整体清空。

    清空只是丢缓存、下次多打一次 introspection，可接受。
    """
    if len(_cache) < _CACHE_MAX:
        return
    expired = [k for k, (_user, exp) in _cache.items() if exp <= now]
    for k in expired:
        del _cache[k]
    if len(_cache) >= _CACHE_MAX:
        _cache.clear()


def _lookup_token(token: str, settings: Settings) -> tuple[CurrentUser | None, bool]:
    """返回 (user, from_cache)；from_cache 为 True 表示命中缓存、未打上游。"""
    digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
    now = time.monotonic()
    cached = _cache.get(digest)
    if cached and cached[1] > now:
        return cached[0], True
    user = _check_token(token, settings)
    if user is not None:
        _trim_cache(now)
        _cache[digest] = (user, now + CACHE_TTL)
    return user, False


def verify_token(token: str, settings: Settings | None = None) -> CurrentUser | None:
    """带 60s 进程内缓存的校验：成功返回 CurrentUser，失败返回 None。"""
    settings = settings or get_settings()
    return _lookup_token(token, settings)[0]


def _upsert_user(session_factory, user: CurrentUser) -> None:
    """缓存未命中（真正打了一次 introspection）时落库：不存在则插入，存在则更新资料与最近活跃。

    并发下两个请求可能同时插入同一 sub：捕获 IntegrityError 后回滚并改为 update。
    """
    now = datetime.now()
    session = session_factory()
    try:
        existing = session.get(User, user.sub)
        if existing is None:
            session.add(User(sub=user.sub, email=user.email, name=user.name, created_at=now, last_seen_at=now))
        else:
            existing.email = user.email
            existing.name = user.name
            existing.last_seen_at = now
        session.commit()
    except IntegrityError:
        # 另一请求已插入同一 sub：回滚后改为更新，不让请求失败
        session.rollback()
        try:
            session.execute(
                update(User).where(User.sub == user.sub).values(email=user.email, name=user.name, last_seen_at=now)
            )
            session.commit()
        except Exception:
            session.rollback()
    except Exception:
        session.rollback()
    finally:
        session.close()


async def require_auth(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> CurrentUser:
    """FastAPI 依赖：校验失败一律 401 {"code": "unauthorized"}；成功返回当前用户。

    缓存未命中时把用户 upsert 进 users 表（首次登录自动开通）；命中缓存不写库。
    settings 优先取 app.state（create_app 注入），回退全局 get_settings()。
    """
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail={"code": "unauthorized"})
    settings = getattr(request.app.state, "settings", None) or get_settings()
    user, from_cache = _lookup_token(credentials.credentials, settings)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail={"code": "unauthorized"})
    if not from_cache:
        _upsert_user(request.app.state.session_factory, user)
    return user
