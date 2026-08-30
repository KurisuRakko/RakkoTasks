"""Phainon introspection 鉴权测试：respx mock /me，合法 token 即放行（无 sub 白名单）。"""
import httpx
import respx
from fastapi.testclient import TestClient

from app import auth
from app.api import create_app
from app.config import Settings


def _settings() -> Settings:
    return Settings(
        database_path=":memory:",
        phainon_api_base="https://api.rakko.cn",
        phainon_app_id="rakkotasks",
    )


def _app(settings):
    return create_app(settings=settings)


def test_valid_token_allowed(session_factory):
    with respx.mock:
        route = respx.get("https://api.rakko.cn/auth/priestess/oidc/me").mock(
            return_value=httpx.Response(
                200, json={"app_id": "rakkotasks", "user": {"sub": "user-1", "email": "a@x.com", "name": "甲"}}
            )
        )
        client = TestClient(_app(_settings()))
        resp = client.get("/api/status", headers={"Authorization": "Bearer good-token"})
        assert resp.status_code == 200
        assert route.called


def test_verify_token_returns_current_user(session_factory):
    """verify_token 返回 CurrentUser（sub/email/name 取自 /me）。"""
    with respx.mock:
        respx.get("https://api.rakko.cn/auth/priestess/oidc/me").mock(
            return_value=httpx.Response(
                200, json={"app_id": "rakkotasks", "user": {"sub": "user-1", "email": "a@x.com", "name": "甲"}}
            )
        )
        user = auth.verify_token("t", _settings())
        assert user is not None
        assert user.sub == "user-1"
        assert user.email == "a@x.com"
        assert user.name == "甲"


def test_valid_any_sub_allowed(session_factory):
    """不再有 ALLOWED_SUBS：任意 sub 只要 app_id 匹配即放行。"""
    with respx.mock:
        respx.get("https://api.rakko.cn/auth/priestess/oidc/me").mock(
            return_value=httpx.Response(
                200, json={"app_id": "rakkotasks", "user": {"sub": "stranger"}}
            )
        )
        client = TestClient(_app(_settings()))
        resp = client.get("/api/status", headers={"Authorization": "Bearer t"})
        assert resp.status_code == 200


def test_wrong_app_id_rejected(session_factory):
    with respx.mock:
        respx.get("https://api.rakko.cn/auth/priestess/oidc/me").mock(
            return_value=httpx.Response(
                200, json={"app_id": "other-app", "user": {"sub": "user-1"}}
            )
        )
        client = TestClient(_app(_settings()))
        resp = client.get("/api/status", headers={"Authorization": "Bearer t"})
        assert resp.status_code == 401
        assert resp.json() == {"code": "unauthorized"}


def test_missing_sub_rejected(session_factory):
    """/me 返回 200 但无 user.sub：视为非法。"""
    with respx.mock:
        respx.get("https://api.rakko.cn/auth/priestess/oidc/me").mock(
            return_value=httpx.Response(200, json={"app_id": "rakkotasks", "user": {}})
        )
        client = TestClient(_app(_settings()))
        resp = client.get("/api/status", headers={"Authorization": "Bearer t"})
        assert resp.status_code == 401


def test_upstream_401_rejected(session_factory):
    with respx.mock:
        respx.get("https://api.rakko.cn/auth/priestess/oidc/me").mock(
            return_value=httpx.Response(401, json={"error": "bad token"})
        )
        client = TestClient(_app(_settings()))
        resp = client.get("/api/status", headers={"Authorization": "Bearer bad"})
        assert resp.status_code == 401


def test_missing_token_rejected(session_factory):
    with respx.mock:
        respx.get("https://api.rakko.cn/auth/priestess/oidc/me").mock(
            return_value=httpx.Response(200, json={"app_id": "rakkotasks", "user": {"sub": "user-1"}})
        )
        client = TestClient(_app(_settings()))
        resp = client.get("/api/status")
        assert resp.status_code == 401


def test_cache_hits_within_60s(session_factory):
    """第二次同 token 请求不再调上游（60s 缓存），也不重复写库。"""
    with respx.mock:
        route = respx.get("https://api.rakko.cn/auth/priestess/oidc/me").mock(
            return_value=httpx.Response(
                200, json={"app_id": "rakkotasks", "user": {"sub": "user-1"}}
            )
        )
        client = TestClient(_app(_settings()))
        headers = {"Authorization": "Bearer cached-token"}
        assert client.get("/api/status", headers=headers).status_code == 200
        assert client.get("/api/status", headers=headers).status_code == 200
        assert route.call_count == 1


def test_failed_tokens_not_cached(session_factory):
    """校验失败的 token 不进缓存（防随机 token 撑爆内存）。"""
    with respx.mock:
        respx.get("https://api.rakko.cn/auth/priestess/oidc/me").mock(
            return_value=httpx.Response(401, json={"error": "bad token"})
        )
        s = _settings()
        for i in range(32):
            assert auth.verify_token(f"sprayed-token-{i}", s) is None
        assert len(auth._cache) == 0


def test_cache_bounded_by_max(session_factory):
    """写入超过上限的不同成功 token 后，缓存长度不超过 _CACHE_MAX。"""
    with respx.mock:
        respx.get("https://api.rakko.cn/auth/priestess/oidc/me").mock(
            return_value=httpx.Response(200, json={"app_id": "rakkotasks", "user": {"sub": "u"}})
        )
        s = _settings()
        for i in range(auth._CACHE_MAX + 128):
            assert auth.verify_token(f"good-token-{i}", s).sub == "u"
        assert len(auth._cache) <= auth._CACHE_MAX
