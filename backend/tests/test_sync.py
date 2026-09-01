"""单轮同步测试：FakeImap / FakeLLM 注入，不触网。"""
import logging
from email.message import EmailMessage

import pytest
from sqlalchemy import select

from app.models import Account, Email, Item, User
from app.sync import run_once


def make_raw(subject="主题", message_id="<m@example.com>", body="正文", sender="a@example.com"):
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = "me@example.com"
    msg["Date"] = "Tue, 26 Aug 2026 10:00:00 +0800"
    if message_id:
        msg["Message-ID"] = message_id
    msg.set_content(body)
    return msg.as_bytes()


class FakeImap:
    """duck-typing 协议类：select_inbox / search_uids / fetch_uid / logout。"""

    def __init__(self, uidvalidity: int = 1):
        self.uidvalidity = uidvalidity
        self.mails: dict[int, bytes] = {}
        self.logged_out = False

    def select_inbox(self) -> int:
        return self.uidvalidity

    def search_uids(self, criteria: str) -> list[int]:
        return list(self.mails)

    def fetch_uid(self, uid: int) -> bytes:
        return self.mails[uid]

    def logout(self) -> None:
        self.logged_out = True


class WorkerKilled(BaseException):
    """模拟 worker 进程崩溃：BaseException 不被 except Exception 捕获，能穿透到调用方。"""


class FakeLLM:
    def __init__(self, results=None, raise_invalid=False, fail_subjects=(), crash_subjects=()):
        self.results = list(results or [])
        self.raise_invalid = raise_invalid
        self.fail_subjects = set(fail_subjects)  # 命中的 subject 抛 ValueError（单封失败）
        self.crash_subjects = set(crash_subjects)  # 命中的 subject 抛 WorkerKilled（模拟崩溃）

    def classify_email(self, info: dict) -> dict:
        if self.raise_invalid:
            raise ValueError("LLM 返回非法 JSON")
        subject = info.get("subject") or ""
        if subject in self.crash_subjects:
            raise WorkerKilled("worker 崩溃")
        if subject in self.fail_subjects:
            raise ValueError("单封处理失败")
        return self.results.pop(0)


def _run(session_factory, imap: FakeImap, llm: FakeLLM):
    return run_once(session_factory, imap_factory=lambda a, s: imap, llm=llm)


def _seed_account(sf) -> None:
    with sf() as s:
        s.add(User(sub="user-1"))
        s.commit()
        s.add(Account(user_sub="user-1", name="测试邮箱", kind="gmail", email="t@example.com", status="pending"))
        s.commit()


def _emails(sf):
    with sf() as s:
        return s.execute(select(Email)).scalars().all()


def _account(sf):
    with sf() as s:
        return s.execute(select(Account)).scalars().one()


def test_fetch_new_emails_and_advance_cursor(session_factory):
    _seed_account(session_factory)
    imap = FakeImap()
    imap.mails = {1: make_raw(message_id="<a1>"), 2: make_raw(message_id="<a2>", subject="第二封")}
    _run(session_factory, imap, FakeLLM())

    emails = _emails(session_factory)
    assert len(emails) == 2
    acc = _account(session_factory)
    assert acc.last_uid == 2
    assert acc.uidvalidity == 1
    assert acc.status == "ok"
    assert acc.last_sync_at is not None
    assert acc.last_error is None

    # 无新邮件：游标不动
    _run(session_factory, imap, FakeLLM())
    assert len(_emails(session_factory)) == 2
    assert _account(session_factory).last_uid == 2


def test_duplicate_message_id_not_reinserted(session_factory):
    _seed_account(session_factory)
    imap = FakeImap()
    imap.mails = {1: make_raw(message_id="<dup>"), 2: make_raw(message_id="<dup>")}
    _run(session_factory, imap, FakeLLM())
    emails = _emails(session_factory)
    assert len(emails) == 1

    # 后续 uid 出现相同 message_id：仍去重，游标只前进
    imap.mails = {1: make_raw(message_id="<dup>"), 2: make_raw(message_id="<dup>"), 3: make_raw(message_id="<new>")}
    _run(session_factory, imap, FakeLLM())
    assert len(_emails(session_factory)) == 2
    assert _account(session_factory).last_uid == 3


def test_uidvalidity_change_resets_cursor(session_factory):
    _seed_account(session_factory)
    imap = FakeImap(uidvalidity=5)
    imap.mails = {1: make_raw(message_id="<a1>"), 2: make_raw(message_id="<a2>")}
    _run(session_factory, imap, FakeLLM())
    assert _account(session_factory).last_uid == 2

    # UIDVALIDITY 变化 → 游标重置 → 全量回补；已存在 message_id 去重，新 uid 3 入库
    imap.uidvalidity = 99
    imap.mails = {1: make_raw(message_id="<a1>"), 2: make_raw(message_id="<a2>"), 3: make_raw(message_id="<a3>")}
    _run(session_factory, imap, FakeLLM())

    acc = _account(session_factory)
    assert acc.uidvalidity == 99
    assert acc.last_uid == 3
    assert len(_emails(session_factory)) == 3


def test_classify_filtered_and_item_created(session_factory):
    _seed_account(session_factory)
    imap = FakeImap()
    imap.mails = {1: make_raw(message_id="<a1>", subject="促销"), 2: make_raw(message_id="<a2>", subject="交作业")}
    llm = FakeLLM(
        results=[
            {"filtered": True, "filter_reason": "广告营销", "title": "", "summary": "",
             "category": "", "due_date": None, "actionable": False},
            {"filtered": False, "filter_reason": None, "title": "交作业", "summary": "周五前交",
             "category": "学业", "due_date": "2026-09-04", "actionable": True},
        ]
    )
    _run(session_factory, imap, llm)

    emails = _emails(session_factory)
    by_mid = {e.message_id: e for e in emails}
    assert by_mid["<a1>"].filtered is True
    assert by_mid["<a1>"].filter_reason == "广告营销"
    assert by_mid["<a1>"].llm_state == "done"
    assert by_mid["<a2>"].filtered is False
    assert by_mid["<a2>"].llm_state == "done"

    with session_factory() as s:
        items = s.execute(select(Item)).scalars().all()
        assert len(items) == 1
        it = items[0]
        assert it.title == "交作业"
        assert it.category == "学业"
        assert str(it.due_date) == "2026-09-04"
        assert it.actionable is True
        assert it.status == "open"
        assert it.importance == "normal"  # LLM 未返回 importance 时兜底 normal


def test_item_importance_from_llm(session_factory):
    """sync 建出的 item 带上 LLM 返回的 importance。"""
    _seed_account(session_factory)
    imap = FakeImap()
    imap.mails = {1: make_raw(message_id="<imp>", subject="ELP 确认")}
    llm = FakeLLM(
        results=[
            {"filtered": False, "filter_reason": None, "title": "ELP 确认并转发", "summary": "s",
             "category": "学业", "due_date": None, "actionable": True, "importance": "high"},
        ]
    )
    _run(session_factory, imap, llm)

    with session_factory() as s:
        item = s.execute(select(Item)).scalars().one()
        assert item.importance == "high"


def test_item_importance_whitelist_fallback(session_factory):
    """LLM 返回白名单外的 importance（urgent）时兜底 normal。"""
    _seed_account(session_factory)
    imap = FakeImap()
    imap.mails = {1: make_raw(message_id="<imp2>", subject="补考通知")}
    llm = FakeLLM(
        results=[
            {"filtered": False, "filter_reason": None, "title": "补考", "summary": "s",
             "category": "学业", "due_date": None, "actionable": True, "importance": "urgent"},
        ]
    )
    _run(session_factory, imap, llm)

    with session_factory() as s:
        item = s.execute(select(Item)).scalars().one()
        assert item.importance == "normal"


def test_invalid_json_marks_error_no_item(session_factory):
    _seed_account(session_factory)
    imap = FakeImap()
    imap.mails = {1: make_raw(message_id="<a1>")}
    _run(session_factory, imap, FakeLLM(raise_invalid=True))

    emails = _emails(session_factory)
    assert emails[0].llm_state == "error"
    assert "LLM 处理失败" in (emails[0].filter_reason or "")
    with session_factory() as s:
        assert s.execute(select(Item)).scalars().all() == []


def test_account_failure_marks_error(session_factory):
    _seed_account(session_factory)
    def bad_factory(account, settings):
        raise RuntimeError("连接失败")

    run_once(session_factory, imap_factory=bad_factory, llm=FakeLLM())
    acc = _account(session_factory)
    assert acc.status == "error"
    assert acc.last_error == "连接失败"
    assert len(_emails(session_factory)) == 0


def _ok_result(title):
    """正常分类结果：不过滤、建任务。"""
    return {
        "filtered": False,
        "filter_reason": None,
        "title": title,
        "summary": "s",
        "category": "学业",
        "due_date": None,
        "actionable": True,
    }


def test_per_email_commit_survives_crash(session_factory):
    """第 3 封分类时模拟 worker 崩溃：前 2 封已逐封落盘，不随崩溃回滚。"""
    _seed_account(session_factory)
    imap = FakeImap()
    imap.mails = {
        1: make_raw(message_id="<m1>", subject="崩溃前1"),
        2: make_raw(message_id="<m2>", subject="崩溃前2"),
        3: make_raw(message_id="<m3>", subject="崩溃封"),
    }
    llm = FakeLLM(
        results=[_ok_result("任务1"), _ok_result("任务2"), _ok_result("任务3")],
        crash_subjects={"崩溃封"},
    )
    with pytest.raises(WorkerKilled):
        _run(session_factory, imap, llm)

    # 用全新 session 验证落盘状态，而非内存态
    with session_factory() as s:
        emails = {e.message_id: e for e in s.execute(select(Email)).scalars().all()}
        items = s.execute(select(Item)).scalars().all()
    assert emails["<m1>"].llm_state == "done"
    assert emails["<m2>"].llm_state == "done"
    assert emails["<m3>"].llm_state == "pending"  # 崩溃点之前未处理
    assert len(items) == 2  # 前 2 封的 Item 已在库中


def test_single_failure_does_not_affect_others(session_factory):
    """第 2 封分类失败标 error，第 1、3 封仍为 done 且各有 Item。"""
    _seed_account(session_factory)
    imap = FakeImap()
    imap.mails = {
        1: make_raw(message_id="<m1>", subject="正常1"),
        2: make_raw(message_id="<m2>", subject="失败封"),
        3: make_raw(message_id="<m3>", subject="正常3"),
    }
    llm = FakeLLM(
        results=[_ok_result("任务1"), _ok_result("任务2"), _ok_result("任务3")],
        fail_subjects={"失败封"},
    )
    _run(session_factory, imap, llm)

    with session_factory() as s:
        emails = {e.message_id: e for e in s.execute(select(Email)).scalars().all()}
        items = s.execute(select(Item)).scalars().all()
    assert emails["<m1>"].llm_state == "done"
    assert emails["<m2>"].llm_state == "error"
    assert "LLM 处理失败" in (emails["<m2>"].filter_reason or "")
    assert emails["<m3>"].llm_state == "done"
    assert len(items) == 2


def test_progress_logging_every_10_and_no_subject_leak(session_factory, caplog):
    """处理 25 封至少输出 2 条进度日志，且日志不包含任何邮件主题。"""
    _seed_account(session_factory)
    imap = FakeImap()
    imap.mails = {i: make_raw(message_id=f"<m{i}>", subject=f"机密主题{i}") for i in range(1, 26)}
    llm = FakeLLM(results=[_ok_result(f"任务{i}") for i in range(1, 26)])
    with caplog.at_level(logging.INFO, logger="rakkotasks.sync"):
        _run(session_factory, imap, llm)

    progress = [r.getMessage() for r in caplog.records if r.getMessage().startswith("分类进度")]
    assert len(progress) >= 2
    assert all("机密主题" not in (r.getMessage() or "") for r in caplog.records)
