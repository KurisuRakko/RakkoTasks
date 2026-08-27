"""原邮件展示安全红线：nh3 白名单消毒 + CSP 文档组装（DESIGN.md 第 7 节）。"""
from __future__ import annotations

import re

import nh3

# 允许的标签：结构/表格/图文/行内样式
_ALLOWED_TAGS = {
    "a", "abbr", "b", "blockquote", "br", "caption", "cite", "code", "col",
    "colgroup", "dd", "del", "details", "div", "dl", "dt", "em", "figcaption",
    "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins",
    "kbd", "li", "mark", "ol", "p", "pre", "q", "s", "samp", "small", "span",
    "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th",
    "thead", "tr", "u", "ul", "var",
}

_ALLOWED_ATTRIBUTES = {
    "a": {"href", "title", "target", "name"},
    "img": {"src", "alt", "title", "width", "height", "align"},
    "td": {"align", "colspan", "rowspan", "width", "height", "style", "class"},
    "th": {"align", "colspan", "rowspan", "width", "height", "style", "class"},
    "table": {"align", "width", "border", "cellpadding", "cellspacing", "style", "class"},
    "col": {"align", "span", "width", "style"},
    "colgroup": {"align", "span", "width", "style"},
    "tr": {"align", "style", "class"},
    "div": {"align", "style", "class"},
    "span": {"style", "class"},
    "p": {"align", "style", "class"},
    "h1": {"align", "style", "class"},
    "h2": {"align", "style", "class"},
    "h3": {"align", "style", "class"},
    "h4": {"align", "style", "class"},
    "h5": {"align", "style", "class"},
    "h6": {"align", "style", "class"},
    "ol": {"start", "type", "style", "class"},
    "ul": {"type", "style", "class"},
    "li": {"value", "style", "class"},
    "blockquote": {"cite", "style", "class"},
    "pre": {"style", "class"},
    "code": {"style", "class"},
    "figure": {"style", "class"},
    "figcaption": {"style", "class"},
}

_ALLOWED_URL_SCHEMES = {"http", "https", "mailto", "data", "cid"}

# 各标签通用的样式/对齐属性
_GENERIC_ATTRS = {"style", "class", "align", "width", "height"}
for _tag in _ALLOWED_TAGS:
    _ALLOWED_ATTRIBUTES.setdefault(_tag, set()).update(_GENERIC_ATTRS)


def sanitize_email_html(html: str) -> str:
    """白名单消毒：剥 script/iframe/form/事件属性/javascript: URL，保留 style。"""
    return nh3.clean(
        html,
        tags=_ALLOWED_TAGS,
        attributes=_ALLOWED_ATTRIBUTES,
        url_schemes=_ALLOWED_URL_SCHEMES,
        link_rel="noopener noreferrer",
        strip_comments=True,
    )


def _csp_meta(allow_remote_images: bool) -> str:
    if allow_remote_images:
        img_src = "data: cid: https:"
    else:
        img_src = "data: cid:"
    return (
        '<meta http-equiv="Content-Security-Policy" content='
        f'"default-src \'none\'; style-src \'unsafe-inline\'; img-src {img_src}">'
    )


def _strip_tags(text: str) -> str:
    """粗略去标签（用于无 text_body 时取 html 纯文本），不用于展示。"""
    text = re.sub(r"<style[^>]*>.*?</style>", "", text, flags=re.S | re.I)
    text = re.sub(r"<script[^>]*>.*?</script>", "", text, flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def build_email_document(html: str, allow_remote_images: bool = False) -> str:
    """组装完整 HTML 文档：注入 CSP meta，远程图片默认拦截，仅 data:/cid: 允许。"""
    body = sanitize_email_html(html)
    return (
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\">"
        f"{_csp_meta(allow_remote_images)}"
        "</head><body>"
        f"{body}"
        "</body></html>"
    )
