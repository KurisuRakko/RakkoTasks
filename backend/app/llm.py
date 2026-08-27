"""LLM 管线（OpenAI-compatible）：classify_email / generate_detail。

真实实现走 openai SDK（base_url=LLM_BASE_URL）；测试注入 FakeLLM（仅需同签名方法）。
"""
from __future__ import annotations

import json

from openai import OpenAI

from app.config import Settings, get_settings

CLASSIFY_SYSTEM = """你是 RakkoTasks 的邮件处理助手。用户把邮件自动转成待办事项，你的任务是判断每封邮件是否值得建任务，并提取信息。

请严格按以下标准判断是否过滤（filtered=true）：
- 纯广告/营销/newsletter（订阅邮件、促销、推广）；
- 标题党：标题声称紧急但正文没有实际要办的事。

其余邮件不过滤（filtered=false），包括通知类邮件（即使不可行动也要生成条目，actionable=false，便于用户看过即勾掉）。

分类固定为以下之一：学业、工作、个人、账单、其他。
due_date 为可执行的截止时间，格式 YYYY-MM-DD；没有明确截止时间则为 null。
title 为不超过 30 字的任务标题；summary 为 1-2 句摘要。
所有输出一律使用中文。

只输出 JSON，不要输出任何其他文字，格式：
{"filtered": false, "filter_reason": null, "title": "任务标题", "summary": "摘要",
 "category": "学业|工作|个人|账单|其他", "due_date": "YYYY-MM-DD 或 null", "actionable": true}"""


def _email_prompt(email_info: dict) -> str:
    body = (email_info.get("text_body") or "")[:8000]
    return (
        f"主题：{email_info.get('subject')}\n"
        f"发件人：{email_info.get('sender')}\n"
        f"日期：{email_info.get('sent_at') or '未知'}\n"
        f"正文：\n{body or '（无纯文本正文）'}"
    )


class LLMClient:
    """openai SDK 封装：分类 + 详情生成。"""

    def __init__(self, base_url: str, api_key: str, model: str):
        self.model = model
        self.client = OpenAI(base_url=base_url, api_key=api_key)

    def classify_email(self, email_info: dict) -> dict:
        """单封邮件 → DESIGN.md 4.1 JSON；非法 JSON 重试 1 次，再失败抛异常。"""
        messages = [
            {"role": "system", "content": CLASSIFY_SYSTEM},
            {"role": "user", "content": _email_prompt(email_info)},
        ]
        for attempt in range(2):
            text = self._chat_json(messages)
            try:
                return _normalize_classify(json.loads(text))
            except (json.JSONDecodeError, TypeError, ValueError):
                if attempt == 0:
                    # 重试一次：追加纠错指令
                    messages.append(
                        {"role": "user", "content": "你上一次的输出不是合法 JSON，请只输出一个合法 JSON 对象。"}
                    )
                    continue
                raise
        raise RuntimeError("classify 输出非法 JSON")  # 不可达，防御性保留

    def generate_detail(self, email_info: dict) -> str:
        """基于邮件全文写中文 Markdown 详情（DESIGN.md 4.2）。"""
        body = (email_info.get("text_body") or "")[:8000]
        messages = [
            {
                "role": "system",
                "content": (
                    "你是 RakkoTasks 的任务详情助手。根据邮件内容为待办条目生成中文详情，"
                    "用 Markdown 输出。剔除客套话、签名档、免责声明和无关信息，"
                    "保留关键事实、时间、链接和要求的动作。直接输出 Markdown 正文。"
                ),
            },
            {
                "role": "user",
                "content": (
                    f"主题：{email_info.get('subject')}\n"
                    f"发件人：{email_info.get('sender')}\n"
                    f"日期：{email_info.get('sent_at') or '未知'}\n"
                    f"正文：\n{body or '（无纯文本正文）'}"
                ),
            },
        ]
        resp = self.client.chat.completions.create(
            model=self.model,
            messages=messages,
            temperature=0.3,
        )
        return resp.choices[0].message.content or ""

    def _chat_json(self, messages: list[dict]) -> str:
        resp = self.client.chat.completions.create(
            model=self.model,
            messages=messages,
            response_format={"type": "json_object"},
            temperature=0.2,
        )
        return resp.choices[0].message.content or ""


def _normalize_classify(data: dict) -> dict:
    """规范化 LLM 输出：默认值兜底（category 非法归“其他”由 sync 处理，这里保结构）。"""
    return {
        "filtered": bool(data.get("filtered", False)),
        "filter_reason": data.get("filter_reason"),
        "title": str(data.get("title") or "")[:30],
        "summary": str(data.get("summary") or ""),
        "category": str(data.get("category") or "其他"),
        "due_date": data.get("due_date"),
        "actionable": bool(data.get("actionable", True)),
    }


def get_llm(settings: Settings | None = None) -> LLMClient:
    """LLM 客户端工厂：测试 monkeypatch app.llm.get_llm 注入 FakeLLM。"""
    settings = settings or get_settings()
    if not settings.llm_base_url or not settings.llm_api_key:
        raise RuntimeError("未配置 LLM_BASE_URL / LLM_API_KEY")
    return LLMClient(settings.llm_base_url, settings.llm_api_key, settings.llm_model)
