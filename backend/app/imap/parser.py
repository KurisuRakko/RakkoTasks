"""RFC822 → dict 解析：标准库 email，中文 header 解码，正文容错解码。"""
from __future__ import annotations

import email
import hashlib
import re
from datetime import datetime, timezone
from email.header import decode_header, make_header
from email.message import Message
from email.utils import getaddresses, parsedate_to_datetime

_WS_RE = re.compile(r"\s+")


def _decode_header(value: str | None) -> str:
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        # 极端畸形 header 兜底：原样返回
        return _WS_RE.sub(" ", value)


def _decode_body(part: Message) -> str | None:
    """按 charset 容错解码正文；失败时 replace。"""
    payload = part.get_payload(decode=True)
    if payload is None:
        return None
    charset = part.get_content_charset() or "utf-8"
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
