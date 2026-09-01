"""就地迁移测试：旧库（缺 importance 列）init_db 补列且默认 normal，重复执行幂等。

生产库存着邮箱 OAuth token cache，不允许删库重建，所以验证的是 ALTER 路径而非重建。
"""
from sqlalchemy import create_engine, text
from sqlalchemy.pool import StaticPool

from app.db import init_db


def _old_schema_engine():
    """构造缺 importance 列的旧版 items 表（等价于功能上线前的生产库）。"""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    with engine.begin() as conn:
        conn.execute(
            text(
                """
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
            )
        )
    return engine


def _columns(engine, table: str) -> set[str]:
    with engine.connect() as conn:
        return {row[1] for row in conn.execute(text(f"PRAGMA table_info({table})"))}


def test_old_db_gets_importance_column_with_default():
    """旧库 init_db 后 importance 列被补上，且已有行/新行的默认值为 normal。"""
    engine = _old_schema_engine()
    init_db(engine)
    assert "importance" in _columns(engine, "items")

    # 旧行：缺列补上后默认 normal
    with engine.begin() as conn:
        conn.execute(
            text("INSERT INTO items (email_id, title, summary, category) VALUES (1, '旧任务', '', '学业')")
        )
        conn.execute(
            text(
                "INSERT INTO items (email_id, title, summary, category, importance) "
                "VALUES (2, '高重要', '', '学业', 'high')"
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
