"""邮件原件归档：把 IMAP 拉到的原始 RFC822 字节（含附件）原样写成 .eml。

路径由纯函数 archive_path 决定，写入与删除共用同一套规则，保证两侧对同一
封邮件算出同一个路径——否则删不掉会留下永久孤儿文件。
归档是旁路能力：任何失败都只计数并告警，不影响入库、游标推进与分类结果。
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

# 失败告警只写账户目录名与异常类名，绝不写异常字符串与邮件内容（见 _log_failure 说明）
logger = logging.getLogger("rakkotasks.archive")

# 文件名主题段的码点上限：中文 3 字节/字，50 字连同时间前缀与 .tmp 后缀
# 仍远低于 ext4 单段 255 字节上限
_SLUG_MAX_CHARS = 50

# 账户目录里允许出现的字符；其余替换为 _，避免邮箱地址里的路径元字符逃出 root
_ACCOUNT_UNSAFE = re.compile(r"[^a-z0-9@._+-]")


def local_zone(name: str) -> ZoneInfo:
    """把配置里的时区名解析成 ZoneInfo，非法时回落 UTC。

    两种非法形态都要兜：ZoneInfoNotFoundError（查无此区）与 ValueError
    （空串 / 绝对路径 / 含 .. 的路径）。归档路径要用它算本地日期目录，
    时区配错只应退化成本地时间偏移不对，不该让整个同步失败。
    """
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def _subject_slug(subject: str) -> str:
    """主题 → 文件名安全片段：保留中日韩等文字，去掉路径元字符，截断到上限。"""
    text = unicodedata.normalize("NFKC", subject or "")
    # \w 在 Unicode 模式下匹配中日韩文字，所以中文主题不会被清空
    text = re.sub(r"[^\w-]+", "_", text)
    text = re.sub(r"_+", "_", text)
    text = text.strip("_-.")
    text = text[:_SLUG_MAX_CHARS]
    text = text.rstrip("_")
    return text or "no-subject"


def _account_dir(account_email: str) -> str:
    """账户邮箱 → 一层目录名：统一小写并替换掉所有非白名单字符。"""
    name = (account_email or "").strip().lower()
    name = _ACCOUNT_UNSAFE.sub("_", name)
    if not name or name.startswith("."):
        name = "_" + name
    return name


def _message_key(message_id: str) -> str:
    """message_id → 短摘要，兼作同主题不同邮件的区分与文件名长度的控制。"""
    return hashlib.sha256((message_id or "").encode("utf-8")).hexdigest()[:12]


def archive_path(
    root: Path,
    account_email: str,
    message_id: str,
    subject: str,
    sent_at: datetime | None,
    zone: ZoneInfo,
) -> Path:
    """算出某一封邮件的归档路径（写与删共用，纯函数、无副作用）。

    sent_at 是 naive UTC（parser 统一转成 UTC 后去掉 tzinfo）：先贴回 UTC 再
    换算到 zone，日期目录与文件名时间都用本地时间。缺 Date 头（sent_at 为
    None）的邮件没有可信时间，统一落到 undated/，避免用「拉取时刻」伪造时间。
    """
    account = _account_dir(account_email)
    slug = _subject_slug(subject)
    key = _message_key(message_id)
    if sent_at is None:
        path = root / account / "undated" / f"{slug}_{key}.eml"
    else:
        local = sent_at.replace(tzinfo=timezone.utc).astimezone(zone)
        path = root / account / local.strftime("%Y-%m-%d") / f"{local.strftime('%H%M%S')}_{slug}_{key}.eml"
    try:
        rel = path.relative_to(root)
    except ValueError as exc:
        # 异常文本里同样不带上文件名——文件名含主题
        raise ValueError(f"归档路径不在根目录之下（账户目录 {account}）") from exc
    # relative_to 只是字面比较，不会展开 ..（Path("/r/../x").relative_to("/r") 照样成功），
    # 所以这里补一步：路径必须恰好三段且不含 ..。slug 与账户名都已净化，
    # 正常规则下永远不该触发；万一有人改坏了净化规则，这里要挡住写出 root 之外
    if ".." in rel.parts or len(rel.parts) != 3:
        raise ValueError(f"归档路径形态非法（账户目录 {account}）")
    return path


class EmailArchive:
    """原件归档器：一轮同步内累积 written / failed / discarded 计数。"""

    def __init__(self, root: Path, zone: ZoneInfo) -> None:
        self.root = Path(root)
        self.zone = zone
        self.written = 0
        self.failed = 0
        self.discarded = 0

    @classmethod
    def from_settings(cls, settings) -> EmailArchive | None:
        """按配置构造；email_archive_dir 去空白后为空即关闭归档。"""
        raw = settings.email_archive_dir.strip()
        if not raw:
            return None
        return cls(Path(raw), local_zone(settings.local_timezone))

    def path_for(
        self, account_email: str, message_id: str, subject: str, sent_at: datetime | None
    ) -> Path:
        return archive_path(self.root, account_email, message_id, subject, sent_at, self.zone)

    def _log_failure(self, account_email: str, exc: Exception) -> None:
        """只写账户目录名与异常类名。

        OSError 的字符串里带文件名，而文件名含主题——写进去就等于把邮件主题
        泄进日志，破坏「日志不含邮件内容」的既有纪律。
        """
        logger.warning("原件归档失败（%s）：%s", _account_dir(account_email), type(exc).__name__)

    def store(
        self,
        account_email: str,
        message_id: str,
        subject: str,
        sent_at: datetime | None,
        raw: bytes,
    ) -> None:
        """把原始字节原子写入归档路径；失败（含路径算不出）只计数告警，不抛出。"""
        tmp: Path | None = None
        try:
            path = self.path_for(account_email, message_id, subject, sent_at)
            tmp = path.with_name(path.name + ".tmp")
            # 三层各自 mkdir：parents=True 建出的中间目录不套用 mode，靠它建会把
            # 账户/日期目录留成 0o777 & ~umask，目录列表（也就是文件名里的主题）就敞开了
            self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
            path.parent.parent.mkdir(mode=0o700, exist_ok=True)
            path.parent.mkdir(mode=0o700, exist_ok=True)
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            # fdopen 接管 fd 后由 with 负责关闭，不再手动 os.close
            with os.fdopen(fd, "wb") as f:
                f.write(raw)  # BufferedWriter 自己处理短写，不像 os.write 只写一次
                f.flush()
                # 不 fsync 的话断电时 rename 可能先于数据落盘，留下零字节文件；
                # 归档的全部意义就是原件可靠，这一步不能省
                os.fsync(f.fileno())
            # 目标已存在就直接覆盖：整批回滚后重拉同一封会算出同一路径，
            # 覆盖即自愈，不会留下重复副本或改名前被中断的孤儿文件
            os.replace(tmp, path)
        except (OSError, ValueError) as exc:
            # ValueError 来自 archive_path 的路径校验：必须在归档内部吞掉，
            # 冒泡到 _sync_account 会让整个账户批次回滚、last_uid 永不推进
            self.failed += 1
            self._log_failure(account_email, exc)
            if tmp is not None:
                try:
                    os.unlink(tmp)  # 残留的 .tmp 不会被下轮复用，清掉；清不掉就算了
                except OSError:
                    pass
            return
        self.written += 1

    def discard(
        self, account_email: str, message_id: str, subject: str, sent_at: datetime | None
    ) -> None:
        """删除某封邮件的归档文件；文件本就不存在则静默跳过。"""
        try:
            path = self.path_for(account_email, message_id, subject, sent_at)
        except ValueError as exc:
            # path_for 是纯函数，只可能抛路径校验的 ValueError（不碰文件系统，
            # 不会抛 OSError）：在这里计失败并返回，不让它冒泡到 _process_pending
            # 打断本轮剩余邮件的分类、把 run_once 顶出去
            self.failed += 1
            self._log_failure(account_email, exc)
            return
        try:
            os.unlink(path)
        except FileNotFoundError:
            # 已删或从未写入：不是错误，也不计入 discarded
            return
        except OSError as exc:
            self.failed += 1
            self._log_failure(account_email, exc)
            return
        self.discarded += 1
        try:
            # 顺手清掉空的日期目录；里面还有别的邮件时会抛 OSError，忽略即可
            # （不必先 listdir 判断，那不是原子的）
            os.rmdir(path.parent)
        except OSError:
            pass

    def summary(self) -> dict:
        return {"written": self.written, "failed": self.failed, "discarded": self.discarded}
