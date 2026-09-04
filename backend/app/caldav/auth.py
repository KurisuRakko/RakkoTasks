"""CalDAV Basic 鉴权：应用密码生成/校验、Authorization 头解析、客户端来源提取。

安全边界（写在这里避免后人误解）：
- 密码是服务端 generate_app_password() 生成的 32 字符高熵令牌，不是用户自选
  口令——抗离线字典攻击的强度来自熵本身，因此单轮 sha256（无盐）够用；
  用户自选弱口令才需要 bcrypt/argon2 这类慢哈希。
- iPhone 每轮同步会对每个资源反复发请求，鉴权必须在每请求路径上廉价执行，
  慢哈希会让一轮同步变成数秒级的 CPU 开销。
- 密码只在 POST /api/caldav/password 的响应里出现过一次，之后库里只存
  sha256 hex；任何日志/异常路径都绝不打印密码本身。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets

from app.auth import find_user_by_spec
from app.models import User

# 401 时回给客户端的 WWW-Authenticate 值（路由层用；登录框的 realm 提示）
REALM_HEADER = 'Basic realm="RakkoTasks", charset="UTF-8"'


def generate_app_password() -> str:
    """生成新应用密码：secrets.token_urlsafe(24) = 32 字符（url-safe base64，无填充）。"""
    return secrets.token_urlsafe(24)


def hash_app_password(pw: str) -> str:
    """应用密码 → 存库的 sha256 hex。见模块 docstring 对单轮 sha256 边界的说明。"""
    return hashlib.sha256(pw.encode("utf-8")).hexdigest()


def verify_app_password(pw: str, stored_hash: str | None) -> bool:
    """校验应用密码；stored_hash 为 None（未开通）恒 False。常量时间比较防时序侧信道。"""
    if stored_hash is None:
        return False
    return hmac.compare_digest(hash_app_password(pw), stored_hash)


def parse_basic(authorization: str | None) -> tuple[str, str] | None:
    """解 "Basic base64(user:pass)" → (username, password)；任何失败返回 None。

    密码可含冒号：只按首个冒号切分。base64 严格解码（validate=True），
    坏字符/坏填充/非 UTF-8 都按鉴权失败处理，不抛异常。
    """
    if not authorization:
        return None
    parts = authorization.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "basic":
        return None
    try:
        raw = base64.b64decode(parts[1].strip(), validate=True)
    except (ValueError, TypeError):
        return None
    try:
        decoded = raw.decode("utf-8")
    except UnicodeDecodeError:
        return None
    user, sep, pw = decoded.partition(":")
    if not sep:
        return None
    if not user:
        return None
    return user, pw


def client_key(request) -> str:
    """请求来源标识（限流/审计用）：CF-Connecting-IP → X-Forwarded-For 首段 → 直连地址 → unknown。

    CF-Connecting-IP 是 Cloudflare 直连服务器时注入的受信头；X-Forwarded-For
    只信首段（最近一跳），防伪造链污染。
    """
    cf = request.headers.get("CF-Connecting-IP")
    if cf:
        return cf
    xff = request.headers.get("X-Forwarded-For")
    if xff:
        return xff.split(",")[0].strip()
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


def authenticate(session, authorization: str | None) -> User | None:
    """CalDAV Basic 鉴权：解析头 → 按 sub/邮箱找用户 → 校验应用密码。

    任一环节失败返回 None（路由层回 401 + REALM_HEADER）。用户名与密码
    都不在这里打印。
    """
    parsed = parse_basic(authorization)
    if parsed is None:
        return None
    username, pw = parsed
    user = find_user_by_spec(session, username)
    if user is None:
        return None
    if not verify_app_password(pw, user.caldav_password_hash):
        return None
    return user
