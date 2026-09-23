"""原件归档测试：路径规则（纯函数）与 EmailArchive 的写入/删除行为。"""
import hashlib
import logging
import os
import re
import stat
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from app.archive import EmailArchive, archive_path, local_zone
from app.config import Settings

SYDNEY = ZoneInfo("Australia/Sydney")
UTC = ZoneInfo("UTC")
ACCOUNT = "me@example.com"
SUBJECT = "会议通知"
MESSAGE_ID = "<m1@example.com>"
# 与实现同一套规则，但独立算一遍，避免用实现自身验证实现
MESSAGE_KEY = hashlib.sha256(MESSAGE_ID.encode("utf-8")).hexdigest()[:12]


def find_eml(root: Path) -> list[Path]:
    return sorted(p for p in Path(root).rglob("*") if p.is_file())


def make_archive(tmp_path: Path, zone: ZoneInfo = SYDNEY) -> EmailArchive:
    return EmailArchive(Path(tmp_path), zone)


def test_path_uses_local_date_and_time() -> None:
    """naive UTC 的 sent_at 换算到悉尼本地时间后决定日期目录与 HHMMSS。

    9 月 23 日悉尼还是 AEST(+10)，UTC 22:30:05 → 本地 9 月 24 日 08:30:05：
    日期目录必须跨到 24 号，否则跨天邮件会归错日期。
    """
    path = archive_path(
        Path("/archive"), ACCOUNT, MESSAGE_ID, SUBJECT, datetime(2026, 9, 23, 22, 30, 5), SYDNEY
    )
    assert path.parent.parent.name == "me@example.com"
    assert path.parent.name == "2026-09-24"
    assert path.name == f"083005_{SUBJECT}_{MESSAGE_KEY}.eml"


def test_path_without_sent_at_goes_to_undated() -> None:
    """缺 Date 头的邮件落到 undated/，文件名不带时间前缀。"""
    path = archive_path(Path("/archive"), ACCOUNT, MESSAGE_ID, SUBJECT, None, SYDNEY)
    assert path.parent.name == "undated"
    assert path.name == f"{SUBJECT}_{MESSAGE_KEY}.eml"


def test_path_traversal_is_neutralized(tmp_path: Path) -> None:
    """恶意主题与账户邮箱都不能造出 root 之外的路径或 .. 段。"""
    root = tmp_path / "root"
    path = archive_path(
        root, "../Evil@X.com", "<m1>", "../../etc/passwd", datetime(2026, 9, 23, 22, 30, 5), SYDNEY
    )
    assert path.is_relative_to(root)  # 不抛即位于 root 之下
    rel = path.relative_to(root)
    assert ".." not in rel.parts
    assert all(part not in ("", "/") for part in rel.parts)
    assert "/" not in path.name
    assert rel.parts[0] == "_.._evil@x.com"  # 斜杠变 _ 后前置 _ 兜底，且全小写


def test_slug_keeps_cjk_and_bounds_length() -> None:
    """中文主题保留中文；空主题用 no-subject；超长主题截到 50 码点，文件名不超 200 字节。"""
    zone = SYDNEY
    sent = datetime(2026, 9, 23, 22, 30, 5)

    kept = archive_path(Path("/a"), ACCOUNT, MESSAGE_ID, "会议通知", sent, zone)
    assert "会议通知" in kept.name

    empty = archive_path(Path("/a"), ACCOUNT, MESSAGE_ID, "", sent, zone)
    assert empty.name.startswith("083005_no-subject_")

    long = archive_path(Path("/a"), ACCOUNT, MESSAGE_ID, "汉" * 300, sent, zone)
    assert len(long.name.encode("utf-8")) <= 200
    assert "汉" * 50 in long.name  # 按码点截断，不切出半个字符


def test_path_is_deterministic_and_keyed_by_message_id() -> None:
    """同输入两次同一路径；message_id 不同则路径不同（同主题不互相覆盖）。"""
    args = (Path("/a"), ACCOUNT, MESSAGE_ID, SUBJECT, datetime(2026, 9, 23, 22, 30, 5), SYDNEY)
    assert archive_path(*args) == archive_path(*args)
    other = archive_path(Path("/a"), ACCOUNT, "<m2>", SUBJECT, datetime(2026, 9, 23, 22, 30, 5), SYDNEY)
    assert other != archive_path(*args)


def test_local_zone_falls_back_to_utc() -> None:
    """空串 / 查无此区 / 路径形态都回落 UTC，不抛异常。"""
    assert local_zone("") == ZoneInfo("UTC")
    assert local_zone("Not/AZone") == ZoneInfo("UTC")
    assert local_zone("/etc/passwd") == ZoneInfo("UTC")
    assert local_zone("Australia/Sydney") == SYDNEY


def test_store_writes_raw_bytes_and_sets_permissions(tmp_path: Path) -> None:
    """原件逐字节落盘，文件 0600、日期目录与账户目录 0700，不留 .tmp。"""
    archive = make_archive(tmp_path)
    raw = b"From: a@example.com\r\nSubject: x\r\n\r\nbody\x00\xff"
    archive.store(ACCOUNT, MESSAGE_ID, SUBJECT, datetime(2026, 9, 23, 22, 30, 5), raw)

    path = archive_path(tmp_path, ACCOUNT, MESSAGE_ID, SUBJECT, datetime(2026, 9, 23, 22, 30, 5), SYDNEY)
    assert path.read_bytes() == raw
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
    assert stat.S_IMODE(path.parent.parent.stat().st_mode) == 0o700
    assert [p.name for p in find_eml(tmp_path)] == [path.name]
    assert not list(tmp_path.rglob("*.tmp"))
    assert archive.summary() == {"written": 1, "failed": 0, "discarded": 0}


def test_store_twice_overwrites_single_file(tmp_path: Path) -> None:
    """回滚后重拉同一封会算出同一路径：覆盖写，不产生第二份副本。"""
    archive = make_archive(tmp_path)
    when = datetime(2026, 9, 23, 22, 30, 5)
    archive.store(ACCOUNT, MESSAGE_ID, SUBJECT, when, b"first")
    archive.store(ACCOUNT, MESSAGE_ID, SUBJECT, when, b"second")

    files = find_eml(tmp_path)
    assert len(files) == 1
    assert files[0].read_bytes() == b"second"
    assert archive.summary() == {"written": 2, "failed": 0, "discarded": 0}


def test_discard_removes_file_and_empty_date_dir(tmp_path: Path) -> None:
    """删掉最后一封后空日期目录一并清掉。"""
    archive = make_archive(tmp_path)
    when = datetime(2026, 9, 23, 22, 30, 5)
    archive.store(ACCOUNT, MESSAGE_ID, SUBJECT, when, b"raw")
    path = archive_path(tmp_path, ACCOUNT, MESSAGE_ID, SUBJECT, when, SYDNEY)

    archive.discard(ACCOUNT, MESSAGE_ID, SUBJECT, when)
    assert not path.exists()
    assert not path.parent.exists()
    assert path.parent.parent.exists()  # 账户目录不是空的清理目标，保留
    assert archive.summary() == {"written": 1, "failed": 0, "discarded": 1}


def test_discard_keeps_date_dir_when_other_files_remain(tmp_path: Path) -> None:
    """同一日期目录还有别的邮件时目录保留。"""
    archive = make_archive(tmp_path)
    when = datetime(2026, 9, 23, 22, 30, 5)
    archive.store(ACCOUNT, MESSAGE_ID, SUBJECT, when, b"one")
    archive.store(ACCOUNT, "<m2>", SUBJECT, when, b"two")

    archive.discard(ACCOUNT, MESSAGE_ID, SUBJECT, when)
    others = find_eml(tmp_path)
    assert len(others) == 1
    assert others[0].parent.exists()
    assert archive.summary() == {"written": 2, "failed": 0, "discarded": 1}


def test_discard_missing_file_is_silent(tmp_path: Path) -> None:
    """对不存在的文件 discard 不抛，也不计入 discarded。"""
    archive = make_archive(tmp_path)
    archive.discard(ACCOUNT, "<never-stored>", SUBJECT, datetime(2026, 9, 23, 22, 30, 5))
    assert archive.summary() == {"written": 0, "failed": 0, "discarded": 0}


def test_store_failure_is_counted_and_logged_without_leaking(tmp_path: Path, caplog) -> None:
    """root 指向普通文件时写入必然失败：不抛、计 failed，日志里只有账户目录名与异常类名。

    恰好一条告警，且整条消息完全匹配「原件归档失败（账户目录名）：类名」——
    多出任何一个字符（主题、message_id、路径）都会让断言失败。
    """
    blocker = tmp_path / "not-a-dir"
    blocker.write_bytes(b"")
    archive = EmailArchive(blocker, SYDNEY)
    secret_subject = "绝密主题标题"
    with caplog.at_level(logging.WARNING, logger="rakkotasks.archive"):
        archive.store(
            ACCOUNT, "<secret-message-id>", secret_subject, datetime(2026, 9, 23, 22, 30, 5), b"raw"
        )
    assert archive.summary() == {"written": 0, "failed": 1, "discarded": 0}
    assert len(caplog.records) == 1
    message = caplog.records[0].getMessage()
    assert re.fullmatch(r"原件归档失败（me@example\.com）：[A-Za-z]+Error", message), message
    assert secret_subject not in message
    assert "secret-message-id" not in message
    assert str(blocker) not in message


def test_store_failure_cleans_tmp(tmp_path: Path, caplog) -> None:
    """rename 一步失败也计 failed，并清掉残留的 .tmp（异常文本仍不含主题）。"""
    archive = make_archive(tmp_path)
    when = datetime(2026, 9, 23, 22, 30, 5)
    path = archive_path(tmp_path, ACCOUNT, MESSAGE_ID, SUBJECT, when, SYDNEY)
    path.parent.parent.mkdir(mode=0o700, exist_ok=True)  # 账户目录
    os.mkdir(path.parent)  # 日期目录
    os.mkdir(path)  # 正式路径已被目录占用 → os.replace 必然失败
    with caplog.at_level(logging.WARNING, logger="rakkotasks.archive"):
        archive.store(ACCOUNT, MESSAGE_ID, SUBJECT, when, b"raw")
    assert archive.summary() == {"written": 0, "failed": 1, "discarded": 0}
    assert not path.with_name(path.name + ".tmp").exists()
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert "IsADirectoryError" in text
    assert SUBJECT not in text


@pytest.mark.parametrize(
    ("slug", "account_dir", "expected"),
    [
        ("/abs", None, "不在根目录之下"),  # 变成绝对路径 → relative_to 直接拒绝
        ("a/b", None, "形态非法"),  # 相对但四段 → 长度分支
        (SUBJECT, "..", "形态非法"),  # 恰好三段且首段是 .. → 只有 .. 检查能拦住
    ],
    ids=["absolute", "too-many-segments", "dotdot-segment"],
)
def test_escaped_path_is_rejected_with_value_error(
    monkeypatch, slug: str, account_dir: str | None, expected: str
) -> None:
    """净化规则被改坏时路径校验必须抛 ValueError，三个分支各自钉住。"""
    import app.archive as archive_mod

    monkeypatch.setattr(archive_mod, "_subject_slug", lambda _s: slug)
    if account_dir is not None:
        monkeypatch.setattr(archive_mod, "_account_dir", lambda _e: account_dir)
    with pytest.raises(ValueError, match=expected):
        archive_path(Path("/archive"), ACCOUNT, MESSAGE_ID, SUBJECT, None, SYDNEY)


def test_store_swallows_path_validation_failure(tmp_path: Path, monkeypatch, caplog) -> None:
    """store 遇到路径校验失败只计 failed、不落任何文件、不抛。

    异常若冒泡到 _sync_account，整个账户批次会回滚、last_uid 永不推进。
    """
    import app.archive as archive_mod

    monkeypatch.setattr(archive_mod, "_subject_slug", lambda _s: "../../etc/passwd")
    archive = make_archive(tmp_path)
    with caplog.at_level(logging.WARNING, logger="rakkotasks.archive"):
        archive.store(ACCOUNT, MESSAGE_ID, SUBJECT, None, b"raw")  # 不抛即通过
    assert archive.summary() == {"written": 0, "failed": 1, "discarded": 0}
    assert not list(tmp_path.rglob("*"))


def test_discard_swallows_path_validation_failure(tmp_path: Path, monkeypatch, caplog) -> None:
    """discard 遇到路径校验失败同样只计 failed、不抛、不删（也没东西可删）。

    discard 的调用方是 _process_pending 的分类循环：异常冒泡会打断本轮剩余
    邮件的分类，并让 run_once 抛出。
    """
    import app.archive as archive_mod

    monkeypatch.setattr(archive_mod, "_subject_slug", lambda _s: "/abs")
    archive = make_archive(tmp_path)
    with caplog.at_level(logging.WARNING, logger="rakkotasks.archive"):
        archive.discard(ACCOUNT, MESSAGE_ID, SUBJECT, None)  # 不抛
    assert archive.summary() == {"written": 0, "failed": 1, "discarded": 0}
    assert not list(tmp_path.rglob("*"))


def test_from_settings_disabled_when_dir_blank(tmp_path: Path) -> None:
    """配置留空（含纯空白）即关闭归档。"""
    assert EmailArchive.from_settings(Settings(email_archive_dir="")) is None
    assert EmailArchive.from_settings(Settings(email_archive_dir="  ")) is None


def test_from_settings_builds_archive_with_configured_zone(tmp_path: Path) -> None:
    """开启时按配置的根目录与本地区时区构造。"""
    archive = EmailArchive.from_settings(
        Settings(email_archive_dir=str(tmp_path), local_timezone="Australia/Sydney")
    )
    assert archive is not None
    assert archive.root == tmp_path
    assert archive.zone == SYDNEY
    assert archive.summary() == {"written": 0, "failed": 0, "discarded": 0}


def test_from_settings_invalid_zone_falls_back_to_utc(tmp_path: Path) -> None:
    """local_timezone 非法时归档仍可用，只是按 UTC 分目录。"""
    archive = EmailArchive.from_settings(Settings(email_archive_dir=str(tmp_path), local_timezone=""))
    assert archive is not None
    assert archive.zone == UTC
