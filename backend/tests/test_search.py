"""邮件检索工具测试：FTS5 内存库真跑 + read_emails 正文提取。"""
from datetime import datetime

from sqlalchemy import select, text

from app.agent import _dispatch_tool, _fts_match_ids, fts_query
from app.config import Settings
from app.models import Account, Email, User


def _settings() -> Settings:
    return Settings(database_path=":memory:", llm_base_url="http://x", llm_api_key="k")


def _seed(session_factory) -> tuple[int, int]:
    with session_factory() as s:
        s.add(User(sub="user-1"))
        s.commit()
        acc = Account(user_sub="user-1", name="学校邮箱", kind="microsoft", email="a@example.com", status="ok")
        s.add(acc)
        s.commit()
        e1 = Email(
            account_id=acc.id, message_id="<e1>", subject="发票通知", sender="b@example.com",
            sent_at=datetime.now(), text_body="发票已开具，请查收附件。", html_body=None, llm_state="done",
        )
        e2 = Email(
            account_id=acc.id, message_id="<e2>", subject="会议通知", sender="c@example.com",
            sent_at=datetime.now(), text_body="", html_body="<p>周五项目启动会</p>", llm_state="done",
        )
        s.add_all([e1, e2])
        s.commit()
        return e1.id, e2.id


def test_fts_search_runs_in_memory(session_factory):
    """FTS5 虚表 + 触发器在内存库真跑（StaticPool 共享连接）。"""
    e1_id, e2_id = _seed(session_factory)
    with session_factory() as s:
        # 原生 MATCH 命中 text_body
        hit_ids = s.execute(
            text("SELECT rowid FROM emails_fts WHERE emails_fts MATCH :q").bindparams(q="发票*")
        ).scalars().all()
        assert e1_id in hit_ids
        assert e2_id not in hit_ids

        # 主题也可检索
        hit_ids = s.execute(
            text("SELECT rowid FROM emails_fts WHERE emails_fts MATCH :q").bindparams(q="会议*")
        ).scalars().all()
        assert e2_id in hit_ids

        # 多关键词 OR + 特殊字符转义
        assert fts_query('a b"c') == 'a* OR "b""c"'
        q = fts_query("会议 发票")
        assert q == "会议* OR 发票*"
        hits = s.execute(
            text("SELECT rowid FROM emails_fts WHERE emails_fts MATCH :q").bindparams(q=q)
        ).scalars().all()
        assert e1_id in hits
        assert e2_id in hits


def test_fts_query_punctuation_tokens_quoted_phrases():
    """非 \\w 字符（. @ % + 等）token 整体按短语加引号且不加通配；纯词 token 保持 * 前缀。"""
    # 生产报错回归：rakko.cn 曾裸拼为 "rakko.cn*" 触发 fts5: syntax error near "."
    assert fts_query("rakko.cn domain verify") == '"rakko.cn" OR domain* OR verify*'
    # 每个含标点的 token 都被引号包裹，纯 CJK 词加 *
    assert fts_query("a@b.com 50% C++ 会议") == '"a@b.com" OR "50%" OR "C++" OR 会议*'


def test_fts_punctuation_queries_run_in_memory(session_factory):
    """上述含标点查询在真实 FTS5 虚表上执行 _fts_match_ids 不抛异常（语法错误回归）。"""
    _seed(session_factory)
    with session_factory() as s:
        for keywords in ("rakko.cn domain verify", "a@b.com 50% C++ 会议", 'a b"c'):
            ids = _fts_match_ids(s, fts_query(keywords))
            assert isinstance(ids, list)


def test_read_emails_falls_back_to_html_text(session_factory):
    """无 text_body 的邮件用 html 剥标签返回（回归：read_emails 行为不变）。"""
    e1_id, e2_id = _seed(session_factory)
    with session_factory() as s:
        owned = list(s.execute(select(Account.id)).scalars().all())
        result = _dispatch_tool(s, "read_emails", {"ids": [e2_id]}, _settings(), owned)
    # 工具结果里的正文来自 html 提取：含关键词、不含标签
    assert result["ok"] is True
    body = result["emails"][0]["text"]
    assert "周五项目启动会" in body
    assert "<p>" not in body
