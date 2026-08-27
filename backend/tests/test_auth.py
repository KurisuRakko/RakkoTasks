"""Phainon introspection 鉴权测试：respx mock /me。"""
import httpx
import respx
from fastapi.testclient import TestClient

from app import auth
from app.api import create_app
from app.config import Settings


def _settings(allowed_subs: str = "user-1,user-2") -> Settings:
    return Settings(
        database_path=":memory:",
        phainon_api_base="https://api.rakko.cn",
        phainon_app_id="rakkotasks",
        allowed_subs=allowed_subs,
    )


def _app(settings):
    return create_app(settings=settings)


def test_valid_token_allowed(session_factory):
    with respx.mock:
        route = respx.get("https://api.rakko.cn/auth/priestess/oidc/me").mock(
            return_value=httpx.Response(
                200, json={"app_id": "rakkotasks", "user": {"sub": "user-1"}}
            )
        )
        client = TestClient(_app(_settings()))
        resp = client.get("/api/status", headers={"Authorization": "Bearer good-token"})
        assert resp.status_code == 200
        assert route.called


def test_sub_not_in_whitelist_rejected(session_factory):
    with respx.mock:
        respx.get("https://api.rakko.cn/auth/priestess/oidc/me").mock(
            return_value=httpx.Response(
                200, json={"app_id": "rakkotasks", "user": {"sub": "stranger"}}
            )
        )
        client = TestClient(_app(_settings()))
        resp = client.get("/api/status", headers={"Authorization": "Bearer t"})
        assert resp.status_code == 401
        assert resp.json() == {"code": "unauthorized"}


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
    """第二次同 token 请求不再调上游（60s 缓存）。"""
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


def test_cache_bounded_by_max(session_factory):
    """写入超过上限的不同 token 后，缓存长度不超过 _CACHE_MAX。"""
    with respx.mock:
        respx.get("https://api.rakko.cn/auth/priestess/oidc/me").mock(
            return_value=httpx.Response(401, json={"error": "bad token"})
        )
        s = _settings()
        # 全部走 miss + 写入路径（每个 token 都失败，且都是新 digest）
        for i in range(auth._CACHE_MAX + 128):
            assert auth.verify_token(f"sprayed-token-{i}", s) is False
        assert len(auth._cache) <= auth._CACHE_MAX
