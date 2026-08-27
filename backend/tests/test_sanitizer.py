"""消毒与 CSP 文档组装测试（DESIGN.md 第 7 节）。"""
from app.sanitizer import build_email_document, sanitize_email_html


def test_script_and_event_attrs_stripped():
    html = '<p onclick="alert(1)">你好</p><script>evil()</script><img src="x" onerror="steal()">'
    out = sanitize_email_html(html)
    assert "<script" not in out
    assert "onclick" not in out
    assert "onerror" not in out
    assert "你好" in out


def test_javascript_url_stripped():
    out = sanitize_email_html('<a href="javascript:alert(1)">点我</a><a href="https://ok.example">正常</a>')
    assert "javascript:" not in out
    assert 'href="https://ok.example"' in out


def test_style_preserved():
    out = sanitize_email_html('<p style="color:red;font-weight:bold">红色</p>')
    assert "style=" in out
    assert "color:red" in out
    assert "红色" in out


def test_csp_meta_present():
    doc = build_email_document("<p>x</p>")
    assert 'http-equiv="Content-Security-Policy"' in doc
    assert "default-src 'none'" in doc
    assert "style-src 'unsafe-inline'" in doc
    assert "img-src data: cid:" in doc


def test_remote_images_variants():
    # 默认：拦截远程图片
    default_doc = build_email_document("<img src='https://x/y.png'>")
    assert "img-src data: cid:" in default_doc
    assert "https:" not in default_doc.split("img-src")[1].split(">")[0]
    # 允许远程图片：img-src 追加 https:
    remote_doc = build_email_document("<img src='https://x/y.png'>", allow_remote_images=True)
    assert "img-src data: cid: https:" in remote_doc
