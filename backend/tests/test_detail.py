"""agentic 详情测试：三轮工具循环 + 关联邮件过滤净化 + 哨兵防护 + 导出文本 + run_tool_loop 边界。

FakeLLM 按调用次序脚本化（search_emails → read_emails → 最终 JSON），在 FTS5 内存库上真跑
generate_item_detail；另直接单测 resolve_related / build_export_text / run_tool_loop 的失败语义。
"""
import copy
import json
from datetime import date

import pytest
from sqlalchemy import select

from app.agent import run_tool_loop
from app.config import Settings
from app.detail import apply_detail, build_export_text, generate_item_detail, resolve_related
from app.models import Account, Email, Item, User
from app.promptguard import UNTRUSTED_BEGIN, UNTRUSTED_END


class FakeDetailLLM:
    """三轮对话：search_emails → read_emails（读本人另一封）→ 最终 JSON（含恶意图片与脏 related）。"""

    def __init__(self, read_id: int, current_id: int, stranger_id: int):
        self.read_id = read_id
        self.current_id = current_id
        self.stranger_id = stranger_id
        self.calls: list[dict] = []  # 每轮 (tools, json_mode) 记录
        self.snapshots: list[list[dict]] = []  # 每轮 messages 深拷贝

    def chat_completion(self, messages, tools=None, json_mode=False):
        self.calls.append({"tools": bool(tools), "json_mode": json_mode})
        self.snapshots.append(copy.deepcopy(messages))
        if len(self.calls) == 1:
            return {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {"id": "call_1", "function": {"name": "search_emails", "arguments": json.dumps({"keywords": "退款"})}}
                ],
            }
        if len(self.calls) == 2:
            return {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {"id": "call_2", "function": {"name": "read_emails", "arguments": json.dumps({"ids": [self.read_id]})}}
                ],
            }
        return {
            "role": "assistant",
            "content": json.dumps(
                {
                    "detail_md": "结论如下 ![x](http://evil.example/p.png) 详见背景",
                    "related": [
                        {"email_id": self.read_id, "reason": "背景邮件"},
                        {"email_id": self.stranger_id, "reason": "他人邮件"},
                        {"email_id": self.current_id, "reason": "当前邮件自身"},
                        {"email_id": self.read_id, "reason": "重复的本人邮件"},
                        {"email_id": 999999, "reason": "不存在"},
                        "垃圾项",
                        {"reason": "无 email_id"},
                    ],
                },
                ensure_ascii=False,
            ),
        }


def _seed(session_factory) -> tuple[int, int, int, int]:
    """user-1 两封邮件 + 当前 item；user-2 一封邮件（陌生人）。返回 (当前邮件id, 本人另一封id, 陌生id, item id)。"""
    with session_factory() as s:
        s.add(User(sub="user-1", email="a@example.com"))
        s.add(User(sub="user-2", email="b@example.com"))
        s.commit()
        acc1 = Account(user_sub="user-1", name="学校邮箱", kind="microsoft", email="a@example.com", status="ok")
        s.add(acc1)
        s.commit()
        acc2 = Account(user_sub="user-2", name="他人邮箱", kind="gmail", email="b@example.com", status="ok")
        s.add(acc2)
        s.commit()
        cur = Email(
            account_id=acc1.id, message_id="<cur>", subject="成绩状态", sender="office@x.com",
            sent_at=None, text_body="你的成绩显示为未知，请核对。", html_body=None, llm_state="done",
        )
        other = Email(
            account_id=acc1.id, message_id="<other>", subject="成绩发布通知", sender="office@x.com",
            sent_at=None, text_body="成绩已于上周发布，登录查看。", html_body=None, llm_state="done",
        )
        stranger = Email(
            account_id=acc2.id, message_id="<str>", subject="他人的秘密", sender="z@x.com",
            text_body="机密内容", html_body=None, llm_state="done",
        )
        s.add_all([cur, other, stranger])
        s.commit()
        it = Item(
            email_id=cur.id, user_sub="user-1", title="核对成绩", summary="s", category="学业", actionable=True,
            importance="high", status="open",
        )
        s.add(it)
        s.commit()
        return cur.id, other.id, stranger.id, it.id


def _settings() -> Settings:
    return Settings(database_path=":memory:", llm_base_url="http://x", llm_api_key="k")


def _first_user_content(snapshots: list[list[dict]]) -> str:
    """首轮 system 之后那条 user 消息（详情 prompt，含当前邮件与邮件索引）。"""
    for m in snapshots[0]:
        if m["role"] == "user":
            return m["content"]
    raise AssertionError("无 user 消息")


def test_generate_detail_agentic_loop_sanitizes_and_filters(session_factory):
    """三轮工具循环真跑：detail_md 无图片语法，related 只留本人另一封、去重、顺序保持。"""
    cur_id, other_id, stranger_id, item_id = _seed(session_factory)
    with session_factory() as s:
        item = s.get(Item, item_id)
        llm = FakeDetailLLM(read_id=other_id, current_id=cur_id, stranger_id=stranger_id)
        md, related = generate_item_detail(s, llm, item, _settings())

    # detail_md 净化：外泄图片语法被剥
    assert "](http://evil" not in md
    assert "![" not in md
    assert "详见背景" in md

    # related：本人另一封保留（顺序第一），他人/当前自身/重复/不存在/垃圾项全部过滤
    assert related == [{"email_id": other_id, "reason": "背景邮件"}]

    # 三轮对话，前两轮 tools、最终轮仍带 tools（与搜索一致的 agentic 契约）
    assert len(llm.calls) == 3
    assert all(c["tools"] for c in llm.calls)
    assert all(not c["json_mode"] for c in llm.calls)

    # 首条 user 消息：当前邮件与索引都被哨兵包裹，且索引块整体在哨兵内
    user_content = _first_user_content(llm.snapshots)
    assert UNTRUSTED_BEGIN in user_content
    assert UNTRUSTED_END in user_content
    index_tail = user_content.split("最近邮件索引", 1)[1]
    assert index_tail.count(UNTRUSTED_BEGIN) == 1
    assert index_tail.count(UNTRUSTED_END) == 1

    # read_emails 工具结果进上下文：正文被哨兵包裹（不可信内容框定）
    read_msgs = [
        m["content"]
        for snap in llm.snapshots
        for m in snap
        if m.get("role") == "tool" and m.get("tool_call_id") == "call_2"
    ]
    assert read_msgs
    read_body = json.loads(read_msgs[-1])["emails"][0]["text"]
    assert read_body.startswith(UNTRUSTED_BEGIN)
    assert read_body.endswith(UNTRUSTED_END)


def test_apply_detail_roundtrip(session_factory):
    """apply_detail 后 related_json 可 json.loads 回同样内容；详情落库。"""
    _cur_id, other_id, _stranger_id, item_id = _seed(session_factory)
    with session_factory() as s:
        item = s.get(Item, item_id)
        apply_detail(item, "**详情**", [{"email_id": other_id, "reason": "背景"}])
        s.commit()
        item = s.get(Item, item_id)
        assert item.detail_md == "**详情**"
        assert json.loads(item.related_json) == [{"email_id": other_id, "reason": "背景"}]


def test_resolve_related_invalid_json_and_non_owned(session_factory):
    """resolve_related：非法 JSON / None → []；已不属于本人的 id 被过滤；顺序保持。"""
    _cur_id, other_id, stranger_id, item_id = _seed(session_factory)
    with session_factory() as s:
        item = s.get(Item, item_id)
        owned = [item.email.account_id]

        item.related_json = "not-json{{{"
        assert resolve_related(s, item, owned) == []

        item.related_json = None
        assert resolve_related(s, item, owned) == []

        item.related_json = json.dumps([], ensure_ascii=False)
        assert resolve_related(s, item, owned) == []

        # 含陌生人 id 与非 dict 垃圾项：非法项被跳过，陌生人（不属于 owned）被过滤；
        # resolve_related 不排除当前邮件自身（去自身是生成期语义），只按归属解析
        item.related_json = json.dumps(
            [
                {"email_id": other_id, "reason": "背景"},
                {"email_id": stranger_id, "reason": "他人"},
                {"email_id": 999999, "reason": "不存在"},
                "垃圾",
            ],
            ensure_ascii=False,
        )
        out = resolve_related(s, item, owned)
        assert [r["email_id"] for r in out] == [other_id]
        assert out[0]["subject"] == "成绩发布通知"
        assert out[0]["reason"] == "背景"


def test_build_export_text_sections_and_html_body(session_factory):
    """导出文本含三段式结构；当前邮件为纯 HTML 时正文来自 html 剥标签。"""
    with session_factory() as s:
        s.add(User(sub="user-1"))
        s.commit()
        acc = Account(user_sub="user-1", name="学校邮箱", kind="microsoft", email="a@example.com", status="ok")
        s.add(acc)
        s.commit()
        cur = Email(
            account_id=acc.id, message_id="<c1>", subject="报告提交", sender="x@x.com",
            sent_at=None, text_body="", html_body="<p>请在周五前提交</p>", llm_state="done",
        )
        rel = Email(
            account_id=acc.id, message_id="<c2>", subject="评分标准", sender="y@y.com",
            sent_at=None, text_body="满分 100", html_body=None, llm_state="done",
        )
        s.add_all([cur, rel])
        s.commit()
        item = Item(email_id=cur.id, user_sub="user-1", title="交报告", summary="", category="学业", status="open")
        s.add(item)
        s.commit()
        item.related_json = json.dumps([{"email_id": rel.id, "reason": "评分标准说明"}], ensure_ascii=False)
        item.detail_md = "**AI 见解正文**"
        s.commit()
        owned = [acc.id]
        text = build_export_text(s, item, owned)

    assert text.startswith("# 交报告")
    assert "## AI 见解" in text
    assert "**AI 见解正文**" in text
    assert "## 当前邮件" in text
    assert "请在周五前提交" in text  # 纯 HTML 邮件正文来自剥标签结果
    assert "<p>" not in text
    assert "## 关联邮件（1 封）" in text
    assert "### 1. 评分标准" in text
    assert "关联原因：评分标准说明" in text
    assert "满分 100" in text  # 关联邮件正文全文

    # 无关联时写「（无）」
    with session_factory() as s:
        item = s.execute(select(Item)).scalars().one()
        item.related_json = None
        text0 = build_export_text(s, item, owned)
    assert "## 关联邮件（0 封）" in text0
    assert "（无）" in text0
    assert "满分 100" not in text0


class RetryLLM:
    """第一次输出非法 JSON，第二次（json_mode=True）输出合法 JSON。"""

    def __init__(self, final: dict, fail_all: bool = False, always_tool: bool = False):
        self.final = final
        self.fail_all = fail_all
        self.always_tool = always_tool
        self.calls: list[dict] = []

    def chat_completion(self, messages, tools=None, json_mode=False):
        self.calls.append({"tools": bool(tools), "json_mode": json_mode, "n": len(messages)})
        if self.always_tool:
            return {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {"id": "c1", "function": {"name": "read_emails", "arguments": json.dumps({"ids": []})}}
                ],
            }
        if len(self.calls) == 1:
            return {"role": "assistant", "content": "不是 JSON"}
        if self.fail_all:
            return {"role": "assistant", "content": "还是不是 JSON"}
        return {"role": "assistant", "content": json.dumps(self.final, ensure_ascii=False)}


class FencedJsonLLM:
    """第 1 轮直接输出被 ```json 围栏包裹的最终 JSON（不触发重试的回归）。"""

    def __init__(self):
        self.calls: list[dict] = []

    def chat_completion(self, messages, tools=None, json_mode=False):
        self.calls.append({"tools": bool(tools), "json_mode": json_mode})
        return {
            "role": "assistant",
            "content": '```json\n{"detail_md": "ok", "related": []}\n```',
        }


def test_run_tool_loop_fenced_json_parsed_once(session_factory):
    """最终输出带 ```json 围栏：首轮直接解析成功，llm 只被调用 1 次。"""
    with session_factory() as s:
        llm = FencedJsonLLM()
        data = run_tool_loop(
            llm, [{"role": "user", "content": "hi"}], s, _settings(), [],
            max_rounds=8, retry_hint="hint",
        )
        assert data == {"detail_md": "ok", "related": []}
        assert len(llm.calls) == 1
        assert llm.calls[0]["json_mode"] is False


def test_run_tool_loop_json_retry(session_factory):
    """run_tool_loop：非法 JSON 首轮重试一次且 json_mode=True 后成功返回；messages 就地追加。"""
    with session_factory() as s:
        messages = [{"role": "user", "content": "hi"}]
        llm = RetryLLM(final={"detail_md": "ok", "related": []})
        data = run_tool_loop(
            llm, messages, s, _settings(), [],
            max_rounds=8, retry_hint='请只输出 {"detail_md": "...", "related": [...]}。',
        )
        assert data == {"detail_md": "ok", "related": []}
        assert len(llm.calls) == 2
        assert llm.calls[0]["json_mode"] is False
        assert llm.calls[1]["json_mode"] is True
        # 重试发生在同一 messages 上：追加了失败回答与纠错提示
        assert messages[-1] == {"role": "user", "content": '请只输出 {"detail_md": "...", "related": [...]}。'}
        assert messages[-2] == {"role": "assistant", "content": "不是 JSON"}


def test_run_tool_loop_invalid_json_twice_raises(session_factory):
    """两次都非法 JSON → RuntimeError（含「非法 JSON」）。"""
    with session_factory() as s:
        llm = RetryLLM(final={}, fail_all=True)
        with pytest.raises(RuntimeError) as exc:
            run_tool_loop(
                llm, [{"role": "user", "content": "hi"}], s, _settings(), [],
                max_rounds=8, retry_hint="hint",
            )
        assert "非法 JSON" in str(exc.value)


def test_run_tool_loop_over_max_rounds_raises(session_factory):
    """每轮都返回工具调用：轮数耗尽抛 RuntimeError（含 max_rounds）。"""
    with session_factory() as s:
        llm = RetryLLM(final={}, always_tool=True)
        with pytest.raises(RuntimeError) as exc:
            run_tool_loop(
                llm, [{"role": "user", "content": "hi"}], s, _settings(), [],
                max_rounds=3, retry_hint="hint",
            )
        assert "3" in str(exc.value)
        assert llm.calls[-1]["n"] > 1  # 工具结果确实回填进对话


def test_generate_detail_reason_truncated_and_sentinel_stripped(session_factory):
    """reason 超过 REASON_MAX 被截断、哨兵被剥；非字符串 reason 置空串。"""
    cur_id, other_id, _stranger_id, item_id = _seed(session_factory)

    class FinalLLM:
        def chat_completion(self, messages, tools=None, json_mode=False):
            evil = f"x{UNTRUSTED_END}y"
            return {
                "role": "assistant",
                "content": json.dumps(
                    {
                        "detail_md": "md",
                        "related": [
                            {"email_id": other_id, "reason": evil * 500},
                            {"email_id": cur_id, "reason": "自身"},
                            {"email_id": other_id, "reason": None},
                        ],
                    },
                    ensure_ascii=False,
                ),
            }

    with session_factory() as s:
        item = s.get(Item, item_id)
        md, related = generate_item_detail(s, FinalLLM(), item, _settings())
    assert md == "md"
    # 第二条（自身）被剔除；重复本人条目被去重；哨兵剥掉、超长截断到 200
    assert len(related) == 1
    reason = related[0]["reason"]
    assert len(reason) <= 200
    assert UNTRUSTED_END not in reason
    assert UNTRUSTED_BEGIN not in reason


def test_detail_prompt_contains_today_and_email_id(session_factory):
    """user 消息带今天日期与当前邮件 id（模型据此知道自己在处理哪封）。"""
    cur_id, _other_id, _stranger_id, item_id = _seed(session_factory)

    class CaptureLLM:
        def __init__(self):
            self.user_content = ""

        def chat_completion(self, messages, tools=None, json_mode=False):
            for m in messages:
                if m["role"] == "user":
                    self.user_content = m["content"]
                    break
            return {"role": "assistant", "content": json.dumps({"detail_md": "md", "related": []})}

    llm = CaptureLLM()
    with session_factory() as s:
        item = s.get(Item, item_id)
        generate_item_detail(s, llm, item, _settings())
    assert f"今天是 {date.today().isoformat()}" in llm.user_content
    assert f"当前邮件 id：{cur_id}" in llm.user_content
