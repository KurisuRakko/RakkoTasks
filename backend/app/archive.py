"""邮件原件归档：每个账户一个只追加的 mbox 文件（mboxrd 格式）。

- `<root>/<邮箱名>.mbox`：mboxrd 正文，只追加；收件箱全部邮件都归档（永不删除），
  发件箱只归档、不入库。
- `<root>/<邮箱名>.mbox.idx`：每行一个已归档邮件的 key（sha256(message_id) 的
  64 位十六进制），只追加，用于跨进程去重。

worker 与 `archive-backfill` 是两个独立进程，可能同时写同一个账户的 mbox：
两者都靠 mbox 文件锁 + 索引去重保证同一封邮件只追加一次。
归档是旁路能力：任何失败都只计数并告警，不影响入库、游标推进与分类结果。
"""
from __future__ import annotations

import fcntl
import hashlib
import logging
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path

# 失败告警只写邮箱名与异常类名，绝不写异常字符串与邮件内容（见 _log_failure 说明）
logger = logging.getLogger("rakkotasks.archive")

# 账户名里允许出现的字符；其余替换为 _，避免邮箱地址里的路径元字符逃出 root
_ACCOUNT_UNSAFE = re.compile(r"[^a-z0-9@._+-]")

# mboxrd 转义：行首「若干个 > 紧跟 From 」再加一个 >
_FROM_ESCAPE = re.compile(rb"^(>*From )", re.M)


def mailbox_name(account_email: str) -> str:
    """账户邮箱 → mbox 文件名（不含 .mbox 扩展名）：统一小写并替换掉所有非白名单字符。"""
    name = (account_email or "").strip().lower()
    name = _ACCOUNT_UNSAFE.sub("_", name)
    if not name or name.startswith("."):
        name = "_" + name
    return name


def _safe_mailbox_name(root: Path, account_email: str) -> str:
    """净化 + 越界校验，返回可安全拼成 `<root>/<这个名字>.mbox` 的名字。

    净化规则正常时两条校验永远通过；万一以后有人把净化规则改坏（放进 .. 或
    路径分隔符），这里必须挡住写出 root 之外的文件。
    """
    name = mailbox_name(account_email)
    if name in (".", "..") or (root / name).parent != root:
        raise ValueError("归档文件名非法")
    return name


def _write_all(fd: int, data: bytes) -> None:
    """os.write 可能短写，循环写到写完为止。"""
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        view = view[written:]


class EmailArchive:
    """原件归档器：一轮同步内累积 written / duplicates / failed 计数。"""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.written = 0
        self.duplicates = 0
        self.failed = 0
        # 按邮箱名缓存 (已归档 key 集合, idx 已读到的字节偏移)：
        # 增量读取让「别的进程刚追加的 key」也能被看见，且不必每次重读整个文件
        self._index: dict[str, tuple[set[str], int]] = {}

    @classmethod
    def from_settings(cls, settings) -> EmailArchive | None:
        """按配置构造；email_archive_dir 去空白后为空即关闭归档。"""
        raw = settings.email_archive_dir.strip()
        if not raw:
            return None
        return cls(Path(raw))

    def _log_failure(self, name: str | None, exc: Exception) -> None:
        """只写邮箱名与异常类名。

        OSError 的字符串里带文件路径，写进去等于把归档目录结构泄进日志；
        邮箱名净化本身失败时连名字都算不出来，用 ? 占位。
        """
        logger.warning("原件归档失败（%s）：%s", name or "?", type(exc).__name__)

    def _load_index(self, name: str, idx: Path) -> set[str]:
        """刷新该账户的 key 缓存并返回 key 集合：只从上次读到的偏移往后读。

        另一个进程（archive-backfill 或另一个 worker 周期）追加进来的 key 靠
        offset 增量读进来，不必每次重读整个索引文件。
        """
        keys, offset = self._index.get(name, (set(), 0))
        fd = os.open(idx, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            size = os.fstat(fd).st_size
            if size < offset:
                # 索引被截断/替换（人工干预）：退回从头读，宁可多读不可漏判
                keys, offset = set(), 0
            if size > offset:
                os.lseek(fd, offset, os.SEEK_SET)
                chunk = b""
                while True:
                    part = os.read(fd, 1 << 16)
                    if not part:
                        break
                    chunk += part
                # 最后一段可能是别的进程写了一半的行，只认完整行
                lines = chunk.split(b"\n")[:-1]
                for line in lines:
                    text = line.decode("utf-8", errors="replace").strip()
                    if text:
                        keys.add(text)
                offset += sum(len(line) + 1 for line in lines)
        finally:
            os.close(fd)
        self._index[name] = (keys, offset)
        return keys

    def _append_key(self, name: str, idx: Path, key: str) -> None:
        """把 key 追加进索引并同步刷新缓存；idx 与 mbox 一样只追加。"""
        fd = os.open(idx, os.O_RDWR | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            _write_all(fd, (key + "\n").encode("ascii"))
            os.fsync(fd)
            size = os.fstat(fd).st_size
        finally:
            os.close(fd)
        keys, _offset = self._index[name]
        keys.add(key)
        self._index[name] = (keys, size)

    @staticmethod
    def _heal_tail(fd: int) -> None:
        """补足文件尾换行：保证下一行的 From 分隔符从新行开始。

        上一次追加写到一半就崩溃时，文件末尾停在残缺邮件的中间；不补换行的话，
        下一个 From 行会粘在残缺邮件的尾巴上，整段会被读成一个邮件。
        """
        size = os.fstat(fd).st_size
        if size == 0:
            return
        tail = os.pread(fd, 2, size - 2) if size >= 2 else os.pread(fd, 1, 0)
        if tail == b"\n\n":
            return
        _write_all(fd, b"\n" if tail.endswith(b"\n") else b"\n\n")

    @staticmethod
    def _render(sent_at: datetime | None, raw: bytes) -> bytes:
        """把原始邮件字节渲染成 mbox 中的一段（From 分隔行 + 转义后的正文）。"""
        if sent_at is None:
            # 缺 Date 头：用当前 UTC 时间，只是分隔行的记账时间
            when = time.gmtime()
        else:
            # parser 统一给 naive UTC；这里把 sent_at 当 UTC 处理
            base = sent_at if sent_at.tzinfo is not None else sent_at.replace(tzinfo=timezone.utc)
            when = base.astimezone(timezone.utc).timetuple()
        # time.asctime 不受 locale 影响：按 locale 取星期/月份缩写的日期格式化
        # 不能用在这里——非英文 locale 下会写出解析器认不出的 From 行
        header = b"From MAILER-DAEMON " + time.asctime(when).encode("ascii") + b"\n"
        body = raw.replace(b"\r\n", b"\n")
        # mboxrd：行首「若干个 > 紧跟 From 」的行再加一个 >
        body = _FROM_ESCAPE.sub(rb">\1", body)
        if not body.endswith(b"\n"):
            body += b"\n"
        return header + body + b"\n"

    def store(
        self,
        account_email: str,
        message_id: str,
        sent_at: datetime | None,
        raw: bytes,
    ) -> None:
        """把一封邮件追加进该账户的 mbox；失败（含文件名非法）只计数告警，不抛出。"""
        name: str | None = None
        try:
            name = _safe_mailbox_name(self.root, account_email)
            key = hashlib.sha256((message_id or "").encode("utf-8")).hexdigest()
            mbox = self.root / f"{name}.mbox"
            idx = self.root / f"{name}.mbox.idx"
            self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
            # O_APPEND + flock：worker 与 archive-backfill 可能同时写同一个文件，
            # 「查索引、追加、记索引」三步必须在同一把锁里连着做，否则两边都会
            # 在索引里看不到对方、把同一封邮件追加两次
            fd = os.open(mbox, os.O_RDWR | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX)
                try:
                    if key in self._load_index(name, idx):
                        self.duplicates += 1
                        return
                    self._heal_tail(fd)
                    # 一次 write 写完整封（_write_all 保证写全）
                    _write_all(fd, self._render(sent_at, raw))
                    os.fsync(fd)
                    # 先让 mbox 落盘再记索引：崩在两步之间时最坏结果是下轮重复
                    # 归档一封（被索引挡住），绝不会漏掉一封
                    self._append_key(name, idx, key)
                finally:
                    fcntl.flock(fd, fcntl.LOCK_UN)
            finally:
                os.close(fd)
        except (OSError, ValueError) as exc:
            # ValueError 来自文件名校验：必须在归档内部吞掉，冒泡到 _sync_account
            # 会让整个账户批次回滚、last_uid 永不推进
            self.failed += 1
            self._log_failure(name, exc)
            return
        self.written += 1

    def summary(self) -> dict:
        return {"written": self.written, "duplicates": self.duplicates, "failed": self.failed}
