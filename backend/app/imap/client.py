"""IMAP 连接与按 UID 增量抓取：Gmail / QQ LOGIN、微软 XOAUTH2。

协议交互封装在 ImapClient（duck-typing 协议类），测试注入 FakeImap。
"""
from __future__ import annotations

import imaplib
import re
import ssl
from datetime import datetime, timedelta

from app.config import Settings, get_settings

# 密码登录类 kind（IMAP LOGIN）→ 主机。这是「哪些 kind 用密码登录、连哪台主机」的
# 唯一来源：connect_account 与 accounts 的凭据判断都以它为准，避免两处各写一遍。
# foxmail.com / vip.qq.com 地址同样走 imap.qq.com。
PASSWORD_IMAP_HOSTS = {"gmail": "imap.gmail.com", "qq": "imap.qq.com"}
MS_IMAP_HOST = "outlook.office365.com"
IMAP_PORT = 993

_UIDVALIDITY_RE = re.compile(r"UIDVALIDITY\s+(\d+)", re.I)


def _as_text(value: object) -> str:
    """LIST 响应里的 bytes 按 utf-8（非法字节替换）解码后再解析。"""
    if isinstance(value, (bytes, bytearray)):
        return bytes(value).decode("utf-8", errors="replace")
    return str(value)


def _split_flags(text: str) -> tuple[set[str], str] | None:
    """把 `(<flags>) <剩余>` 拆成（flags 集合, 剩余部分）；开头不是 (...) 时返回 None。"""
    if not text.startswith("("):
        return None
    end = text.find(")")
    if end < 0:
        return None
    return set(text[1:end].split()), text[end + 1 :].strip()


def _skip_quoted(text: str) -> int:
    """text 以双引号开头时，返回闭引号之后的下标；找不到闭引号返回 len(text)。"""
    i = 1
    while i < len(text):
        if text[i] == "\\":
            i += 2
            continue
        if text[i] == '"':
            return i + 1
        i += 1
    return len(text)


def _unescape_quoted(text: str) -> str:
    """去掉包裹的双引号并还原 \\ 与 \\" 转义。"""
    end = _skip_quoted(text)
    inner = text[1 : end - 1] if text[end - 1 : end] == '"' else text[1:]
    return re.sub(r"\\(.)", r"\1", inner)


def parse_list_line(line: bytes | str) -> tuple[set[str], str] | None:
    """解析一行 IMAP LIST 响应，返回 (flags 集合, 文件夹原始名字)；无法解析返回 None。

    形态：`(<flags>) <delim> <name>`，delim 是带引号的字符串或 NIL。
    name 带双引号时去掉引号并还原 \\ 与 \\"；不带引号时原样取 atom。
    名字按原样返回，绝不解码 modified UTF-7（&XfJT0ZABkK5O9g- 就是「已发送邮件」）。
    """
    split = _split_flags(_as_text(line).strip())
    if split is None:
        return None
    flags, rest = split
    if not rest:
        return None
    if rest.startswith('"'):
        rest = rest[_skip_quoted(rest) :].strip()  # 跳过分隔符
    else:
        parts = rest.split(None, 1)
        rest = parts[1].strip() if len(parts) > 1 else ""
    if not rest:
        return None
    return flags, _unescape_quoted(rest) if rest.startswith('"') else rest


def _quote_mailbox(name: str) -> str:
    """给文件夹名加双引号并转义其中的 \\ 与 "（"[Gmail]/Sent Mail" 这类名字必须带引号）。"""
    return '"' + name.replace("\\", "\\\\").replace('"', '\\"') + '"'


class ImapClient:
    """对 imaplib.IMAP4_SSL 的薄封装，仅暴露同步所需操作。

    不变量：对用户邮箱只发只读命令（EXAMINE / STATUS / LIST / UID SEARCH /
    UID FETCH BODY.PEEK[]），不得出现 STORE / COPY / MOVE / APPEND / EXPUNGE /
    CREATE / DELETE / RENAME / SUBSCRIBE。
    """

    def __init__(self, conn: imaplib.IMAP4_SSL | object):
        self.conn = conn

    # ---- 认证 ----

    def login_password(self, email: str, password: str) -> None:
        self.conn.login(email, password)

    def login_xoauth2(self, email: str, token: str) -> None:
        def _xoauth2(_resp) -> bytes:
            return f"user={email}\x01auth=Bearer {token}\x01\x01".encode()
        self.conn.authenticate("XOAUTH2", _xoauth2)

    # ---- 会话 ----

    def select_inbox(self) -> int:
        """只读打开 INBOX（EXAMINE）并返回 UIDVALIDITY。"""
        typ, _data = self.conn.select("INBOX", readonly=True)
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
        """逐封 UID FETCH (BODY.PEEK[])，返回原始邮件字节。

        用 PEEK 而不是 RFC822：PEEK 不会设置 \\Seen，本客户端对用户邮箱只读，
        拉取不能改变邮箱里的已读状态（发件箱尤其明显——用户没读过的已发送邮件
        不该因为归档变成已读）。
        """
        typ, data = self.conn.uid("FETCH", str(uid), "(BODY.PEEK[])")
        if typ != "OK" or not data:
            raise RuntimeError(f"UID FETCH {uid} 失败: {typ}")
        if isinstance(data[0], tuple):
            return data[0][1]
        raise RuntimeError(f"UID FETCH {uid} 返回异常: {data!r}")

    def find_sent_folder(self) -> str | None:
        """返回 LIST 里第一个带 \\Sent 标记的文件夹原始名字；没有则 None。

        生产四个账户的发件箱都带 \\Sent（包括不声明 SPECIAL-USE 的 Outlook），
        所以按标记找而不是按名字猜；名字按原样返回（不解码 modified UTF-7）。
        """
        typ, data = self.conn.list()
        if typ != "OK" or not data:
            return None
        for entry in data:
            if isinstance(entry, tuple):
                # 字面量形式：flags 在 tuple[0] 里，名字已经是解析好的原始字节
                split = _split_flags(_as_text(entry[0]).strip()) if entry else None
                flags = split[0] if split else set()
                name = _as_text(entry[1]) if len(entry) > 1 else ""
            else:
                parsed = parse_list_line(entry)
                if parsed is None:
                    continue
                flags, name = parsed
            if any(f.lower() == "\\sent" for f in flags):
                return name
        return None

    def select_folder_readonly(self, name: str) -> int:
        """SELECT <name>（只读）并返回 UIDVALIDITY；失败抛 RuntimeError。"""
        quoted = _quote_mailbox(name)
        typ, _data = self.conn.select(quoted, readonly=True)
        if typ != "OK":
            raise RuntimeError(f"SELECT {quoted} 失败: {typ}")
        typ, data = self.conn.status(quoted, "(UIDVALIDITY)")
        if typ != "OK" or not data or not data[0]:
            raise RuntimeError("读取 UIDVALIDITY 失败")
        m = _UIDVALIDITY_RE.search(str(data[0]))
        if not m:
            raise RuntimeError(f"无法解析 UIDVALIDITY: {data[0]!r}")
        return int(m.group(1))

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

    密码登录类账户（Gmail / QQ）凭据来自账户的 app_password（CLI 或网页录入，
    QQ 是 16 位授权码而非 QQ 密码）；微软走 msal 静默取 token。
    """
    from app.imap import mstoken  # 延迟导入避免循环依赖

    settings = settings or get_settings()
    # 标准库默认上下文（ssl._create_stdlib_context）不校验证书也不核对主机名，
    # 中间人可截走应用密码/授权码与微软 access token；必须显式传入
    # create_default_context()（CERT_REQUIRED + check_hostname）。
    tls_ctx = ssl.create_default_context()
    host = PASSWORD_IMAP_HOSTS.get(account.kind)
    if host:
        if not account.app_password:
            raise RuntimeError("该账户未设置密码/授权码，请在设置页重新录入")
        conn = imaplib.IMAP4_SSL(host, IMAP_PORT, ssl_context=tls_ctx)
        client = ImapClient(conn)
        client.login_password(account.email, account.app_password)
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
