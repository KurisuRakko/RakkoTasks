"""reclassify 命令测试：删任务、重置 LLM 状态、邮件本体保留、账户/用户隔离、确认交互。

全部离线：直接调用 cli._cmd_reclassify，使用临时 SQLite 文件库
（CLI 按 settings.database_path 自己开库，不能用内存库 fixture 播种）。
"""
from __future__ import annotations

import argparse
import io

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
    filtered/filter_reason/llm_state/item(含 detail_md)。
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


def _run(settings, user="sub-1", account=None):
    """以 --yes 方式执行 reclassify。"""
    args = argparse.Namespace(user=user, account=account, yes=True)
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
