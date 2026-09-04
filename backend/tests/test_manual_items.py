"""手动条目（无源邮件）测试：POST/PATCH/DELETE items、detail 拦截、export、多用户隔离。

沿用 test_api.py 的 _client/_seed 风格：依赖覆盖指定当前用户，内存库。
"""
from datetime import date, datetime

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.api import create_app
from app.auth import CurrentUser, require_auth
from app.config import Settings
from app.models import Account, Email, Item, User


def _settings() -> Settings:
    return Settings(database_path=":memory:", llm_base_url="http://x", llm_api_key="k")


def _seed(session_factory) -> tuple[int, int, int]:
    """user-1 一账户一邮件 + 一条邮件条目；user-2 无内容。返回 (邮件条目 id, em id, acc id)。"""
    with session_factory() as s:
        s.add(User(sub="user-1", email="a@example.com", name="甲"))
        s.add(User(sub="user-2", email="b@example.com", name="乙"))
        s.commit()
        acc = Account(user_sub="user-1", name="学校邮箱", kind="microsoft", email="a@example.com", status="ok")
        s.add(acc)
        s.commit()
        em = Email(
            account_id=acc.id, message_id="<m1>", subject="开学通知", sender="b@example.com",
            sent_at=datetime(2026, 9, 4, 1, 2, 3), text_body="九月一号开学", llm_state="done",
        )
        s.add(em)
        s.commit()
        it = Item(email_id=em.id, user_sub="user-1", title="交学费", summary="s", category="学业", status="open")
        s.add(it)
        s.commit()
        return it.id, em.id, acc.id


def _add_manual(session_factory, *, sub: str = "user-1", title: str = "手动任务", category: str = "个人",
                due_date=None) -> int:
    with session_factory() as s:
        it = Item(
            user_sub=sub, email_id=None, title=title, summary="手写摘要", category=category,
            due_date=date.fromisoformat(due_date) if due_date else None,
            importance="normal", actionable=True, status="open",
        )
        s.add(it)
        s.commit()
        return it.id


def _client(session_factory, monkeypatch, sub: str = "user-1"):
    app = create_app(settings=_settings(), session_factory=session_factory)
    app.dependency_overrides[require_auth] = lambda: CurrentUser(sub=sub, email=f"{sub}@example.com", name="甲")
    return TestClient(app)


def test_create_manual_item_201_and_list(session_factory, monkeypatch):
    _seed(session_factory)
    client = _client(session_factory, monkeypatch)

    resp = client.post(
        "/api/items",
        json={"title": "  去图书馆还书  ", "summary": "三楼还书机", "category": "个人", "due_date": "2026-09-10"},
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["title"] == "去图书馆还书"  # 首尾空白被 strip
    assert data["summary"] == "三楼还书机"
    assert data["category"] == "个人"
    assert data["due_date"] == "2026-09-10"
    assert data["email_id"] is None  # 手动条目：无源邮件
    assert data["email_subject"] is None
    assert data["email_sender"] is None
    assert data["email_sent_at"] is None
    assert data["importance"] == "normal"
    assert data["actionable"] is True
    assert data["status"] == "open"
    assert data["detail_md"] is None
    assert data["related"] == []

    # 出现在 open 列表；category 过滤有效；邮件条目不受影响
    items = client.get("/api/items").json()["items"]
    assert {i["title"] for i in items} == {"去图书馆还书", "交学费"}
    assert [i["title"] for i in client.get("/api/items", params={"category": "个人"}).json()["items"]] == [
        "去图书馆还书"
    ]
    assert [i["title"] for i in client.get("/api/items", params={"category": "学业"}).json()["items"]] == [
        "交学费"
    ]
    # done 列表不含新条目
    assert client.get("/api/items", params={"status": "done"}).json()["items"] == []


def test_create_manual_item_four_bad_codes_and_due_date_format(session_factory, monkeypatch):
    _seed(session_factory)
    client = _client(session_factory, monkeypatch)

    cases = [
        ({"title": "   ", "category": "个人"}, "bad_title"),
        ({"title": "x" * 129, "category": "个人"}, "bad_title"),
        ({"title": "ok", "summary": "x" * 5001, "category": "个人"}, "bad_summary"),
        ({"title": "ok", "category": "边栏"}, "bad_category"),
        ({"title": "ok", "category": "个人", "due_date": "2026-13-01"}, "bad_due_date"),
        ({"title": "ok", "category": "个人", "due_date": "2026-1-2"}, "bad_due_date"),
    ]
    for body, code in cases:
        resp = client.post("/api/items", json=body)
        assert resp.status_code == 400, body
        assert resp.json() == {"code": code}, body
    # 都没有写进库
    with session_factory() as s:
        manual = s.execute(select(Item).where(Item.email_id.is_(None))).scalars().all()
        assert manual == []

    # due_date 显式 null 合法
    resp = client.post("/api/items", json={"title": "无期限", "category": "个人", "due_date": None})
    assert resp.status_code == 201
    assert resp.json()["due_date"] is None


def test_patch_manual_item_fields_and_clear_due_date(session_factory, monkeypatch):
    _seed(session_factory)
    manual_id = _add_manual(session_factory, title="旧标题", category="个人", due_date="2026-09-10")
    client = _client(session_factory, monkeypatch)

    resp = client.patch(
        f"/api/items/{manual_id}",
        json={"title": "新标题", "summary": "新摘要", "category": "工作", "due_date": "2026-10-01"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["title"] == "新标题"
    assert data["summary"] == "新摘要"
    assert data["category"] == "工作"
    assert data["due_date"] == "2026-10-01"
    assert data["status"] == "open"

    # 单字段 patch：没给的字段不动
    resp = client.patch(f"/api/items/{manual_id}", json={"title": "只改标题"})
    assert resp.status_code == 200
    assert resp.json()["title"] == "只改标题"
    assert resp.json()["summary"] == "新摘要"
    assert resp.json()["due_date"] == "2026-10-01"

    # due_date 传 null = 清除日期（与「没传」区分）
    resp = client.patch(f"/api/items/{manual_id}", json={"due_date": None})
    assert resp.status_code == 200
    assert resp.json()["due_date"] is None

    # 手动条目改 status 仍然正常
    resp = client.patch(f"/api/items/{manual_id}", json={"status": "done"})
    assert resp.status_code == 200
    assert resp.json()["status"] == "done"
    assert resp.json()["done_at"] is not None


def test_patch_email_item_not_editable_and_status_ok(session_factory, monkeypatch):
    email_item_id, _em_id, _acc_id = _seed(session_factory)
    client = _client(session_factory, monkeypatch)

    resp = client.patch(f"/api/items/{email_item_id}", json={"title": "改邮件任务"})
    assert resp.status_code == 400
    assert resp.json() == {"code": "not_editable"}

    resp = client.patch(f"/api/items/{email_item_id}", json={"due_date": "2026-12-31"})
    assert resp.status_code == 400
    assert resp.json() == {"code": "not_editable"}

    # 邮件条目的 status 仍可改（与现状一致）
    resp = client.patch(f"/api/items/{email_item_id}", json={"status": "done"})
    assert resp.status_code == 200
    assert resp.json()["status"] == "done"

    # 手动条目同样按 POST 校验规则报错
    manual_id = _add_manual(session_factory)
    resp = client.patch(f"/api/items/{manual_id}", json={"category": "不存在"})
    assert resp.status_code == 400
    assert resp.json() == {"code": "bad_category"}


def test_patch_empty_body_and_bad_status(session_factory, monkeypatch):
    _seed(session_factory)
    manual_id = _add_manual(session_factory)
    client = _client(session_factory, monkeypatch)

    resp = client.patch(f"/api/items/{manual_id}", json={})
    assert resp.status_code == 400
    assert resp.json() == {"code": "bad_request"}

    resp = client.patch(f"/api/items/{manual_id}", json={"status": "invalid"})
    assert resp.status_code == 400
    assert resp.json() == {"code": "bad_status"}

    resp = client.patch("/api/items/999999", json={"status": "done"})
    assert resp.status_code == 404
    assert resp.json() == {"code": "not_found"}


def test_delete_manual_item_and_email_item(session_factory, monkeypatch):
    email_item_id, _em_id, _acc_id = _seed(session_factory)
    manual_id = _add_manual(session_factory)
    client = _client(session_factory, monkeypatch)

    # 邮件条目不可删
    resp = client.delete(f"/api/items/{email_item_id}")
    assert resp.status_code == 400
    assert resp.json() == {"code": "not_editable"}

    # 手动条目删除 204 无正文，再查 404
    resp = client.delete(f"/api/items/{manual_id}")
    assert resp.status_code == 204
    assert resp.content == b""
    resp = client.get(f"/api/items/{manual_id}")
    assert resp.status_code == 404

    # 删除不存在的条目 404
    assert client.delete("/api/items/999999").status_code == 404

    # 他人条目：404（不暴露存在性）
    other_id = _add_manual(session_factory, sub="user-2", title="乙的手动任务")
    resp = client.delete(f"/api/items/{other_id}")
    assert resp.status_code == 404
    assert resp.json() == {"code": "not_found"}


def test_detail_endpoint_rejects_manual_without_llm(session_factory, monkeypatch):
    email_item_id, _em_id, _acc_id = _seed(session_factory)
    manual_id = _add_manual(session_factory)

    def boom(*_args, **_kw):  # 若被调用则测试失败而不是 502
        raise AssertionError("手动条目不应调用 LLM")

    monkeypatch.setattr("app.llm.get_llm", boom)
    client = _client(session_factory, monkeypatch)

    resp = client.post(f"/api/items/{manual_id}/detail")
    assert resp.status_code == 400
    assert resp.json() == {"code": "no_email"}

    # 邮件条目不受拦截：走 LLM 路径，mock 抛异常 → 502 llm_error（证明不是 no_email 拦的）
    resp = client.post(f"/api/items/{email_item_id}/detail")
    assert resp.status_code == 502
    assert resp.json() == {"code": "llm_error"}


def test_export_manual_item_has_detail_section(session_factory, monkeypatch):
    _seed(session_factory)
    manual_id = _add_manual(session_factory, title="手动导出任务", category="学业")
    client = _client(session_factory, monkeypatch)

    resp = client.get(f"/api/items/{manual_id}/export")
    assert resp.status_code == 200
    text = resp.json()["text"]
    assert text.startswith("# 手动导出任务")
    assert "分类：学业" in text
    assert "## 详情" in text
    assert "手写摘要" in text
    assert "当前邮件" not in text
    assert "关联邮件" not in text
    assert "AI 见解" not in text


def test_multiuser_isolation_manual_items(session_factory, monkeypatch):
    _seed(session_factory)
    a_id = _add_manual(session_factory, sub="user-1", title="甲的私事")
    b_id = _add_manual(session_factory, sub="user-2", title="乙的私事")
    client_b = _client(session_factory, monkeypatch, sub="user-2")

    # 用户 B 列表只见自己的手动条目
    titles = [i["title"] for i in client_b.get("/api/items").json()["items"]]
    assert titles == ["乙的私事"]

    # B 拿不到 A 的手动条目：GET/PATCH/DELETE/export/detail 全 404
    assert client_b.get(f"/api/items/{a_id}").status_code == 404
    assert client_b.patch(f"/api/items/{a_id}", json={"title": "x"}).status_code == 404
    assert client_b.delete(f"/api/items/{a_id}").status_code == 404
    assert client_b.get(f"/api/items/{a_id}/export").status_code == 404
    assert client_b.post(f"/api/items/{a_id}/detail").status_code == 404
    # A 自己的可正常访问
    client_a = _client(session_factory, monkeypatch, sub="user-1")
    assert client_a.get(f"/api/items/{a_id}").status_code == 200
    assert client_a.get(f"/api/items/{b_id}").status_code == 404
