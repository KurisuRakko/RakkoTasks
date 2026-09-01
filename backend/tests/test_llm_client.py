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


def _classify_sections():
    """把 CLASSIFY_SYSTEM 按段落切分为 (保留段, 过滤段, 回执类段)。

    keep：从「必须保留（filtered=false）」到「必须过滤（filtered=true）」之间；
    filter_all：「必须过滤（filtered=true）」之后；
    receipt：过滤四类中第 1 类「回执/确认类」到第 2 类「可选活动推广」之间。
    锚点用带括号的全称标题，避免撞上「判定顺序」行里的简称。
    """
    from app.llm import CLASSIFY_SYSTEM

    _, _, keep = CLASSIFY_SYSTEM.partition("必须保留（filtered=false）")
    keep, _, _ = keep.partition("必须过滤（filtered=true）")
    _, _, filter_all = CLASSIFY_SYSTEM.partition("必须过滤（filtered=true）")
    _, _, receipt = filter_all.partition("1. 回执/确认类")
    receipt, _, _ = receipt.partition("2. 可选活动推广")
    return keep, filter_all, receipt


def test_classify_system_keeps_turnitin_as_submission_voucher():
    """Turnitin 提交回执是「有后果的事」的凭证，必须出现在保留段、不得出现在过滤段。"""
    keep, filter_all, _ = _classify_sections()

    # 分辨依据：回执是否构成有后果的事（成绩、金钱、身份/资格、法律责任）的凭证
    assert "凭证" in keep
    # Turnitin 必须列在保留段的凭证条目里
    assert "Turnitin" in keep
    # 防止把规则改回去：Turnitin 不得出现在过滤段
    assert "Turnitin" not in filter_all
    # 防止改回旧版把 Turnitin 与问卷提交成功并列的措辞
    assert "Turnitin、问卷提交成功" not in keep + filter_all


def test_classify_system_still_filters_non_voucher_receipts():
    """不构成凭证的回执（图书馆座位、问卷提交、验证码）必须仍在过滤清单的回执类里。"""
    _, _, receipt = _classify_sections()

    for keyword in ("图书馆", "问卷", "验证码"):
        assert keyword in receipt


def test_classify_system_reply_rule_judged_by_conclusion_not_re_prefix():
    """论坛/往来回信的过滤收窄：以正文是否有「结论」为判断依据，不以 Re: 前缀为依据。"""
    from app.llm import CLASSIFY_SYSTEM

    # 判断依据关键词：回信是否含结论性内容
    assert "结论" in CLASSIFY_SYSTEM
    # 明确写了不以 Re: 前缀作为判断依据（提示词同时出现 Re: 与「前缀」）
    assert "Re:" in CLASSIFY_SYSTEM
    assert "前缀" in CLASSIFY_SYSTEM
    # 群发回复通知与纯流程性回信仍在过滤清单里
    assert "群发" in CLASSIFY_SYSTEM
    assert "已收到" in CLASSIFY_SYSTEM


def test_classify_system_still_filters_promotions():
    """可选活动推广必须仍在过滤段，防止本轮改动把推广类一起放行。"""
    _, filter_all, _ = _classify_sections()

    assert "活动推广" in filter_all


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


def test_normalize_classify_importance_whitelist():
    """importance 白名单：high/low 原样保留；白名单外（urgent/缺失/None）一律归 normal。"""
    from app.llm import _normalize_classify

    assert _normalize_classify({"importance": "high"})["importance"] == "high"
    assert _normalize_classify({"importance": "low"})["importance"] == "low"
    assert _normalize_classify({"importance": "urgent"})["importance"] == "normal"
    assert _normalize_classify({"importance": "HIGH"})["importance"] == "normal"
    assert _normalize_classify({})["importance"] == "normal"
    assert _normalize_classify({"importance": None})["importance"] == "normal"
