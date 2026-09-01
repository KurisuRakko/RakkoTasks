"""email_plain_text 单元测试：纯文本优先、HTML 回退、script/style 内容剥离。"""
from app.emailtext import email_plain_text


def test_plain_text_used_when_present():
    """text_body 非空时原样返回，不碰 html。"""
    assert email_plain_text("你好，正文", "<p>html 正文</p>") == "你好，正文"


def test_html_fallback_when_plain_empty():
    """text_body 为空且有 html：返回去标签后的文本，含正文关键词、不含标签。"""
    out = email_plain_text("", "<p>请提交<b>实验报告</b></p>")
    assert "<" not in out
    assert "实验报告" in out


def test_both_empty_returns_empty_string():
    assert email_plain_text("", None) == ""
    assert email_plain_text(None, "") == ""
    assert email_plain_text("", "") == ""


def test_script_and_style_content_stripped():
    """HTML 里的 script/style 内容不得出现在提取结果里。"""
    html = "<style>.x{color:red}</style><p>正文关键词</p><script>alert(1)</script>"
    out = email_plain_text("", html)
    assert "alert" not in out
    assert "color:red" not in out
    assert "正文关键词" in out
    assert "<" not in out
