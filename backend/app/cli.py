"""账户 CLI：python -m app.cli accounts add/connect/list。"""
from __future__ import annotations

import argparse
import sys

from sqlalchemy import select

from app.config import Settings, get_settings
from app.db import init_db, make_engine, make_session_factory
from app.models import Account


def _cmd_accounts_add(args: argparse.Namespace, settings: Settings) -> None:
    if args.kind not in ("gmail", "microsoft"):
        print(f"错误：kind 必须是 gmail 或 microsoft，收到 {args.kind!r}", file=sys.stderr)
        sys.exit(2)
    engine = make_engine(settings.database_path)
    init_db(engine)
    with make_session_factory(engine)() as session:
        existing = session.execute(
            select(Account).where(Account.email == args.email, Account.kind == args.kind)
        ).first()
        if existing:
            print(f"账户已存在：{args.email}（kind={args.kind}）")
            return
        account = Account(
            name=args.name,
            kind=args.kind,
            email=args.email,
            ms_client_id=args.client_id,
            status="pending",
        )
        session.add(account)
        session.commit()
        print(f"已添加账户 #{account.id}：{account.name} <{account.email}>（{account.kind}）")
    if args.kind == "microsoft":
        print("提示：请运行 `python -m app.cli accounts connect <email>` 完成 OAuth 授权。")


def _cmd_accounts_connect(args: argparse.Namespace, settings: Settings) -> None:
    from app.imap import mstoken

    engine = make_engine(settings.database_path)
    init_db(engine)
    with make_session_factory(engine)() as session:
        account = session.execute(select(Account).where(Account.email == args.email)).scalars().first()
        if account is None:
            print(f"错误：未找到账户 {args.email}", file=sys.stderr)
            sys.exit(2)
        if account.kind != "microsoft":
            print(f"错误：账户 {args.email} 类型为 {account.kind}，仅 microsoft 需要 connect", file=sys.stderr)
            sys.exit(2)
        flow = mstoken.initiate_device_flow(account, settings)
        print(flow["message"])
        result = mstoken.wait_for_device_completion(account, flow["_flow"], settings)
        account.status = "ok"
        account.last_error = None
        session.commit()
        print(f"授权完成：{account.email}，token 已保存（expires_in={result.get('expires_in')}s）")


def _cmd_accounts_list(args: argparse.Namespace, settings: Settings) -> None:  # noqa: ARG001
    engine = make_engine(settings.database_path)
    init_db(engine)
    with make_session_factory(engine)() as session:
        accounts = session.execute(select(Account).order_by(Account.id)).scalars().all()
        if not accounts:
            print("（暂无账户，用 `accounts add` 添加）")
            return
        header = f"{'name':<16} {'kind':<10} {'email':<36} {'status':<9} last_sync"
        print(header)
        print("-" * len(header))
        for a in accounts:
            last_sync = a.last_sync_at.isoformat() if a.last_sync_at else "-"
            print(f"{a.name:<16} {a.kind:<10} {a.email:<36} {a.status:<9} {last_sync}")


def main() -> None:
    settings = get_settings()
    parser = argparse.ArgumentParser(prog="python -m app.cli", description="RakkoTasks 账户管理")
    sub = parser.add_subparsers(dest="command", required=True)

    accounts = sub.add_parser("accounts", help="账户管理")
    accounts_sub = accounts.add_subparsers(dest="action", required=True)

    add = accounts_sub.add_parser("add", help="添加账户")
    add.add_argument("--kind", required=True, choices=["gmail", "microsoft"])
    add.add_argument("--name", required=True, help="显示名")
    add.add_argument("--email", required=True, help="邮箱地址")
    add.add_argument("--client-id", dest="client_id", default=None, help="微软 OAuth client id（默认官方公共客户端）")
    add.set_defaults(handler=_cmd_accounts_add)

    connect = accounts_sub.add_parser("connect", help="微软账户 OAuth 授权（device code flow）")
    connect.add_argument("email", help="邮箱地址")
    connect.set_defaults(handler=_cmd_accounts_connect)

    lst = accounts_sub.add_parser("list", help="列出账户")
    lst.set_defaults(handler=_cmd_accounts_list)

    args = parser.parse_args()
    args.handler(args, settings)


if __name__ == "__main__":
    main()
