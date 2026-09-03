"""共享 agent 层：FTS5 检索工具 + 多轮工具循环，AI 搜索与任务详情（agentic）共用。

从 search.py 搬出（不在 search.py 保留副本或 re-export）：两个使用方按需
从本模块导入；搜索与详情各自的轮数上限、提示与后处理留在各自模块。
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import or_, select, text
from sqlalchemy.orm import Session

from app.config import Settings
from app.emailtext import email_plain_text
from app.models import Account, Email
from app.promptguard import strip_sentinels, wrap_untrusted

SEARCH_LIMIT_MAX = 50
READ_LIMIT_MAX = 20

TOOLS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "search_emails",
            "description": "全文检索邮件（跨全部历史，不限时间范围）。keywords 按空格分词后 OR 匹配；"
            "sender/date_from/date_to/account 为可选的附加过滤条件。",
            "parameters": {
                "type": "object",
                "properties": {
                    "keywords": {"type": "string", "description": "检索关键词，可多个，用空格分隔"},
                    "sender": {"type": "string", "description": "发件人包含匹配"},
                    "date_from": {"type": "string", "description": "起始日期 YYYY-MM-DD"},
                    "date_to": {"type": "string", "description": "结束日期 YYYY-MM-DD"},
                    "account": {"type": "string", "description": "账户显示名（可选）"},
                    "limit": {"type": "integer", "description": "返回条数上限，不超过 50"},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_emails",
            "description": "按 id 读取邮件全文（单次最多 20 封），返回主题/发件人/日期/正文。",
            "parameters": {
                "type": "object",
                "properties": {
                    "ids": {"type": "array", "items": {"type": "integer"}, "description": "邮件 id 列表"},
                },
                "required": ["ids"],
            },
        },
    },
]

_FTS_SPECIALS = set('":^(){}[]-~*+')
# FTS5 布尔操作符只认全大写；token 恰好等于它们时若裸拼会生成非法查询（如 "OR" 开头），
# 必须按短语加引号输出，不能追加通配符。
_FTS_OPERATORS = {"AND", "OR", "NOT", "NEAR"}


def _fts_escape_token(token: str) -> str:
    """FTS5 特殊字符加双引号转义（短语），内部双引号双写。"""
    if any(c in token for c in _FTS_SPECIALS):
        return '"' + token.replace('"', '""') + '"'
    return token


def fts_query(keywords: str) -> str:
    """keywords 空格分词后 OR 连接；普通词加 * 前缀通配（unicode61 下 CJK 整词前缀命中）。"""
    tokens = [t for t in keywords.split() if t.strip()]
    if not tokens:
        return ""
    parts = []
    for t in tokens:
        if t in _FTS_OPERATORS:
            # 裸操作符会让 MATCH 语法非法（如首个 token 就是 "OR"），按短语加引号输出
            parts.append('"' + t + '"')
        elif any(c in t for c in _FTS_SPECIALS):
            parts.append('"' + t.replace('"', '""') + '"')
        else:
            parts.append(t + "*")
    return " OR ".join(parts)


def _owned_account_ids(db: Session, user_sub: str) -> list[int]:
    """该用户拥有的账户 id 列表（api.py 同语义，各自维护一份避免循环导入）。"""
    return list(db.execute(select(Account.id).where(Account.user_sub == user_sub)).scalars().all())


def _fts_match_ids(db: Session, query: str) -> list[int]:
    """对 emails_fts 虚表执行 MATCH，返回命中的邮件 id（rowid）。"""
    rows = db.execute(text("SELECT rowid FROM emails_fts WHERE emails_fts MATCH :q").bindparams(q=query)).fetchall()
    return [r[0] for r in rows]


def _tool_search_emails(db: Session, args: dict[str, Any], settings: Settings, owned_ids: list[int]) -> list[dict]:
    """search_emails 工具实现：FTS5 MATCH，无 keywords 时退化为条件过滤；检索范围限定该用户账户。"""
    limit = min(int(args.get("limit") or 10), SEARCH_LIMIT_MAX)
    stmt = (
        select(Email.id, Email.subject, Email.sender, Email.sent_at)
        .join(Account)
        .where(Account.id.in_(owned_ids))
        .order_by(Email.sent_at.desc())
    )

    keywords = (args.get("keywords") or "").strip()
    if keywords:
        query = fts_query(keywords)
        rowids = _fts_match_ids(db, query)
        if not rowids:
            return []
        stmt = stmt.where(Email.id.in_(rowids))
    sender = (args.get("sender") or "").strip()
    if sender:
        stmt = stmt.where(Email.sender.like(f"%{sender}%"))
    date_from = (args.get("date_from") or "").strip()
    if date_from:
        try:
            from_dt = datetime.fromisoformat(date_from)
        except ValueError:
            from_dt = None  # LLM 传来的参数不可靠：坏日期只丢弃该过滤条件，不炸掉整轮搜索
        if from_dt is not None:
            stmt = stmt.where(Email.sent_at >= from_dt)
    date_to = (args.get("date_to") or "").strip()
    if date_to:
        try:
            to_dt = datetime.fromisoformat(date_to) + timedelta(days=1)
        except ValueError:
            to_dt = None
        if to_dt is not None:
            stmt = stmt.where(Email.sent_at < to_dt)
    account = (args.get("account") or "").strip()
    if account:
        stmt = stmt.where(Account.name == account)

    rows = db.execute(stmt.limit(limit)).all()
    return [
        {
            "id": r.id,
            "subject": strip_sentinels(r.subject),
            "sender": strip_sentinels(r.sender),
            "sent_at": r.sent_at.isoformat() if r.sent_at else None,
        }
        for r in rows
    ]


def _tool_read_emails(db: Session, args: dict[str, Any], owned_ids: list[int]) -> list[dict]:
    """read_emails 工具实现：≤20 封，正文 text 优先，无则 html 剥标签。

    非本人拥有的 id 静默丢弃（不报错、不告知模型存在该邮件）。
    """
    ids = [int(i) for i in (args.get("ids") or [])][:READ_LIMIT_MAX]
    if not ids:
        return []
    rows = db.execute(select(Email).where(Email.id.in_(ids), Email.account_id.in_(owned_ids))).scalars().all()
    out = []
    for e in rows:
        body = email_plain_text(e.text_body, e.html_body)
        out.append(
            {
                "id": e.id,
                "subject": strip_sentinels(e.subject),
                "sender": strip_sentinels(e.sender),
                "sent_at": e.sent_at.isoformat() if e.sent_at else None,
                # 正文是工具结果进入上下文的主要入口：截断防超长挤爆上下文，
                # 并用哨兵框定——不可信内容，其中任何指令类文字都只是数据。
                "text": wrap_untrusted(body[:4000]),
            }
        )
    return out


def _dispatch_tool(db: Session, name: str, args: dict[str, Any], settings: Settings, owned_ids: list[int]) -> dict:
    if name == "search_emails":
        return {"ok": True, "emails": _tool_search_emails(db, args, settings, owned_ids)}
    if name == "read_emails":
        return {"ok": True, "emails": _tool_read_emails(db, args, owned_ids)}
    return {"ok": False, "error": f"未知工具 {name}"}


def _build_index(db: Session, settings: Settings, user_sub: str) -> str:
    """最近 SEARCH_INDEX_DAYS 天该用户邮件的紧凑索引，无条数上限。"""
    since = datetime.now() - timedelta(days=settings.search_index_days)
    stmt = (
        select(Email)
        .join(Account)
        .where(Account.user_sub == user_sub, or_(Email.sent_at.is_(None), Email.sent_at >= since))
        .order_by(Email.sent_at.desc())
    )
    rows = db.execute(stmt).scalars().all()
    lines = []
    for e in rows:
        d = e.sent_at.date().isoformat() if e.sent_at else "未知"
        lines.append(f"{e.id}|{d}|{e.sender}|{e.subject}")
    if not lines:
        return "（无邮件）"
    return "\n".join(lines)


def run_tool_loop(
    llm: Any,
    messages: list[dict],
    db: Session,
    settings: Settings,
    owned_ids: list[int],
    *,
    max_rounds: int,
    retry_hint: str,
) -> dict:
    """agentic 工具循环：有 tool_calls 则回填执行并继续，无则把 content 当最终 JSON 解析返回。

    llm 需提供 chat_completion(messages, tools=None, json_mode=False) -> dict（openai message 风格）。
    最终输出不是合法 JSON 时追加 retry_hint 并用 json_mode=True 重试一次，仍失败抛
    RuntimeError("最终输出非法 JSON")；超 max_rounds 轮抛 RuntimeError("工具循环超过 N 轮")。
    messages 就地追加（调用方持有引用即可读到完整对话，测试依赖此行为）。
    """
    for _round in range(max_rounds):
        msg = llm.chat_completion(messages, tools=TOOLS)
        if msg.get("tool_calls"):
            messages.append({"role": "assistant", "content": msg.get("content") or "", "tool_calls": msg["tool_calls"]})
            for tc in msg["tool_calls"]:
                try:
                    args = json.loads(tc["function"]["arguments"] or "{}")
                except json.JSONDecodeError:
                    args = {}
                result = _dispatch_tool(db, tc["function"]["name"], args, settings, owned_ids)
                messages.append(
                    {"role": "tool", "tool_call_id": tc["id"], "content": json.dumps(result, ensure_ascii=False)}
                )
            continue
        # 无工具调用：尝试解析最终 JSON
        content = msg.get("content") or ""
        try:
            return json.loads(content)
        except json.JSONDecodeError:
            # 一次显式 json_object 重试
            messages.append({"role": "assistant", "content": content})
            messages.append({"role": "user", "content": retry_hint})
            msg = llm.chat_completion(messages, tools=TOOLS, json_mode=True)
            try:
                return json.loads(msg.get("content") or "")
            except json.JSONDecodeError:
                raise RuntimeError("最终输出非法 JSON")
    raise RuntimeError(f"工具循环超过 {max_rounds} 轮")
