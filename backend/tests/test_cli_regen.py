"""regen-details 命令测试：置空详情与关联邮件、账户/用户隔离、确认交互。

全部离线：直接调用 cli._cmd_regen_details，使用临时 SQLite 文件库
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
    """建一个用户及其账户/邮件/任务（邮件描述支持 message_id/subject/item(含 detail_md/related_json)）。"""
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
                    llm_state="done",
                )
                s.add(em)
                s.flush()
                if e.get("item"):
                    s.add(
                        Item(
                            email_id=em.id,
                            title=e["item"]["title"],
                            summary=e["item"].get("summary", ""),
                            category="其他",
                            status="open",
                            detail_md=e["item"].get("detail_md"),
                            related_json=e["item"].get("related_json"),
                        )
                    )
        s.commit()


def _item_of(settings: Settings, user_sub: str) -> Item:
    with _sf(settings)() as s:
        return s.execute(select(Item).join(Email).join(Account).where(Account.user_sub == user_sub)).scalars().one()


def _run(settings, user="sub-1", account=None):
    args = argparse.Namespace(user=user, account=account, yes=True)
    cli._cmd_regen_details(args, settings)


def test_regen_details_resets_only_target_user(tmp_path):
    """用户 A 的条目 detail_md/related_json 置 NULL；B 的条目原样保留。"""
    settings = _settings(tmp_path)
    init_db(make_engine(settings.database_path))
    _seed_user(
        settings,
        "user-A",
        {
            "a@example.com": [
                {"message_id": "<a1>", "subject": "A 主题", "body": "A 正文",
                 "item": {"title": "A 任务", "detail_md": "**A 详情**", "related_json": '[{"email_id": 1, "reason": "背景"}]'}},
            ],
        },
    )
    _seed_user(
        settings,
        "user-B",
        {
            "b@example.com": [
                {"message_id": "<b1>", "subject": "B 主题", "body": "B 正文",
                 "item": {"title": "B 任务", "detail_md": "**B 详情**", "related_json": '[{"email_id": 2, "reason": "B 背景"}]'}},
            ],
        },
    )
    _run(settings, user="user-A")

    item_a = _item_of(settings, "user-A")
    item_b = _item_of(settings, "user-B")
    assert item_a.detail_md is None
    assert item_a.related_json is None
    assert item_b.detail_md == "**B 详情**"
    assert item_b.related_json == '[{"email_id": 2, "reason": "B 背景"}]'


def test_regen_details_account_scope(tmp_path):
    """给 --account 时只重置该账户的条目，其它账户不受影响。"""
    settings = _settings(tmp_path)
    init_db(make_engine(settings.database_path))
    _seed_user(
        settings,
        "user-A",
        {
            "a@example.com": [
                {"message_id": "<a1>", "item": {"title": "A 任务", "detail_md": "**A**", "related_json": "[]"}},
            ],
            "b@example.com": [
                {"message_id": "<b1>", "item": {"title": "B 任务", "detail_md": "**B**", "related_json": "[]"}},
            ],
        },
    )
    _run(settings, user="user-A", account="b@example.com")

    with _sf(settings)() as s:
        items = {i.title: i for i in s.execute(select(Item)).scalars().all()}
    assert items["A 任务"].detail_md == "**A**"  # a@example.com 未动
    assert items["B 任务"].detail_md is None  # b@example.com 已重置
    assert items["B 任务"].related_json is None


def test_regen_details_without_yes_and_non_yes_stdin_aborts(tmp_path, monkeypatch):
    """未给 --yes 且 stdin 输入非 yes：不做任何修改并退出码非 0。"""
    settings = _settings(tmp_path)
    init_db(make_engine(settings.database_path))
    _seed_user(
        settings,
        "user-A",
        {"a@example.com": [{"message_id": "<a1>", "item": {"title": "A 任务", "detail_md": "**A**"}}]},
    )
    args = argparse.Namespace(user="user-A", account=None, yes=False)
    monkeypatch.setattr("sys.stdin", io.StringIO("no\n"))
    with pytest.raises(SystemExit) as exc:
        cli._cmd_regen_details(args, settings)
    assert exc.value.code != 0

    item_a = _item_of(settings, "user-A")
    assert item_a.detail_md == "**A**"
    assert item_a.related_json is None  # 原样（本就没设置）


def test_regen_details_unknown_account_exits_2(tmp_path):
    """--account 指向不存在的账户：退出码 2，不做任何修改。"""
    settings = _settings(tmp_path)
    init_db(make_engine(settings.database_path))
    _seed_user(
        settings,
        "user-A",
        {"a@example.com": [{"message_id": "<a1>", "item": {"title": "A 任务", "detail_md": "**A**"}}]},
    )
    args = argparse.Namespace(user="user-A", account="nobody@example.com", yes=True)
    with pytest.raises(SystemExit) as exc:
        cli._cmd_regen_details(args, settings)
    assert exc.value.code == 2
    assert _item_of(settings, "user-A").detail_md == "**A**"
