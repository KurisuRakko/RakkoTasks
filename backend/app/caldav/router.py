"""CalDAV HTTP 层：/.well-known/caldav 与 /caldav/** 的全部方法。

布局（用户段固定为字面量 me，身份完全由 Basic 鉴权决定，不进 URL 也不进日志）：
    /caldav/                               ROOT
    /caldav/principals/me/                 PRINCIPAL
    /caldav/calendars/me/                  HOME
    /caldav/calendars/me/tasks/            唯一的 VTODO 集合
    /caldav/calendars/me/tasks/{stem}.ics  任务对象

两条 catch-all 路由必须在 SPA fallback 之前注册，否则 GET 会被吞成 index.html、
其它方法被吞成 405。这里的一切错误都经 DavError 变成纯文本或 XML，永不 JSON。
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from email.utils import format_datetime
from typing import Callable
from urllib.parse import quote, unquote, urlsplit
from zoneinfo import ZoneInfo

from fastapi import FastAPI, Request
from fastapi.responses import RedirectResponse, Response
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.caldav import store
from app.caldav.auth import authenticate, client_key
from app.caldav.errors import (
    ALLOW_HEADER,
    XML_MEDIA_TYPE,
    DavError,
    forbidden_precondition,
    forbidden_text,
    method_not_allowed,
    not_found,
    payload_too_large,
    precondition_failed,
    too_many_attempts,
    unauthorized,
)
from app.caldav.vtodo import VTodoError, master_vtodo, parse_calendar, read_fields
from app.caldav.xmlio import (
    NS_APPLE,
    NS_CALDAV,
    NS_CS,
    NS_DAV,
    DavResponse,
    PropName,
    PropRequest,
    href_tag,
    parse_propfind,
    parse_proppatch,
    parse_report,
    prop_tag,
    render_forbidden_propstats,
    render_multistatus,
    xml_text,
)
from app.config import Settings
from app.db import session_scope
from app.models import Item, User
from app.ratelimit import RateLimiter

logger = logging.getLogger("rakkotasks.caldav")

ALL_METHODS = [
    "OPTIONS", "GET", "HEAD", "PROPFIND", "REPORT", "PUT", "DELETE", "PROPPATCH",
    "MKCALENDAR", "MKCOL", "MOVE", "COPY", "LOCK", "UNLOCK", "ACL", "POST", "PATCH",
]
XML_BODY_LIMIT = 1024 * 1024
PUT_BODY_LIMIT = 256 * 1024

ROOT_HREF = "/caldav/"
PRINCIPAL_HREF = "/caldav/principals/me/"
HOME_HREF = "/caldav/calendars/me/"
COLLECTION_HREF = "/caldav/calendars/me/tasks/"
COLLECTION_NAME = "RakkoTasks"
CALENDAR_CONTENT_TYPE = "text/calendar; charset=utf-8"

PRIVILEGES = (
    "<d:current-user-privilege-set>"
    + "".join(
        f"<d:privilege><d:{p}/></d:privilege>"
        for p in ("read", "read-current-user-privilege-set", "write", "write-content", "write-properties", "bind", "unbind")
    )
    + "</d:current-user-privilege-set>"
)
SUPPORTED_REPORTS = (
    "<d:supported-report-set>"
    "<d:supported-report><d:report><c:calendar-query/></d:report></d:supported-report>"
    "<d:supported-report><d:report><c:calendar-multiget/></d:report></d:supported-report>"
    "</d:supported-report-set>"
)


# ── 路径解析 ────────────────────────────────────────────────────────

class Target:
    """解析后的资源：kind ∈ root|principal|home|collection|object；object 带 stem。"""

    __slots__ = ("kind", "stem")

    def __init__(self, kind: str, stem: str | None = None):
        self.kind = kind
        self.stem = stem

    @property
    def href(self) -> str:
        if self.kind == "root":
            return ROOT_HREF
        if self.kind == "principal":
            return PRINCIPAL_HREF
        if self.kind == "home":
            return HOME_HREF
        if self.kind == "collection":
            return COLLECTION_HREF
        return object_href(self.stem or "")


def object_href(stem: str) -> str:
    return f"{COLLECTION_HREF}{quote(stem, safe='')}.ics"


def resolve(rest: str) -> Target | None:
    """按段精确匹配；尾斜杠可有可无；其余形状一律 None（404）。"""
    segs = [s for s in rest.split("/") if s]
    if not segs:
        return Target("root")
    if segs == ["principals", "me"]:
        return Target("principal")
    if segs == ["calendars", "me"]:
        return Target("home")
    if segs == ["calendars", "me", "tasks"]:
        return Target("collection")
    if len(segs) == 4 and segs[:3] == ["calendars", "me", "tasks"] and segs[3].endswith(".ics"):
        stem = segs[3][:-4]
        if 0 < len(stem) <= 200:
            return Target("object", stem)
    return None


def stem_from_href(href: str) -> str | None:
    """multiget 里的 href（可能是绝对 URL、可能百分号编码）→ 本集合对象的 stem；不属于本集合 → None。"""
    path = unquote(urlsplit(href).path)
    if not path.startswith(COLLECTION_HREF):
        return None
    target = resolve(path[len("/caldav/"):])
    return target.stem if target is not None and target.kind == "object" else None


# ── 属性表 ──────────────────────────────────────────────────────────

class Ctx:
    """属性求值上下文：当前用户、集合成员（ctag 用）、对象及其 body/etag。"""

    def __init__(self, user: User, zone: ZoneInfo, members: list[Item] | None = None, item: Item | None = None):
        self.user = user
        self.zone = zone
        self.members = members
        self.item = item
        if item is not None:
            self.body, self.etag = store.body_and_etag(item, zone)
        else:
            self.body, self.etag = "", ""


def _fmt_http_date(dt: datetime) -> str:
    """库内 naive 时间按 UTC 解释 → HTTP-date（getlastmodified 用）。"""
    return format_datetime(dt.replace(tzinfo=timezone.utc), usegmt=True)


def _display_name(ctx: Ctx) -> str:
    return xml_text(ctx.user.name or ctx.user.email or ctx.user.sub)


def _address_set(ctx: Ctx) -> str:
    hrefs = ""
    if ctx.user.email:
        hrefs += href_tag(f"mailto:{ctx.user.email}")
    hrefs += href_tag(PRINCIPAL_HREF)
    return hrefs


PropTable = dict[PropName, Callable[[Ctx], str | None]]

_COMMON: PropTable = {
    (NS_DAV, "current-user-principal"): lambda c: href_tag(PRINCIPAL_HREF),
    (NS_DAV, "principal-URL"): lambda c: href_tag(PRINCIPAL_HREF),
    (NS_DAV, "owner"): lambda c: href_tag(PRINCIPAL_HREF),
    (NS_DAV, "current-user-privilege-set"): lambda c: "",  # 整个元素由 _render_prop 特殊处理
    (NS_CALDAV, "calendar-home-set"): lambda c: href_tag(HOME_HREF),
}

ROOT_PROPS: PropTable = {
    **_COMMON,
    (NS_DAV, "resourcetype"): lambda c: "<d:collection/>",
    (NS_DAV, "displayname"): lambda c: COLLECTION_NAME,
    (NS_DAV, "supported-report-set"): lambda c: "",
}

PRINCIPAL_PROPS: PropTable = {
    **_COMMON,
    (NS_DAV, "resourcetype"): lambda c: "<d:collection/><d:principal/>",
    (NS_DAV, "displayname"): _display_name,
    (NS_CALDAV, "calendar-user-address-set"): _address_set,
}

HOME_PROPS: PropTable = {
    **_COMMON,
    (NS_DAV, "resourcetype"): lambda c: "<d:collection/>",
    (NS_DAV, "displayname"): lambda c: COLLECTION_NAME,
}

COLLECTION_PROPS: PropTable = {
    **_COMMON,
    (NS_DAV, "resourcetype"): lambda c: "<d:collection/><c:calendar/>",
    (NS_DAV, "displayname"): lambda c: COLLECTION_NAME,
    (NS_DAV, "supported-report-set"): lambda c: "",
    (NS_CALDAV, "calendar-description"): lambda c: "RakkoTasks 待办",
    (NS_CALDAV, "supported-calendar-component-set"): lambda c: '<c:comp name="VTODO"/>',
    (NS_CALDAV, "supported-calendar-data"): lambda c: '<c:calendar-data content-type="text/calendar" version="2.0"/>',
    (NS_CS, "getctag"): lambda c: store.ctag(c.members or [], c.zone),
    (NS_APPLE, "calendar-color"): lambda c: "#1976D2FF",
    (NS_APPLE, "calendar-order"): lambda c: "1",
}

OBJECT_PROPS: PropTable = {
    (NS_DAV, "getetag"): lambda c: xml_text(c.etag),
    (NS_DAV, "getcontenttype"): lambda c: f"{CALENDAR_CONTENT_TYPE}; component=VTODO",
    (NS_DAV, "resourcetype"): lambda c: "",
    (NS_DAV, "getcontentlength"): lambda c: str(len(c.body.encode("utf-8"))),
    (NS_DAV, "getlastmodified"): lambda c: _fmt_http_date(c.item.updated_at or c.item.created_at),
    (NS_DAV, "creationdate"): lambda c: c.item.created_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
    (NS_CALDAV, "calendar-data"): lambda c: xml_text(c.body),
}

TABLES = {
    "root": ROOT_PROPS,
    "principal": PRINCIPAL_PROPS,
    "home": HOME_PROPS,
    "collection": COLLECTION_PROPS,
    "object": OBJECT_PROPS,
}

# 值本身就是完整元素的两个属性：不用 prop_tag 包一层
_WHOLE_ELEMENT = {
    (NS_DAV, "current-user-privilege-set"): PRIVILEGES,
    (NS_DAV, "supported-report-set"): SUPPORTED_REPORTS,
}


def _render_prop(name: PropName, table: PropTable, ctx: Ctx, mode: str) -> str | None:
    """渲染一个属性；None 表示该资源没有这个属性（进 404 propstat）。"""
    fn = table.get(name)
    if fn is None:
        return None
    if mode == "propname":
        return prop_tag(name)
    if name in _WHOLE_ELEMENT:
        if name == (NS_DAV, "supported-report-set") and table is ROOT_PROPS:
            return prop_tag(name)  # 根上报告集为空
        return _WHOLE_ELEMENT[name]
    value = fn(ctx)
    if value is None:
        return None
    return prop_tag(name, value)


def build_response(target_href: str, table: PropTable, ctx: Ctx, req: PropRequest) -> DavResponse:
    resp = DavResponse(href=target_href)
    names = list(table.keys()) if req.mode != "prop" else req.props
    for name in names:
        rendered = _render_prop(name, table, ctx, req.mode)
        if rendered is None:
            resp.missing.append(name)
        else:
            resp.found.append(rendered)
    return resp


# ── 条件头 ──────────────────────────────────────────────────────────

def _etag_list(header: str) -> list[str]:
    return [t.strip()[2:] if t.strip().startswith("W/") else t.strip() for t in header.split(",") if t.strip()]


def check_preconditions(request: Request, current_etag: str | None) -> None:
    """If-Match / If-None-Match（RFC 7232）：只支持 CalDAV 客户端实际会发的形态。"""
    if_match = request.headers.get("If-Match")
    if if_match is not None:
        if current_etag is None:
            raise precondition_failed()
        if if_match.strip() != "*" and current_etag not in _etag_list(if_match):
            raise precondition_failed()
    if_none = request.headers.get("If-None-Match")
    if if_none is not None and current_etag is not None:
        if if_none.strip() == "*" or current_etag in _etag_list(if_none):
            raise precondition_failed()


# ── 注册与分派 ──────────────────────────────────────────────────────

def register_caldav(app: FastAPI, settings: Settings, limiter: RateLimiter) -> None:
    """挂载 CalDAV 路由。时区在此解析一次：配错宁可启动失败，不能静默把日期算错。"""
    zone = ZoneInfo(settings.local_timezone)
    retention_days = settings.caldav_done_retention_days

    async def well_known(request: Request) -> Response:
        return RedirectResponse(url=ROOT_HREF, status_code=301)

    async def entry(request: Request) -> Response:
        # rest 从 path_params 取而不是做成函数参数：/caldav 那条路由没有它，
        # 若写成带默认值的参数会被 FastAPI 当成查询参数暴露出去
        rest = request.path_params.get("rest", "")
        limit = PUT_BODY_LIMIT if request.method == "PUT" else XML_BODY_LIMIT
        declared = request.headers.get("Content-Length")
        if declared and declared.isdigit() and int(declared) > limit:
            return payload_too_large().to_response()
        body = await request.body()
        if len(body) > limit:
            return payload_too_large().to_response()
        return await run_in_threadpool(_dispatch, request, rest, body)

    def _dispatch(request: Request, rest: str, body: bytes) -> Response:
        try:
            with session_scope(request.app.state.session_factory) as session:
                user = authenticate(session, request.headers.get("Authorization"))
                if user is None:
                    if not limiter.allow(client_key(request)):
                        logger.warning("caldav 鉴权失败过多 client=%s", client_key(request))
                        raise too_many_attempts()
                    raise unauthorized()
                if request.method.upper() in ("MKCALENDAR", "MKCOL"):
                    # 新建集合的目标路径按定义尚不存在，先于路径解析拒绝，否则会被 404 遮住真实原因
                    raise forbidden_text("不支持新建日历集合：列表集合是固定的")
                target = resolve(rest)
                if target is None:
                    raise not_found()
                return _handle(request, session, user, target, body)
        except DavError as e:
            return e.to_response()

    def _handle(request: Request, session: Session, user: User, target: Target, body: bytes) -> Response:
        method = request.method.upper()
        now = datetime.now()
        if method == "OPTIONS":
            return Response(status_code=200, headers={"DAV": "1, 3, access-control, calendar-access", "Allow": ALLOW_HEADER})
        if method == "PROPFIND":
            return _propfind(request, session, user, target, body, now)
        if method == "REPORT":
            return _report(session, user, target, body, now)
        if method in ("GET", "HEAD"):
            return _get(session, user, target, method == "HEAD")
        if method == "PUT":
            return _put(request, session, user, target, body, now)
        if method == "DELETE":
            return _delete(request, session, user, target, now)
        if method == "PROPPATCH":
            return Response(render_forbidden_propstats(target.href, parse_proppatch(body)), status_code=207, media_type=XML_MEDIA_TYPE)
        raise method_not_allowed()

    def _members(session: Session, user: User, now: datetime) -> list[Item]:
        return store.list_members(session, user.sub, now=now, retention_days=retention_days)

    def _propfind(request: Request, session: Session, user: User, target: Target, body: bytes, now: datetime) -> Response:
        depth = request.headers.get("Depth", "0").strip().lower()
        if depth == "infinity":
            raise forbidden_precondition("<d:propfind-finite-depth/>")
        req = parse_propfind(body)
        responses: list[DavResponse] = []
        if target.kind == "object":
            item = store.find_by_stem(session, user.sub, target.stem or "")
            if item is None:
                raise not_found()
            responses.append(build_response(object_href(store.stem_of(item)), OBJECT_PROPS, Ctx(user, zone, item=item), req))
        elif target.kind == "collection":
            members = _members(session, user, now)
            responses.append(build_response(COLLECTION_HREF, COLLECTION_PROPS, Ctx(user, zone, members=members), req))
            if depth == "1":
                responses.extend(
                    build_response(object_href(store.stem_of(i)), OBJECT_PROPS, Ctx(user, zone, item=i), req) for i in members
                )
        else:
            responses.append(build_response(target.href, TABLES[target.kind], Ctx(user, zone), req))
            if target.kind == "home" and depth == "1":
                members = _members(session, user, now)
                responses.append(build_response(COLLECTION_HREF, COLLECTION_PROPS, Ctx(user, zone, members=members), req))
        return Response(render_multistatus(responses), status_code=207, media_type=XML_MEDIA_TYPE)

    def _report(session: Session, user: User, target: Target, body: bytes, now: datetime) -> Response:
        if target.kind != "collection":
            raise forbidden_precondition("<d:supported-report/>")
        req = parse_report(body)
        responses: list[DavResponse] = []
        if req.name == "calendar-multiget":
            for href in req.hrefs:
                stem = stem_from_href(href)
                item = store.find_by_stem(session, user.sub, stem) if stem else None
                if item is None:
                    responses.append(DavResponse(href=href, status="HTTP/1.1 404 Not Found"))
                else:
                    responses.append(build_response(object_href(store.stem_of(item)), OBJECT_PROPS, Ctx(user, zone, item=item), req.props))
        elif req.name == "calendar-query":
            if req.comp_filter == "VTODO":
                responses.extend(
                    build_response(object_href(store.stem_of(i)), OBJECT_PROPS, Ctx(user, zone, item=i), req.props)
                    for i in _members(session, user, now)
                )
        else:
            raise forbidden_precondition("<d:supported-report/>")
        return Response(render_multistatus(responses), status_code=207, media_type=XML_MEDIA_TYPE)

    def _get(session: Session, user: User, target: Target, head: bool) -> Response:
        if target.kind != "object":
            raise method_not_allowed()
        item = store.find_by_stem(session, user.sub, target.stem or "")
        if item is None:
            raise not_found()
        body, etag = store.body_and_etag(item, zone)
        return Response(b"" if head else body, media_type=CALENDAR_CONTENT_TYPE, headers={"ETag": etag})

    def _put(request: Request, session: Session, user: User, target: Target, body: bytes, now: datetime) -> Response:
        if target.kind != "object":
            raise method_not_allowed()
        try:
            text = body.decode("utf-8")
            parsed = read_fields(master_vtodo(parse_calendar(text)), local_zone=zone)
        except (UnicodeDecodeError, VTodoError):
            raise forbidden_precondition("<c:valid-calendar-data/>") from None
        stem = target.stem or ""
        item = store.find_by_stem(session, user.sub, stem)
        if item is None and parsed.uid:
            item = store.find_by_uid(session, user.sub, parsed.uid)  # 同一对象换了文件名
        check_preconditions(request, store.body_and_etag(item, zone)[1] if item is not None else None)
        item, created, ignored = store.apply_put(session, user.sub, item, stem, parsed, text, now=now)
        session.commit()
        _body, etag = store.body_and_etag(item, zone)
        logger.info("caldav put action=%s item_id=%s ignored=%s", "create" if created else "update", item.id, ignored)
        return Response(status_code=201 if created else 204, headers={"ETag": etag})

    def _delete(request: Request, session: Session, user: User, target: Target, now: datetime) -> Response:
        if target.kind != "object":
            raise method_not_allowed()
        item = store.find_by_stem(session, user.sub, target.stem or "")
        if item is None:
            raise not_found()
        check_preconditions(request, store.body_and_etag(item, zone)[1])
        logger.info("caldav delete item_id=%s manual=%s", item.id, item.email_id is None)
        store.apply_delete(session, item, now=now)
        session.commit()
        return Response(status_code=204)

    for path in ("/.well-known/caldav", "/.well-known/caldav/"):
        app.api_route(path, methods=ALL_METHODS, include_in_schema=False)(well_known)
    app.api_route("/caldav", methods=ALL_METHODS, include_in_schema=False)(entry)
    app.api_route("/caldav/{rest:path}", methods=ALL_METHODS, include_in_schema=False)(entry)
