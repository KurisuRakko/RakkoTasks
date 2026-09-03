"""AI 搜索测试：FakeLLM 三轮工具循环 + FTS5 内存库真跑。"""
import json
from datetime import datetime

from sqlalchemy import select, text

from app.agent import _fts_match_ids, fts_query
from app.models import Account, Email, User
from app.search import run_search


class FakeSearchLLM:
    """三轮对话：search_emails → read_emails → 最终 JSON。"""

    def __init__(self, target_id: int):
        self.target_id = target_id
        self.calls: list[dict] = []
        self.tool_results: list[dict] = []  # 记录 read_emails 工具结果（供断言正文提取）

    def chat_completion(self, messages, tools=None, json_mode=False):
        self.calls.append({"tools": bool(tools), "json_mode": json_mode})
        if len(self.calls) == 1:
            return {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {"id": "call_1", "function": {"name": "search_emails", "arguments": json.dumps({"keywords": "发票"})}}
                ],
            }
        if len(self.calls) == 2:
            return {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {"id": "call_2", "function": {"name": "read_emails", "arguments": json.dumps({"ids": [self.target_id]})}}
                ],
            }
        # 第三轮：messages 里已带 read_emails 的工具结果，记录下来供断言
        for m in messages:
            if m.get("role") == "tool" and m.get("tool_call_id") == "call_2":
                self.tool_results.append(json.loads(m["content"]))
        return {
            "role": "assistant",
            "content": json.dumps({"answer_md": "**找到了**：发票已开具", "citations": [self.target_id, 9999]}),
        }


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


def test_agentic_loop_and_citations(session_factory):
    e1_id, e2_id = _seed(session_factory)
    with session_factory() as s:
        llm = FakeSearchLLM(target_id=e1_id)
        result = run_search("发票在哪里？", s, llm, "user-1")

    assert result["answer_md"] == "**找到了**：发票已开具"
    # 富化：join emails 补 subject/sent_at；9999 不存在被过滤
    assert len(result["citations"]) == 1
    cit = result["citations"][0]
    assert cit["email_id"] == e1_id
    assert cit["subject"] == "发票通知"
    assert cit["sent_at"] is not None
    # 三轮对话：都带 tools（第三轮最终回答）
    assert len(llm.calls) == 3
    assert all(c["tools"] for c in llm.calls)


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
        llm = FakeSearchLLM(target_id=e2_id)
        result = run_search("会议内容", s, llm, "user-1")
    # FakeSearchLLM 第二轮 read_emails 读 e2（html 正文），断言没炸且能完成
    assert result["citations"][0]["email_id"] == e2_id
    # 工具结果里的正文来自 html 提取：含关键词、不含标签
    body = llm.tool_results[0]["emails"][0]["text"]
    assert "周五项目启动会" in body
    assert "<p>" not in body
