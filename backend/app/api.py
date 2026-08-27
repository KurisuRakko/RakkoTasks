"""FastAPI 应用：REST API（DESIGN.md 第 6 节）+ 静态托管（frontend/dist 存在才挂，SPA fallback）。"""
from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import datetime
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.auth import require_auth
from app.config import Settings, get_settings
from app.db import init_db, make_engine, make_session_factory
from app.models import Account, Email, Item
from app.sanitizer import build_email_document
from app.search import run_search


class ItemPatch(BaseModel):
    status: str  # done | open


class SearchRequest(BaseModel):
    question: str


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

    @app.exception_handler(HTTPException)
    async def _http_exception_handler(_request, exc: HTTPException):
        # 401 按任务书返回裸 JSON {"code": "unauthorized"}，其余错误同样只回 detail
        return JSONResponse(status_code=exc.status_code, content=exc.detail)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.frontend_origin],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok"}

    @app.get("/api/items", dependencies=[Depends(require_auth)])
    def list_items(
        db: Session = Depends(_get_db),
        status: str = Query(default="open"),
        category: str | None = Query(default=None),
    ) -> dict:
        stmt = select(Item).where(Item.status == status)
        if category:
            stmt = stmt.where(Item.category == category)
        items = (
            db.execute(stmt.order_by(Item.due_date.is_(None), Item.due_date.asc(), Item.created_at.desc()))
            .scalars()
            .all()
        )
        return {"items": [_item_dict(i) for i in items]}

    @app.patch("/api/items/{item_id}", dependencies=[Depends(require_auth)])
    def patch_item(item_id: int, body: ItemPatch, db: Session = Depends(_get_db)) -> dict:
        if body.status not in ("done", "open"):
            raise HTTPException(status_code=400, detail={"code": "bad_status"})
        item = db.get(Item, item_id)
        if item is None:
            raise HTTPException(status_code=404, detail={"code": "not_found"})
        item.status = body.status
        item.done_at = datetime.now() if body.status == "done" else None
        db.commit()
        return _item_dict(item)

    @app.get("/api/items/{item_id}", dependencies=[Depends(require_auth)])
    def get_item(item_id: int, db: Session = Depends(_get_db)) -> dict:
        item = db.get(Item, item_id)
        if item is None:
            raise HTTPException(status_code=404, detail={"code": "not_found"})
        return _item_dict(item)

    @app.post("/api/items/{item_id}/detail", dependencies=[Depends(require_auth)])
    def generate_item_detail(item_id: int, db: Session = Depends(_get_db)) -> dict:
        item = db.get(Item, item_id)
        if item is None:
            raise HTTPException(status_code=404, detail={"code": "not_found"})
        if item.detail_md is None:
            email = item.email
            if email is None:
                raise HTTPException(status_code=404, detail={"code": "no_email"})
            from app.llm import get_llm  # 延迟导入，便于测试 monkeypatch

            try:
                detail = get_llm(settings).generate_detail(
                    {
                        "subject": email.subject,
                        "sender": email.sender,
                        "sent_at": email.sent_at,
                        "text_body": email.text_body,
                    }
                )
            except Exception as exc:
                raise HTTPException(status_code=502, detail={"code": "llm_error", "message": str(exc)})
            item.detail_md = detail
            db.commit()
        return {"id": item.id, "detail_md": item.detail_md}

    @app.get("/api/emails/{email_id}", dependencies=[Depends(require_auth)])
    def get_email(
        email_id: int,
        remote_images: int = Query(default=0),
        db: Session = Depends(_get_db),
    ) -> dict:
        email = db.get(Email, email_id)
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

    @app.post("/api/search", dependencies=[Depends(require_auth)])
    def search(request: SearchRequest, db: Session = Depends(_get_db)) -> dict:
        if not request.question.strip():
            raise HTTPException(status_code=400, detail={"code": "empty_question"})
        from app.llm import get_llm  # 延迟导入，便于测试 monkeypatch

        try:
            return run_search(request.question, db, get_llm(settings))
        except Exception as exc:
            raise HTTPException(status_code=502, detail={"code": "search_error", "message": str(exc)})

    @app.get("/api/status", dependencies=[Depends(require_auth)])
    def status_endpoint(db: Session = Depends(_get_db)) -> dict:
        accounts = db.execute(select(Account)).scalars().all()
        pending_llm = len(db.execute(select(Email).where(Email.llm_state == "pending")).scalars().all())
        return {
            "accounts": [
                {
                    "name": a.name,
                    "kind": a.kind,
                    "email": a.email,
                    "status": a.status,
                    "last_sync_at": a.last_sync_at.isoformat() if a.last_sync_at else None,
                    "last_error": a.last_error,
                }
                for a in accounts
            ],
            "pending_llm": pending_llm,
        }

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


def _item_dict(item: Item) -> dict:
    email = item.email
    return {
        "id": item.id,
        "email_id": item.email_id,
        "email_subject": email.subject if email else None,
        "email_sender": email.sender if email else None,
        "title": item.title,
        "summary": item.summary,
        "category": item.category,
        "due_date": item.due_date.isoformat() if item.due_date else None,
        "actionable": item.actionable,
        "status": item.status,
        "detail_md": item.detail_md,
        "created_at": item.created_at.isoformat() if item.created_at else None,
        "done_at": item.done_at.isoformat() if item.done_at else None,
    }
