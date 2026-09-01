"""邮件正文取值：优先 text/plain，为空时从 HTML 提取纯文本（供 LLM 消费）。

search / sync / api 三个调用方共用，避免各自实现一份「HTML 去标签」漂移。
"""
from __future__ import annotations

from app.sanitizer import _strip_tags


def email_plain_text(text_body: str | None, html_body: str | None) -> str:
    """取邮件的纯文本正文：优先 text/plain；为空则从 HTML 提取。

    很多发件方只发 HTML（无 text/plain 分段），此时 text_body 为空，
    若不回退到 HTML，喂给 LLM 的正文就是空的——实测这类邮件占四成。
    去标签复用 sanitizer._strip_tags（已处理 script/style 与空白压缩），不重复实现。
    """
    if text_body:
        return text_body
    if html_body:
        return _strip_tags(html_body)
    return ""
