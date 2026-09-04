"""多用户隔离验收测试：IDOR / 搜索隔离 / 首次登录自动建用户 / 软删除跳过同步。"""
import json

import httpx
import respx
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.api import create_app
from app.auth import CurrentUser, require_auth
from app.config import Settings
from app.models import Account, Email, Item, User
from app.search import run_search
from app.sync import run_once


def _settings() -> Settings:
    return Settings(
        database_path=":memory:",
        phainon_api_base="https://api.rakko.cn",
        phainon_app_id="rakkotasks",
    )


def _client_as(session_factory, sub: str, email: str | None = None, name: str | None = None) -> TestClient:
    app = create_app(settings=_settings(), session_factory=session_factory)
    app.dependency_overrides[require_auth] = lambda: CurrentUser(sub=sub, email=email, name=name)
    return TestClient(app)


def _seed_two_users(session_factory) -> dict:
    """用户 A/B 各一账户、一邮件、一任务；A 的账户带 token_cache、B 的账户带 app_password。"""
    with session_factory() as s:
        s.add(User(sub="user-A", email="a@x.com", name="甲"))
        s.add(User(sub="user-B", email="b@x.com", name="乙"))
        s.commit()
        acc_a = Account(
            user_sub="user-A", name="A 邮箱", kind="microsoft", email="a@x.com", status="ok",
            token_cache="secret-cache-a",
        )
        acc_b = Account(
            user_sub="user-B", name="B 邮箱", kind="gmail", email="b@x.com", status="ok",
            app_password="secret-password-b",
        )
        s.add_all([acc_a, acc_b])
        s.commit()
        em_a = Email(
            account_id=acc_a.id, message_id="<a1>", subject="A 的主题", sender="x@x.com",
            text_body="A 的正文", html_body=None, llm_state="done",
        )
        em_b = Email(
            account_id=acc_b.id, message_id="<b1>", subject="B 的秘密主题", sender="y@y.com",
            text_body="B 的机密正文", html_body=None, llm_state="done",
        )
        s.add_all([em_a, em_b])
        s.commit()
        it_a = Item(email_id=em_a.id, user_sub="user-A", title="A 的任务", summary="", category="其他", status="open")
        it_b = Item(email_id=em_b.id, user_sub="user-B", title="B 的任务", summary="", category="其他", status="open")
        s.add_all([it_a, it_b])
        s.commit()
        return {"acc_a": acc_a.id, "acc_b": acc_b.id, "em_a": em_a.id, "em_b": em_b.id, "it_a": it_a.id, "it_b": it_b.id}


def test_idor_isolation(session_factory):
    """以 A 身份访问：列表只见 A；改 URL 里的 id 拿不到 B 的任何数据；status 不含凭据。"""
    ids = _seed_two_users(session_factory)
    client = _client_as(session_factory, "user-A", "a@x.com", "甲")

    # 列表只返回 A 的条目
    items = client.get("/api/items").json()["items"]
    assert [i["id"] for i in items] == [ids["it_a"]]

    # 跨用户访问一律 404（不暴露 id 是否存在）
    assert client.get(f"/api/items/{ids['it_b']}").status_code == 404
    assert client.patch(f"/api/items/{ids['it_b']}", json={"status": "done"}).status_code == 404
    assert client.post(f"/api/items/{ids['it_b']}/detail").status_code == 404
    assert client.get(f"/api/emails/{ids['em_b']}").status_code == 404
    assert client.get(f"/api/items/{ids['it_b']}/export").status_code == 404

    # 自己的数据正常访问
    assert client.get(f"/api/items/{ids['it_a']}").status_code == 200
    assert client.patch(f"/api/items/{ids['it_a']}", json={"status": "done"}).status_code == 200
    assert client.get(f"/api/emails/{ids['em_a']}").status_code == 200
    assert client.get(f"/api/items/{ids['it_a']}/export").status_code == 200

    # status：只含 A 的账户，且响应里绝无 app_password / token_cache 及明文
    data = client.get("/api/status").json()
    assert len(data["accounts"]) == 1
    assert data["accounts"][0]["id"] == ids["acc_a"]
    raw = json.dumps(data, ensure_ascii=False)
    assert "app_password" not in raw
    assert "token_cache" not in raw
    assert "secret-password-b" not in raw
    assert "secret-cache-a" not in raw

    # 对称检查：B 也只见 B 的
    client_b = _client_as(session_factory, "user-B", "b@x.com", "乙")
    assert [i["id"] for i in client_b.get("/api/items").json()["items"]] == [ids["it_b"]]
    assert client_b.get(f"/api/emails/{ids['em_a']}").status_code == 404
    assert [a["id"] for a in client_b.get("/api/status").json()["accounts"]] == [ids["acc_b"]]


class StealLLM:
    """第一轮 read_emails 请求 B 的邮件 id，第二轮给出最终答案（citations 指向 B 的邮件）。"""

    def __init__(self, target_id: int):
        self.target_id = target_id
        self.messages_seen: list[list[dict]] = []

    def chat_completion(self, messages, tools=None, json_mode=False):
        self.messages_seen.append(list(messages))
        if len(self.messages_seen) == 1:
            return {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {"id": "c1", "function": {"name": "read_emails", "arguments": json.dumps({"ids": [self.target_id]})}}
                ],
            }
        return {
            "role": "assistant",
            "content": json.dumps({"answer_md": "回答", "citations": [self.target_id]}),
        }


def test_search_isolated_between_users(session_factory):
    """A 的搜索：喂给模型的索引不含 B 的邮件；read_emails 请求 B 的 id 被静默丢弃；citations 无 B。"""
    ids = _seed_two_users(session_factory)
    with session_factory() as s:
        llm = StealLLM(ids["em_b"])
        result = run_search("B 的邮件在哪？", s, llm, "user-A")

    # 首条 user 消息（邮件索引）只含 A 的邮件
    first_user = llm.messages_seen[0][1]["content"]
    assert "B 的秘密主题" not in first_user
    assert "A 的主题" in first_user

    # read_emails 工具结果：不含 B 的正文
    tool_msgs = [m for m in llm.messages_seen[-1] if m["role"] == "tool"]
    assert tool_msgs
    assert "B 的机密正文" not in tool_msgs[-1]["content"]
    assert result["citations"] == []  # citations 富化同样只查该用户邮件


def test_first_login_auto_creates_user_without_repeat_writes(session_factory, monkeypatch):
    """首次鉴权自动建用户；第二次请求命中 60s 缓存：不再 introspection 也不重复写库。"""
    from app import auth

    upsert_calls = []
    orig_upsert = auth._upsert_user
    monkeypatch.setattr(
        auth, "_upsert_user", lambda sf, user: (upsert_calls.append(user), orig_upsert(sf, user))[1]
    )
    with respx.mock:
        route = respx.get("https://api.rakko.cn/auth/priestess/oidc/me").mock(
            return_value=httpx.Response(
                200, json={"app_id": "rakkotasks", "user": {"sub": "newbie", "email": "n@x.com", "name": "新人"}}
            )
        )
        app = create_app(settings=_settings(), session_factory=session_factory)
        client = TestClient(app)
        headers = {"Authorization": "Bearer tok-1"}
        assert client.get("/api/status", headers=headers).status_code == 200
        assert client.get("/api/status", headers=headers).status_code == 200
        assert route.call_count == 1  # 第二次命中缓存，不产生第二次 introspection

    assert len(upsert_calls) == 1  # 命中缓存时不写库
    with session_factory() as s:
        users = s.execute(select(User)).scalars().all()
        assert len(users) == 1
        u = users[0]
        assert u.sub == "newbie"
        assert u.email == "n@x.com"
        assert u.name == "新人"
        assert u.created_at is not None
        assert u.last_seen_at is not None


def test_soft_deleted_account_skipped_by_sync_but_data_kept(session_factory):
    """enabled=0 的账户被 sync.run_once 跳过，但其邮件与任务仍在库、仍能被该用户 API 查到。"""
    with session_factory() as s:
        s.add(User(sub="user-A"))
        s.commit()
        acc = Account(
            user_sub="user-A", name="旧邮箱", kind="microsoft", email="old@x.com", status="ok", enabled=False
        )
        s.add(acc)
        s.commit()
        em = Email(account_id=acc.id, message_id="<old1>", subject="旧邮件", text_body="正文", llm_state="done")
        s.add(em)
        s.commit()
        it = Item(email_id=em.id, user_sub="user-A", title="旧任务", summary="", category="其他", status="open")
        s.add(it)
        s.commit()

    imap_calls = []

    def factory(account, settings):  # noqa: ARG001
        imap_calls.append(account.email)
        raise AssertionError("停用账户不应被同步")

    run_once(session_factory, imap_factory=factory, llm=None)
    assert imap_calls == []

    # 邮件与任务仍保留在库
    with session_factory() as s:
        assert len(s.execute(select(Email)).scalars().all()) == 1
        assert len(s.execute(select(Item)).scalars().all()) == 1

    # 该用户 API 仍可查到（status 标注 enabled=false）
    client = _client_as(session_factory, "user-A")
    items = client.get("/api/items").json()["items"]
    assert [i["id"] for i in items] == [it.id]
    data = client.get("/api/status").json()
    assert len(data["accounts"]) == 1
    assert data["accounts"][0]["enabled"] is False
