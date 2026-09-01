"""IMAP 连接与按 UID 增量抓取：Gmail LOGIN / 微软 XOAUTH2。

协议交互封装在 ImapClient（duck-typing 协议类），测试注入 FakeImap。
"""
from __future__ import annotations

import imaplib
import re
import ssl
from datetime import datetime, timedelta

from app.config import Settings, get_settings

GMAIL_IMAP_HOST = "imap.gmail.com"
MS_IMAP_HOST = "outlook.office365.com"
IMAP_PORT = 993

_UIDVALIDITY_RE = re.compile(r"UIDVALIDITY\s+(\d+)", re.I)


class ImapClient:
    """对 imaplib.IMAP4_SSL 的薄封装，仅暴露同步所需操作。"""

    def __init__(self, conn: imaplib.IMAP4_SSL | object):
        self.conn = conn

    # ---- 认证 ----

    def login_gmail(self, email: str, password: str) -> None:
        self.conn.login(email, password)

    def login_xoauth2(self, email: str, token: str) -> None:
        def _xoauth2(_resp) -> bytes:
            return f"user={email}\x01auth=Bearer {token}\x01\x01".encode()
        self.conn.authenticate("XOAUTH2", _xoauth2)

    # ---- 会话 ----

    def select_inbox(self) -> int:
        """SELECT INBOX 并返回 UIDVALIDITY。"""
        typ, _data = self.conn.select("INBOX")
        if typ != "OK":
            raise RuntimeError(f"SELECT INBOX 失败: {typ}")
        typ, data = self.conn.status("INBOX", "(UIDVALIDITY)")
        if typ != "OK" or not data or not data[0]:
            raise RuntimeError("读取 UIDVALIDITY 失败")
        m = _UIDVALIDITY_RE.search(str(data[0]))
        if not m:
            raise RuntimeError(f"无法解析 UIDVALIDITY: {data[0]!r}")
        return int(m.group(1))

    def search_uids(self, criteria: str) -> list[int]:
        """执行 UID SEARCH，返回升序 UID 列表（0 封返回空列表）。"""
        typ, data = self.conn.uid("SEARCH", criteria)
        if typ != "OK":
            raise RuntimeError(f"UID SEARCH 失败: {typ}")
        payload = data[0] if data else b""
        if not payload:
            return []
        return [int(u) for u in payload.split()]

    def fetch_uid(self, uid: int) -> bytes:
        """逐封 UID FETCH (RFC822)，返回原始邮件字节。"""
        typ, data = self.conn.uid("FETCH", str(uid), "(RFC822)")
        if typ != "OK" or not data:
            raise RuntimeError(f"UID FETCH {uid} 失败: {typ}")
        if data and isinstance(data[0], tuple):
            return data[0][1]
        raise RuntimeError(f"UID FETCH {uid} 返回异常: {data!r}")

    def logout(self) -> None:
        try:
            self.conn.logout()
        except Exception:
            pass


def _since_date(days_back: int) -> str:
    """IMAP SINCE 日期格式：d-MMM-yyyy（英文月份缩写）。"""
    d = datetime.now() - timedelta(days=days_back)
    return d.strftime("%d-%b-%Y").lstrip("0")


def build_search_criteria(last_uid: int, backfill_days: int) -> str:
    """增量搜索条件：游标 0 时按日期回补，否则 UID 区间（闭区间含 last_uid 本身，调用方过滤）。"""
    if last_uid <= 0:
        return f"SINCE {_since_date(backfill_days)}"
    return f"UID {last_uid + 1}:*"


def connect_account(account, settings: Settings | None = None):
    """连接并登录账户，返回 (ImapClient, access_token)；失败时抛异常由调用方标记。

    Gmail 凭据来自账户的 app_password（CLI 录入）；微软走 msal 静默取 token。
    """
    from app.imap import mstoken  # 延迟导入避免循环依赖

    settings = settings or get_settings()
    # 标准库默认上下文（ssl._create_stdlib_context）不校验证书也不核对主机名，
    # 中间人可截走 Gmail 应用密码与微软 access token；必须显式传入
    # create_default_context()（CERT_REQUIRED + check_hostname）。
    tls_ctx = ssl.create_default_context()
    if account.kind == "gmail":
        if not account.app_password:
            raise RuntimeError("该 Gmail 账户未设置应用专用密码，请用 accounts set-password 录入")
        conn = imaplib.IMAP4_SSL(GMAIL_IMAP_HOST, IMAP_PORT, ssl_context=tls_ctx)
        client = ImapClient(conn)
        client.login_gmail(account.email, account.app_password)
        return client, None
    if account.kind == "microsoft":
        token = mstoken.acquire_token_silent(account, settings)
        if not token:
            raise RuntimeError("静默获取 access token 失败，请重跑 accounts connect")
        conn = imaplib.IMAP4_SSL(MS_IMAP_HOST, IMAP_PORT, ssl_context=tls_ctx)
        client = ImapClient(conn)
        client.login_xoauth2(account.email, token)
        return client, token
    raise RuntimeError(f"未知账户类型: {account.kind}")
