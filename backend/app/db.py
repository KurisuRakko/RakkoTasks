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


def init_db(engine: Engine) -> None:
    """建普通表（含 accounts/emails/items）与 FTS5 虚表 + 触发器。"""
    Base.metadata.create_all(engine)
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
