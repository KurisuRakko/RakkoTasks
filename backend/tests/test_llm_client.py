"""LLMClient 真实实现离线测试：假 OpenAI client 注入 LLMClient.client，不触网。

覆盖：chat_completion 的 SDK→dict 规范化、json_mode/tools 请求参数、
reasoning_effort 三调用点透传、任何调用都不设置 max_tokens。
"""
from types import SimpleNamespace

from app.llm import LLMClient


class _FakeCompletions:
    """记录每次 create 的 kwargs，按序弹出预设响应。"""

    def __init__(self, responses: list):
        self._responses = list(responses)
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return self._responses.pop(0)


class _FakeChat:
    def __init__(self, responses: list):
        self.completions = _FakeCompletions(responses)


class _FakeClient:
    """假 openai 客户端：只实现 LLMClient 用到的 client.chat.completions.create。"""

    def __init__(self, responses: list):
        self.chat = _FakeChat(responses)


def _tool_call(tc_id: str, name: str, arguments: str) -> SimpleNamespace:
    return SimpleNamespace(
        id=tc_id, type="function", function=SimpleNamespace(name=name, arguments=arguments)
    )


def _message(content=None, tool_calls=None) -> SimpleNamespace:
    return SimpleNamespace(role="assistant", content=content, tool_calls=tool_calls)


def _response(message: SimpleNamespace) -> SimpleNamespace:
    return SimpleNamespace(choices=[SimpleNamespace(message=message)])


def _make_client(responses: list, reasoning_effort: str = "high"):
    """构造注入假 client 的 LLMClient，返回 (client, 假 completions)。"""
    fake = _FakeClient(responses)
    client = LLMClient(
        "http://fake.invalid", "sk-fake", "deepseek-v4-flash",
        reasoning_effort=reasoning_effort,
    )
    client.client = fake
    return client, fake.chat.completions


CLASSIFY_OK = (
    '{"filtered": false, "filter_reason": null, "title": "测试", '
    '"summary": "摘要", "category": "其他", "due_date": null, "actionable": true}'
)


def test_classify_system_contains_new_filter_rules():
    """CLASSIFY_SYSTEM 必须包含新过滤标准的关键要素，防止被改回旧版两条规则。"""
    from app.llm import CLASSIFY_SYSTEM

    for keyword in ("图书馆", "复习课", "回执", "非可选"):
        assert keyword in CLASSIFY_SYSTEM


def test_chat_completion_normalizes_tool_calls():
    """SDK 风格响应（带 tool_calls）→ 纯 dict，每个 tool_call 都必须含 type=="function"。"""
    client, completions = _make_client([
        _response(_message(tool_calls=[
            _tool_call("call_00_a", "search_emails", '{"keywords": "发票"}'),
            _tool_call("call_00_b", "read_emails", '{"ids": [1, 2]}'),
        ])),
    ])
    out = client.chat_completion(
        [{"role": "user", "content": "hi"}],
        tools=[{"type": "function", "function": {"name": "search_emails"}}],
    )
    assert out["role"] == "assistant"
    assert out["content"] == ""
    calls = out["tool_calls"]
    assert len(calls) == 2
    # type 必须为 "function"：search.py 会把 tool_calls 原样回填进下一轮请求，
    # 缺了这个字段 DeepSeek API 直接 400（missing field 'type'）
    for tc in calls:
        assert tc["type"] == "function"
    assert calls[0]["id"] == "call_00_a"
    assert calls[0]["function"] == {"name": "search_emails", "arguments": '{"keywords": "发票"}'}
    assert calls[1]["id"] == "call_00_b"
    assert calls[1]["function"] == {"name": "read_emails", "arguments": '{"ids": [1, 2]}'}
    # 本轮请求确实带了 tools 且未设置 max_tokens
    assert completions.calls[0]["tools"] == [
        {"type": "function", "function": {"name": "search_emails"}}
    ]
    assert "max_tokens" not in completions.calls[0]


def test_chat_completion_without_tool_calls():
    """响应无 tool_calls 时：content 正确，返回 dict 不含 tool_calls 键。"""
    client, _ = _make_client([_response(_message(content='{"answer_md": "x", "citations": []}'))])
    out = client.chat_completion([{"role": "user", "content": "hi"}])
    assert out["content"] == '{"answer_md": "x", "citations": []}'
    assert out["role"] == "assistant"
    assert "tool_calls" not in out

    # content 为 None 时规范化为空字符串
    client, _ = _make_client([_response(_message(content=None))])
    out = client.chat_completion([{"role": "user", "content": "hi"}])
    assert out["content"] == ""
    assert "tool_calls" not in out


def test_chat_completion_passes_json_mode_and_tools():
    """json_mode=True 时带 response_format；tools 非空时带 tools；messages 原样透传。"""
    tools = [{"type": "function", "function": {"name": "search_emails"}}]
    messages = [{"role": "user", "content": "hi"}]
    client, completions = _make_client([_response(_message(content="{}"))])
    client.chat_completion(messages, tools=tools, json_mode=True)
    kw = completions.calls[0]
    assert kw["response_format"] == {"type": "json_object"}
    assert kw["tools"] == tools
    assert kw["messages"] == messages

    # 无 tools / 非 json_mode 时这两键都不出现
    client, completions = _make_client([_response(_message(content="{}"))])
    client.chat_completion(messages)
    kw = completions.calls[0]
    assert "response_format" not in kw
    assert "tools" not in kw


def test_reasoning_effort_high_applied_to_all_call_sites():
    """reasoning_effort="high" 时三个调用点（_chat_json/generate_detail/chat_completion）的请求都带该参数。"""
    client, completions = _make_client([
        _response(_message(content=CLASSIFY_OK)),  # classify_email → _chat_json
        _response(_message(content="**详情**")),    # generate_detail
        _response(_message(content="{}")),          # chat_completion
    ])
    client.classify_email({"subject": "s", "text_body": "b"})
    client.generate_detail({"subject": "s", "text_body": "b"})
    client.chat_completion([{"role": "user", "content": "hi"}])
    assert len(completions.calls) == 3
    for kw in completions.calls:
        assert kw["reasoning_effort"] == "high"
        assert "max_tokens" not in kw


def test_reasoning_effort_empty_omits_key():
    """reasoning_effort="" 时任何请求参数都不含该键（兼容不支持它的模型/供应商）。"""
    client, completions = _make_client([
        _response(_message(content=CLASSIFY_OK)),
        _response(_message(content="**详情**")),
        _response(_message(content="{}")),
    ], reasoning_effort="")
    client.classify_email({"subject": "s", "text_body": "b"})
    client.generate_detail({"subject": "s", "text_body": "b"})
    client.chat_completion([{"role": "user", "content": "hi"}])
    assert len(completions.calls) == 3
    for kw in completions.calls:
        assert "reasoning_effort" not in kw
        assert "max_tokens" not in kw


def test_never_sets_max_tokens():
    """任何调用都不得设置 max_tokens：推理模型下小 max_tokens 会把可见内容全部吃掉。"""
    client, completions = _make_client([
        _response(_message(content=CLASSIFY_OK)),
        _response(_message(content="**详情**")),
        _response(_message(content="{}")),
    ])
    client.classify_email({"subject": "s", "text_body": "b"})
    client.generate_detail({"subject": "s", "text_body": "b"})
    client.chat_completion([{"role": "user", "content": "hi"}], json_mode=True)
    assert len(completions.calls) == 3
    for kw in completions.calls:
        assert "max_tokens" not in kw
