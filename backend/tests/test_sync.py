"""单轮同步测试：FakeImap / FakeLLM 注入，不触网。"""
import json
import logging
from datetime import datetime
from email.message import EmailMessage

import pytest
from sqlalchemy import select

from app.archive import EmailArchive, archive_path, local_zone
from app.config import Settings
from app.models import Account, Email, Item, User
from app.sync import _process_pending, run_once


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


def make_raw_html_only(subject="主题", message_id="<m@example.com>", html="<p>正文</p>", sender="a@example.com"):
    """只有 text/html 分段的邮件（无 text/plain）：text_body 解析为空，正文在 html_body。"""
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = "me@example.com"
    msg["Date"] = "Tue, 26 Aug 2026 10:00:00 +0800"
    if message_id:
        msg["Message-ID"] = message_id
    msg.add_alternative(html, subtype="html")
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


def _user_message(messages: list[dict]) -> str:
    """取对话里最近一条 user 消息（详情流程首轮即 system + user 两条）。"""
    for m in reversed(messages):
        if m.get("role") == "user":
            return m.get("content") or ""
    raise AssertionError("无 user 消息")


def _subject_of(user_content: str) -> str:
    """从详情 prompt 的「主题：」行解析当前邮件主题（subject 内不会再有「主题：」前缀）。"""
    for line in user_content.splitlines():
        if line.startswith("主题："):
            return line[len("主题：") :]
    return ""


class FakeLLM:
    def __init__(self, results=None, raise_invalid=False, fail_subjects=(), crash_subjects=(),
                 detail_fail_subjects=(), detail_crash_subjects=()):
        self.results = list(results or [])
        self.raise_invalid = raise_invalid
        self.fail_subjects = set(fail_subjects)  # 命中的 subject 抛 ValueError（单封失败）
        self.crash_subjects = set(crash_subjects)  # 命中的 subject 抛 WorkerKilled（模拟崩溃）
        self.seen_infos: list[dict] = []  # 记录每次 classify_email 收到的 info
        self.seen_detail_messages: list[list[dict]] = []  # 记录每次详情生成的完整对话
        self.detail_fail_subjects = set(detail_fail_subjects)  # 详情生成失败（单条）
        self.detail_crash_subjects = set(detail_crash_subjects)  # 详情生成时崩溃

    def classify_email(self, info: dict) -> dict:
        self.seen_infos.append(info)
        if self.raise_invalid:
            raise ValueError("LLM 返回非法 JSON")
        subject = info.get("subject") or ""
        if subject in self.crash_subjects:
            raise WorkerKilled("worker 崩溃")
        if subject in self.fail_subjects:
            raise ValueError("单封处理失败")
        return self.results.pop(0)

    def chat_completion(self, messages, tools=None, json_mode=False):
        # 详情生成改为 agentic 对话后的最终回答：直接返回合法 JSON，
        # 成功/失败/崩溃按当前邮件 subject 区分（与旧 generate_detail 语义一致）
        self.seen_detail_messages.append(list(messages))
        subject = _subject_of(_user_message(messages))
        if subject in self.detail_crash_subjects:
            raise WorkerKilled("worker 崩溃")
        if subject in self.detail_fail_subjects:
            raise ValueError("详情生成失败")
        return {
            "role": "assistant",
            "content": json.dumps({"detail_md": f"详情：{subject}", "related": []}, ensure_ascii=False),
        }


def _run(session_factory, imap: FakeImap, llm: FakeLLM, settings: Settings | None = None):
    return run_once(session_factory, imap_factory=lambda a, s: imap, llm=llm, settings=settings)


def _archive_settings(tmp_path, zone: str = "Australia/Sydney") -> Settings:
    """开启原件归档的配置：根目录指向 tmp_path，时区固定便于算路径。"""
    return Settings(email_archive_dir=str(tmp_path), local_timezone=zone)


# make_raw 固定 Date: Tue, 26 Aug 2026 10:00:00 +0800 → parser 转成 naive UTC
_ARCHIVED_SENT_AT = datetime(2026, 8, 26, 2, 0, 0)


def _archived_path(tmp_path, settings: Settings, message_id: str, subject: str):
    """同步用的那封邮件应落到的归档路径（与实现同一套规则）。"""
    return archive_path(
        tmp_path, "t@example.com", message_id, subject, _ARCHIVED_SENT_AT, local_zone(settings.local_timezone)
    )


def _seed_account(sf) -> None:
    with sf() as s:
        s.add(User(sub="user-1"))
        s.commit()
        # app_password 必填：run_once 自 2026-09-06 起跳过无凭据账户（本轮需真实走 IMAP 路径）
        s.add(Account(user_sub="user-1", name="测试邮箱", kind="gmail", email="t@example.com",
                      app_password="app-pw", status="pending"))
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
    """处理 25 封至少输出 2 条分类进度与 2 条详情进度日志，且日志不包含任何邮件主题。"""
    _seed_account(session_factory)
    imap = FakeImap()
    imap.mails = {i: make_raw(message_id=f"<m{i}>", subject=f"机密主题{i}") for i in range(1, 26)}
    llm = FakeLLM(results=[_ok_result(f"任务{i}") for i in range(1, 26)])
    with caplog.at_level(logging.INFO, logger="rakkotasks.sync"):
        _run(session_factory, imap, llm)

    progress = [r.getMessage() for r in caplog.records if r.getMessage().startswith("分类进度")]
    assert len(progress) >= 2
    detail_progress = [r.getMessage() for r in caplog.records if r.getMessage().startswith("详情进度")]
    assert len(detail_progress) >= 2
    assert all("机密主题" not in (r.getMessage() or "") for r in caplog.records)


def test_html_only_email_body_extracted_for_llm(session_factory):
    """只有 html_body 的邮件：传给 FakeLLM 的 text_body 非空且含正文关键词（验收核心）。

    纯 HTML 邮件（无 text/plain 分段）占生产约四成；不回退时 LLM 只看到主题行。
    """
    _seed_account(session_factory)
    imap = FakeImap()
    imap.mails = {
        1: make_raw_html_only(message_id="<html1>", subject="纯HTML邮件", html="<p>请确认出席周五的评审会</p>"),
    }
    llm = FakeLLM(results=[_ok_result("评审会")])
    _run(session_factory, imap, llm)

    with session_factory() as s:
        email = s.execute(select(Email)).scalars().one()
    assert email.text_body == ""
    assert email.html_body  # 解析确认：正文只在 html
    info = llm.seen_infos[0]
    assert info["text_body"] and "评审会" in info["text_body"]
    assert "<" not in info["text_body"]  # 给 LLM 的是提取后的纯文本，不是 HTML 源码


def test_prefill_detail_html_only_body_fallback(session_factory):
    """只有 html_body 的邮件：详情预生成时传给 LLM 的正文非空且含正文关键词。

    预生成路径曾直接用 email.text_body，纯 HTML 邮件（约占生产四成）下为空，
    详情会基于空正文生成；此断言在修复前必须失败，防止旧分支合入时把回退改回去。
    """
    _seed_account(session_factory)
    imap = FakeImap()
    imap.mails = {
        1: make_raw_html_only(message_id="<html2>", subject="纯HTML详情", html="<p>请确认出席周五的评审会</p>"),
    }
    llm = FakeLLM(results=[_ok_result("评审会")])
    summary = _run(session_factory, imap, llm)

    with session_factory() as s:
        email = s.execute(select(Email)).scalars().one()
        item = s.execute(select(Item)).scalars().one()
    assert email.text_body == ""  # 解析确认：正文只在 html
    assert email.html_body
    assert item.detail_md  # 详情非空生成
    # 详情对话的 user 消息里正文来自 html 提取：含关键词、不含原始 HTML 标签
    content = _user_message(llm.seen_detail_messages[0])
    assert "请确认出席周五的评审会" in content
    assert "<p>" not in content
    assert summary["details"] == {"total": 1, "generated": 1, "failed": 0}


def _items(sf):
    with sf() as s:
        return s.execute(select(Item)).scalars().all()


def test_details_prefilled_after_classify(session_factory):
    """分类建出的条目在同一轮内预生成详情；被过滤的邮件无条目、不生成。"""
    _seed_account(session_factory)
    imap = FakeImap()
    imap.mails = {1: make_raw(message_id="<a1>", subject="促销"), 2: make_raw(message_id="<a2>", subject="交作业")}
    llm = FakeLLM(
        results=[
            {"filtered": True, "filter_reason": "广告营销", "title": "", "summary": "",
             "category": "", "due_date": None, "actionable": False},
            _ok_result("交作业"),
        ]
    )
    summary = _run(session_factory, imap, llm)

    items = _items(session_factory)
    assert len(items) == 1
    assert items[0].detail_md == "详情：交作业"
    assert summary["details"] == {"total": 1, "generated": 1, "failed": 0}


def test_detail_backfill_fills_null_and_keeps_cached(session_factory):
    """历史回填：detail_md 为 NULL 的旧条目补生成，已缓存的不重新生成。"""
    _seed_account(session_factory)
    imap = FakeImap()
    imap.mails = {1: make_raw(message_id="<old1>", subject="旧任务甲"), 2: make_raw(message_id="<old2>", subject="旧任务乙")}
    _run(session_factory, imap, FakeLLM(results=[_ok_result("甲"), _ok_result("乙")]))
    with session_factory() as s:
        # 制造历史状态：甲的详情清空（如预生成上线前建的），乙已有缓存
        items = {i.email.subject: i for i in s.execute(select(Item)).scalars().all()}
        items["旧任务甲"].detail_md = None
        items["旧任务乙"].detail_md = "**旧缓存**"
        s.commit()

    summary = _run(session_factory, imap, FakeLLM())  # 无新邮件的一轮

    with session_factory() as s:
        items = {i.email.subject: i for i in s.execute(select(Item)).scalars().all()}
    assert items["旧任务甲"].detail_md == "详情：旧任务甲"
    assert items["旧任务乙"].detail_md == "**旧缓存**"
    assert summary["details"] == {"total": 1, "generated": 1, "failed": 0}


def test_detail_failure_skips_and_retries_next_round(session_factory):
    """单条详情失败不影响其余条目，detail_md 保持 NULL 由下轮重试补齐。"""
    _seed_account(session_factory)
    imap = FakeImap()
    imap.mails = {1: make_raw(message_id="<d1>", subject="失败封"), 2: make_raw(message_id="<d2>", subject="正常封")}
    llm = FakeLLM(
        results=[_ok_result("任务1"), _ok_result("任务2")],
        detail_fail_subjects={"失败封"},
    )
    summary = _run(session_factory, imap, llm)

    with session_factory() as s:
        items = {i.email.subject: i for i in s.execute(select(Item)).scalars().all()}
    assert items["失败封"].detail_md is None
    assert items["正常封"].detail_md == "详情：正常封"
    assert summary["details"] == {"total": 2, "generated": 1, "failed": 1}

    # 下轮失败原因消失：NULL 的条目被重试补齐
    summary = _run(session_factory, imap, FakeLLM())
    with session_factory() as s:
        items = {i.email.subject: i for i in s.execute(select(Item)).scalars().all()}
    assert items["失败封"].detail_md == "详情：失败封"
    assert summary["details"] == {"total": 1, "generated": 1, "failed": 0}


def test_detail_per_item_commit_survives_crash(session_factory):
    """详情生成中途崩溃：已生成的详情逐条落盘，不随崩溃回滚。

    预生成按条目新→旧执行：id 较大的「先成功」先生成并提交，
    随后「崩溃封」触发崩溃，验证已提交的详情保留。
    """
    _seed_account(session_factory)
    imap = FakeImap()
    imap.mails = {1: make_raw(message_id="<c1>", subject="崩溃封"), 2: make_raw(message_id="<c2>", subject="先成功")}
    llm = FakeLLM(
        results=[_ok_result("任务1"), _ok_result("任务2")],
        detail_crash_subjects={"崩溃封"},
    )
    with pytest.raises(WorkerKilled):
        _run(session_factory, imap, llm)

    with session_factory() as s:
        items = {i.email.subject: i for i in s.execute(select(Item)).scalars().all()}
    assert items["先成功"].detail_md == "详情：先成功"  # id 较大，先处理并已落盘
    assert items["崩溃封"].detail_md is None


def test_archive_stores_raw_message_bytes(session_factory, tmp_path):
    """归档开启：新邮件在本地日期目录下写出 .eml，字节与 IMAP 给的 raw 完全一致。"""
    _seed_account(session_factory)
    imap = FakeImap()
    raw = make_raw(message_id="<arch1>", subject="归档主题")
    imap.mails = {1: raw}
    settings = _archive_settings(tmp_path)

    summary = _run(session_factory, imap, FakeLLM(results=[_ok_result("任务")]), settings)

    path = _archived_path(tmp_path, settings, "<arch1>", "归档主题")
    assert path.parent.name == "2026-08-26"  # UTC 02:00 → 悉尼 12:00，同日
    assert path.name.startswith("120000_归档主题_")
    assert path.read_bytes() == raw
    assert summary["archive"] == {"written": 1, "failed": 0, "discarded": 0}


def test_archive_discards_filtered_mail_but_keeps_tasks(session_factory, tmp_path):
    """被过滤的邮件原件被删；进入待办与 LLM 失败的都保留。"""
    _seed_account(session_factory)
    imap = FakeImap()
    imap.mails = {
        1: make_raw(message_id="<filtered>", subject="促销邮件"),
        2: make_raw(message_id="<real>", subject="交作业"),
        3: make_raw(message_id="<broken>", subject="失败封"),
    }
    llm = FakeLLM(
        results=[
            {"filtered": True, "filter_reason": "广告营销", "title": "", "summary": "",
             "category": "", "due_date": None, "actionable": False},
            _ok_result("交作业"),
        ],
        fail_subjects={"失败封"},
    )
    settings = _archive_settings(tmp_path)

    summary = _run(session_factory, imap, llm, settings)

    assert not _archived_path(tmp_path, settings, "<filtered>", "促销邮件").exists()
    assert _archived_path(tmp_path, settings, "<real>", "交作业").exists()
    assert _archived_path(tmp_path, settings, "<broken>", "失败封").exists()
    assert summary["archive"] == {"written": 3, "failed": 0, "discarded": 1}

    with session_factory() as s:
        emails = {e.message_id: e for e in s.execute(select(Email)).scalars().all()}
    assert emails["<filtered>"].filtered is True  # 邮件记录仍在库中，删的只是原件文件
    assert emails["<broken>"].llm_state == "error"


def test_archive_disabled_by_default_writes_nothing(session_factory, tmp_path):
    """归档关闭（配置留空）：磁盘不落任何文件，summary 里也不出现 archive 键。"""
    _seed_account(session_factory)
    imap = FakeImap()
    imap.mails = {1: make_raw(message_id="<off1>", subject="不归档")}
    settings = Settings(email_archive_dir="", local_timezone="Australia/Sydney")

    summary = _run(session_factory, imap, FakeLLM(results=[_ok_result("任务")]), settings)

    assert list(tmp_path.rglob("*")) == []
    assert "archive" not in summary
    assert len(_emails(session_factory)) == 1  # 关掉归档不影响入库


def test_archive_write_failure_does_not_break_sync(session_factory, tmp_path):
    """归档根目录不可用（普通文件）时：邮件照常入库、账户仍 ok、failed 计数 +1。"""
    _seed_account(session_factory)
    blocker = tmp_path / "blocker"
    blocker.write_bytes(b"")
    imap = FakeImap()
    imap.mails = {1: make_raw(message_id="<fail1>", subject="归档失败")}
    settings = Settings(email_archive_dir=str(blocker), local_timezone="Australia/Sydney")

    summary = _run(session_factory, imap, FakeLLM(results=[_ok_result("任务")]), settings)

    assert summary["accounts"]["t@example.com"] == {"status": "ok", "error": None}
    assert summary["archive"] == {"written": 0, "failed": 1, "discarded": 0}
    with session_factory() as s:
        assert [e.message_id for e in s.execute(select(Email)).scalars().all()] == ["<fail1>"]
    assert _account(session_factory).last_uid == 1  # 游标照常推进


def _filtered_result():
    """LLM 判为过滤（不建待办）的分类结果。"""
    return {"filtered": True, "filter_reason": "广告营销", "title": "", "summary": "",
            "category": "", "due_date": None, "actionable": False}


def _seed_pending_email(session) -> Email:
    """直接塞一封 pending 邮件（不经 IMAP），供 _process_pending 单独驱动。"""
    session.add(User(sub="user-1"))
    session.add(Account(user_sub="user-1", name="测试邮箱", kind="gmail", email="t@example.com",
                        app_password="app-pw", status="pending"))
    session.commit()
    account_id = session.execute(select(Account)).scalars().one().id
    email = Email(account_id=account_id, message_id="<pending1>", subject="促销邮件",
                  sender="a@example.com", recipients="me@example.com",
                  sent_at=_ARCHIVED_SENT_AT, text_body="正文", html_body=None,
                  attachments_json="[]", llm_state="pending")
    session.add(email)
    session.commit()
    return email


def _row(session_factory, message_id: str) -> Email:
    with session_factory() as s:
        return s.execute(select(Email).where(Email.message_id == message_id)).scalars().one()


def test_commit_failure_keeps_archived_original(session_factory, tmp_path, monkeypatch):
    """提交失败（rollback 后改标 error）时原件必须留着：过滤标记没落库，删了就永久丢了。"""
    archive = EmailArchive(tmp_path, local_zone("Australia/Sydney"))
    with session_factory() as session:
        _seed_pending_email(session)
        archive.store("t@example.com", "<pending1>", "促销邮件", _ARCHIVED_SENT_AT, b"raw-bytes")
        path = archive_path(tmp_path, "t@example.com", "<pending1>", "促销邮件",
                            _ARCHIVED_SENT_AT, archive.zone)
        assert path.exists()

        original = session.commit
        calls = []

        def flaky_commit():
            calls.append(1)
            if len(calls) == 1:
                raise RuntimeError("约束冲突")
            return original()

        monkeypatch.setattr(session, "commit", flaky_commit)
        rows = session.execute(select(Email).where(Email.llm_state == "pending")).scalars().all()
        _process_pending(session, FakeLLM(results=[_filtered_result()]), rows, archive=archive)

    assert len(calls) == 2  # 第一次失败，第二次把 error 标记提交成功
    row = _row(session_factory, "<pending1>")
    assert row.llm_state == "error"
    assert row.filtered is False
    assert path.exists()  # 原件未被删
    assert archive.summary() == {"written": 1, "failed": 0, "discarded": 0}


class FlakyFetchImap(FakeImap):
    """第 2 个 UID 第一次拉取时抛异常：模拟单封失败导致整批回滚。"""

    def __init__(self, uidvalidity: int = 1):
        super().__init__(uidvalidity)
        self.fail_once = False

    def fetch_uid(self, uid: int) -> bytes:
        if uid == 2 and not self.fail_once:
            self.fail_once = True
            raise RuntimeError("拉取第 2 封失败")
        return super().fetch_uid(uid)


def test_rollback_then_refetch_reuses_same_archive_file(session_factory, tmp_path):
    """整批回滚后下轮重拉同一批 UID：同 message_id 覆盖同一路径，不多出副本也不留 .tmp。"""
    _seed_account(session_factory)
    mails = {1: make_raw(message_id="<r1>", subject="回滚封"), 2: make_raw(message_id="<r2>", subject="触发封")}
    settings = _archive_settings(tmp_path)
    first = FlakyFetchImap()
    first.mails = dict(mails)

    summary = _run(session_factory, first, FakeLLM(), settings)

    assert summary["accounts"]["t@example.com"]["status"] == "error"
    assert len(list(tmp_path.rglob("*.eml"))) == 1  # 第 1 封的原件已落盘
    assert _emails(session_factory) == []  # 但整批回滚，库里没有行

    second = FakeImap()
    second.mails = dict(mails)
    _run(session_factory, second, FakeLLM(results=[_ok_result("任务1"), _ok_result("任务2")]), settings)

    assert len(_emails(session_factory)) == 2
    assert len(list(tmp_path.rglob("*.eml"))) == 2  # 第 1 封被覆盖，不是又多一份
    assert not list(tmp_path.rglob("*.tmp"))


def test_dedup_hit_does_not_rewrite_existing_archive(session_factory, tmp_path):
    """UIDVALIDITY 变化导致重拉同一批 UID 时命中去重，不再写盘。"""
    _seed_account(session_factory)
    imap = FakeImap(uidvalidity=5)
    imap.mails = {1: make_raw(message_id="<d1>", subject="第一封"), 2: make_raw(message_id="<d2>", subject="第二封")}
    settings = _archive_settings(tmp_path)

    first = _run(session_factory, imap, FakeLLM(results=[_ok_result("任务1"), _ok_result("任务2")]), settings)
    assert first["archive"]["written"] == 2
    files = sorted(p.name for p in tmp_path.rglob("*.eml"))
    assert len(files) == 2

    imap.uidvalidity = 99  # 游标重置 → 全量回补 → 两封都被 (account_id, message_id) 去重
    second = _run(session_factory, imap, FakeLLM(), settings)

    assert second["archive"]["written"] == 0
    assert sorted(p.name for p in tmp_path.rglob("*.eml")) == files
    assert len(_emails(session_factory)) == 2
