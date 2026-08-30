"""REST API 测试：TestClient + 依赖覆盖指定当前用户。"""
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.api import create_app
from app.auth import CurrentUser, require_auth
from app.config import Settings
from app.models import Account, Email, Item, User


class FakeDetailLLM:
    def __init__(self):
        self.detail_calls = 0

    def generate_detail(self, info: dict) -> str:
        self.detail_calls += 1
        return "**AI 详情**"


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
            sent_at=None, text_body="九月一号开学", html_body="<p>九月一号开学</p><script>x()</script>",
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
            email_id=em.id, title="交学费", summary="s", category="学业", actionable=True,
            status="open",
        )
        done = Item(
            email_id=em2.id, title="旧任务", summary="s", category="工作", actionable=False,
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

    resp = client.get("/api/items", params={"status": "done"})
    assert len(resp.json()["items"]) == 1
    assert resp.json()["items"][0]["title"] == "旧任务"

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

    # 首次生成
    resp = client.post(f"/api/items/{item_id}/detail")
    assert resp.status_code == 200
    assert resp.json()["detail_md"] == "**AI 详情**"
    assert fake.detail_calls == 1

    # 二次命中缓存：不再调用 LLM
    resp = client.post(f"/api/items/{item_id}/detail")
    assert resp.status_code == 200
    assert fake.detail_calls == 1

    # GET 详情带 detail_md
    resp = client.get(f"/api/items/{item_id}")
    assert resp.json()["detail_md"] == "**AI 详情**"


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
