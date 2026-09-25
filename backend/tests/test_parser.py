"""RFC822 解析测试：中文 header、multipart、合成 message_id、折行头展开、GB 系编码容错。"""
import base64
from datetime import datetime, timezone
from email.header import Header
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import pytest

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


# ── gb2312 声明但内容含 GBK/GB18030 专有字符（QQ 等国内邮件常见） ────────

# 「镕」「喆」不在 gb2312 里，只在 gbk/gb18030 里——这才是把严格解码逼到抛异常的字符
GBK_ONLY = "镕喆"


def _gbk_encoded_word(text: str, charset: str = "gb2312") -> str:
    """声明成 charset、实际用 gbk 编码的 encoded-word（真实邮件的错标就是这样）。"""
    return f"=?{charset}?B?" + base64.b64encode(text.encode("gbk")).decode() + "?="


def test_gbk_only_chars_are_not_gb2312():
    """前提校验：这两个字确实编不进 gb2312，否则下面的用例就不再是回归守卫。"""
    with pytest.raises(UnicodeEncodeError):
        GBK_ONLY.encode("gb2312")
    assert GBK_ONLY.encode("gbk")


def test_declared_gb2312_subject_with_gbk_only_chars_decodes():
    """声明 gb2312 却含 GBK 专有字符的 Subject 要正常解码，不能退化成 encoded-word 乱码。"""
    parsed = parse_message(_folded_subject_raw(_gbk_encoded_word(f"{GBK_ONLY}会议通知")))

    assert parsed["subject"] == f"{GBK_ONLY}会议通知"


def test_declared_gb2312_sender_with_gbk_only_chars_decodes():
    """From 的显示名同理：encoded-word 与 <地址> 之间保留原有空格。"""
    raw = (
        f"From: {_gbk_encoded_word(GBK_ONLY + '张三')} <zhangsan@qq.com>\r\n"
        "Date: Tue, 26 Aug 2026 10:00:00 +0800\r\n"
        "Subject: x\r\n"
        "MIME-Version: 1.0\r\n"
        'Content-Type: text/plain; charset="utf-8"\r\n'
        "\r\n"
        "正文\r\n"
    ).encode("utf-8")

    sender = parse_message(raw)["sender"]

    assert sender == f"{GBK_ONLY}张三 <zhangsan@qq.com>"


def test_declared_gb2312_body_with_gbk_only_chars_decodes():
    """正文同理：Content-Type 声明 gb2312、内容含 GBK 专有字符时要按 gb18030 解出来。"""
    body = f"{GBK_ONLY}测试正文：会议室 3 号。"
    raw = (
        "From: a@example.com\r\n"
        "Date: Tue, 26 Aug 2026 10:00:00 +0800\r\n"
        "Subject: gbk body\r\n"
        "MIME-Version: 1.0\r\n"
        'Content-Type: text/plain; charset="gb2312"\r\n'
        "Content-Transfer-Encoding: base64\r\n"
        "\r\n" + base64.b64encode(body.encode("gbk")).decode() + "\r\n"
    ).encode("ascii")

    assert parse_message(raw)["text_body"] == body


def test_declared_gbk_charset_variants_decode():
    """gbk / x-gbk 等别名声明同样按 gb18030 解。"""
    for charset in ("gbk", "x-gbk", "GB2312"):
        parsed = parse_message(_folded_subject_raw(_gbk_encoded_word(f"{GBK_ONLY}通知", charset)))

        assert parsed["subject"] == f"{GBK_ONLY}通知", charset


def test_unknown_declared_charset_falls_back_to_utf8():
    """声明了不存在的 charset（畸形邮件）也不能退化成 encoded-word 原样乱码。"""
    word = "=?nosuch-charset?B?" + base64.b64encode("会议通知".encode()).decode() + "?="

    assert parse_message(_folded_subject_raw(word))["subject"] == "会议通知"
