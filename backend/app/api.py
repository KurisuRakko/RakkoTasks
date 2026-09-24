"""FastAPI 应用：REST API（DESIGN.md 第 6 节）+ 静态托管（frontend/dist 存在才挂，SPA fallback）。"""
from __future__ import annotations

import json
import logging
import re
import secrets
from collections.abc import Iterator
from datetime import date, datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.accounts import account_info
from app.accounts_api import register_accounts
from app.auth import CurrentUser, require_auth
from app.calendar import build_ics
from app.caldav import register_caldav
from app.caldav.auth import generate_app_password, hash_app_password
from app.config import Settings, get_settings
from app.db import init_db, make_engine, make_session_factory
from app.detail import apply_detail, build_export_text, generate_item_detail, resolve_related
from app.itemrules import (
    CATEGORIES,
    DEFAULT_TITLE,
    ItemFieldError,
    local_wall_to_utc,
    set_status,
    validate_item_fields,
    validate_reminders,
)
from app.models import Account, Email, Item, Reminder, User
from app.ratelimit import RateLimiter
from app.sanitizer import build_email_document
from app.search import run_search
from app.sync_state import request_sync, status_payload

logger = logging.getLogger("rakkotasks.api")


class ItemCreate(BaseModel):
    title: str
    summary: str = ""
    category: str
    due_date: str | None = None
    importance: str | None = None   # 省略 → 落 normal
    actionable: bool | None = None  # 省略 → 落 True
    reminders: list[str] | None = None  # 带 UTC 偏移的 ISO 8601（不带偏移一律 400）


class ItemPatch(BaseModel):
    # 每个字段的 None 都是「没传」，不是「清空」：字段是否出现在请求体里一律用
    # model_fields_set 判断（actionable 显式传 false 是合法操作，绝不能用值做真值判断）
    status: str | None = None  # done | open
    title: str | None = None
    summary: str | None = None
    category: str | None = None
    due_date: str | None = None
    importance: str | None = None   # high | normal | low；省略 → 保持现值
    actionable: bool | None = None  # false 是合法值；省略 → 保持现值
    reminders: list[str] | None = None  # 带 UTC 偏移的 ISO 8601；传 null 与传 [] 都清空


class ParseRequest(BaseModel):
    text: str = Field(max_length=2000)  # 防超长文本灌进 LLM 上下文烧钱
    today: str | None = None            # 用户浏览器本地日期 YYYY-MM-DD
    tz: str | None = None               # IANA 时区名，如 "Australia/Sydney"


class SearchRequest(BaseModel):
    question: str = Field(max_length=2000)  # 防超长问题灌进 LLM 上下文烧钱


def _resolve_today(raw: str | None, settings) -> str:
    """解析用的「今天」：请求体传的浏览器本地日期优先，缺省或非法回落到
    settings.local_timezone 的今天。

    不要用 date.today()：容器 TZ=UTC（deploy/Dockerfile）而 local_timezone
    默认 Australia/Sydney，悉尼上午 10 点前 date.today() 还是「昨天」，
    解析「明天」会直接差一天。
    """
    if raw is not None and re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
        try:
            date.fromisoformat(raw)  # 形状过完再过真实性，挡住 2026-13-45
        except ValueError:
            pass
        else:
            return raw
    try:
        return datetime.now(ZoneInfo(settings.local_timezone)).date().isoformat()
    except (ZoneInfoNotFoundError, ValueError):
        # 配错 local_timezone 的两种形态都兜：ZoneInfoNotFoundError（查无此区，
        # KeyError 子类）与 ValueError（空串/绝对路径/越界路径——如 .env 里
        # LOCAL_TIMEZONE= 留空），统一退一步用 UTC，不要让端点 500
        return datetime.now(timezone.utc).date().isoformat()


def _resolve_zone(raw: str | None, settings) -> ZoneInfo:
    """解析用的时区：请求体传的 IANA 名优先，缺省或非法回落到
    settings.local_timezone 的时区，再非法回落到 UTC。

    与 _resolve_today 同款三级回落：ZoneInfoNotFoundError（查无此区）与
    ValueError（空串/绝对路径/.. 路径）两种形态都兜，非法 tz 不应让端点
    500——解析提醒时刻换算失败会连累整条 /parse，宁可退回配置时区。
    """
    if raw is not None:
        try:
            return ZoneInfo(raw)
        except (ZoneInfoNotFoundError, ValueError):
            pass
    try:
        return ZoneInfo(settings.local_timezone)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def _get_db(request: Request) -> Iterator[Session]:
    session: Session = request.app.state.session_factory()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def _owned_account_ids(db: Session, user_sub: str) -> list[int]:
    """该用户拥有的账户 id 列表（归属推导链：Account.user_sub）。"""
    return list(db.execute(select(Account.id).where(Account.user_sub == user_sub)).scalars().all())


def _owned_item(db: Session, item_id: int, user_sub: str) -> Item | None:
    """按归属直挂字段取属于该用户的条目；不属于返回 None（对外按 404 处理）。"""
    return db.execute(
        select(Item).where(Item.id == item_id, Item.user_sub == user_sub)
    ).scalars().first()


def _owned_email(db: Session, email_id: int, user_sub: str) -> Email | None:
    """按归属链 Email→Account 取属于该用户的邮件；不属于返回 None（对外按 404 处理）。"""
    return db.execute(
        select(Email).join(Email.account).where(Email.id == email_id, Account.user_sub == user_sub)
    ).scalars().first()


def create_app(
    settings: Settings | None = None,
    session_factory: sessionmaker[Session] | None = None,
    engine: Engine | None = None,
) -> FastAPI:
    """创建应用。测试可注入内存库 engine / 自定义 session_factory。"""
    settings = settings or get_settings()
    if engine is None and session_factory is not None:
        engine = session_factory.kw.get("bind")
    if engine is None:
        engine = make_engine(settings.database_path)
    if session_factory is None:
        session_factory = make_session_factory(engine)
    init_db(engine)

    app = FastAPI(title="RakkoTasks API")
    app.state.settings = settings
    app.state.session_factory = session_factory

    # 每用户限流：保护会产生 LLM 费用的端点（每个 app 实例各一份，测试互不污染）
    search_limiter = RateLimiter(6, 60.0)
    detail_limiter = RateLimiter(30, 60.0)
    # parse 与 quick 共用同一份 20 次/60 秒计数
    parse_limiter = RateLimiter(20, 60.0)

    @app.exception_handler(HTTPException)
    async def _http_exception_handler(_request, exc: HTTPException):
        # 401 按任务书返回裸 JSON {"code": "unauthorized"}，其余错误同样只回 detail；
        # headers（如 WWW-Authenticate）必须透传，否则客户端拿不到质询参数
        return JSONResponse(status_code=exc.status_code, content=exc.detail, headers=exc.headers)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.frontend_origin],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # 禁止在此加 Content-Security-Policy：原邮件查看用 srcdoc sandbox iframe，
    # 会继承父页 CSP，加了会打死「显示远程图片」既有功能（X-Frame-Options
    # 不经 policy container 继承，所以安全）。
    @app.middleware("http")
    async def _security_headers(request: Request, call_next):
        resp = await call_next(request)
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("X-Frame-Options", "DENY")
        resp.headers.setdefault("Referrer-Policy", "same-origin")
        resp.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        if request.url.path.startswith(("/api/", "/caldav")):
            # 邮件内容与 CalDAV 凭据态不允许进任何缓存
            resp.headers["Cache-Control"] = "no-store"
        elif request.url.path in ("/", "/index.html", "/sw.js", "/registerSW.js", "/manifest.webmanifest") or request.url.path.startswith(
            "/workbox-"
        ):
            # SW 与入口 HTML 不能进启发式缓存：Safari 对没有显式 Cache-Control 的
            # 响应按启发式缓存（最长可达一天），会让常驻的 iPhone PWA 一直拿不到
            # 新版本；no-cache 强制每次回源校验。带 hash 的 /assets/ 不在此列，
            # 它们靠文件名失效，缓存越久越好。
            resp.headers["Cache-Control"] = "no-cache"
        return resp

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok"}

    @app.get("/api/items")
    def list_items(
        user: CurrentUser = Depends(require_auth),
        db: Session = Depends(_get_db),
        status: str = Query(default="open"),
        category: str | None = Query(default=None),
    ) -> dict:
        stmt = select(Item).where(Item.user_sub == user.sub, Item.status == status)
        if category:
            stmt = stmt.where(Item.category == category)
        items = (
            db.execute(stmt.order_by(Item.due_date.is_(None), Item.due_date.asc(), Item.created_at.desc()))
            .scalars()
            .all()
        )
        owned_ids = _owned_account_ids(db, user.sub)  # 只查一次，逐条复用
        return {"items": [_item_dict(i, resolve_related(db, i, owned_ids)) for i in items]}

    @app.post("/api/items", status_code=201)
    def create_item(
        body: ItemCreate, user: CurrentUser = Depends(require_auth), db: Session = Depends(_get_db)
    ) -> dict:
        """新建手动条目（无源邮件，email_id 为 null）：importance/actionable 省略时默认落
        normal / True，status=open。"""
        try:
            due = validate_item_fields(
                body.title, body.summary, body.category, body.due_date, body.importance
            )
            reminders = validate_reminders(body.reminders)  # None = 没传；list = 升序去重 naive UTC
        except ItemFieldError as e:
            raise HTTPException(status_code=400, detail={"code": e.code}) from None
        item = Item(
            user_sub=user.sub,
            email_id=None,
            title=body.title.strip(),
            summary=body.summary,
            category=body.category,
            due_date=due,
            importance=body.importance or "normal",
            actionable=True if body.actionable is None else body.actionable,
            status="open",
        )
        db.add(item)
        if reminders is not None:
            for dt in reminders:
                item.reminders.append(Reminder(remind_at=dt))  # 关系 append，ORM 自己填 item_id
        db.commit()
        return _item_dict(item, [])

    def _ai_parse(text: str, today: str | None, tz: str | None) -> list[dict]:
        """/parse 与 /quick 共用的解析路径：解析「今天」与「时区」→ parse_task →
        归一化 → 逐条把提醒换算成带偏移的绝对时刻。

        一段文本可能说了好几件事，所以返回列表；只说一件事时是一元列表。
        无论几条都只打一次 LLM——拆条是模型在同一次输出里做的。

        from app.llm import ... 必须写在函数体内（延迟导入）：测试用
        monkeypatch.setattr("app.llm.get_llm", lambda settings=None: FakeLLM())
        打桩，模块顶层导入会让打桩失效。
        """
        from app.llm import get_llm, normalize_parsed_tasks  # 延迟导入，便于测试 monkeypatch

        llm = get_llm(settings)
        tasks = normalize_parsed_tasks(llm.parse_task(text, _resolve_today(today, settings)))
        zone = _resolve_zone(tz, settings)
        # 模型输出的 reminders 是本地墙上时刻串（normalize 拿不到时区、保持原样），
        # 只有这里同时握着模型输出和请求时区，所以换算放服务端：转成 naive UTC 后
        # 序列化成带 +00:00 偏移的绝对时刻。/parse 的响应要被前端直接回填进
        # POST /api/items 的 reminders，而那个端点只收带偏移的串（见 DESIGN.md 6）。
        for parsed in tasks:
            parsed["reminders"] = [
                dt.replace(tzinfo=timezone.utc).isoformat()
                for dt in local_wall_to_utc(parsed["reminders"], zone)
            ]
        return tasks

    @app.post("/api/items/parse")
    def parse_item(
        body: ParseRequest, user: CurrentUser = Depends(require_auth)
    ) -> dict:
        """一段自然语言 → 结构化任务列表（不落库、不碰 db）。

        响应是 {"tasks": [...]} 信封而不是裸数组：与 GET /api/items 的
        {"items": [...]} 同款，留出以后加同级字段的余地。

        LLM 失败回 502，异常细节绝不能进响应体。
        """
        if not parse_limiter.allow(user.sub):
            raise HTTPException(status_code=429, detail={"code": "rate_limited"})
        try:
            return {"tasks": _ai_parse(body.text, body.today, body.tz)}
        except Exception as exc:
            logger.exception("AI 解析失败")
            raise HTTPException(status_code=502, detail={"code": "parse_error"}) from exc

    @app.post("/api/items/quick", status_code=201)
    def quick_add_item(
        body: ParseRequest, user: CurrentUser = Depends(require_auth), db: Session = Depends(_get_db)
    ) -> dict:
        """自然语言一键建条目：正常路径 AI 解析后落库；LLM 失败或字段仍非法时用原文
        兜底建条目，两种情况都 201。

        一段话里说了几件事就落几条，响应是 {"items": [...]} 列表。兜底路径只落
        一条（原文本身就是一件事，没有可信的拆分依据）。

        兜底放在服务端而非前端：请求一旦到达服务端就会跑完（同步 def 端点跑在
        starlette 线程池里，客户端断连不会杀线程），所以用户点完确定立刻关掉
        PWA，条目照样入库；前端两步编排做不到这点。
        """
        if not parse_limiter.allow(user.sub):
            raise HTTPException(status_code=429, detail={"code": "rate_limited"})
        # (字段, 提醒) 对的列表。兜底路径（LLM 挂）没有 AI 判断可用，不挂任何提醒。
        drafts: list[tuple[dict, list[datetime]]] = []
        try:
            for parsed in _ai_parse(body.text, body.today, body.tz):
                # 第二道保险：normalize_parsed_task 理论上已兜住字段非法，这里再校一次
                due = validate_item_fields(
                    parsed["title"], parsed["summary"], parsed["category"],
                    parsed["due_date"], parsed["importance"],
                )
                # _ai_parse 已按请求时区把模型输出的墙上时刻换成带 +00:00 的绝对时刻串，
                # 这里再落成库里的 naive UTC（validate_reminders 收的就是带偏移串）
                drafts.append((
                    {
                        "title": parsed["title"],
                        "summary": parsed["summary"],
                        "category": parsed["category"],
                        "due_date": due,
                        "importance": parsed["importance"],
                        "actionable": parsed["actionable"],
                    },
                    validate_reminders(parsed["reminders"]) or [],
                ))
            ai_parsed = True
        except Exception:
            logger.exception("AI 解析失败，改用原文兜底建条目")
            ai_parsed = False
            raw = body.text.strip()
            if not raw:
                title, summary = DEFAULT_TITLE, ""
            else:
                title = raw[:128]
                # 超过 128 字的部分放 summary：完整原文进 summary，别把用户的话弄丢
                summary = "" if len(raw) <= 128 else raw
            # 整批丢弃已解析出的部分：一次请求要么全是 AI 结果、要么全是原文兜底，
            # 半截 AI 半截原文的混合结果没法向用户解释（ai_parsed 只有一个）。
            drafts = [(
                {
                    "title": title, "summary": summary, "category": "其他",
                    "due_date": None, "importance": "normal", "actionable": True,
                },
                [],
            )]
        items: list[Item] = []
        for fields, reminder_dts in drafts:
            item = Item(user_sub=user.sub, email_id=None, status="open", **fields)
            db.add(item)
            for dt in reminder_dts:
                item.reminders.append(Reminder(remind_at=dt))
            items.append(item)
        db.commit()
        return {"items": [_item_dict(item, []) for item in items], "ai_parsed": ai_parsed}

    @app.patch("/api/items/{item_id}")
    def patch_item(
        item_id: int, body: ItemPatch, user: CurrentUser = Depends(require_auth), db: Session = Depends(_get_db)
    ) -> dict:
        item = _owned_item(db, item_id, user.sub)
        if item is None:
            raise HTTPException(status_code=404, detail={"code": "not_found"})
        fields = body.model_fields_set
        if not fields:
            raise HTTPException(status_code=400, detail={"code": "bad_request"})
        # 邮件条目与手动条目在 PATCH 上同权（产品决策）：条目内容字段谁都能改，
        # 下面统一走「现值合并 + 整体校验」这一条路径。reminders 不进这个集合
        # 不是因为权限，而是写入语义不同——它是整体替换 + 差集计算，单独走
        # 下面的分支，任何条目都能改。
        editable = fields & {"title", "summary", "category", "due_date", "importance", "actionable"}
        if "status" in fields:
            if body.status not in ("done", "open"):
                raise HTTPException(status_code=400, detail={"code": "bad_status"})
            set_status(item, body.status, now=datetime.now())
        if "reminders" in fields:
            # 整体替换（不是增量）：传 [] 清空全部；传 null 与 [] 同义，都清空
            # （list[str] | None 的 null 在这里没有第三种含义，统一成清空）。
            # 实现上算差集而不是 clear()+重建：同一时刻的行若先删后插，会在同一次
            # flush 里先 INSERT 再 DELETE（unit-of-work 顺序），新行撞上还没删掉的
            # 旧行命中 UNIQUE(item_id, remind_at) → 500。差集只删多余、只加新增，
            # 交集行原样保留（id 稳定，也少写库）。
            try:
                new_reminders = validate_reminders(body.reminders)  # None（=清空）或 naive UTC 列表
            except ItemFieldError as e:
                raise HTTPException(status_code=400, detail={"code": e.code}) from None
            wanted = set(new_reminders or [])
            existing = {r.remind_at: r for r in item.reminders}
            for at, row in existing.items():
                if at not in wanted:
                    item.reminders.remove(row)  # delete-orphan 负责真删
            for at in sorted(wanted - existing.keys()):
                item.reminders.append(Reminder(remind_at=at))
        if editable:
            # 未给出的字段用现值合并后整体校验一次（校验语义与 POST 一致）；
            # actionable 由 Pydantic 保证 bool 类型，不进 validate_item_fields
            title = body.title if "title" in fields else item.title
            summary = body.summary if "summary" in fields else item.summary
            category = body.category if "category" in fields else item.category
            due_raw = (
                body.due_date
                if "due_date" in fields
                else (item.due_date.isoformat() if item.due_date else None)
            )
            importance = body.importance if "importance" in fields else item.importance
            try:
                due = validate_item_fields(title, summary, category, due_raw, importance)
            except ItemFieldError as e:
                raise HTTPException(status_code=400, detail={"code": e.code}) from None
            item.title = title.strip()
            item.summary = summary
            item.category = category
            item.due_date = due
            item.importance = importance
            if "actionable" in fields:
                # 只认 model_fields_set（fields）判断字段是否给出：actionable 是布尔，
                # 显式 false 是合法修改，写成真值判断会让「改成 false」静默失效
                item.actionable = bool(body.actionable)
        db.commit()
        return _item_dict(item, resolve_related(db, item, _owned_account_ids(db, user.sub)))

    @app.delete("/api/items/{item_id}", status_code=204)
    def delete_item(
        item_id: int, user: CurrentUser = Depends(require_auth), db: Session = Depends(_get_db)
    ) -> Response:
        item = _owned_item(db, item_id, user.sub)
        if item is None:
            raise HTTPException(status_code=404, detail={"code": "not_found"})
        if item.email_id is not None:
            raise HTTPException(status_code=400, detail={"code": "not_editable"})
        db.delete(item)
        db.commit()
        return Response(status_code=204)

    @app.get("/api/items/{item_id}")
    def get_item(item_id: int, user: CurrentUser = Depends(require_auth), db: Session = Depends(_get_db)) -> dict:
        item = _owned_item(db, item_id, user.sub)
        if item is None:
            raise HTTPException(status_code=404, detail={"code": "not_found"})
        return _item_dict(item, resolve_related(db, item, _owned_account_ids(db, user.sub)))

    @app.post("/api/items/{item_id}/detail")
    def generate_detail_endpoint(
        item_id: int, user: CurrentUser = Depends(require_auth), db: Session = Depends(_get_db)
    ) -> dict:
        item = _owned_item(db, item_id, user.sub)
        if item is None:
            raise HTTPException(status_code=404, detail={"code": "not_found"})
        if item.email_id is None:
            raise HTTPException(status_code=400, detail={"code": "no_email"})  # 手动条目没有邮件正文，不生成 AI 详情
        if item.detail_md is None:
            if not detail_limiter.allow(user.sub):
                raise HTTPException(status_code=429, detail={"code": "rate_limited"})
            from app.llm import get_llm  # 延迟导入，便于测试 monkeypatch

            try:
                md, related = generate_item_detail(db, get_llm(settings), item, settings)
            except Exception as exc:
                logger.exception("生成详情失败 item_id=%s", item_id)
                raise HTTPException(status_code=502, detail={"code": "llm_error"}) from exc
            apply_detail(item, md, related)
            db.commit()
        owned = _owned_account_ids(db, user.sub)
        return {"id": item.id, "detail_md": item.detail_md, "related": resolve_related(db, item, owned)}

    @app.get("/api/items/{item_id}/export")
    def export_item(item_id: int, user: CurrentUser = Depends(require_auth), db: Session = Depends(_get_db)) -> dict:
        """导出条目为 Markdown 纯文本（含 AI 见解与关联邮件全文）；纯读、无 LLM 调用，不限流。"""
        item = _owned_item(db, item_id, user.sub)
        if item is None:
            raise HTTPException(status_code=404, detail={"code": "not_found"})
        return {"text": build_export_text(db, item, _owned_account_ids(db, user.sub))}

    @app.get("/api/calendar")
    def get_calendar_token(
        user: CurrentUser = Depends(require_auth), db: Session = Depends(_get_db)
    ) -> dict:
        """当前用户日历订阅令牌；尚无令牌则生成并落库（鉴权首次登录会 upsert 用户，此处兜底补建）。"""
        u = db.get(User, user.sub)
        if u is None:
            u = User(sub=user.sub)
            db.add(u)
        if not u.calendar_token:
            u.calendar_token = secrets.token_urlsafe(32)
            db.commit()
        return {"token": u.calendar_token}

    @app.post("/api/calendar/rotate")
    def rotate_calendar_token(
        user: CurrentUser = Depends(require_auth), db: Session = Depends(_get_db)
    ) -> dict:
        """无条件生成新令牌覆盖旧令牌：旧订阅链接立即失效。"""
        u = db.get(User, user.sub)
        if u is None:
            u = User(sub=user.sub)
            db.add(u)
        u.calendar_token = secrets.token_urlsafe(32)
        db.commit()
        return {"token": u.calendar_token}

    @app.get("/api/caldav")
    def get_caldav_status(
        user: CurrentUser = Depends(require_auth), db: Session = Depends(_get_db)
    ) -> dict:
        """CalDAV 同步的接入信息（username/path/是否已配置）。

        GET 不自动生成应用密码：密码只显示一次，只能由显式 POST
        /api/caldav/password 产生——被动生成会让密码永远到不了用户手里。
        本端点及密码端点响应都不含 hash 本身。
        """
        u = db.get(User, user.sub)
        if u is None:
            u = User(sub=user.sub)
            db.add(u)
        return {
            "username": u.email or u.sub,
            "path": "/caldav/",
            "configured": u.caldav_password_hash is not None,
        }

    @app.post("/api/caldav/password")
    def create_caldav_password(
        user: CurrentUser = Depends(require_auth), db: Session = Depends(_get_db)
    ) -> dict:
        """无条件重新生成 CalDAV 应用密码（旧密码立即失效），明文只在本次响应出现一次。"""
        u = db.get(User, user.sub)
        if u is None:
            u = User(sub=user.sub)
            db.add(u)
        pw = generate_app_password()
        u.caldav_password_hash = hash_app_password(pw)
        db.commit()
        return {"password": pw}

    @app.get("/api/calendar/{token}.ics")
    def calendar_ics(token: str, db: Session = Depends(_get_db)) -> Response:
        """公开订阅端点（无 Depends(require_auth)）：令牌即链接即凭据，泄露就 rotate。

        返回该用户 status=open 且 due_date 非空（含手动条目）的全天事件 ICS。
        """
        u = db.execute(select(User).where(User.calendar_token == token)).scalars().first()
        if u is None:
            raise HTTPException(status_code=404, detail={"code": "not_found"})
        items = (
            db.execute(
                select(Item)
                .where(Item.user_sub == u.sub, Item.status == "open", Item.due_date.is_not(None))
                .order_by(Item.due_date)
            )
            .scalars()
            .all()
        )
        return Response(
            content=build_ics(items, now=datetime.now(timezone.utc)),
            media_type="text/calendar; charset=utf-8",
            headers={"Content-Disposition": 'inline; filename="rakkotasks.ics"'},
        )

    @app.get("/api/emails/{email_id}")
    def get_email(
        email_id: int,
        remote_images: int = Query(default=0),
        user: CurrentUser = Depends(require_auth),
        db: Session = Depends(_get_db),
    ) -> dict:
        email = _owned_email(db, email_id, user.sub)
        if email is None:
            raise HTTPException(status_code=404, detail={"code": "not_found"})
        html = None
        if email.html_body:
            html = build_email_document(email.html_body, allow_remote_images=bool(remote_images))
        try:
            attachments = json.loads(email.attachments_json or "[]")
        except ValueError:
            attachments = []
        return {
            "id": email.id,
            "account_id": email.account_id,
            "message_id": email.message_id,
            "subject": email.subject,
            "sender": email.sender,
            "recipients": email.recipients,
            "sent_at": email.sent_at.isoformat() if email.sent_at else None,
            "fetched_at": email.fetched_at.isoformat() if email.fetched_at else None,
            "attachments": attachments,
            "filtered": email.filtered,
            "filter_reason": email.filter_reason,
            "llm_state": email.llm_state,
            "text_body": email.text_body,
            "html": html,
        }

    @app.post("/api/search")
    def search(
        request: SearchRequest, user: CurrentUser = Depends(require_auth), db: Session = Depends(_get_db)
    ) -> dict:
        if not request.question.strip():
            raise HTTPException(status_code=400, detail={"code": "empty_question"})
        if not search_limiter.allow(user.sub):
            raise HTTPException(status_code=429, detail={"code": "rate_limited"})
        from app.llm import get_llm  # 延迟导入，便于测试 monkeypatch

        try:
            return run_search(request.question, db, get_llm(settings), user.sub)
        except Exception as exc:
            logger.exception("AI 搜索失败")
            raise HTTPException(status_code=502, detail={"code": "search_error"}) from exc

    @app.get("/api/status")
    def status_endpoint(
        user: CurrentUser = Depends(require_auth), db: Session = Depends(_get_db)
    ) -> dict:
        owned = _owned_account_ids(db, user.sub)
        accounts = db.execute(select(Account).where(Account.id.in_(owned)).order_by(Account.id)).scalars().all()
        pending_llm = len(
            db.execute(
                select(Email).where(Email.llm_state == "pending", Email.account_id.in_(owned))
            ).scalars().all()
        )
        return {
            # AccountInfo 与 /api/accounts* 共用同一序列化函数（含 has_credentials / ms_client_id）
            "accounts": [account_info(a) for a in accounts],
            "pending_llm": pending_llm,
        }

    # 同步进度与手动触发：前端顶栏刷新按钮用（GET 拉进度，POST 唤醒 worker 立刻跑一轮）。
    # 必须在 SPA fallback 之前注册，否则会被 GET 兜底吞掉。
    @app.get("/api/sync/status")
    def sync_status(
        user: CurrentUser = Depends(require_auth), db: Session = Depends(_get_db)
    ) -> dict:
        """当前轮次 / 最近一轮 / 有无待认领请求；逐账户明细只回该用户自己的邮箱。"""
        return status_payload(db, user.sub)

    @app.post("/api/sync/trigger", status_code=202)
    def sync_trigger(
        user: CurrentUser = Depends(require_auth), db: Session = Depends(_get_db)
    ) -> dict:
        """写一条手动请求等 worker 认领；已有请求或在跑时不重复写。"""
        return {"accepted": True, "already_running": not request_sync(db)}

    # 邮箱账户自助管理（/api/accounts*）；须在 SPA fallback 之前注册
    register_accounts(app, settings, _get_db)

    # CalDAV（iPhone 提醒事项）：必须在 SPA fallback 之前注册，否则 /caldav/ 会被 GET 兜底吞掉；
    # 失败鉴权每来源每分钟 30 次
    register_caldav(app, settings, RateLimiter(30, 60.0))

    # 静态托管：settings.frontend_dist 非空时用它，否则回退启发式路径；目录存在才挂 SPA fallback
    dist_str = settings.frontend_dist
    frontend_dist = (
        Path(dist_str)
        if dist_str
        else Path(__file__).resolve().parent.parent / "frontend" / "dist"
    )
    if frontend_dist.is_dir():

        @app.get("/{path:path}")
        def spa_fallback(path: str):  # noqa: ANN201
            base = frontend_dist.resolve()
            target = (base / path).resolve()
            if path and target.is_file() and target.is_relative_to(base):
                return FileResponse(target)
            return FileResponse(base / "index.html")

    return app


def _item_dict(item: Item, related: list[dict]) -> dict:
    email = item.email
    return {
        "id": item.id,
        "email_id": item.email_id,
        # DB 存 naive UTC，显式补 +00:00 偏移，前端 new Date() 才不会按本地时区误读
        "email_sent_at": (
            email.sent_at.replace(tzinfo=timezone.utc).isoformat() if email and email.sent_at else None
        ),
        "email_subject": email.subject if email else None,
        "email_sender": email.sender if email else None,
        "title": item.title,
        "summary": item.summary,
        "category": item.category,
        "due_date": item.due_date.isoformat() if item.due_date else None,
        "importance": item.importance,
        "actionable": item.actionable,
        "status": item.status,
        "detail_md": item.detail_md,
        "related": related,
        "created_at": item.created_at.isoformat() if item.created_at else None,
        "done_at": item.done_at.isoformat() if item.done_at else None,
        # 显式按 remind_at 升序排序，不依赖关系上 order_by 的隐式行为；
        # 序列化与 email_sent_at 同款：库内 naive UTC 显式补 +00:00，前端
        # new Date() 才不会按本地时区误读
        "reminders": [
            {"id": r.id, "remind_at": r.remind_at.replace(tzinfo=timezone.utc).isoformat()}
            for r in sorted(item.reminders, key=lambda r: r.remind_at)
        ],
    }
