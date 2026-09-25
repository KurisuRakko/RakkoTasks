"""用法：由 dev/demo/demo_server.py 调用（seed_all(engine)）；也可单独 python dev/demo/seed.py --reset 造一份库。

演示站的虚构数据：一个用户、五个邮箱账户、三封邮件、若干条目与一轮同步记录。
全部虚构：人名自编、邮箱一律 @example.com、正文不引用任何外部资源。
日期一律相对「今天」计算——脚本在本机跑，进程本地时区即用户时区，所以此刻的
本地日期就是报告里说的「用户时区的今天」。

播种走后端自己的模型与服务层（app.items_service / app.itemrules / app.sync_state），
不写裸 SQL；直接构造的只有 Email 与 Account 两行，因为后端没有「造一封历史邮件」
的服务函数（邮件由 IMAP 同步写入，见 app/sync.py），而这两个模型没有需要复用的
校验逻辑。刻意不用 app.accounts.add_account：它只产 status=pending 的账户，而演示
要求「设置页区分的每种状态下各至少一个」。
"""
from __future__ import annotations

import sys
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

# 由脚本自身位置推出仓库根（<repo>/dev/demo/seed.py → <repo>），不依赖调用时的 cwd
REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = REPO_ROOT / "backend"
# 必须先于 import 后端执行：防止解释器环境里 editable 安装的另一份 app 包抢先命中
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy.engine import Engine  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.detail import apply_detail  # noqa: E402
from app.items_service import create_manual_item  # noqa: E402
from app.itemrules import set_status  # noqa: E402
from app.models import Account, Email, SyncRun, User  # noqa: E402
from app.sync_state import SyncProgress  # noqa: E402

# 唯一虚构用户：假 Phainon 的任何凭证都登录成这个 sub
DEMO_USER_SUB = "demo-user"
DEMO_USER_NAME = "演示用户"
DEMO_USER_EMAIL = "demo@example.com"

# 演示里不打印任何配置值，只打印本模块造出的行数
DEMO_CALENDAR_TOKEN = "demo-calendar-token"
DEMO_CALDAV_PASSWORD_HASH = "demo-caldav-password-hash"


def _day(today: date, offset: int) -> date:
    """相对今天偏移若干天的日期。"""
    return today + timedelta(days=offset)


def _utc(hours_from_now: float) -> datetime:
    """相对此刻偏移若干小时的 naive UTC 时刻（reminders 列的口径）。"""
    return (datetime.now(timezone.utc) + timedelta(hours=hours_from_now)).replace(
        tzinfo=None, microsecond=0
    )


# ── 账户：设置页 statusChipMeta（frontend/src/components/accounts/meta.ts:19-29）
# 区分的状态有五种，每种各造一个账户。凭据字段一律占位串，绝不写真实密码/token。
_ACCOUNTS = (
    # (名称, 类型, 邮箱, status, enabled, app_password, token_cache, 上次同步(小时,相对此刻), last_error)
    # 正常：enabled + status=ok
    ("公司邮箱", "microsoft", "work.account@example.com", "ok", True, None, "demo-placeholder-token-cache", -3, None),
    # 已停用：enabled=False 优先于 status（前端 meta.ts:19 先判 enabled）
    ("旧个人邮箱", "gmail", "old.personal@example.com", "pending", False, None, None, -240, None),
    # 出错：enabled + status=error + last_error
    ("学校邮箱", "microsoft", "campus.mail@example.com", "error", True, None, "demo-placeholder-token-cache", -26,
     "登录失败：授权已过期，请重新授权"),
    # 待授权：enabled + status=pending + 无凭据
    ("社团邮箱", "gmail", "club.contact@example.com", "pending", True, None, None, None, None),
    # 等待首次同步：enabled + status=pending + 有凭据
    ("订阅邮箱", "gmail", "digest.reader@example.com", "pending", True, "demo-placeholder-app-password", None, None, None),
)


# ── 三封源邮件：正文纯文本、自编、不含任何图片/样式/脚本 URL。
# subject 里的日期占位符 {d} 由 _make_emails 按 offset 填，避免写死绝对日期。
_EMAILS = (
    dict(
        ref="course",
        subject="《数据结构》第三次作业提交要求（截止{d}）",
        sender="课程教务 <course.office@example.com>",
        recipients="demo@example.com",
        offset=-2,
        body=(
            "同学你好：\n\n"
            "《数据结构》第三次作业的提交通道已经开放，请在本周内完成并提交。\n\n"
            "提交要求：\n"
            "1. 源码打包成一个压缩包，命名为「学号-姓名-第三次作业」。\n"
            "2. 实验报告包含运行截图与复杂度分析，缺一项按未完成处理。\n"
            "3. 迟交每天扣五分，超过三天不再接收。\n\n"
            "作业内容：实现一个基于邻接表的图最短路径算法，并对给定样例数据给出运行结果。\n\n"
            "如有疑问请在答疑时间到实验楼三层找助教。\n\n"
            "课程教务办公室\n"
        ),
    ),
    dict(
        ref="finance",
        subject="本学期学杂费缴费通知（缴费截止{d}）",
        sender="财务处 <campus.finance@example.com>",
        recipients="demo@example.com",
        offset=-1,
        body=(
            "同学你好：\n\n"
            "本学期学杂费缴费通道已开放，请在截止日期前完成缴费。\n\n"
            "应缴金额：人民币 ¥4,860.00\n"
            "缴费方式：校务系统 → 财务缴费 → 选择学期 → 生成缴费单\n"
            "缴费成功后系统会自动登记，无需另行提交凭证。\n\n"
            "逾期未缴费的，选课记录会在两周后被冻结，请务必留意。\n"
            "若已办理助学贷款，请在缴费说明中上传受理编号。\n\n"
            "财务处\n"
        ),
    ),
    dict(
        ref="lab",
        subject="关于补交机房门禁卡申请材料的通知",
        sender="实验中心 王老师 <demo-prof-wang@example.com>",
        recipients="demo@example.com",
        offset=-4,
        body=(
            "同学你好：\n\n"
            "你上一个学期提交的机房门禁卡申请里，缺少一份导师签字确认单，材料目前处于退回状态。\n\n"
            "请补齐以下两项后交回实验中心前台：\n"
            "1. 导师签字确认单（可在实验中心领取纸质表格，或使用电子版填好后打印）。\n"
            "2. 本学期课表打印件一份，标注使用机房的时间段。\n\n"
            "补齐材料后，门禁卡一般三个工作日内开通。\n\n"
            "实验中心 王老师\n"
        ),
    ),
)

_EMAIL_ITEM_DETAIL = (
    "## 要点\n\n"
    "- 这是一封由系统预置的演示邮件条目，AI 详情已按演示数据预生成。\n"
    "- 真实环境下的「AI 详情」由模型懒生成，此处不再调用模型。\n\n"
    "## 背景\n\n"
    "演示数据只用于界面评审与 DOM/CSS 取证，内容与任何真实机构无关。"
)


def _make_emails(session: Session, today: date, account_ids: dict[str, int]) -> dict[str, Email]:
    """造三封源邮件（正文为纯文本，不含任何外部资源引用）。"""
    emails: dict[str, Email] = {}
    for spec in _EMAILS:
        sent_on = _day(today, spec["offset"])
        email = Email(
            account_id=account_ids[str(spec["ref"])],
            message_id=f"demo-{spec['ref']}-{sent_on.isoformat()}@example.com",
            subject=str(spec["subject"]).format(d=sent_on.isoformat()),
            sender=spec["sender"],
            recipients=spec["recipients"],
            # 邮件时刻按本地时区的整点落到 UTC，与 item_dict 补 +00:00 的序列化口径一致
            sent_at=datetime.combine(sent_on, time(9, 30)),
            text_body=spec["body"],
            html_body=None,
            attachments_json="[]",
            filtered=False,
            filter_reason=None,
            llm_state="done",
        )
        session.add(email)
        emails[str(spec["ref"])] = email
    session.flush()  # 拿到 email.id 供条目挂靠
    return emails


def _item_specs(today: date) -> list[dict]:
    """未完成条目清单。

    due_offset=None 表示无截止日；remind_hours 非 None 时挂一条提醒（相对此刻的小时数）。
    覆盖面按任务书要求分配，理由写在每一条的 note 里。
    """
    return [
        # —— 「今天」组（effectiveDate ≤ 今天；含逾期，逾期只看 due_date）
        # 逾期条目：验证 isOverdue 的红色高亮
        dict(
            title="补交上学期的机房门禁卡申请材料", summary="材料被退回，需带导师签字确认单与课表打印件重交。",
            category="学业", due_offset=-3, importance="normal", source="lab",
        ),
        dict(
            title="把上学期所有没归档的实验报告和课程论文按课程分开整理好放进资料夹并把清单填进台账",
            summary="每门课建一个文件夹，文件名统一成「课程-序号-日期」。",
            category="学业", due_offset=-1, importance="normal", source=None,
        ),
        dict(
            title="续借图书馆借出的三本参考书", summary="", category="学业",
            due_offset=0, importance="low", source=None,
        ),
        dict(
            title="把上周的会议纪要补完并同步给项目组", summary="",
            category="工作", due_offset=0, importance="normal", source=None,
        ),
        # 提醒落在今天、无截止日：验证 effectiveDate 取「最早提醒」的分组口径
        dict(
            title="给房东转账这个月的房租并索要收据",
            summary="转账后记得在账本里记一笔。",
            category="账单", due_offset=None, importance="normal", source=None,
            remind_hours=6.0,
        ),
        # 有截止日 + 提醒（两者都有）
        dict(
            title="确认信用卡自动还款账户余额是否足够",
            summary="不足时先从活期转一笔进去。",
            category="账单", due_offset=1, importance="high", source=None,
            remind_hours=20.0,
        ),
        # —— 「本周」组（明天 ~ 本周日）
        dict(
            title="完成《数据结构》第三次作业并提交",
            summary="需要附运行截图与复杂度分析，迟交每天扣五分。",
            category="学业", due_offset=4, importance="high", source="course",
        ),
        dict(
            title="把车库角落里那台闲置的旧显示器处理掉",
            summary="问一下小区二手群有没有人要。",
            category="个人", due_offset=5, importance="low", source=None,
        ),
        # —— 「重要」组（日期落在本周之后，或压根没有日期，但 importance=high）
        dict(
            title="在截止日前完成本学期学杂费缴费并保存缴费单",
            summary="逾期两周后选课记录会被冻结。",
            category="账单", due_offset=12, importance="high", source="finance",
        ),
        dict(
            title="给远程办公的室友配一把备用钥匙并登记门禁",
            summary="物业要求登记一个紧急联系人。",
            category="个人", due_offset=None, importance="high", source=None,
        ),
        dict(
            title="整理季度报销材料并上传到财务系统",
            summary="", category="工作", due_offset=None, importance="high", source=None,
            remind_hours=50.0,
        ),
        dict(
            title="和导师确认毕业论文的选题方向与开题时间",
            summary="开题报告初稿需要提前一周交。",
            category="学业", due_offset=None, importance="high", source=None,
        ),
        # —— 「无期限」组（无日期且 importance 非 high）
        dict(
            title="把厨房水槽下面渗水的那截软管换掉",
            summary="先量好管径再下单。",
            category="个人", due_offset=None, importance="normal", source=None,
        ),
        dict(
            title="归档去年一整年的电子发票和缴费凭证",
            summary="", category="账单", due_offset=None, importance="low", source=None,
        ),
        dict(
            title="看完借来的那本《数据库系统概念》剩下的四章",
            summary="重点看查询优化那一章。",
            category="学业", due_offset=None, importance="low", source=None,
        ),
        dict(
            title="给读研的旧同学回一封邮件说说近况",
            summary="他上次问起换工作的事，一直没回。",
            category="其他", due_offset=None, importance="normal", source=None,
        ),
        dict(
            title="找一个周末去把阳台的防水补一遍",
            summary="梅雨季之前必须弄完，不然墙皮会返潮发霉。",
            category="其他", due_offset=None, importance="normal", source=None,
        ),
        # 刻意造一条「长到超过一行、又几乎没有摘要」的组合，用于 375px 宽的折行取证
        dict(
            title="把上个月所有没报销的打车发票按项目和日期整理成一张汇总表",
            summary="", category="工作", due_offset=None, importance="normal", source=None,
        ),
        # 刻意造一条 43 字的标题：375px 宽下标题列约 239px、中文 14px 每行约 17 字，
        # 必然折成两行以上——用于「长标题折行」的取证
        dict(
            title="把三个平台的云盘里那些重复的照片按拍摄日期去重后再合并成一个总相册存档",
            summary="重复的按分辨率高的那一份保留。",
            category="个人", due_offset=None, importance="normal", source=None,
        ),
    ]


def _done_specs(today: date) -> list[dict]:
    """已完成条目（≥ 3 条），全部手动创建：items.email_id 有 UNIQUE 约束
    （backend/app/models.py:92），三封源邮件已各挂一条未完成条目，没有富余邮件可挂。
    """
    return [
        dict(
            title="把课程表导进日历并设好每周提醒", summary="学期初一次性做完的事。",
            category="学业", due_offset=-3, importance="normal", source=None,
            done_hours=-52.0,
        ),
        dict(
            title="把月度考勤表发给人事", summary="",
            category="工作", due_offset=-5, importance="normal", source=None,
            done_hours=-96.0,
        ),
        dict(
            title="换掉玄关那盏一直闪的灯", summary="顺带买了两只备用灯泡。",
            category="个人", due_offset=-8, importance="low", source=None,
            done_hours=-200.0,
        ),
    ]


def _make_sync_run(session: Session, accounts: list[Account]) -> None:
    """造一轮已完成的同步记录，供 /sync 状态页展示（演示里 worker 不启动）。"""
    started = datetime.now() - timedelta(minutes=12)
    run = SyncRun(
        trigger="scheduled", state="running",
        requested_at=None, started_at=started, finished_at=None, stages="{}",
    )
    session.add(run)
    session.flush()
    progress = SyncProgress(session, run, [a.email for a in accounts])
    for account in accounts:
        if not account.enabled or not account.status == "ok":
            progress.account(account.email, "skipped")
        else:
            progress.account(account.email, "done", new_count=1)
    progress.stage("classify", "done", total=1, done=1, created=1)
    progress.stage("detail", "done", total=1, done=1)
    progress.finish()


def seed_all(engine: Engine) -> dict[str, int]:
    """把演示数据写进 engine 指向的库；调用方负责建库（init_db）与删除旧库文件。"""
    today = date.today()
    counts = {"accounts": 0, "emails": 0, "items": 0, "done": 0}
    with Session(engine) as session:
        session.add(
            User(
                sub=DEMO_USER_SUB,
                email=DEMO_USER_EMAIL,
                name=DEMO_USER_NAME,
                calendar_token=DEMO_CALENDAR_TOKEN,
                caldav_password_hash=DEMO_CALDAV_PASSWORD_HASH,
                created_at=datetime.now(),
                last_seen_at=datetime.now(),
            )
        )

        accounts: list[Account] = []
        for name, kind, email, status, enabled, password, token, hours, last_error in _ACCOUNTS:
            account = Account(
                user_sub=DEMO_USER_SUB,
                name=name,
                kind=kind,
                email=email,
                ms_client_id=None,
                app_password=password,
                token_cache=token,
                enabled=enabled,
                uidvalidity=1 if enabled else None,
                last_sync_at=datetime.now() + timedelta(hours=hours) if hours is not None else None,
                last_error=last_error,
                status=status,
            )
            session.add(account)
            accounts.append(account)
        session.flush()
        counts["accounts"] = len(accounts)

        # 三封源邮件必须挂在「正常」账户下：其余账户要么停用、要么拿不到邮件
        email_account = accounts[0]
        email_accounts = {"course": email_account.id, "finance": email_account.id, "lab": email_account.id}
        emails = _make_emails(session, today, email_accounts)
        counts["emails"] = len(emails)

        for spec in _item_specs(today) + _done_specs(today):
            due = _day(today, spec["due_offset"]) if spec["due_offset"] is not None else None
            remind_hours = spec.get("remind_hours")
            item = create_manual_item(
                session,
                DEMO_USER_SUB,
                title=spec["title"],
                summary=spec["summary"],
                category=spec["category"],
                due_date=due.isoformat() if due else None,
                importance=spec["importance"],
                actionable=True,
                reminders=[_utc(remind_hours).replace(tzinfo=timezone.utc).isoformat()] if remind_hours else None,
            )
            source = spec.get("source")
            if source:
                item.email_id = emails[source].id
                # 预生成详情：真实环境下这里是懒生成的，演示不许调 LLM，
                # 留着 None 会让用户点开详情时撞 502
                item.detail_md = _EMAIL_ITEM_DETAIL
                if source == "finance":
                    finance_item = item
            if spec.get("done_hours") is not None:
                set_status(item, "done", now=datetime.now() + timedelta(hours=spec["done_hours"]))
                counts["done"] += 1
            counts["items"] += 1

        # 关联邮件只挂一条，用于验证详情弹窗里的「关联邮件」展开
        apply_detail(
            finance_item,
            _EMAIL_ITEM_DETAIL,
            [{"email_id": emails["course"].id, "reason": "同一缴费事项的上一年度通知"}],
        )

        _make_sync_run(session, accounts)
        session.commit()
    return counts


def main() -> None:
    """单独运行时的入口：重建 dev/demo/data/demo.sqlite3 并播种。"""
    from app.config import get_settings
    from app.db import init_db, make_engine

    data_dir = REPO_ROOT / "dev" / "demo" / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    db_path = get_settings().database_path
    for suffix in ("", "-wal", "-shm"):
        Path(db_path + suffix).unlink(missing_ok=True)
    engine = make_engine(db_path)
    init_db(engine)
    counts = seed_all(engine)
    print(f"seeded: {counts}")


if __name__ == "__main__":
    main()
