"""原件归档测试：一个账户一个只追加的 mbox + 索引去重。

用标准库 mailbox.mbox 读回来验证（写侧不许用 mailbox：它每次追加都会扫描整个
文件）。
"""
import hashlib
import logging
import mailbox
import re
import stat
from datetime import datetime
from pathlib import Path

from app.archive import EmailArchive, mailbox_name
from app.config import Settings

ACCOUNT = "me@example.com"
MBOX_NAME = "me@example.com.mbox"
IDX_NAME = "me@example.com.mbox.idx"
MESSAGE_ID = "<m1@example.com>"
KEY = hashlib.sha256(MESSAGE_ID.encode("utf-8")).hexdigest()
SENT_AT = datetime(2026, 9, 4, 3, 5, 9)

# 手写原始邮件：不用 EmailMessage，避免正文被 MIME 编码后看不到 From 行
def raw_for(message_id: str) -> bytes:
    return (
        b"From: a@example.com\r\n"
        b"To: me@example.com\r\n"
        b"Subject: hello\r\n"
        b"Message-ID: " + message_id.encode("ascii") + b"\r\n"
        b"Date: Fri, 4 Sep 2026 03:05:09 +0000\r\n"
        b"\r\n"
        b"From here\r\n"
        b">From deeper\r\n"
        b"plain line\r\n"
    )


RAW = raw_for(MESSAGE_ID)


def make_archive(tmp_path: Path) -> EmailArchive:
    return EmailArchive(tmp_path / "archive")


def root_of(tmp_path: Path) -> Path:
    return tmp_path / "archive"


def read_messages(tmp_path: Path) -> list:
    """读完就关：mbox 是惰性读的，值取出后才安全关闭。"""
    box = mailbox.mbox(str(root_of(tmp_path) / MBOX_NAME))
    try:
        return list(box)
    finally:
        box.close()


def sha_key(message_id: str) -> str:
    return hashlib.sha256(message_id.encode("utf-8")).hexdigest()


def test_mailbox_name_sanitizes_email() -> None:
    """邮箱 → 文件名：小写、白名单外的字符换 _、结果以点开头时前置 _。"""
    assert mailbox_name("../Evil@X.com") == "_.._evil@x.com"
    assert mailbox_name("A b@c.com") == "a_b@c.com"
    assert mailbox_name("me@example.com") == "me@example.com"


def test_store_appends_mboxrd_and_reads_back(tmp_path: Path) -> None:
    """一封邮件落成一个 mbox 条目：Message-ID / 主题读回一致，From 行按 mboxrd 转义。"""
    archive = make_archive(tmp_path)
    archive.store(ACCOUNT, MESSAGE_ID, SENT_AT, RAW)

    messages = read_messages(tmp_path)
    assert len(messages) == 1
    assert messages[0]["Message-ID"] == MESSAGE_ID
    assert messages[0]["Subject"] == "hello"
    # mailbox 读回时不会去掉这一层 >：断言的是磁盘上的原始字节
    raw = (root_of(tmp_path) / MBOX_NAME).read_bytes()
    assert b"\n>From here\n" in raw
    assert b"\n>>From deeper\n" in raw
    assert b"\nplain line\n" in raw
    assert b"\r\n" not in raw  # CRLF 统一成 LF
    assert archive.summary() == {"written": 1, "duplicates": 0, "failed": 0}


def test_store_appends_in_order_with_private_permissions(tmp_path: Path) -> None:
    """两封按追加顺序读回；mbox 与 idx 都是 0600，归档根目录 0700。"""
    archive = make_archive(tmp_path)
    archive.store(ACCOUNT, "<a1@example.com>", SENT_AT, raw_for("<a1@example.com>"))
    archive.store(ACCOUNT, "<a2@example.com>", SENT_AT, raw_for("<a2@example.com>"))

    messages = read_messages(tmp_path)
    assert [m["Message-ID"] for m in messages] == ["<a1@example.com>", "<a2@example.com>"]
    assert stat.S_IMODE((root_of(tmp_path) / MBOX_NAME).stat().st_mode) == 0o600
    assert stat.S_IMODE((root_of(tmp_path) / IDX_NAME).stat().st_mode) == 0o600
    assert stat.S_IMODE(root_of(tmp_path).stat().st_mode) == 0o700


def test_same_message_id_twice_is_duplicate(tmp_path: Path) -> None:
    """同一 message_id 只追加一次，第二次计 duplicates。"""
    archive = make_archive(tmp_path)
    archive.store(ACCOUNT, MESSAGE_ID, SENT_AT, RAW)
    archive.store(ACCOUNT, MESSAGE_ID, SENT_AT, RAW)

    assert len(read_messages(tmp_path)) == 1
    assert archive.summary() == {"written": 1, "duplicates": 1, "failed": 0}


def test_duplicate_detected_across_instances(tmp_path: Path) -> None:
    """另起一个实例（索引只存在 idx 文件里）也能判重。"""
    make_archive(tmp_path).store(ACCOUNT, MESSAGE_ID, SENT_AT, RAW)
    other = make_archive(tmp_path)
    other.store(ACCOUNT, MESSAGE_ID, SENT_AT, RAW)

    assert other.summary() == {"written": 0, "duplicates": 1, "failed": 0}
    assert len(read_messages(tmp_path)) == 1


def test_index_offset_picks_up_key_appended_by_another_process(tmp_path: Path) -> None:
    """别的进程往 idx 末尾追加的 key 靠偏移增量读进来，不必重读整个文件。"""
    archive = make_archive(tmp_path)
    archive.store(ACCOUNT, MESSAGE_ID, SENT_AT, RAW)  # 缓存偏移停在第一行之后
    other_id = "<other@example.com>"
    with open(root_of(tmp_path) / IDX_NAME, "ab") as f:
        f.write(sha_key(other_id).encode("ascii") + b"\n")  # 模拟另一个进程的追加

    archive.store(ACCOUNT, other_id, SENT_AT, raw_for(other_id))

    assert archive.summary() == {"written": 1, "duplicates": 1, "failed": 0}
    assert len(read_messages(tmp_path)) == 1


def test_heals_truncated_tail_before_appending(tmp_path: Path) -> None:
    """上次写到一半的残缺文件尾先补换行：新邮件不会被粘进残件的尾巴。"""
    archive = make_archive(tmp_path)
    root_of(tmp_path).mkdir(mode=0o700, exist_ok=True)
    (root_of(tmp_path) / MBOX_NAME).write_bytes(
        b"From MAILER-DAEMON Fri Sep  4 03:05:09 2026\nSubject: x\n\npartial"
    )

    archive.store(ACCOUNT, MESSAGE_ID, SENT_AT, RAW)

    messages = read_messages(tmp_path)
    assert len(messages) == 2
    assert messages[0]["Subject"] == "x"
    assert "partial" in messages[0].get_payload()
    assert messages[1]["Message-ID"] == MESSAGE_ID


def test_from_line_is_asctime_in_utc(tmp_path: Path) -> None:
    """From_ 分隔行用 time.asctime（不受 locale 影响），日期个位数空一格补位。"""
    archive = make_archive(tmp_path)
    archive.store(ACCOUNT, MESSAGE_ID, SENT_AT, RAW)

    first_line = (root_of(tmp_path) / MBOX_NAME).read_bytes().split(b"\n", 1)[0]
    assert first_line == b"From MAILER-DAEMON Fri Sep  4 03:05:09 2026"


def test_store_failure_is_counted_and_logged_without_leaking(tmp_path: Path, caplog) -> None:
    """归档根目录是个普通文件时：不抛、计 failed，日志只有邮箱名与异常类名。"""
    blocker = tmp_path / "not-a-dir"
    blocker.write_bytes(b"")
    archive = EmailArchive(blocker)
    with caplog.at_level(logging.WARNING, logger="rakkotasks.archive"):
        archive.store(ACCOUNT, "<secret-message-id>", SENT_AT, RAW)

    assert archive.summary() == {"written": 0, "duplicates": 0, "failed": 1}
    assert len(caplog.records) == 1
    message = caplog.records[0].getMessage()
    assert re.fullmatch(r"原件归档失败（me@example\.com）：[A-Za-z]+Error", message), message
    assert "secret-message-id" not in message
    assert str(blocker) not in message


def test_invalid_mailbox_name_counts_failed_with_placeholder(tmp_path: Path, monkeypatch, caplog) -> None:
    """净化后名字非法（.. 之类）时只计 failed，日志用 ? 占位，不落任何文件。"""
    import app.archive as archive_mod

    monkeypatch.setattr(archive_mod, "mailbox_name", lambda _email: "..")
    archive = make_archive(tmp_path)
    with caplog.at_level(logging.WARNING, logger="rakkotasks.archive"):
        archive.store(ACCOUNT, MESSAGE_ID, SENT_AT, RAW)

    assert archive.summary() == {"written": 0, "duplicates": 0, "failed": 1}
    assert [r.getMessage() for r in caplog.records] == ["原件归档失败（?）：ValueError"]
    assert not root_of(tmp_path).exists()


def test_from_settings_disabled_when_dir_blank() -> None:
    """配置留空（含纯空白）即关闭归档。"""
    assert EmailArchive.from_settings(Settings(email_archive_dir="")) is None
    assert EmailArchive.from_settings(Settings(email_archive_dir="  ")) is None


def test_from_settings_builds_archive(tmp_path: Path) -> None:
    """开启时按配置的根目录构造，计数从零开始。"""
    archive = EmailArchive.from_settings(Settings(email_archive_dir=str(tmp_path)))
    assert archive is not None
    assert archive.root == tmp_path
    assert archive.summary() == {"written": 0, "duplicates": 0, "failed": 0}
