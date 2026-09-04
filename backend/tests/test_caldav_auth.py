"""CalDAV Basic 鉴权与应用密码测试：生成/哈希/校验、头解析、来源提取、鉴权全链。"""
import base64
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool

from app.auth import find_user_by_spec
from app.caldav.auth import (
    REALM_HEADER,
    authenticate,
    client_key,
    generate_app_password,
    hash_app_password,
    parse_basic,
    verify_app_password,
)
from app.db import init_db, make_session_factory
from app.models import User


def _auth_header(user: str, pw: str) -> str:
    raw = base64.b64encode(f"{user}:{pw}".encode("utf-8")).decode("ascii")
    return f"Basic {raw}"


def test_generate_app_password_length_and_uniqueness():
    """应用密码固定 32 字符（url-safe base64 无填充），连续生成不重复。"""
    p1 = generate_app_password()
    p2 = generate_app_password()
    assert len(p1) == 32
    assert len(p2) == 32
    assert p1 != p2


def test_hash_and_verify_roundtrip():
    pw = generate_app_password()
    digest = hash_app_password(pw)
    assert isinstance(digest, str) and len(digest) == 64
    assert verify_app_password(pw, digest) is True
    assert verify_app_password("wrong-password", digest) is False
    assert verify_app_password(pw, digest.upper()) is False  # hex 大小写不模糊


def test_verify_with_none_stored_hash_is_false():
    """未开通（库里 hash 为 NULL）：任何密码都验不过。"""
    assert verify_app_password("whatever", None) is False


def test_parse_basic_normal():
    header = _auth_header("user-1", "s3cret")
    assert parse_basic(header) == ("user-1", "s3cret")


def test_parse_basic_password_may_contain_colon():
    """密码含冒号：只按首个冒号切。"""
    header = _auth_header("user-1", "p:a:ss")
    assert parse_basic(header) == ("user-1", "p:a:ss")


def test_parse_basic_rejects_bad_inputs():
    assert parse_basic(None) is None
    assert parse_basic("") is None
    assert parse_basic("Bearer abc") is None
    assert parse_basic("Basic") is None
    assert parse_basic("Basic not-base64!!!") is None
    # 无冒号的解码结果（只有用户名）
    no_sep = base64.b64encode(b"justuser").decode("ascii")
    assert parse_basic(f"Basic {no_sep}") is None
    # 空用户名
    empty_user = base64.b64encode(b":pw").decode("ascii")
    assert parse_basic(f"Basic {empty_user}") is None
    # scheme 大小写不敏感
    raw = base64.b64encode(b"u:p").decode("ascii")
    assert parse_basic(f"basic {raw}") == ("u", "p")
    # 非 UTF-8 载荷
    bad_utf8 = base64.b64encode(b"\xff\xfe:xx").decode("ascii")
    assert parse_basic(f"Basic {bad_utf8}") is None


def test_client_key_fallback_order():
    """CF-Connecting-IP → X-Forwarded-For 首段 → 直连 host → unknown。"""
    req = SimpleNamespace(
        headers={"CF-Connecting-IP": "1.1.1.1", "X-Forwarded-For": "2.2.2.2, 3.3.3.3"},
        client=SimpleNamespace(host="4.4.4.4"),
    )
    assert client_key(req) == "1.1.1.1"

    req2 = SimpleNamespace(
        headers={"X-Forwarded-For": " 2.2.2.2 , 3.3.3.3"}, client=SimpleNamespace(host="4.4.4.4")
    )
    assert client_key(req2) == "2.2.2.2"  # 只信首段并去空白

    req3 = SimpleNamespace(headers={}, client=SimpleNamespace(host="4.4.4.4"))
    assert client_key(req3) == "4.4.4.4"

    req4 = SimpleNamespace(headers={}, client=None)
    assert client_key(req4) == "unknown"


@pytest.fixture
def sf():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    init_db(engine)
    return make_session_factory(engine)


def _seed_user(sf, sub: str, email: str, pw: str | None) -> None:
    with sf() as s:
        s.add(
            User(
                sub=sub,
                email=email,
                caldav_password_hash=hash_app_password(pw) if pw is not None else None,
            )
        )
        s.commit()


def test_find_user_by_spec(sf):
    _seed_user(sf, "sub-1", "a@example.com", None)
    with sf() as s:
        assert find_user_by_spec(s, "sub-1").sub == "sub-1"  # sub 精确
        assert find_user_by_spec(s, "a@example.com").sub == "sub-1"  # 邮箱精确
        assert find_user_by_spec(s, "nobody") is None
        assert find_user_by_spec(s, "") is None


def test_find_user_by_spec_ambiguous_email_returns_none(sf):
    with sf() as s:
        s.add_all(
            [
                User(sub="sub-a", email="dup@example.com"),
                User(sub="sub-b", email="dup@example.com"),
            ]
        )
        s.commit()
    with sf() as s:
        assert find_user_by_spec(s, "dup@example.com") is None  # 歧义不命中
        assert find_user_by_spec(s, "sub-a").sub == "sub-a"  # sub 仍可精确定位


def test_authenticate_by_sub_and_email(sf):
    _seed_user(sf, "sub-1", "a@example.com", "app-pw-1")
    with sf() as s:
        u = authenticate(s, _auth_header("sub-1", "app-pw-1"))
        assert u is not None and u.sub == "sub-1"
        u = authenticate(s, _auth_header("a@example.com", "app-pw-1"))
        assert u is not None and u.sub == "sub-1"
        assert authenticate(s, _auth_header("sub-1", "wrong")) is None  # 密码错
        assert authenticate(s, _auth_header("unknown", "app-pw-1")) is None  # 用户不存在
        assert authenticate(s, None) is None  # 无 Authorization 头
        assert authenticate(s, "Bearer tok") is None  # 非 Basic


def test_authenticate_user_without_password_never_passes(sf):
    """用户存在但未开通应用密码（hash 为 NULL）：任何密码都拒绝。"""
    _seed_user(sf, "sub-2", "b@example.com", None)
    with sf() as s:
        assert authenticate(s, _auth_header("sub-2", "anything")) is None


def test_realm_header_shape():
    """401 质询头形状：realm 提示 + UTF-8 声明。"""
    assert REALM_HEADER == 'Basic realm="RakkoTasks", charset="UTF-8"'
    assert "RakkoTasks" in REALM_HEADER
