"""FastAPI 应用：REST API（DESIGN.md 第 6 节）+ 静态托管（frontend/dist 存在才挂，SPA fallback）。"""
from __future__ import annotations

import json
import logging
import secrets
from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.auth import CurrentUser, require_auth
from app.calendar import build_ics
from app.caldav import register_caldav
from app.caldav.auth import generate_app_password, hash_app_password
from app.config import Settings, get_settings
from app.db import init_db, make_engine, make_session_factory
from app.detail import apply_detail, build_export_text, generate_item_detail, resolve_related
from app.itemrules import CATEGORIES, ItemFieldError, set_status, validate_item_fields
from app.models import Account, Email, Item, User
from app.ratelimit import RateLimiter
from app.sanitizer import build_email_document
from app.search import run_search

logger = logging.getLogger("rakkotasks.api")


class ItemCreate(BaseModel):
    title: str
    summary: str = ""
    category: str
    due_date: str | None = None


class ItemPatch(BaseModel):
    # due_date 区分「没传」与「传 null 清除」：用 model_fields_set 判断字段是否出现在请求体里
    status: str | None = None  # done | open
    title: str | None = None
    summary: str | None = None
    category: str | None = None
    due_date: str | None = None


class SearchRequest(BaseModel):
    question: str = Field(max_length=2000)  # 防超长问题灌进 LLM 上下文烧钱


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
        """新建手动条目（无源邮件，email_id 为 null）：importance/actionable 固定、status=open。"""
        try:
            due = validate_item_fields(body.title, body.summary, body.category, body.due_date)
        except ItemFieldError as e:
            raise HTTPException(status_code=400, detail={"code": e.code}) from None
        item = Item(
            user_sub=user.sub,
            email_id=None,
            title=body.title.strip(),
            summary=body.summary,
            category=body.category,
            due_date=due,
            importance="normal",
            actionable=True,
            status="open",
        )
        db.add(item)
        db.commit()
        return _item_dict(item, [])

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
        editable = fields & {"title", "summary", "category", "due_date"}
        if editable and item.email_id is not None:
            raise HTTPException(status_code=400, detail={"code": "not_editable"})
        if "status" in fields:
            if body.status not in ("done", "open"):
                raise HTTPException(status_code=400, detail={"code": "bad_status"})
            set_status(item, body.status, now=datetime.now())
        if editable:
            # 未给出的字段用现值合并后整体校验一次（校验语义与 POST 一致）
            title = body.title if "title" in fields else item.title
            summary = body.summary if "summary" in fields else item.summary
            category = body.category if "category" in fields else item.category
            due_raw = (
                body.due_date
                if "due_date" in fields
                else (item.due_date.isoformat() if item.due_date else None)
            )
            try:
                due = validate_item_fields(title, summary, category, due_raw)
            except ItemFieldError as e:
                raise HTTPException(status_code=400, detail={"code": e.code}) from None
            item.title = title.strip()
            item.summary = summary
            item.category = category
            item.due_date = due
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
            "accounts": [
                {
                    "id": a.id,
                    "name": a.name,
                    "kind": a.kind,
                    "email": a.email,
                    "status": a.status,
                    "enabled": bool(a.enabled),
                    "last_sync_at": a.last_sync_at.isoformat() if a.last_sync_at else None,
                    "last_error": a.last_error,
                }
                for a in accounts
            ],
            "pending_llm": pending_llm,
        }

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
    }
