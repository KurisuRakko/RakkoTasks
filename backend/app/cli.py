"""账户与用户 CLI：python -m app.cli accounts add/connect/auth-url/auth-code/list/set-password/remove、users list、reclassify、regen-details、archive-backfill。

accounts 子命令（connect 除外）复用 app/accounts.py 服务层，与网页 /api/accounts* 语义一致；
网页已提供自助管理，CLI 保留为运维兜底。Gmail 应用专用密码仅经 getpass 交互录入，
绝不进命令行参数或日志。
"""
from __future__ import annotations

import argparse
import sys

from sqlalchemy import func, select

from app import accounts
from app.auth import find_user_by_spec
from app.config import Settings, get_settings
from app.db import init_db, make_engine, make_session_factory
from app.models import Account, Email, Item, User

# AccountError code → 中文说明（_die_account_error 统一打到 stderr；auth_failed 的
# 分 kind 详细提示另见 _print_auth_failure，此处只是总括句）
_ACCOUNT_ERR_TEXT = {
    "bad_kind": "不支持的账户类型（仅支持 gmail / microsoft）",
    "bad_name": "账户名称需为 1-128 个字符",
    "bad_email": "邮箱地址无效（需包含 @ 且不超过 256 个字符）",
    "password_required": "应用专用密码不能为空",
    "account_exists": "该邮箱账户已存在（含已停用账户）",
    "invalid_kind": "账户类型与操作不匹配（应用专用密码仅 gmail；OAuth 授权仅 microsoft）",
    "bad_redirect": "不支持的 OAuth 重定向地址",
    "bad_request": "请求参数无效",
    "no_pending_flow": "未找到进行中的授权流程，请先运行 accounts auth-url",
    "auth_failed": "微软 OAuth 授权失败",
}
# 流程类错误退出码沿用 1（授权流程可重试）；参数/校验类沿用 2
_FLOW_ERROR_CODES = frozenset({"no_pending_flow", "bad_request", "auth_failed"})


def _resolve_user(session, spec: str) -> User:
    """按 --user 取值解析用户：先精确匹配 users.sub，再精确匹配 users.email。

    find_user_by_spec 对歧义邮箱返回 None（它的契约），这里补一次查询把
    「同一邮箱对应多个用户」与「真没找到」区分开提示；两者都以退出码 1
    结束（用户需先登录网页才能被 CLI 管理）。
    """
    user = find_user_by_spec(session, spec)
    if user is None:
        dup = session.execute(select(User).where(User.email == spec)).scalars().all()
        if len(dup) > 1:
            subs = ", ".join(u.sub for u in dup)
            print(f"错误：邮箱 {spec} 对应多个用户，请改用 sub 精确指定：{subs}", file=sys.stderr)
        else:
            print(f"未找到用户 {spec}；该用户需要先登录一次网页，再用 users list 查看", file=sys.stderr)
        sys.exit(1)
    return user


def _dt(s: object) -> str:
    return s.strftime("%Y-%m-%d %H:%M:%S") if s else "-"


def _cmd_users_list(args: argparse.Namespace, settings: Settings) -> None:  # noqa: ARG001
    engine = make_engine(settings.database_path)
    init_db(engine)
    with make_session_factory(engine)() as session:
        users = session.execute(select(User).order_by(User.created_at)).scalars().all()
        if not users:
            print("（暂无用户；用户首次登录网页后自动创建）")
            return
        header = f"{'sub':<28} {'name':<14} {'email':<40} {'首次登录':<20} {'最近活跃':<20} 账户数"
        print(header)
        print("-" * len(header))
        for u in users:
            count = session.execute(
                select(func.count(Account.id)).where(Account.user_sub == u.sub)
            ).scalar() or 0
            print(
                f"{u.sub:<28} {(u.name or '-'):<14} {(u.email or '-'):<40} "
                f"{_dt(u.created_at):<20} {_dt(u.last_seen_at):<20} {count}"
            )


def _require_account(session, user: User, email: str) -> Account:
    """CLI 按邮箱寻址（服务层按 id）：一条 select 精确找该用户的账户，找不到 exit 2。"""
    account = accounts.get_account_by_email(session, user.sub, email)
    if account is None:
        print(f"错误：未找到账户 {email}（用户 {user.sub}）", file=sys.stderr)
        sys.exit(2)
    return account


def _print_auth_failure(kind: str, detail: str, sub: str | None = None, email: str | None = None) -> None:
    """auth_failed 按 kind 给中文提示（含可复制的重试命令），输出 stdout，与授权码流程既有文案一致。"""
    if kind == "expired":
        print("授权流程已过期：授权码未在有效期内使用，请重新生成授权链接。")
        if sub and email:
            _print_auth_url_retry(sub, email)
    elif kind == "declined":
        if sub and email:
            _print_auth_url_retry(sub, email)
        print("授权被拒绝：你在微软页面上点了拒绝。如需继续，请重新生成授权链接并选择同意。")
    elif kind == "admin_required":
        print(
            "该租户要求管理员同意此应用。可改用你自己的 Azure 应用注册："
            f"accounts add 时追加 --client-id <你的client_id>。原始信息：{detail}"
        )
    else:
        print(f"授权码流程失败：{detail}")


def _die_account_error(
    exc: accounts.AccountError, *, user_sub: str | None = None, email: str | None = None
) -> None:
    """AccountError → stderr 中文说明 + 退出码（校验类 2、流程类 1），不冒 traceback。

    auth_failed 的具体原因与重试命令已由 _print_auth_failure 打到 stdout，
    这里不再重复泛句，直接按流程类退出。
    """
    if exc.code == "auth_failed":
        _print_auth_failure(exc.extra.get("kind", "other"), exc.extra.get("detail", ""), user_sub, email)
        sys.exit(1)
    print(f"错误：{_ACCOUNT_ERR_TEXT.get(exc.code, exc.code)}", file=sys.stderr)
    sys.exit(1 if exc.code in _FLOW_ERROR_CODES else 2)


def _cmd_accounts_add(args: argparse.Namespace, settings: Settings) -> None:
    from getpass import getpass as _getpass

    engine = make_engine(settings.database_path)
    init_db(engine)
    with make_session_factory(engine)() as session:
        user = _resolve_user(session, args.user)
        try:
            account = accounts.add_account(
                session,
                user.sub,
                name=args.name,
                kind=args.kind,
                email=args.email,
                app_password=(
                    _getpass("Gmail 应用专用密码（输入不回显）：") if args.kind == "gmail" else None
                ),
                ms_client_id=args.client_id,
            )
        except accounts.AccountError as exc:
            _die_account_error(exc)
        session.commit()
        print(f"已添加账户 #{account.id}：{account.name} <{account.email}>（{account.kind}，用户 {user.sub}）")
    if args.kind == "microsoft":
        print("提示：请运行 `python -m app.cli accounts connect --user <sub|邮箱> <email>` 完成 OAuth 授权。")


def _cmd_accounts_set_password(args: argparse.Namespace, settings: Settings) -> None:
    from getpass import getpass as _getpass

    engine = make_engine(settings.database_path)
    init_db(engine)
    with make_session_factory(engine)() as session:
        user = _resolve_user(session, args.user)
        account = _require_account(session, user, args.email)
        try:
            accounts.set_app_password(
                account,
                _getpass("Gmail 应用专用密码（输入不回显）：") if account.kind == "gmail" else None,
            )
        except accounts.AccountError as exc:
            _die_account_error(exc)
        session.commit()
        print(f"已更新密码：{account.email}")


def _print_connect_retry(sub: str, email: str) -> None:
    """打印可复制的重试命令；sub/email 填本次实际传入的账户参数。"""
    print("重新运行即可获取新代码：")
    print(f"  python -m app.cli accounts connect --user {sub} {email}")


def _cmd_accounts_connect(args: argparse.Namespace, settings: Settings) -> None:
    from app.imap import mstoken

    engine = make_engine(settings.database_path)
    init_db(engine)
    with make_session_factory(engine)() as session:
        if args.user:
            user = _resolve_user(session, args.user)
            account = session.execute(
                select(Account).where(Account.user_sub == user.sub, Account.email == args.email)
            ).scalars().first()
        else:
            matches = session.execute(select(Account).where(Account.email == args.email)).scalars().all()
            if len(matches) > 1:
                subs = ", ".join(m.user_sub for m in matches)
                print(
                    f"错误：邮箱 {args.email} 存在于多个用户下，请用 --user 指定：{subs}",
                    file=sys.stderr,
                )
                sys.exit(2)
            account = matches[0] if matches else None
        if account is None:
            print(f"错误：未找到账户 {args.email}", file=sys.stderr)
            sys.exit(2)
        if account.kind != "microsoft":
            print(f"错误：账户 {args.email} 类型为 {account.kind}，仅 microsoft 需要 connect", file=sys.stderr)
            sys.exit(2)
        try:
            flow = mstoken.initiate_device_flow(account, settings)
            print(flow["message"])
            result = mstoken.wait_for_device_completion(account, flow["_flow"], settings)
        except mstoken.DeviceFlowError as exc:
            # 超时/拒绝是预期结果，按类别给提示与可复制的重试命令，不冒 traceback
            sub = args.user or account.user_sub
            if exc.kind == "expired":
                print("授权超时：设备码已过期（有效期 15 分钟），没有收到授权。")
                _print_connect_retry(sub, args.email)
            elif exc.kind == "declined":
                _print_connect_retry(sub, args.email)
                print("授权被拒绝：你在微软页面上点了拒绝。如需继续，请重新运行上面的命令并选择同意。")
            elif exc.kind == "admin_required":
                print(
                    "该租户要求管理员同意此应用。可改用你自己的 Azure 应用注册："
                    f"accounts add 时追加 --client-id <你的client_id>。原始信息：{exc.detail}"
                )
            else:
                print(f"设备码授权失败：{exc.detail}")
            sys.exit(1)
        account.status = "ok"
        account.last_error = None
        session.commit()
        print(f"授权完成：{account.email}，token 已保存（expires_in={result.get('expires_in')}s）")


def _print_auth_url_retry(sub: str, email: str) -> None:
    """打印可复制的重试命令；sub/email 填本次实际传入的账户参数。"""
    print("重新运行即可生成新链接：")
    print(f"  python -m app.cli accounts auth-url --user {sub} {email}")


def _cmd_accounts_auth_url(args: argparse.Namespace, settings: Settings) -> None:
    """授权码流程第一步：生成授权链接并把 flow 落盘（/data 卷），第二步另起进程。"""
    engine = make_engine(settings.database_path)
    init_db(engine)
    with make_session_factory(engine)() as session:
        user = _resolve_user(session, args.user)
        account = _require_account(session, user, args.email)
        try:
            uri = accounts.start_ms_auth(account, settings, args.redirect_uri)
        except accounts.AccountError as exc:
            _die_account_error(exc)
    print("请用浏览器打开下面的链接，用该邮箱登录并完成 MFA：")
    print(uri)
    print()
    print("登录成功后浏览器会停在一个空白页。把地址栏里的完整 URL 复制回来，")
    print("或复制页面上显示的授权码，然后运行第二步（URL 含 & 符号，务必保留引号）：")
    print(f"  python -m app.cli accounts auth-code --user {args.user} {args.email} '<粘贴回来的完整URL或授权码>'")


def _cmd_accounts_auth_code(args: argparse.Namespace, settings: Settings) -> None:
    """授权码流程第二步：读回第一步落盘的 flow，用粘贴回的 URL/授权码换 token。"""
    engine = make_engine(settings.database_path)
    init_db(engine)
    with make_session_factory(engine)() as session:
        user = _resolve_user(session, args.user)
        account = _require_account(session, user, args.email)
        try:
            accounts.finish_ms_auth(account, settings, args.auth_response)
        except accounts.AccountError as exc:
            # 两步是两次独立进程，flow 靠文件接力；失败按类别提示并给可复制重试命令
            _die_account_error(exc, user_sub=user.sub, email=account.email)
        session.commit()
        print(f"授权成功：{account.email}，token 已保存")


def _cmd_accounts_list(args: argparse.Namespace, settings: Settings) -> None:
    engine = make_engine(settings.database_path)
    init_db(engine)
    with make_session_factory(engine)() as session:
        if args.user:
            user = _resolve_user(session, args.user)
            rows = accounts.list_accounts(session, user.sub)
        else:
            rows = session.execute(select(Account).order_by(Account.id)).scalars().all()
        if not rows:
            print("（暂无账户，用 `accounts add` 添加）")
            return
        header = f"{'所属用户':<28} {'name':<16} {'kind':<10} {'email':<36} {'status':<9} {'凭据':<6} last_sync"
        print(header)
        print("-" * len(header))
        for a in rows:
            # 凭据列只显示是否已设置，绝不打印密码/token 本身
            has_cred = accounts.has_credentials(a)
            last_sync = _dt(a.last_sync_at)
            print(
                f"{a.user_sub:<28} {a.name:<16} {a.kind:<10} {a.email:<36} "
                f"{a.status:<9} {'已设置' if has_cred else '未设置':<6} {last_sync}"
            )


def _cmd_accounts_remove(args: argparse.Namespace, settings: Settings) -> None:
    """软删除：置 enabled=0 并清空凭据，保留已抓取的邮件与已生成的任务。"""
    engine = make_engine(settings.database_path)
    init_db(engine)
    with make_session_factory(engine)() as session:
        user = _resolve_user(session, args.user)
        account = _require_account(session, user, args.email)
        n_emails = session.execute(
            select(func.count(Email.id)).where(Email.account_id == account.id)
        ).scalar() or 0
        n_items = session.execute(
            select(func.count(Item.id)).join(Email, Item.email_id == Email.id).where(Email.account_id == account.id)
        ).scalar() or 0
        accounts.set_enabled(account, False)
        session.commit()
        print(
            f"账户已停用：{account.email}（{account.name}），不再同步；"
            f"其 {n_emails} 封邮件与 {n_items} 条任务已保留。"
        )


def _resolve_account_ids(session, user: User, account_email: str | None) -> list[int]:
    """解析「用户 + 可选账户过滤」→ 账户 id 列表（reclassify / regen-details 共用）。

    找不到指定账户 exit 2；该用户没有任何账户 exit 1。
    """
    account_stmt = select(Account.id).where(Account.user_sub == user.sub)
    if account_email:
        account = session.execute(
            select(Account).where(Account.user_sub == user.sub, Account.email == account_email)
        ).scalars().first()
        if account is None:
            print(f"错误：未找到账户 {account_email}（用户 {user.sub}）", file=sys.stderr)
            sys.exit(2)
        account_stmt = account_stmt.where(Account.id == account.id)
    account_ids = session.execute(account_stmt).scalars().all()
    if not account_ids:
        print(f"用户 {user.sub} 没有账户", file=sys.stderr)
        sys.exit(1)
    return list(account_ids)


def _select_target_email_ids(session, account_ids: list[int], last: int | None) -> list[int]:
    """选择要重分类的邮件 id 列表。

    last 为 None：返回这些账户的全部邮件 id（保持既有语义）；
    last 为正整数：对每个账户分别取最近的 last 封（sent_at 倒序、无时间的排最后，
    同时间按 id 倒序），合并返回。
    """
    if last is None:
        return list(
            session.execute(select(Email.id).where(Email.account_id.in_(account_ids))).scalars().all()
        )
    ids: list[int] = []
    for aid in account_ids:
        ids.extend(
            session.execute(
                select(Email.id)
                .where(Email.account_id == aid)
                .order_by(Email.sent_at.desc().nulls_last(), Email.id.desc())
                .limit(last)
            ).scalars().all()
        )
    return ids


def _cmd_reclassify(args: argparse.Namespace, settings: Settings) -> None:
    """重分类：删除目标邮件的任务并重置 LLM 状态，让 worker 下轮用新规则重跑。

    必须先删 item 再重置状态：items.email_id 有 UNIQUE 约束，item 不删的话，
    下轮 sync 重分类时插入同 email_id 的新 item 会撞唯一约束。
    """
    last = getattr(args, "last", None)  # 直调方（测试）可能不带 last 属性
    if last is not None and last <= 0:
        print("错误：--last 必须是正整数", file=sys.stderr)
        sys.exit(2)
    engine = make_engine(settings.database_path)
    init_db(engine)
    with make_session_factory(engine)() as session:
        user = _resolve_user(session, args.user)
        account_ids = _resolve_account_ids(session, user, args.account)
        email_ids = _select_target_email_ids(session, account_ids, last)
        if not email_ids:
            print("没有匹配的邮件", file=sys.stderr)
            sys.exit(1)
        n_emails = len(email_ids)
        n_items = session.execute(
            select(func.count(Item.id)).where(Item.email_id.in_(email_ids))
        ).scalar() or 0
        if last is None:
            print(f"将重分类 {n_emails} 封邮件、删除 {n_items} 条任务（邮件本体保留）")
        else:
            print(
                f"将重分类 {n_emails} 封邮件（每账户最近 {last} 封）、"
                f"删除 {n_items} 条任务（邮件本体保留）"
            )
        if not args.yes:
            print("确认请输入 yes：", end="", flush=True)
            if sys.stdin.readline().strip() != "yes":
                print("已取消，未做任何修改", file=sys.stderr)
                sys.exit(1)
        items = session.execute(
            select(Item).where(Item.email_id.in_(email_ids))
        ).scalars().all()
        for item in items:
            session.delete(item)
        for email in session.execute(
            select(Email).where(Email.id.in_(email_ids))
        ).scalars().all():
            email.llm_state = "pending"
            email.filtered = False
            email.filter_reason = None
        session.commit()
        print(
            f"已完成：{n_emails} 封邮件已重置为待分类，共删除 {n_items} 条任务。"
            "worker 将在下一轮同步时按新规则重新分类；"
            "如需立即触发，可在部署目录运行 docker compose restart worker"
        )


def _cmd_regen_details(args: argparse.Namespace, settings: Settings) -> None:
    """重生成详情：把该用户（可限账户）所有条目的 detail_md 与 related_json 置 NULL。

    条目与邮件本体保留，worker 下轮按最新详情逻辑重新生成（历史任务不回填，
    需要刷新时用本命令手动触发）。
    """
    engine = make_engine(settings.database_path)
    init_db(engine)
    with make_session_factory(engine)() as session:
        user = _resolve_user(session, args.user)
        account_ids = _resolve_account_ids(session, user, args.account)
        n_items = session.execute(
            select(func.count(Item.id))
            .join(Email, Item.email_id == Email.id)
            .where(Email.account_id.in_(account_ids))
        ).scalar() or 0
        print(f"将重置 {n_items} 条任务详情（detail_md 与关联邮件），worker 下轮重新生成")
        if not args.yes:
            print("确认请输入 yes：", end="", flush=True)
            if sys.stdin.readline().strip() != "yes":
                print("已取消，未做任何修改", file=sys.stderr)
                sys.exit(1)
        items = session.execute(
            select(Item)
            .join(Email, Item.email_id == Email.id)
            .where(Email.account_id.in_(account_ids))
        ).scalars().all()
        for item in items:
            item.detail_md = None
            item.related_json = None
        session.commit()
        print(
            f"已完成：{n_items} 条任务详情已标记为待重生成。"
            "worker 将在下一轮同步时重新生成；"
            "如需立即触发，可在部署目录运行 docker compose restart worker"
        )


def _cmd_archive_backfill(args: argparse.Namespace, settings: Settings) -> None:
    """回补历史原件归档：按 SINCE 重扫收件箱与发件箱，追加进各账户的 mbox。

    可以在 worker 运行时执行：两个进程靠 mbox 文件锁与索引（<邮箱名>.mbox.idx）
    去重保证安全，同一封邮件不会被追加两次，也不会漏掉。
    只写归档文件，不碰数据库、不动同步游标。
    """
    from app.archive import EmailArchive
    from app.imap.client import connect_account
    from app.sync import backfill_archive

    archive = EmailArchive.from_settings(settings)
    if archive is None:
        print("错误：未配置 email_archive_dir，原件归档已关闭", file=sys.stderr)
        sys.exit(2)
    days = args.days if args.days is not None else settings.initial_backfill_days
    engine = make_engine(settings.database_path)
    init_db(engine)
    with make_session_factory(engine)() as session:
        query = select(Account).where(Account.enabled.is_(True))
        if args.account is not None:
            query = query.where(Account.id == args.account)
        for account in session.execute(query).scalars().all():
            if not accounts.has_credentials(account):
                continue
            imap = None
            try:
                imap = connect_account(account, settings)[0]
                backfill_archive(account, imap, archive, days)
            except Exception as exc:
                # 只报账户 id 与异常类名：异常字符串可能带上文件夹名/路径
                print(f"账户 {account.id} 回补失败：{type(exc).__name__}", file=sys.stderr)
            finally:
                if imap is not None:
                    imap.logout()
    print(f"归档回补完成：{archive.summary()}")


def main() -> None:
    from app.imap import mstoken  # 保持 msal 懒加载：其它子命令不依赖它

    settings = get_settings()
    parser = argparse.ArgumentParser(prog="python -m app.cli", description="RakkoTasks 账户与用户管理")
    sub = parser.add_subparsers(dest="command", required=True)

    accounts_p = sub.add_parser("accounts", help="账户管理")
    accounts_sub = accounts_p.add_subparsers(dest="action", required=True)

    add = accounts_sub.add_parser("add", help="添加账户")
    add.add_argument("--user", required=True, help="用户 sub 或邮箱")
    add.add_argument("--kind", required=True, choices=["gmail", "microsoft"])
    add.add_argument("--name", required=True, help="显示名")
    add.add_argument("--email", required=True, help="邮箱地址")
    add.add_argument("--client-id", dest="client_id", default=None, help="微软 OAuth client id（默认官方公共客户端）")
    add.set_defaults(handler=_cmd_accounts_add)

    setpwd = accounts_sub.add_parser("set-password", help="重新录入 Gmail 应用专用密码（getpass 交互）")
    setpwd.add_argument("--user", required=True, help="用户 sub 或邮箱")
    setpwd.add_argument("email", help="邮箱地址")
    setpwd.set_defaults(handler=_cmd_accounts_set_password)

    connect = accounts_sub.add_parser("connect", help="微软账户 OAuth 授权（device code flow）")
    connect.add_argument("--user", default=None, help="用户 sub 或邮箱；同邮箱多用户时必填")
    connect.add_argument("email", help="邮箱地址")
    connect.set_defaults(handler=_cmd_accounts_connect)

    authurl = accounts_sub.add_parser(
        "auth-url", help="微软账户 OAuth 授权码流程第一步：生成授权链接（适合设备码被租户条件访问拒绝的场景）"
    )
    authurl.add_argument("--user", required=True, help="用户 sub 或邮箱")
    authurl.add_argument(
        "--redirect-uri",
        dest="redirect_uri",
        default=mstoken.DEFAULT_REDIRECT_URI,
        help=(
            f"OAuth 重定向 URI（默认 {mstoken.DEFAULT_REDIRECT_URI}；"
            "备选 urn:ietf:wg:oauth:2.0:oob，UNSW 官方文档采用）"
        ),
    )
    authurl.add_argument("email", help="邮箱地址")
    authurl.set_defaults(handler=_cmd_accounts_auth_url)

    authcode = accounts_sub.add_parser(
        "auth-code", help="微软账户 OAuth 授权码流程第二步：用粘贴回的 URL/授权码换 token"
    )
    authcode.add_argument("--user", required=True, help="用户 sub 或邮箱")
    authcode.add_argument("email", help="邮箱地址")
    authcode.add_argument("auth_response", help="浏览器地址栏的完整回调 URL，或页面上显示的授权码")
    authcode.set_defaults(handler=_cmd_accounts_auth_code)

    lst = accounts_sub.add_parser("list", help="列出账户（不指定 --user 时列出全部用户的账户）")
    lst.add_argument("--user", default=None, help="用户 sub 或邮箱，仅列该用户的账户")
    lst.set_defaults(handler=_cmd_accounts_list)

    rm = accounts_sub.add_parser("remove", help="停用账户（软删除：邮件与任务保留）")
    rm.add_argument("--user", required=True, help="用户 sub 或邮箱")
    rm.add_argument("email", help="邮箱地址")
    rm.set_defaults(handler=_cmd_accounts_remove)

    users = sub.add_parser("users", help="用户管理（用户由首次登录自动创建）")
    users_sub = users.add_subparsers(dest="action", required=True)
    users_list = users_sub.add_parser("list", help="列出用户")
    users_list.set_defaults(handler=_cmd_users_list)

    reclassify = sub.add_parser(
        "reclassify", help="重分类：删除该用户（或指定账户）邮件的任务并重置 LLM 状态，worker 下轮按最新规则重跑"
    )
    reclassify.add_argument("--user", required=True, help="用户 sub 或邮箱")
    reclassify.add_argument("--account", default=None, help="只重分类该邮箱账户；缺省为该用户全部账户")
    reclassify.add_argument(
        "--last", type=int, default=None, metavar="N",
        help="只重分类每个账户最近的 N 封邮件（按发送时间倒序，无时间的排最后）；缺省为全部",
    )
    reclassify.add_argument("--yes", action="store_true", help="跳过确认（非交互调用）")
    reclassify.set_defaults(handler=_cmd_reclassify)

    regen = sub.add_parser(
        "regen-details", help="重生成详情：把该用户（或指定账户）所有任务条目的详情与关联邮件置空，worker 下轮重跑"
    )
    regen.add_argument("--user", required=True, help="用户 sub 或邮箱")
    regen.add_argument("--account", default=None, help="只重置该邮箱账户；缺省为该用户全部账户")
    regen.add_argument("--yes", action="store_true", help="跳过确认（非交互调用）")
    regen.set_defaults(handler=_cmd_regen_details)

    backfill = sub.add_parser(
        "archive-backfill",
        help="回补历史原件归档：按天数重扫收件箱与发件箱，追加进各账户的 mbox（可在 worker 运行时执行）",
    )
    backfill.add_argument(
        "--days", type=int, default=None, metavar="N",
        help="回补最近 N 天（IMAP SINCE）；缺省用配置 initial_backfill_days",
    )
    backfill.add_argument("--account", type=int, default=None, help="只回补该账户 id；缺省为全部启用中的账户")
    backfill.set_defaults(handler=_cmd_archive_backfill)

    args = parser.parse_args()
    args.handler(args, settings)


if __name__ == "__main__":
    main()
