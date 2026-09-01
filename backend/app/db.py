"""数据库引擎、会话与建表：WAL 模式 + FTS5 虚表及同步触发器（原生 SQL）。"""
from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.config import Settings, get_settings
from app.models import Base

# emails_fts 虚表：内容存原表（content=），由触发器保持同步
FTS_SCHEMA = """
CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts USING fts5(
    subject, sender, text_body,
    content='emails', content_rowid='id'
)
"""

FTS_TRIGGERS = [
    """
    CREATE TRIGGER IF NOT EXISTS emails_ai AFTER INSERT ON emails BEGIN
        INSERT INTO emails_fts(rowid, subject, sender, text_body)
        VALUES (new.id, new.subject, new.sender, new.text_body);
    END
    """,
    """
    CREATE TRIGGER IF NOT EXISTS emails_ad AFTER DELETE ON emails BEGIN
        INSERT INTO emails_fts(emails_fts, rowid, subject, sender, text_body)
        VALUES ('delete', old.id, old.subject, old.sender, old.text_body);
    END
    """,
    """
    CREATE TRIGGER IF NOT EXISTS emails_au AFTER UPDATE ON emails BEGIN
        INSERT INTO emails_fts(emails_fts, rowid, subject, sender, text_body)
        VALUES ('delete', old.id, old.subject, old.sender, old.text_body);
        INSERT INTO emails_fts(rowid, subject, sender, text_body)
        VALUES (new.id, new.subject, new.sender, new.text_body);
    END
    """,
]


def make_engine(database_path: str) -> Engine:
    if database_path == ":memory:":
        # 内存库必须共享单连接，否则各连接是互不相见的独立库
        return create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
    engine = create_engine(
        f"sqlite:///{database_path}",
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(engine, "connect")
    def _set_sqlite_pragma(dbapi_connection, _record):  # noqa: ANN001
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    return engine


# 需要就地补的列：{表名: {列名: DDL 片段}}，_ensure_columns 每次启动幂等执行。
# 以后给既有表加列只改这张映射即可。
_COLUMN_ALTERS: dict[str, dict[str, str]] = {
    "items": {
        "importance": "TEXT NOT NULL DEFAULT 'normal'",
    },
}


def _ensure_columns(engine: Engine) -> None:
    """SQLite 就地补列：create_all 不会给已存在的表加列。

    生产库里存着邮箱 OAuth token，不能靠删库重建，所以新增列必须走 ALTER TABLE。
    每次启动都跑一遍，已存在则跳过（幂等）。
    """
    with engine.begin() as conn:
        for table, columns in _COLUMN_ALTERS.items():
            existing = {row[1] for row in conn.execute(text(f"PRAGMA table_info({table})"))}
            for name, ddl in columns.items():
                if name not in existing:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"))


def init_db(engine: Engine) -> None:
    """建普通表（含 accounts/emails/items）与 FTS5 虚表 + 触发器；对旧库就地补列。"""
    Base.metadata.create_all(engine)
    _ensure_columns(engine)
    with engine.begin() as conn:
        conn.execute(text(FTS_SCHEMA))
        for sql in FTS_TRIGGERS:
            conn.execute(text(sql))


def make_session_factory(engine: Engine | None = None) -> sessionmaker[Session]:
    if engine is None:
        engine = make_engine(get_settings().database_path)
    return sessionmaker(bind=engine, expire_on_commit=False)


@contextmanager
def session_scope(session_factory: sessionmaker[Session]) -> Iterator[Session]:
    """便捷上下文：自动 commit/rollback。"""
    session = session_factory()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
