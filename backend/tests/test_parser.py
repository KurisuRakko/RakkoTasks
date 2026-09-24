"""RFC822 解析测试：中文 header、multipart、合成 message_id、折行头展开。"""
import base64
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


def _folded_subject_raw(subject_line: str) -> bytes:
    return (
        "From: a@example.com\r\n"
        "Date: Tue, 26 Aug 2026 10:00:00 +0800\r\n"
        f"Subject: {subject_line}\r\n"
        "MIME-Version: 1.0\r\n"
        'Content-Type: text/plain; charset="utf-8"\r\n'
        "\r\n"
        "正文\r\n"
    ).encode("utf-8")


def test_attachment_filename_unfolded():
    """未编码折行的附件名里的 CRLF 加空白被展开，返回值不含换行。"""
    msg = MIMEMultipart("alternative")
    msg["Subject"] = "带附件"
    msg["From"] = "a@example.com"
    msg["Date"] = "Tue, 26 Aug 2026 10:00:00 +0800"
    attach = MIMEText("file-content", "plain", "utf-8")
    attach.add_header(
        "Content-Disposition", "attachment", filename="long name part one\r\n part two.png"
    )
    msg.attach(attach)

    parsed = parse_message(msg.as_bytes())

    assert parsed["attachments"] == ["long name part one part two.png"]
    assert "\r" not in parsed["attachments"][0]
    assert "\n" not in parsed["attachments"][0]


def test_encoded_word_subject_split_across_lines():
    """回归守卫：encoded-word 之间的折行由 decode_header 自己拼接，展开折行不能破坏它。"""
    text = "会议通知：项目进度同步"
    encoded = text.encode("utf-8")
    first = base64.b64encode(encoded[: len(encoded) // 2]).decode()
    second = base64.b64encode(encoded[len(encoded) // 2 :]).decode()

    parsed = parse_message(_folded_subject_raw(f"=?utf-8?b?{first}?=\r\n =?utf-8?b?{second}?="))

    assert parsed["subject"] == text


def test_plain_subject_unfolded():
    """纯 ASCII 主题折行展开成一个空格，不含换行。"""
    parsed = parse_message(_folded_subject_raw("Re: COMP1521 W15B Absence\r\n from Week 2"))

    assert parsed["subject"] == "Re: COMP1521 W15B Absence from Week 2"


def test_folded_sender_display_name_unfolded():
    """折行的发件人显示名展开成一个空格，不含换行。"""
    raw = (
        "From: Zhang San\r\n <zhangsan@example.com>\r\n"
        "Date: Tue, 26 Aug 2026 10:00:00 +0800\r\n"
        "Subject: x\r\n"
        "MIME-Version: 1.0\r\n"
        'Content-Type: text/plain; charset="utf-8"\r\n'
        "\r\n"
        "正文\r\n"
    ).encode("utf-8")

    sender = parse_message(raw)["sender"]

    assert sender == "Zhang San <zhangsan@example.com>"
    assert "\r" not in sender
    assert "\n" not in sender


def test_rfc2231_continuation_filename():
    """回归守卫：RFC 2231 续行附件名本来就由 get_filename() 拼好，展开折行不能破坏它。"""
    raw = (
        "From: a@example.com\r\n"
        "Date: Tue, 26 Aug 2026 10:00:00 +0800\r\n"
        "Subject: with attachment\r\n"
        "MIME-Version: 1.0\r\n"
        'Content-Type: text/plain; charset="utf-8"\r\n'
        "Content-Disposition: attachment;\r\n"
        ' filename*0="part1";\r\n'
        ' filename*1="part2.pdf"\r\n'
        "\r\n"
        "file-content\r\n"
    ).encode("utf-8")

    parsed = parse_message(raw)

    assert parsed["attachments"] == ["part1part2.pdf"]
