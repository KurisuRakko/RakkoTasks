"""内网 feed：给 tailnet 里的其它服务 / agent 读邮件与待办、写待办（DESIGN.md 第 12 节）。

与主应用（app.api）是两个进程、两个端口：本应用只绑 127.0.0.1:8001，经宿主机
`tailscale serve --https=8451` 只在 tailnet 内暴露，**不进** cloudflared 公网隧道。
主应用里也没有这些路由，所以公网侧无论怎么拼路径都碰不到它。

为省调用方 token：
- 默认返回紧凑纯文本（一行一条，字段用「 | 」分隔），加 ?format=json 才回 JSON；
- 列表只给摘要字段，正文与详情要按 id 单独取；邮件正文默认截到 2000 字；
- since= 只拉增量（待办按更新时间，邮件按抓取时间）。

鉴权：Authorization: Bearer <feed 令牌>。令牌由 `python -m app.cli feed-token --user ...`
生成（每次生成即轮换），库里只存 sha256（同 CalDAV 应用密码，理由见 caldav/auth.py）。

表结构由主应用 web 进程负责迁移（init_db），本应用不跑迁移，避免与 web 同时启动时
两个进程并发 ALTER TABLE 撞「duplicate column」。
"""
from __future__ import annotations

import json
import re
from collections.abc import Iterator
from datetime import date, datetime, time, timezone
from email.utils import parseaddr
from typing import Annotated, Any
from zoneinfo import ZoneInfo

from fastapi import Depends, FastAPI, HTTPException, Path, Query, Request
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.agent import _fts_match_ids, fts_query
from app.caldav.auth import hash_app_password
from app.config import Settings, get_settings
from app.db import make_engine, make_session_factory
from app.detail import resolve_related
from app.emailtext import email_plain_text
from app.itemrules import ItemFieldError
from app.items_service import apply_item_patch, create_manual_item, item_dict, owned_item
from app.models import Account, Email, Item, User

# 路径 id 上限 = SQLite INTEGER 上限，超了 SQLite 驱动直接 OverflowError
RowId = Annotated[int, Path(ge=1, le=2**63 - 1)]

LIST_LIMIT_DEFAULT = 30
LIST_LIMIT_MAX = 200
BODY_MAX_DEFAULT = 2000
BODY_MAX_CAP = 50000
SUMMARY_CLIP = 80

USAGE = """RakkoTasks feed (tailnet only). Auth: Authorization: Bearer <token>
Text by default (one record per line, fields split by " | "); add ?format=json for JSON.
Times are local ({tz}).

GET  /items                 open to-dos. ?status=open|done|all &since=<date|datetime> &q=<kw> &limit=N
     line: t<id> <status> <due|-> <importance> [<category>] <title> | <summary> | m<email_id>
GET  /items/<id>            one to-do in full (summary, AI detail, reminders, related mail)
POST /items                 JSON {{title, category, summary?, due_date?(YYYY-MM-DD), importance?(high|normal|low), reminders?[ISO8601+offset]}}
PATCH /items/<id>           JSON with any of {{status(open|done), title, summary, category, due_date, importance, actionable, reminders}}
POST /items/<id>/done       mark done   (POST /items/<id>/open to reopen)
GET  /emails                recent mail, ads/noise hidden. ?q=<kw> &since= &sender= &all=1 &limit=N
     line: m<id> <sent time> <sender> | <subject> | t<item_id>
GET  /emails/<id>           headers + plain-text body, clipped to ?max=2000 chars (max=0 → up to {cap})
Categories: {categories}
"""


class FeedItemCreate(BaseModel):
    title: str
    summary: str = ""
    category: str
    due_date: str | None = None
    importance: str | None = None
    actionable: bool | None = None
    reminders: list[str] | None = None


class FeedItemPatch(BaseModel):
    # None 一律是「没传」：是否出现用 model_fields_set 判断（与 api.ItemPatch 同语义）
    status: str | None = None
    title: str | None = None
    summary: str | None = None
    category: str | None = None
    due_date: str | None = None
    importance: str | None = None
    actionable: bool | None = None
    reminders: list[str] | None = None


def find_user_by_feed_token(db: Session, token: str) -> User | None:
    """令牌 → 用户；令牌是 32 字符高熵随机串，按 sha256 精确查即可（见 caldav/auth.py）。"""
    if not token:
        return None
    return db.execute(
        select(User).where(User.feed_token_hash == hash_app_password(token))
    ).scalars().first()


def _one_line(value: str | None, limit: int | None = None) -> str:
    """压成单行（换行、制表、连续空白 → 单空格）；超长截断加省略号。分隔符「|」换成全角防串列。"""
    s = re.sub(r"\s+", " ", value or "").strip().replace("|", "｜")
    if limit is not None and len(s) > limit:
        s = s[: limit - 1] + "…"
    return s


def _short_sender(sender: str) -> str:
    """'"张三" <a@b.c>' → 张三；没有显示名就给地址。"""
    name, addr = parseaddr(sender or "")
    return _one_line(name or addr or sender, 40)


class _Clock:
    """库内 naive UTC ↔ 本地时区显示 / since 参数解析。"""

    def __init__(self, tz_name: str) -> None:
        self.zone = ZoneInfo(tz_name)

    def show(self, dt: datetime | None) -> str:
        if dt is None:
            return "-"
        return dt.replace(tzinfo=timezone.utc).astimezone(self.zone).strftime("%Y-%m-%d %H:%M")

    def parse_since(self, raw: str | None) -> datetime | None:
        """YYYY-MM-DD（本地零点）或 ISO datetime（无偏移按本地）→ naive UTC。坏值 400。"""
        if not raw:
            return None
        try:
            if len(raw) == 10:
                dt = datetime.combine(date.fromisoformat(raw), time.min)
            else:
                dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=self.zone)
            return dt.astimezone(timezone.utc).replace(tzinfo=None)
        except (ValueError, OverflowError):  # 0001-01-01 换算 UTC 会落到公元 1 年前
            raise HTTPException(status_code=400, detail="bad since: use YYYY-MM-DD or ISO 8601") from None


def _item_line(item: Item) -> str:
    due = item.due_date.isoformat() if item.due_date else "-"
    parts = [f"t{item.id} {item.status} {due} {item.importance} [{item.category}] {_one_line(item.title)}"]
    parts.append(_one_line(item.summary, SUMMARY_CLIP))
    parts.append(f"m{item.email_id}" if item.email_id else "manual")
    return " | ".join(parts)


def _email_line(email: Email, item_id: int | None, clock: _Clock) -> str:
    head = f"m{email.id} {clock.show(email.sent_at)} {_short_sender(email.sender)}"
    tail = f"t{item_id}" if item_id else "-"
    return " | ".join([head, _one_line(email.subject, 120), tail])


def _text(lines: list[str]) -> PlainTextResponse:
    return PlainTextResponse("\n".join(lines) + "\n")


def create_feed_app(
    settings: Settings | None = None,
    session_factory: sessionmaker[Session] | None = None,
    engine: Engine | None = None,
) -> FastAPI:
    """创建 feed 应用。测试注入 session_factory；生产从 settings.database_path 建引擎（不迁移）。"""
    settings = settings or get_settings()
    if session_factory is None:
        session_factory = make_session_factory(engine or make_engine(settings.database_path))
    clock = _Clock(settings.local_timezone)

    app = FastAPI(title="RakkoTasks feed", docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def _no_store(request: Request, call_next):
        resp = await call_next(request)
        resp.headers["Cache-Control"] = "no-store"
        return resp

    @app.exception_handler(HTTPException)
    async def _http_error(_request, exc: HTTPException):
        # 错误一律一行纯文本，省调用方 token；401 带质询头
        return PlainTextResponse(f"error: {exc.detail}\n", status_code=exc.status_code, headers=exc.headers)

    def get_db() -> Iterator[Session]:
        session = session_factory()
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    def current_user(request: Request, db: Session = Depends(get_db)) -> User:
        scheme, _, token = (request.headers.get("Authorization") or "").partition(" ")
        user = find_user_by_feed_token(db, token.strip()) if scheme.lower() == "bearer" else None
        if user is None:
            raise HTTPException(status_code=401, detail="unauthorized", headers={"WWW-Authenticate": "Bearer"})
        return user

    def owned_ids(db: Session, user: User) -> list[int]:
        return list(db.execute(select(Account.id).where(Account.user_sub == user.sub)).scalars().all())

    def clamp_limit(limit: int) -> int:
        return max(1, min(limit, LIST_LIMIT_MAX))

    def item_out(db: Session, user: User, item: Item, fmt: str) -> Response:
        if fmt == "json":
            return JSONResponse(item_dict(item, resolve_related(db, item, owned_ids(db, user))))
        return _text([_item_line(item)])

    def get_owned_item(db: Session, user: User, item_id: int) -> Item:
        item = owned_item(db, item_id, user.sub)
        if item is None:
            raise HTTPException(status_code=404, detail="not found")
        return item

    def patch(db: Session, item: Item, changes: dict[str, Any]) -> None:
        try:
            apply_item_patch(item, changes, now=datetime.now())
        except ItemFieldError as e:
            raise HTTPException(status_code=400, detail=e.code) from None
        db.flush()

    @app.get("/", response_class=PlainTextResponse)
    def usage() -> str:
        from app.itemrules import CATEGORIES

        return USAGE.format(tz=settings.local_timezone, cap=BODY_MAX_CAP, categories=" ".join(CATEGORIES))

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok"}

    @app.get("/items")
    def list_items(
        user: User = Depends(current_user),
        db: Session = Depends(get_db),
        status: str = Query(default="open", pattern="^(open|done|all)$"),
        since: str | None = None,
        q: str | None = None,
        limit: int = LIST_LIMIT_DEFAULT,
        fmt: str = Query(default="text", alias="format"),
    ) -> Response:
        stmt = select(Item).where(Item.user_sub == user.sub)
        if status != "all":
            stmt = stmt.where(Item.status == status)
        since_dt = clock.parse_since(since)
        if since_dt is not None:
            # 旧行 updated_at 可能为空（补列前的数据），回退 created_at
            stmt = stmt.where(func.coalesce(Item.updated_at, Item.created_at) >= since_dt)
        if q:
            stmt = stmt.where(Item.title.contains(q, autoescape=True) | Item.summary.contains(q, autoescape=True))
        stmt = stmt.order_by(Item.due_date.is_(None), Item.due_date.asc(), Item.created_at.desc())
        items = list(db.execute(stmt.limit(clamp_limit(limit))).scalars().all())
        if fmt == "json":
            # 列表 JSON 也只给摘要字段：详情（detail_md / related）按 id 取
            return JSONResponse({"items": [
                {k: v for k, v in item_dict(i, []).items() if k not in ("detail_md", "related")} for i in items
            ]})
        return _text([f"# items status={status} n={len(items)}"] + [_item_line(i) for i in items])

    @app.get("/items/{item_id}")
    def get_item(
        item_id: RowId, user: User = Depends(current_user), db: Session = Depends(get_db),
        fmt: str = Query(default="text", alias="format"),
    ) -> Response:
        item = get_owned_item(db, user, item_id)
        related = resolve_related(db, item, owned_ids(db, user))
        if fmt == "json":
            return JSONResponse(item_dict(item, related))
        lines = [
            _item_line(item),
            f"created: {clock.show(item.created_at)}  done: {clock.show(item.done_at)}",
        ]
        if item.reminders:
            lines.append("reminders: " + ", ".join(clock.show(r.remind_at) for r in item.reminders))
        if item.email is not None:
            e = item.email
            lines.append(f"source: m{e.id} {clock.show(e.sent_at)} {_short_sender(e.sender)} | {_one_line(e.subject)}")
        if item.summary:
            lines += ["", item.summary.strip()]
        if item.detail_md:
            lines += ["", item.detail_md.strip()]
        if related:
            lines += ["", "related:"] + [f"m{r['email_id']} {_one_line(r.get('subject'), 80)} — {_one_line(r.get('reason'), 80)}" for r in related]
        return _text(lines)

    @app.post("/items", status_code=201)
    def create_item(
        body: FeedItemCreate, user: User = Depends(current_user), db: Session = Depends(get_db), fmt: str = Query(default="text", alias="format")
    ) -> Response:
        try:
            item = create_manual_item(
                db, user.sub,
                title=body.title, summary=body.summary, category=body.category, due_date=body.due_date,
                importance=body.importance, actionable=body.actionable, reminders=body.reminders,
            )
        except ItemFieldError as e:
            raise HTTPException(status_code=400, detail=e.code) from None
        db.flush()
        resp = item_out(db, user, item, fmt)
        resp.status_code = 201
        return resp

    @app.patch("/items/{item_id}")
    def patch_item(
        item_id: RowId, body: FeedItemPatch, user: User = Depends(current_user), db: Session = Depends(get_db),
        fmt: str = Query(default="text", alias="format"),
    ) -> Response:
        item = get_owned_item(db, user, item_id)
        patch(db, item, {name: getattr(body, name) for name in body.model_fields_set})
        return item_out(db, user, item, fmt)

    @app.post("/items/{item_id}/{action}")
    def set_item_status(
        item_id: RowId, action: str, user: User = Depends(current_user), db: Session = Depends(get_db),
        fmt: str = Query(default="text", alias="format"),
    ) -> Response:
        if action not in ("done", "open"):
            raise HTTPException(status_code=404, detail="not found")
        item = get_owned_item(db, user, item_id)
        patch(db, item, {"status": action})
        return item_out(db, user, item, fmt)

    @app.get("/emails")
    def list_emails(
        user: User = Depends(current_user),
        db: Session = Depends(get_db),
        q: str | None = None,
        since: str | None = None,
        sender: str | None = None,
        include_all: int = Query(default=0, alias="all"),
        limit: int = LIST_LIMIT_DEFAULT,
        fmt: str = Query(default="text", alias="format"),
    ) -> Response:
        ids = owned_ids(db, user)
        stmt = (
            select(Email, Item.id)
            .outerjoin(Item, Item.email_id == Email.id)
            .where(Email.account_id.in_(ids))
        )
        if not include_all:
            stmt = stmt.where(Email.filtered.is_(False))
        if q:
            match = fts_query(q.replace("\x00", " "))  # NUL 进 MATCH 会报 unterminated string
            rowids = _fts_match_ids(db, match) if match else []
            if not rowids:
                return JSONResponse({"emails": []}) if fmt == "json" else _text(["# emails n=0"])
            stmt = stmt.where(Email.id.in_(rowids))
        if sender:
            stmt = stmt.where(Email.sender.contains(sender, autoescape=True))
        since_dt = clock.parse_since(since)
        if since_dt is not None:
            # 按抓取时间：增量拉取关心的是「上次之后新进来的」，发信时间可能早于上次拉取
            stmt = stmt.where(Email.fetched_at >= since_dt)
        stmt = stmt.order_by(Email.sent_at.is_(None), Email.sent_at.desc()).limit(clamp_limit(limit))
        rows = db.execute(stmt).all()
        if fmt == "json":
            return JSONResponse({"emails": [
                {
                    "id": e.id,
                    "sent_at": e.sent_at.replace(tzinfo=timezone.utc).isoformat() if e.sent_at else None,
                    "sender": e.sender,
                    "subject": e.subject,
                    "item_id": item_id,
                    "filtered": e.filtered,
                }
                for e, item_id in rows
            ]})
        return _text([f"# emails n={len(rows)}"] + [_email_line(e, item_id, clock) for e, item_id in rows])

    @app.get("/emails/{email_id}")
    def get_email(
        email_id: RowId,
        user: User = Depends(current_user),
        db: Session = Depends(get_db),
        max_chars: int = Query(default=BODY_MAX_DEFAULT, alias="max"),
        fmt: str = Query(default="text", alias="format"),
    ) -> Response:
        email = db.execute(
            select(Email).join(Email.account).where(Email.id == email_id, Account.user_sub == user.sub)
        ).scalars().first()
        if email is None:
            raise HTTPException(status_code=404, detail="not found")
        body = email_plain_text(email.text_body, email.html_body).strip()
        body = re.sub(r"\n{3,}", "\n\n", body)
        total = len(body)
        cap = BODY_MAX_CAP if max_chars <= 0 else min(max_chars, BODY_MAX_CAP)
        clipped = total > cap
        body = body[:cap]
        attachments = json.loads(email.attachments_json or "[]")
        item_id = email.item.id if email.item is not None else None
        if fmt == "json":
            return JSONResponse({
                "id": email.id,
                "sent_at": email.sent_at.replace(tzinfo=timezone.utc).isoformat() if email.sent_at else None,
                "sender": email.sender,
                "recipients": email.recipients,
                "subject": email.subject,
                "attachments": attachments,
                "item_id": item_id,
                "body": body,
                "body_total_chars": total,
                "clipped": clipped,
            })
        lines = [
            f"m{email.id} {clock.show(email.sent_at)}" + (f" | t{item_id}" if item_id else ""),
            f"from: {_one_line(email.sender)}",
            f"to: {_one_line(email.recipients, 200)}",
            f"subject: {_one_line(email.subject)}",
        ]
        if attachments:
            lines.append("attachments: " + ", ".join(_one_line(str(a)) for a in attachments))
        lines += ["", body]
        if clipped:
            lines.append(f"[clipped {cap}/{total} chars; ?max=0 for up to {BODY_MAX_CAP}]")
        return _text(lines)

    return app
