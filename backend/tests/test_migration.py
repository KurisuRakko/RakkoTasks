"""就地迁移测试：旧库（缺 importance / related_json 列）init_db 补列，重复执行幂等。

生产库存着邮箱 OAuth token cache，不允许删库重建，所以验证的是 ALTER 路径而非重建。
另有 items 重建迁移（email_id 去 NOT NULL + user_sub 归属回填）与 users 补列测试。
CalDAV 部分：items 四新列 / users.caldav_password_hash 补列与身份回填幂等。
"""
import re
from datetime import datetime

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.pool import StaticPool

from app.db import init_db, make_session_factory
from app.models import Account, Base, Email, Item, User

_HEX32 = re.compile(r"^[0-9A-F]{32}$")

_OLD_ITEMS_DDL = """
CREATE TABLE items (
    id INTEGER PRIMARY KEY,
    email_id INTEGER NOT NULL UNIQUE,
    title VARCHAR(128) NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    category VARCHAR(16) NOT NULL DEFAULT '其他',
    due_date DATE,
    actionable BOOLEAN NOT NULL DEFAULT 1,
    status VARCHAR(16) NOT NULL DEFAULT 'open',
    detail_md TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    done_at DATETIME
)
"""


def _old_schema_engine():
    """构造缺 importance 列的旧版 items 表（等价于功能上线前的生产库）。"""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    with engine.begin() as conn:
        conn.execute(text(_OLD_ITEMS_DDL))
    return engine


def _columns(engine, table: str) -> set[str]:
    with engine.connect() as conn:
        return {row[1] for row in conn.execute(text(f"PRAGMA table_info({table})"))}


def _old_db_engine_seeded() -> "Engine":
    """全功能旧库：users/accounts/emails 齐 + 两条可推导归属的旧结构 items。

    items 表用旧 DDL 先建，其余表由当前模型 create_all 建（本任务未动它们结构），
    播种两名用户各一账户一邮件，items.email_id 都指向存在的邮件。
    """
    from sqlalchemy.engine import Engine

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    with engine.begin() as conn:
        conn.execute(text(_OLD_ITEMS_DDL))
        Base.metadata.create_all(conn)
    session_factory = make_session_factory(engine)
    with session_factory() as s:
        s.add(User(sub="u1", email="a@x.com"))
        s.add(User(sub="u2", email="b@x.com"))
        s.commit()
        a1 = Account(user_sub="u1", name="甲邮箱", kind="gmail", email="a@x.com", status="ok")
        a2 = Account(user_sub="u2", name="乙邮箱", kind="gmail", email="b@x.com", status="ok")
        s.add_all([a1, a2])
        s.commit()
        s.add_all(
            [
                Email(account_id=a1.id, message_id="<m1>", subject="甲邮件", sender="x@x.com", llm_state="done"),
                Email(account_id=a2.id, message_id="<m2>", subject="乙邮件", sender="y@y.com", llm_state="done"),
            ]
        )
        s.commit()
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO items (email_id, title, summary, category, due_date, actionable, status)"
                " VALUES (1, '甲的任务', '', '学业', '2026-09-01', 1, 'open'),"
                "        (2, '乙的任务', 's', '工作', NULL, 1, 'done')"
            )
        )
    return engine


def test_old_db_gets_importance_column_with_default():
    """旧库 init_db 后 importance 列被补上，且已有行/新行的默认值为 normal。"""
    engine = _old_schema_engine()
    init_db(engine)
    assert "importance" in _columns(engine, "items")

    # 旧行：缺列补上后默认 normal（重建后的新表即模型结构，NOT NULL 列需显式给值）
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO items (user_sub, email_id, title, summary, category, actionable, status, importance) "
                "VALUES ('u1', 1, '旧任务', '', '学业', 1, 'open', 'normal')"
            )
        )
        conn.execute(
            text(
                "INSERT INTO items (user_sub, email_id, title, summary, category, actionable, status, importance) "
                "VALUES ('u1', 2, '高重要', '', '学业', 1, 'open', 'high')"
            )
        )
    with engine.connect() as conn:
        rows = conn.execute(text("SELECT title, importance FROM items ORDER BY id")).fetchall()
    assert [(r[0], r[1]) for r in rows] == [("旧任务", "normal"), ("高重要", "high")]


def test_init_db_idempotent_on_migrated_db():
    """已迁移的库再跑 init_db 不报错（幂等），列不重复添加。"""
    engine = _old_schema_engine()
    init_db(engine)
    init_db(engine)  # 第二次：已有列应跳过 ALTER
    assert "importance" in _columns(engine, "items")


def test_fresh_db_has_importance_column():
    """全新库 create_all 直接带 importance 列，_ensure_columns 不应再 ALTER。"""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    init_db(engine)
    assert "importance" in _columns(engine, "items")


def test_old_db_gets_related_json_column():
    """旧 schema（无 related_json 列）init_db 补列，旧行补列后为 NULL 且可写入读回。"""
    engine = _old_schema_engine()
    init_db(engine)
    assert "related_json" in _columns(engine, "items")

    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO items (user_sub, email_id, title, summary, category, actionable, status, importance) "
                "VALUES ('u1', 1, '旧任务', '', '学业', 1, 'open', 'normal')"
            )
        )
        conn.execute(
            text("UPDATE items SET related_json = '[{\"email_id\": 2, \"reason\": \"背景\"}]' WHERE id = 1")
        )
    with engine.connect() as conn:
        row = conn.execute(text("SELECT related_json FROM items")).first()
    assert row[0] == '[{"email_id": 2, "reason": "背景"}]'


def test_init_db_idempotent_adds_related_json_once():
    """旧库跑两遍 init_db：related_json 补上且不重复 ALTER（幂等）。"""
    engine = _old_schema_engine()
    init_db(engine)
    init_db(engine)  # 第二次：已有列应跳过 ALTER
    assert "related_json" in _columns(engine, "items")


def test_manual_items_migration_backfills_user_sub():
    """旧结构 items（email_id NOT NULL、无 user_sub）init_db 重建：
    归属从邮件链推导回填 user_sub；email_id 可空；行数与 id 不变；再跑一次幂等。"""
    engine = _old_db_engine_seeded()
    init_db(engine)

    with engine.connect() as conn:
        info = {row[1]: row for row in conn.execute(text("PRAGMA table_info(items)"))}
        assert "user_sub" in info
        assert info["email_id"][3] == 0  # notnull 已去掉：null = 手动条目
        rows = conn.execute(
            text("SELECT id, email_id, user_sub, title, importance, related_json FROM items ORDER BY id")
        ).fetchall()
    assert len(rows) == 2
    assert [(r[0], r[1], r[2], r[3]) for r in rows] == [
        (1, 1, "u1", "甲的任务"),  # 归属经 u1 的邮件链推导
        (2, 2, "u2", "乙的任务"),
    ]
    assert all(r[4] == "normal" for r in rows)  # _ensure_columns 补的默认值随行搬入
    assert all(r[5] is None for r in rows)

    init_db(engine)  # 幂等：user_sub 已在、email_id 已可空 → 直接跳过
    with engine.connect() as conn:
        info = {row[1]: row for row in conn.execute(text("PRAGMA table_info(items)"))}
        assert info["email_id"][3] == 0


def test_manual_items_migration_broken_chain_raises_and_keeps_table():
    """一条 items 的邮件链断裂（email_id 指向不存在的邮件）→ init_db 抛
    RuntimeError 且整体回滚：items 表仍在（旧结构原样），不留 items_old。"""
    engine = _old_db_engine_seeded()
    with engine.begin() as conn:
        conn.execute(text("INSERT INTO items (email_id, title) VALUES (999, '孤儿条目')"))

    with pytest.raises(RuntimeError) as exc:
        init_db(engine)
    assert "1 行" in str(exc.value)

    with engine.connect() as conn:
        tables = {r[0] for r in conn.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))}
        assert "items" in tables
        assert "items_old" not in tables  # 事务回滚：重命名被撤销
        info = {row[1]: row for row in conn.execute(text("PRAGMA table_info(items)"))}
        assert "user_sub" not in info  # 结构仍是旧结构
        assert info["email_id"][3] == 1
        rows = conn.execute(text("SELECT COUNT(*) FROM items")).fetchone()[0]
        assert rows == 3  # 数据原样，无丢失


def test_old_users_table_gets_calendar_token_column():
    """旧 users 表（无 calendar_token 列）init_db 就地补列；再跑一次幂等。"""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    with engine.begin() as conn:
        conn.execute(
            text(
                """
                CREATE TABLE users (
                    sub TEXT NOT NULL PRIMARY KEY,
                    email TEXT,
                    name TEXT,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
        )
        Base.metadata.create_all(conn)
    assert "calendar_token" not in _columns(engine, "users")

    init_db(engine)
    assert "calendar_token" in _columns(engine, "users")
    init_db(engine)  # 幂等
    assert "calendar_token" in _columns(engine, "users")


# ── CalDAV：items 四新列 + 身份回填，users.caldav_password_hash ──


def test_old_db_gets_caldav_columns_and_backfill_idempotent():
    """旧 items 表 init_db 后四新列都在；既有行回填 caldav_uid（32 位大写 hex、
    互不相同）与 updated_at=created_at；二次 init_db 不改变已有值。"""
    engine = _old_db_engine_seeded()
    init_db(engine)
    cols = _columns(engine, "items")
    assert {"caldav_uid", "caldav_name", "caldav_ics", "updated_at"} <= cols

    with engine.connect() as conn:
        rows = conn.execute(
            text("SELECT id, caldav_uid, caldav_name, caldav_ics, updated_at, created_at FROM items ORDER BY id")
        ).fetchall()
    assert len(rows) == 2
    uids = [r[1] for r in rows]
    assert all(u is not None and _HEX32.match(u) for u in uids)
    assert len(set(uids)) == 2  # 每行一个互不相同的 UID
    assert all(r[2] is None and r[3] is None for r in rows)  # 透传列保持 NULL
    assert all(r[4] == r[5] for r in rows)  # updated_at 回填等于 created_at

    # 幂等：跑第二遍 init_db 不重填、不改值
    init_db(engine)
    with engine.connect() as conn:
        rows2 = conn.execute(text("SELECT id, caldav_uid, updated_at FROM items ORDER BY id")).fetchall()
    assert [(r[0], r[1], r[2]) for r in rows2] == [(r[0], r[1], r[4]) for r in rows]


def test_migrated_rows_get_uid_after_table_rebuild():
    """重建迁移路径（旧结构 items 无 caldav 列）后身份由紧随的回填补齐：新列不是 NULL。"""
    engine = _old_db_engine_seeded()
    init_db(engine)
    with engine.connect() as conn:
        n_null = conn.execute(
            text("SELECT COUNT(*) FROM items WHERE caldav_uid IS NULL")
        ).fetchone()[0]
        assert n_null == 0


def test_old_users_table_gets_caldav_password_hash_column():
    """旧 users 表（无 caldav_password_hash 列）init_db 就地补列；再跑一次幂等。"""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    with engine.begin() as conn:
        conn.execute(
            text(
                """
                CREATE TABLE users (
                    sub TEXT NOT NULL PRIMARY KEY,
                    email TEXT,
                    name TEXT,
                    calendar_token TEXT,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
        )
        Base.metadata.create_all(conn)
    assert "caldav_password_hash" not in _columns(engine, "users")

    init_db(engine)
    assert "caldav_password_hash" in _columns(engine, "users")
    init_db(engine)  # 幂等
    assert "caldav_password_hash" in _columns(engine, "users")


def test_orm_new_item_auto_gets_caldav_uid_and_updated_at():
    """ORM 新建 Item 自动获得 caldav_uid（32 位大写 hex，互不相同）；
    不显式碰 updated_at 的 ORM 变更会触发 onupdate 刷新（ETag 来源）。"""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    init_db(engine)
    sf = make_session_factory(engine)
    with sf() as s:
        s.add(Item(user_sub="u1", title="甲", summary="", category="学业", status="open"))
        s.add(Item(user_sub="u1", title="乙", summary="", category="工作", status="open"))
        s.commit()
        items = s.execute(text("SELECT caldav_uid FROM items ORDER BY id")).fetchall()
    uids = [r[0] for r in items]
    assert all(u is not None and _HEX32.match(u) for u in uids)
    assert len(set(uids)) == 2

    with sf() as s:
        it = s.query(Item).first()  # noqa: S608 —— 测试直接取行即可
        it.title = "改名"  # 只改业务字段：updated_at 未进 SET 子句 → onupdate 刷新
        s.commit()
        assert it.updated_at is not None
        assert (datetime.now() - it.updated_at).total_seconds() < 10  # 刷新到了当下而非新建时刻
        fresh = s.get(Item, it.id)
        assert fresh.caldav_uid == uids[0]  # UID 一经生成不变
