"""RFC822 → dict 解析：标准库 email，中文 header 解码，正文容错解码。"""
from __future__ import annotations

import codecs
import email
import hashlib
import re
from datetime import datetime, timezone
from email.header import decode_header, make_header
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


def _effective_charset(charset: str | None) -> str | None:
    """声明 charset → 实际解码用的编码：GB 系按 gb18030（超集）解，未知 charset 回落 utf-8。

    未声明的片段（None）原样返回 None：make_header 把它当 us-ascii 参与拼接。
    """
    if not charset:
        return None
    name = charset.strip().lower()
    if name in _GBK_CHARSETS:
        return "gb18030"
    try:
        codecs.lookup(name)
    except LookupError:
        # 声明了不存在的 charset（畸形邮件）：宁可解错，也不能让整条 header 退化成
        # encoded-word 原样乱码
        return "utf-8"
    return name


def _prepare_words(parts: list[tuple[bytes | str, str | None]]) -> list[tuple[str, str | None]]:
    """把 decode_header 的片段预解码成 str——拼接规则仍由 make_header 负责。

    make_header 用片段声明的 charset 严格解码，遇到声明 gb2312 却含 GBK 专有字符的
    邮件会直接抛 UnicodeDecodeError；这里只替换解码这一步（errors="replace"），
    片段的顺序与 charset 原样交给 make_header，拼出来还是标准库那套结果。
    """
    prepared: list[tuple[str, str | None]] = []
    for data, charset in parts:
        if not isinstance(data, bytes):
            prepared.append((data, charset))  # 已经是 str 的片段原样传下去
            continue
        enc = _effective_charset(charset)
        prepared.append((data.decode(enc or "us-ascii", errors="replace"), enc))
    return prepared


def _decode_header(value: str | None) -> str:
    if not value:
        return ""
    # compat32 不会展开未编码的折行（encoded-word 之间的折行 decode_header 自己能处理）；
    # 头部含裸 8bit 字节时 compat32 给出 Header 对象，统一成 str 再处理
    value = str(value)
    value = _FOLD_RE.sub("", value)
    try:
        # 展开后仍可能有孤立换行，保证返回值里绝不含换行
        return _NEWLINE_RE.sub(" ", str(make_header(_prepare_words(decode_header(value)))))
    except Exception:
        # 极端畸形 header 兜底：原样返回
        return _WS_RE.sub(" ", value)


def _decode_body(part: Message) -> str | None:
    """按 charset 容错解码正文；失败时 replace。"""
    payload = part.get_payload(decode=True)
    if payload is None:
        return None
    # 声明 gb2312/gbk 的正文同样先按 gb18030 解，避免 GBK 专有字符被判成坏数据
    charset = _effective_charset(part.get_content_charset()) or "utf-8"
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
