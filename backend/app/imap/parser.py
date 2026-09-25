"""RFC822 → dict 解析：标准库 email，中文 header 解码，正文容错解码。"""
from __future__ import annotations

import email
import hashlib
import re
from datetime import datetime, timezone
from email.header import decode_header
from email.message import Message
from email.utils import getaddresses, parsedate_to_datetime

_WS_RE = re.compile(r"\s+")
# RFC 5322 折行头：CRLF/LF 加后续空白折出来，保留空白本身
_FOLD_RE = re.compile(r"\r?\n(?=[ \t])")
# 展开后仍残留的孤立换行（畸形邮件）
_NEWLINE_RE = re.compile(r"[\r\n]+")

# 国内邮件常把 Subject/正文声明成 gb2312 或 gbk，实际却含 GBK/GB18030 专有字符
# （「镕」「喆」都不在 gb2312 里）。gb18030 是这几个编码的超集：按它解既不会
# UnicodeDecodeError，纯 gb2312 内容的解码结果也一字不差。
_GBK_CHARSETS = frozenset({"gb2312", "gbk", "gb_2312-80", "x-gbk"})
_USASCII = "us-ascii"


def _effective_charset(charset: str | None) -> str:
    """声明 charset → 实际解码用的编码：GB 系一律换成 gb18030（超集），缺省 utf-8。"""
    name = (charset or "").strip().lower()
    if not name:
        return "utf-8"
    return "gb18030" if name in _GBK_CHARSETS else name


def _decode_word(data: bytes, charset: str) -> str:
    """解一个 encoded-word 的字节：按声明 charset，声明了非法 charset 时回落 utf-8。"""
    try:
        return data.decode(_effective_charset(charset), errors="replace")
    except LookupError:
        return data.decode("utf-8", errors="replace")


def _nonctext(ch: str) -> bool:
    """该字符不是 RFC822 ctext——make_header 以此判断「这里已经有空白/分隔」。"""
    return ch.isspace() or ch in ("(", ")", "\\")


def _join_decoded(parts: list[tuple[bytes | str, str | None]]) -> str:
    """把 decode_header 的片段拼回一个字符串，拼接规则与 make_header 一致。

    与 make_header(decode_header(...)) 的唯一差别是解码步骤容错（见 _decode_word）：
    它按 charset 严格解码，遇到声明 gb2312 却含 GBK 专有字符的邮件直接抛异常。
    拼接：相邻 encoded-word 之间不加空格（中间的空白 decode_header 已丢掉），
    encoded-word 与普通文本之间保留原有空白，跨 us-ascii 边界缺空白时补一个。
    """
    # 1) 解码：bytes 片段按声明 charset，str 片段原样；普通文本按 us-ascii 记账（同 make_header）
    chunks: list[tuple[str, str]] = []
    for data, charset in parts:
        name = (charset or _USASCII).lower()
        chunks.append((_decode_word(data, name) if isinstance(data, bytes) else data, name))
    # 2) 相邻同 charset 的片段合并成一段（make_header 的 _normalize 用空格连接）
    merged: list[tuple[str, str]] = []
    for text, name in chunks:
        if merged and merged[-1][1] == name:
            prev, _ = merged.pop()
            merged.append((prev + " " + text, name))
        else:
            merged.append((text, name))
    # 3) 拼接（make_header 的 __str__）：仅在 us-ascii 与其它 charset 的交界处补空格
    out: list[str] = []
    last_usascii = True
    lastspace = False
    for text, name in merged:
        usascii = name == _USASCII
        if out:
            hasspace = bool(text) and _nonctext(text[0])
            if not last_usascii:
                if usascii and not hasspace:
                    out.append(" ")
                    usascii = True
            elif not usascii and not lastspace:
                out.append(" ")
        lastspace = bool(text) and _nonctext(text[-1])
        last_usascii = usascii
        out.append(text)
    return "".join(out)


def _decode_header(value: str | None) -> str:
    if not value:
        return ""
    # compat32 不会展开未编码的折行（encoded-word 之间的折行 decode_header 自己能处理）；
    # 头部含裸 8bit 字节时 compat32 给出 Header 对象，统一成 str 再处理
    value = str(value)
    value = _FOLD_RE.sub("", value)
    try:
        # 展开后仍可能有孤立换行，保证返回值里绝不含换行
        return _NEWLINE_RE.sub(" ", _join_decoded(decode_header(value)))
    except Exception:
        # 极端畸形 header 兜底：原样返回
        return _WS_RE.sub(" ", value)


def _decode_body(part: Message) -> str | None:
    """按 charset 容错解码正文；失败时 replace。"""
    payload = part.get_payload(decode=True)
    if payload is None:
        return None
    # 声明 gb2312/gbk 的正文同样先按 gb18030 解，避免 GBK 专有字符被判成坏数据
    charset = _effective_charset(part.get_content_charset())
    for enc in (charset, "utf-8", "gb18030", "latin-1"):
        try:
            return payload.decode(enc)
        except (LookupError, UnicodeDecodeError):
            continue
    return payload.decode("utf-8", errors="replace")


def _walk_parts(msg: Message) -> list[Message]:
    parts = []
    for part in msg.walk():
        if part.is_multipart():
            continue
        parts.append(part)
    return parts


def parse_message(raw: bytes) -> dict:
    """解析一封 RFC822 邮件字节串为内部 dict。"""
    msg = email.message_from_bytes(raw)

    subject = _decode_header(msg.get("Subject"))
    sender = _decode_header(msg.get("From"))
    # 收件人：To + Cc 的地址列表，逗号分隔
    recipients = ", ".join(
        addr for _n, addr in getaddresses([msg.get("To", "") or "", msg.get("Cc", "") or ""]) if addr
    )

    sent_at: datetime | None = None
    date_header = msg.get("Date")
    if date_header:
        try:
            dt = parsedate_to_datetime(date_header)
            if dt is not None:
                sent_at = dt.astimezone(timezone.utc).replace(tzinfo=None)
        except (TypeError, ValueError, OverflowError):
            sent_at = None

    text_body, html_body = "", None
    attachments: list[str] = []
    for part in _walk_parts(msg):
        ctype = part.get_content_type()
        disp = (part.get("Content-Disposition") or "").lower()
        if disp.startswith("attachment"):
            name = part.get_filename()
            if name:
                attachments.append(_decode_header(name))
            continue
        if ctype == "text/plain" and not text_body:
            text_body = _decode_body(part) or ""
        elif ctype == "text/html" and html_body is None:
            html_body = _decode_body(part)

    message_id = (msg.get("Message-ID") or "").strip() or _synthetic_message_id(
        subject, sender, date_header or "", text_body
    )
    return {
        "message_id": message_id,
        "subject": subject,
        "sender": sender,
        "recipients": recipients,
        "sent_at": sent_at,
        "text_body": text_body,
        "html_body": html_body,
        "attachments": attachments,
    }


def _synthetic_message_id(subject: str, sender: str, date_header: str, text_body: str) -> str:
    """无 Message-ID 时用内容哈希生成替代键。"""
    digest = hashlib.sha256(
        f"{subject}|{sender}|{date_header}|{text_body[:1024]}".encode("utf-8", errors="replace")
    ).hexdigest()
    return f"synthetic-{digest}"
