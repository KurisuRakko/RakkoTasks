"""归档回补测试：backfill_archive 按 SINCE 重扫收件箱与发件箱，只写 mbox 不碰库。"""
import mailbox

from sqlalchemy import select

from app.archive import EmailArchive
from app.models import Account, Email, User
from app.sync import backfill_archive

ACCOUNT_EMAIL = "t@example.com"
MBOX_NAME = "t@example.com.mbox"


def make_raw(message_id: str, subject: str) -> bytes:
    return (
        b"From: a@example.com\n"
        b"To: me@example.com\n"
        b"Subject: " + subject.encode("utf-8") + b"\n"
        b"Message-ID: " + message_id.encode("ascii") + b"\n"
        b"Date: Fri, 4 Sep 2026 03:05:09 +0000\n"
        b"\n"
        b"body\n"
    )


class FakeImap:
    """按当前选中的文件夹返回对应 UID 集合（真实 IMAP 的 SEARCH 就是这个语义）。"""

    def __init__(self, inbox: dict, sent: dict, sent_folder: str | None = "Sent", uidvalidity: int = 1):
        self.inbox = inbox
        self.sent = sent
        self.sent_folder = sent_folder
        self.uidvalidity = uidvalidity
        self.selected: str | None = None
        self.searches: list[str] = []

    def find_sent_folder(self) -> str | None:
        return self.sent_folder

    def select_folder_readonly(self, name: str) -> int:
        self.selected = name
        return self.uidvalidity

    def search_uids(self, criteria: str) -> list[int]:
        self.searches.append(criteria)
        return list(self.sent if self.selected == self.sent_folder else self.inbox)

    def fetch_uid(self, uid: int) -> bytes:
        return (self.sent if self.selected == self.sent_folder else self.inbox)[uid]


def _seed(session_factory) -> Account:
    """建一个带游标与一封邮件的账户：回补不该动它们。"""
    with session_factory() as s:
        s.add(User(sub="user-1"))
        s.commit()
        account = Account(
            user_sub="user-1", name="测试邮箱", kind="gmail", email=ACCOUNT_EMAIL,
            app_password="app-pw", status="ok", uidvalidity=1, last_uid=9,
            sent_uidvalidity=3, sent_last_uid=4,
        )
        s.add(account)
        s.commit()
        s.add(Email(account_id=account.id, message_id="<db1>", subject="库里的邮件",
                    sender="a@example.com", recipients="me@example.com",
                    text_body="正文", attachments_json="[]", llm_state="done"))
        s.commit()
        return account


def _messages(tmp_path) -> list:
    box = mailbox.mbox(str(tmp_path / MBOX_NAME))
    try:
        return list(box)
    finally:
        box.close()


def _ids(tmp_path) -> list[str]:
    return [m["Message-ID"] for m in _messages(tmp_path)]


def test_backfill_archives_inbox_and_sent(tmp_path, session_factory):
    """收件箱与发件箱两边的邮件都按 SINCE 回补进同一个 mbox。"""
    account = _seed(session_factory)
    imap = FakeImap(
        inbox={1: make_raw("<i1>", "收件一"), 2: make_raw("<i2>", "收件二")},
        sent={1: make_raw("<s1>", "发件一")},
    )
    archive = EmailArchive(tmp_path)

    backfill_archive(account, imap, archive, days=30)

    assert _ids(tmp_path) == ["<i1>", "<i2>", "<s1>"]
    assert imap.selected == "Sent"
    assert imap.searches[0] == imap.searches[1] and imap.searches[0].startswith("SINCE ")
    assert archive.summary() == {"written": 3, "duplicates": 0, "failed": 0}


def test_backfill_without_sent_folder_archives_inbox_only(tmp_path, session_factory):
    """没有 \\Sent 标记的文件夹：只回补收件箱，不报错。"""
    account = _seed(session_factory)
    imap = FakeImap(inbox={1: make_raw("<i1>", "收件一")}, sent={}, sent_folder=None)
    archive = EmailArchive(tmp_path)

    backfill_archive(account, imap, archive, days=30)

    assert _ids(tmp_path) == ["<i1>"]
    assert archive.summary()["written"] == 1


def test_backfill_touches_neither_emails_nor_cursors(tmp_path, session_factory):
    """回补只写 mbox：emails 表行数不变，收件箱与发件箱游标都不动。"""
    account = _seed(session_factory)
    imap = FakeImap(
        inbox={1: make_raw("<i1>", "收件一")},
        sent={1: make_raw("<s1>", "发件一")},
    )
    archive = EmailArchive(tmp_path)

    backfill_archive(account, imap, archive, days=30)

    with session_factory() as s:
        assert [e.message_id for e in s.execute(select(Email)).scalars().all()] == ["<db1>"]
        acc = s.execute(select(Account)).scalars().one()
        assert (acc.uidvalidity, acc.last_uid) == (1, 9)
        assert (acc.sent_uidvalidity, acc.sent_last_uid) == (3, 4)


def test_backfill_twice_only_counts_duplicates(tmp_path, session_factory):
    """重复执行只算 duplicates：索引挡住第二次追加。"""
    account = _seed(session_factory)
    imap = FakeImap(
        inbox={1: make_raw("<i1>", "收件一")},
        sent={1: make_raw("<s1>", "发件一")},
    )
    archive = EmailArchive(tmp_path)
    backfill_archive(account, imap, archive, days=30)

    second = EmailArchive(tmp_path)  # 新实例：索引只能从 idx 文件读出来
    backfill_archive(account, imap, second, days=30)

    assert second.summary() == {"written": 0, "duplicates": 2, "failed": 0}
    assert _ids(tmp_path) == ["<i1>", "<s1>"]
    with session_factory() as s:
        assert len(s.execute(select(Email)).scalars().all()) == 1
