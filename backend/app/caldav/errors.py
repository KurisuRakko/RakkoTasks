"""CalDAV 层的唯一错误出口：DavError → 纯文本 / XML 响应，绝不走 fastapi.HTTPException。

原因：api.py 的全局 HTTPException 处理器回 JSON body，而 CalDAV 客户端只认
WebDAV 语义（状态码 + 可选的 DAV:error XML）。/caldav 路径下任何情况都不能
出现 application/json，否则 iOS 会把整个账户判成「服务器错误」。
"""
from __future__ import annotations

from fastapi.responses import Response

from app.caldav.auth import REALM_HEADER

XML_MEDIA_TYPE = "application/xml; charset=utf-8"
TEXT_MEDIA_TYPE = "text/plain; charset=utf-8"

# OPTIONS/405 共用的 Allow 头：只列我们真正实现的方法
ALLOW_HEADER = "OPTIONS, GET, HEAD, PROPFIND, REPORT, PUT, DELETE, PROPPATCH"

_DAV_ERROR_OPEN = '<?xml version="1.0" encoding="utf-8"?><d:error xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
_DAV_ERROR_CLOSE = "</d:error>"


class DavError(Exception):
    """带状态码与响应体的协议错误；router 顶层捕获后转成 Response。"""

    def __init__(
        self,
        status: int,
        body: str = "",
        *,
        media_type: str = TEXT_MEDIA_TYPE,
        headers: dict[str, str] | None = None,
    ):
        super().__init__(f"{status} {body[:80]}")
        self.status = status
        self.body = body
        self.media_type = media_type
        self.headers = headers or {}

    def to_response(self) -> Response:
        return Response(
            content=self.body,
            status_code=self.status,
            media_type=self.media_type if self.body else None,
            headers=self.headers,
        )


def dav_error_xml(inner: str) -> str:
    """RFC 4918 §16 的 DAV:error 体：inner 是前置条件元素，如 <c:valid-calendar-data/>。"""
    return _DAV_ERROR_OPEN + inner + _DAV_ERROR_CLOSE


def unauthorized() -> DavError:
    """401 + Basic 质询：iOS 靠这个头学会带凭据重试。"""
    return DavError(401, headers={"WWW-Authenticate": REALM_HEADER})


def too_many_attempts() -> DavError:
    return DavError(429, "too many failed authentication attempts", headers={"Retry-After": "60"})


def not_found() -> DavError:
    return DavError(404, "not found")


def method_not_allowed() -> DavError:
    return DavError(405, headers={"Allow": ALLOW_HEADER})


def forbidden_precondition(inner: str) -> DavError:
    """403 + DAV:error，用于协议级前置条件失败（valid-calendar-data、supported-report 等）。"""
    return DavError(403, dav_error_xml(inner), media_type=XML_MEDIA_TYPE)


def forbidden_text(message: str) -> DavError:
    return DavError(403, message)


def precondition_failed() -> DavError:
    return DavError(412, "precondition failed")


def payload_too_large() -> DavError:
    return DavError(413, "payload too large")


def bad_request(message: str) -> DavError:
    return DavError(400, message)
