"""reclassify 命令测试：删任务、重置 LLM 状态、邮件本体保留、账户/用户隔离、确认交互、--last 限量。

全部离线：直接调用 cli._cmd_reclassify，使用临时 SQLite 文件库
（CLI 按 settings.database_path 自己开库，不能用内存库 fixture 播种）。
"""
from __future__ import annotations

import argparse
import io
from datetime import datetime, timedelta

import pytest
from sqlalchemy import select

from app import cli
from app.config import Settings
from app.db import init_db, make_engine, make_session_factory
from app.models import Account, Email, Item, User


def _settings(tmp_path) -> Settings:
    return Settings(database_path=str(tmp_path / "rk.db"))


def _sf(settings: Settings):
    return make_session_factory(make_engine(settings.database_path))


def _seed_user(settings: Settings, sub: str, accounts: dict[str, list[dict]]) -> None:
    """建一个用户及其账户/邮件/任务。

    accounts: {账户邮箱: [邮件描述 dict, ...]}；邮件描述支持 message_id/subject/body/
    sent_at/filtered/filter_reason/llm_state/item(含 detail_md)。
    """
    with _sf(settings)() as s:
        s.add(User(sub=sub, email=f"{sub}@x.com"))
        s.flush()
        for acc_email, emails in accounts.items():
            acc = Account(user_sub=sub, name="邮箱", kind="gmail", email=acc_email, status="ok")
            s.add(acc)
            s.flush()
            for e in emails:
                em = Email(
                    account_id=acc.id,
                    message_id=e["message_id"],
                    subject=e.get("subject", "主题"),
                    text_body=e.get("body", "正文"),
                    sent_at=e.get("sent_at"),
                    llm_state=e.get("llm_state", "done"),
                    filtered=e.get("filtered", False),
                    filter_reason=e.get("filter_reason"),
                )
                s.add(em)
                s.flush()
                if e.get("item"):
                    s.add(
                        Item(
                            email_id=em.id,
                            title=e["item"]["title"],
                            summary=e["item"].get("summary", ""),
                            category=e["item"].get("category", "其他"),
                            status="open",
                            detail_md=e["item"].get("detail_md"),
                        )
                    )
        s.commit()


def _run(settings, user="sub-1", account=None, last=None):
    """以 --yes 方式执行 reclassify。"""
    args = argparse.Namespace(user=user, account=account, yes=True, last=last)
    cli._cmd_reclassify(args, settings)


def test_reclassify_resets_state_and_deletes_items_keeps_email(tmp_path):
    """删任务、状态重置为 pending/filtered=False/filter_reason=None，且邮件本体仍在。"""
    settings = _settings(tmp_path)
    init_db(make_engine(settings.database_path))
    _seed_user(
        settings,
        "sub-1",
        {
            "a@example.com": [
                # 已生成任务（带缓存详情）的邮件
                {"message_id": "<m1>", "subject": "交作业", "body": "周五前交",
                 "item": {"title": "交作业", "detail_md": "**缓存详情**"}},
                # 旧规则下被过滤的邮件
                {"message_id": "<m2>", "subject": "图书馆座位确认", "body": "已确认预订",
                 "filtered": True, "filter_reason": "旧规则判定"},
            ],
        },
    )
    _run(settings)

    with _sf(settings)() as s:
        assert s.execute(select(Item)).scalars().all() == []  # 任务（含 detail_md）随 item 删除
        emails = {e.message_id: e for e in s.execute(select(Email)).scalars().all()}
        assert len(emails) == 2
        # 邮件本体未动
        assert emails["<m1>"].subject == "交作业"
        assert emails["<m1>"].text_body == "周五前交"
        # 状态全部重置
        for e in emails.values():
            assert e.llm_state == "pending"
            assert e.filtered is False
            assert e.filter_reason is None


def test_reclassify_account_scope_only_affects_given_account(tmp_path):
    """给 --account 时只重置该账户，其它账户的邮件与任务不受影响。"""
    settings = _settings(tmp_path)
    init_db(make_engine(settings.database_path))
    _seed_user(
        settings,
        "sub-1",
        {
            "a@example.com": [
                {"message_id": "<a1>", "item": {"title": "A 任务"}},
                {"message_id": "<a2>", "filtered": True, "filter_reason": "广告"},
            ],
            "b@example.com": [
                {"message_id": "<b1>", "item": {"title": "B 任务"}},
                {"message_id": "<b2>", "filtered": True, "filter_reason": "广告"},
            ],
        },
    )
    _run(settings, account="b@example.com")

    with _sf(settings)() as s:
        emails = {e.message_id: e for e in s.execute(select(Email)).scalars().all()}
        item_email_ids = {i.email_id for i in s.execute(select(Item)).scalars().all()}
        # B 账户被重置、任务被删
        assert emails["<b1>"].llm_state == "pending"
        assert emails["<b1>"].id not in item_email_ids
        assert emails["<b2>"].filtered is False
        assert emails["<b2>"].filter_reason is None
        # A 账户原样保留
        assert emails["<a1>"].llm_state == "done"
        assert emails["<a1>"].id in item_email_ids
        assert emails["<a2>"].filtered is True
        assert emails["<a2>"].filter_reason == "广告"


def test_reclassify_user_isolation(tmp_path):
    """用户 A 执行 reclassify 不得影响用户 B 的任何邮件或任务。"""
    settings = _settings(tmp_path)
    init_db(make_engine(settings.database_path))
    _seed_user(
        settings,
        "user-A",
        {"a@example.com": [{"message_id": "<a1>", "item": {"title": "A 任务"}}]},
    )
    _seed_user(
        settings,
        "user-B",
        {
            "b@example.com": [
                {"message_id": "<b1>", "item": {"title": "B 任务"}},
                {"message_id": "<b2>", "filtered": True, "filter_reason": "广告"},
            ],
        },
    )
    _run(settings, user="user-A")

    with _sf(settings)() as s:
        items = s.execute(select(Item)).scalars().all()
        assert [i.title for i in items] == ["B 任务"]  # A 的任务被删，B 的保留
        a = {
            e.message_id: e
            for e in s.execute(
                select(Email).join(Account).where(Account.user_sub == "user-A")
            ).scalars().all()
        }
        b = {
            e.message_id: e
            for e in s.execute(
                select(Email).join(Account).where(Account.user_sub == "user-B")
            ).scalars().all()
        }
        assert a["<a1>"].llm_state == "pending"  # A 已重置
        assert b["<b1>"].llm_state == "done"  # B 原样
        assert b["<b2>"].filtered is True
        assert b["<b2>"].filter_reason == "广告"


def test_reclassify_without_yes_and_non_yes_stdin_aborts(tmp_path, monkeypatch):
    """未给 --yes 且 stdin 输入非 yes：不做任何修改并退出码非 0。"""
    settings = _settings(tmp_path)
    init_db(make_engine(settings.database_path))
    _seed_user(
        settings,
        "sub-1",
        {"a@example.com": [{"message_id": "<m1>", "item": {"title": "任务"}}]},
    )
    args = argparse.Namespace(user="sub-1", account=None, yes=False)
    monkeypatch.setattr("sys.stdin", io.StringIO("no\n"))
    with pytest.raises(SystemExit) as exc:
        cli._cmd_reclassify(args, settings)
    assert exc.value.code != 0

    with _sf(settings)() as s:
        emails = s.execute(select(Email)).scalars().all()
        assert len(emails) == 1
        assert emails[0].llm_state == "done"  # 未做任何修改
        assert len(s.execute(select(Item)).scalars().all()) == 1


def _five_mails(prefix: str, base: datetime) -> list[dict]:
    """一个账户的 5 封邮件：sent_at 递增（第 3 封为 NULL），每封都有任务。"""
    mails = []
    for i in range(1, 6):
        mails.append(
            {
                "message_id": f"<{prefix}{i}>",
                "sent_at": None if i == 3 else base + timedelta(days=i),
                "item": {"title": f"{prefix}{i}"},
            }
        )
    return mails


def test_reclassify_last_takes_recent_n_per_account(tmp_path):
    """--last N 按账户分别取：每账户恰好重置最近 N 封（sent_at 倒序，NULL 不入选）并删其任务。

    两个账户发送时间完全错开（B 全在 A 之后）：若误按全用户取最近 N 封，
    会只剩 B 账户的邮件被选中，这里要求 A、B 各选中 2 封。
    """
    settings = _settings(tmp_path)
    init_db(make_engine(settings.database_path))
    _seed_user(
        settings,
        "sub-1",
        {
            "a@example.com": _five_mails("a", datetime(2025, 1, 1)),
            "b@example.com": _five_mails("b", datetime(2025, 2, 1)),
        },
    )
    _run(settings, last=2)

    with _sf(settings)() as s:
        emails = {e.message_id: e for e in s.execute(select(Email)).scalars().all()}
        item_email_ids = {i.email_id for i in s.execute(select(Item)).scalars().all()}
        assert len(item_email_ids) == 6  # 每账户 5 删 2，共剩 6
        for prefix in ("a", "b"):
            for n in range(1, 6):
                mid = f"<{prefix}{n}>"
                em = emails[mid]
                if n in (4, 5):  # sent_at 最新的两封（第 3 封 sent_at 为 NULL，不入选）
                    assert em.llm_state == "pending"
                    assert em.id not in item_email_ids  # 选中邮件的任务被删
                else:
                    assert em.llm_state == "done"  # 其余邮件原样
                    assert em.id in item_email_ids  # 其余任务保留


def test_reclassify_last_zero_rejected(tmp_path):
    """--last 0：报错退出，退出码 2，且不改任何数据。"""
    settings = _settings(tmp_path)
    init_db(make_engine(settings.database_path))
    _seed_user(
        settings,
        "sub-1",
        {"a@example.com": [{"message_id": "<m1>", "item": {"title": "任务"}}]},
    )
    args = argparse.Namespace(user="sub-1", account=None, yes=True, last=0)
    with pytest.raises(SystemExit) as exc:
        cli._cmd_reclassify(args, settings)
    assert exc.value.code == 2

    with _sf(settings)() as s:
        emails = s.execute(select(Email)).scalars().all()
        assert len(emails) == 1
        assert emails[0].llm_state == "done"  # 未做任何修改
        assert len(s.execute(select(Item)).scalars().all()) == 1
