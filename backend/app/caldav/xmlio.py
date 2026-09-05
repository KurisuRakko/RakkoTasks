"""CalDAV 请求 XML 解析与 207 multistatus 组装。

解析用标准库 ElementTree：它拒绝外部实体（无 XXE），内部实体展开靴带的
billion-laughs 由「先鉴权 + 请求体上限」兜住（见 router）。输出侧不走
ElementTree 序列化而是手写拼接：属性值里大量是我们自己生成的 XML 片段
（resourcetype、privilege-set、calendar-data 等），字符串拼接比构树再序列化直接，
也让命名空间前缀保持稳定，便于测试断言。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape

from app.caldav.errors import bad_request

NS_DAV = "DAV:"
NS_CALDAV = "urn:ietf:params:xml:ns:caldav"
NS_CS = "http://calendarserver.org/ns/"
NS_APPLE = "http://apple.com/ns/ical/"

# multistatus 根上声明的固定前缀；未知命名空间的属性在 404 propstat 里就地声明
PREFIXES = {NS_DAV: "d", NS_CALDAV: "c", NS_CS: "cs", NS_APPLE: "ical"}

XML_DECL = '<?xml version="1.0" encoding="utf-8"?>'
_MULTISTATUS_OPEN = (
    f'{XML_DECL}<d:multistatus xmlns:d="{NS_DAV}" xmlns:c="{NS_CALDAV}" '
    f'xmlns:cs="{NS_CS}" xmlns:ical="{NS_APPLE}">'
)

PropName = tuple[str, str]


def _split_tag(tag: str) -> PropName:
    """ElementTree 的 "{ns}local" → (ns, local)；无命名空间时 ns 为空串。"""
    if tag.startswith("{"):
        ns, _, local = tag[1:].partition("}")
        return ns, local
    return "", tag


def _parse_xml(body: bytes) -> ET.Element | None:
    """空体返回 None；解析失败按 400 处理（客户端发了坏 XML，不是我们的错）。"""
    if not body.strip():
        return None
    try:
        return ET.fromstring(body)
    except ET.ParseError:
        raise bad_request("malformed xml") from None


@dataclass
class PropRequest:
    """PROPFIND / REPORT 里的属性请求：mode 为 prop（按列表）、allprop、propname。"""

    mode: str = "allprop"
    props: list[PropName] = field(default_factory=list)


def _read_prop_request(root: ET.Element | None) -> PropRequest:
    if root is None:
        return PropRequest()
    for child in root:
        ns, local = _split_tag(child.tag)
        if ns != NS_DAV:
            continue
        if local == "allprop":
            return PropRequest(mode="allprop")
        if local == "propname":
            return PropRequest(mode="propname")
        if local == "prop":
            return PropRequest(mode="prop", props=[_split_tag(p.tag) for p in child])
    return PropRequest()


def parse_propfind(body: bytes) -> PropRequest:
    """RFC 4918 §9.1：空体等价于 allprop。"""
    return _read_prop_request(_parse_xml(body))


@dataclass
class ReportRequest:
    """REPORT 请求：name 为报告名（calendar-multiget / calendar-query / 其他）。

    hrefs 只对 multiget 有意义；comp_filter 是 calendar-query 里 VCALENDAR 下一层
    comp-filter 的 name（缺失视为 VTODO——客户端不筛就是全要）。
    """

    name: str
    props: PropRequest
    hrefs: list[str] = field(default_factory=list)
    comp_filter: str = "VTODO"


def parse_report(body: bytes) -> ReportRequest:
    root = _parse_xml(body)
    if root is None:
        raise bad_request("empty report body")
    _ns, name = _split_tag(root.tag)
    req = ReportRequest(name=name, props=_read_prop_request(root))
    for child in root:
        ns, local = _split_tag(child.tag)
        if ns == NS_DAV and local == "href" and child.text:
            req.hrefs.append(child.text.strip())
        elif ns == NS_CALDAV and local == "filter":
            req.comp_filter = _inner_comp_filter(child)
    return req


def _inner_comp_filter(filter_el: ET.Element) -> str:
    """filter → comp-filter(VCALENDAR) → comp-filter(X)：取 X；缺失视为 VTODO。"""
    for outer in filter_el:
        if _split_tag(outer.tag) != (NS_CALDAV, "comp-filter"):
            continue
        for inner in outer:
            if _split_tag(inner.tag) == (NS_CALDAV, "comp-filter"):
                return (inner.get("name") or "VTODO").upper()
    return "VTODO"


def parse_proppatch(body: bytes) -> list[PropName]:
    """收集 set/remove 下 prop 里的属性名；我们对每一个都回 403，所以只要名字。"""
    root = _parse_xml(body)
    if root is None:
        return []
    names: list[PropName] = []
    for op in root:
        if _split_tag(op.tag) not in ((NS_DAV, "set"), (NS_DAV, "remove")):
            continue
        for prop in op:
            if _split_tag(prop.tag) != (NS_DAV, "prop"):
                continue
            names.extend(_split_tag(p.tag) for p in prop)
    return names


def xml_text(value: str) -> str:
    """属性文本值转义（& < >）；href 已先经百分号编码再进这里。"""
    return escape(value)


def prop_tag(name: PropName, inner: str = "") -> str:
    """把 (ns, local) 渲染成带前缀的元素；未知命名空间就地声明 x: 前缀，无命名空间用默认空 xmlns。"""
    ns, local = name
    if ns in PREFIXES:
        tag = f"{PREFIXES[ns]}:{local}"
        return f"<{tag}>{inner}</{tag}>" if inner else f"<{tag}/>"
    if not ns:
        return f'<{local} xmlns="">{inner}</{local}>' if inner else f'<{local} xmlns=""/>'
    return f'<x:{local} xmlns:x="{xml_text(ns)}">{inner}</x:{local}>' if inner else f'<x:{local} xmlns:x="{xml_text(ns)}"/>'


def href_tag(href: str) -> str:
    return f"<d:href>{xml_text(href)}</d:href>"


@dataclass
class DavResponse:
    """一个 <d:response>：有属性时按 200 / 404 两个 propstat 输出，否则只输出 status。"""

    href: str
    found: list[str] = field(default_factory=list)  # 已渲染好的属性元素
    missing: list[PropName] = field(default_factory=list)
    status: str | None = None  # 形如 "HTTP/1.1 404 Not Found"；multiget 找不到 href 时用

    def render(self) -> str:
        parts = ["<d:response>", href_tag(self.href)]
        if self.status is not None:
            parts.append(f"<d:status>{self.status}</d:status>")
        else:
            if self.found:
                parts.append(
                    "<d:propstat><d:prop>" + "".join(self.found) + "</d:prop>"
                    "<d:status>HTTP/1.1 200 OK</d:status></d:propstat>"
                )
            if self.missing:
                parts.append(
                    "<d:propstat><d:prop>" + "".join(prop_tag(n) for n in self.missing) + "</d:prop>"
                    "<d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>"
                )
            if not self.found and not self.missing:
                # 客户端一个属性都没要（propname 表为空等边界）：仍给一个空的 200 propstat 保证结构合法
                parts.append("<d:propstat><d:prop/><d:status>HTTP/1.1 200 OK</d:status></d:propstat>")
        parts.append("</d:response>")
        return "".join(parts)


def render_multistatus(responses: list[DavResponse]) -> bytes:
    return (_MULTISTATUS_OPEN + "".join(r.render() for r in responses) + "</d:multistatus>").encode("utf-8")


def render_forbidden_propstats(href: str, names: list[PropName]) -> bytes:
    """PROPPATCH 的 207：每个属性各一个 403 propstat，让客户端逐属性知道没生效。"""
    body = [_MULTISTATUS_OPEN, "<d:response>", href_tag(href)]
    for name in names:
        body.append(
            f"<d:propstat><d:prop>{prop_tag(name)}</d:prop>"
            "<d:status>HTTP/1.1 403 Forbidden</d:status></d:propstat>"
        )
    body.append("</d:response></d:multistatus>")
    return "".join(body).encode("utf-8")
