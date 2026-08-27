"""RFC822 解析测试：中文 header、multipart、合成 message_id。"""
from datetime import datetime, timezone
from email.header import Header
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from app.imap.parser import parse_message


def _build_raw() -> bytes:
    msg = MIMEMultipart("alternative")
    msg["Subject"] = Header("会议通知", "utf-8")
    msg["From"] = Header("张三 <zhangsan@example.com>", "utf-8")
    msg["To"] = "me@example.com"
    msg["Cc"] = "other@example.com"
    msg["Date"] = "Tue, 26 Aug 2026 10:00:00 +0800"
    # 无 Message-ID（刻意）
    msg.attach(MIMEText("正文内容，请准时参加。", "plain", "utf-8"))
    msg.attach(MIMEText("<p>正文内容，请准时参加。</p>", "html", "utf-8"))
    # 附件：只记文件名
    attach = MIMEText("file-content", "plain", "utf-8")
    attach.add_header("Content-Disposition", "attachment", filename="报告.pdf")
    msg.attach(attach)
    return msg.as_bytes()


def test_parse_fields():
    parsed = parse_message(_build_raw())
    assert parsed["subject"] == "会议通知"
    assert parsed["sender"] == "张三 <zhangsan@example.com>"
    assert parsed["recipients"] == "me@example.com, other@example.com"
    assert parsed["sent_at"] == datetime(2026, 8, 26, 2, 0, tzinfo=timezone.utc).replace(tzinfo=None)
    assert parsed["text_body"] == "正文内容，请准时参加。"
    assert parsed["html_body"] == "<p>正文内容，请准时参加。</p>"
    assert parsed["attachments"] == ["报告.pdf"]


def test_synthetic_message_id_deterministic():
    first = parse_message(_build_raw())
    second = parse_message(_build_raw())
    assert first["message_id"].startswith("synthetic-")
    assert first["message_id"] == second["message_id"]
    assert len(first["message_id"]) == len("synthetic-") + 64
