"""数据库引擎、会话与建表：WAL 模式 + FTS5 虚表及同步触发器（原生 SQL）。"""
from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool
from sqlalchemy.schema import CreateIndex, CreateTable

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
# 注意：UNIQUE 约束不能用 ADD COLUMN 补，就地补列只加普通列；新建库由
# create_all 直接建带 UNIQUE 的完整结构（users.calendar_token 的 unique 属
# 性只在全新库生效，旧库补上的是无唯一约束的普通列）。
_COLUMN_ALTERS: dict[str, dict[str, str]] = {
    "items": {
        "importance": "TEXT NOT NULL DEFAULT 'normal'",
        "related_json": "TEXT",
        "caldav_uid": "TEXT",
        "caldav_name": "TEXT",
        "caldav_ics": "TEXT",
        "updated_at": "DATETIME",
    },
    "users": {
        "calendar_token": "TEXT",
        "caldav_password_hash": "TEXT",
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


def _migrate_items_manual(engine: Engine) -> None:
    """items 表重建迁移：email_id 去掉 NOT NULL、补 user_sub（归属直挂条目）。

    为什么重建：手动条目（无源邮件）没有 email_id，旧结构 email_id NOT NULL 写
    不进去，而 SQLite 的 ALTER TABLE 不能改既有列的约束（去 NOT NULL），只能
    重建表。为什么安全：items 上没有 FTS 触发器（FTS 只挂在 emails 上），也
    没有别的表引用 items，重建不牵动其他表。模型（Base.metadata）是唯一 schema
    来源，新表的 CREATE TABLE / CREATE INDEX 都由模型编译，不手写 DDL。
    归属推导链已从 Item→Email→Account.user_sub 换成 items.user_sub 直挂，旧行
    的归属在迁移里回填：某行邮件链断裂（邮件/账户已不存在）导致归属无法推导时
    抛 RuntimeError 回滚整个事务——宁可启动失败也不能静默丢条目。
    """
    with engine.connect() as conn:
        dbapi = conn.connection.driver_connection
        cur = dbapi.cursor()
        try:
            # 幂等检查放事务外：已具备 user_sub 且 email_id 已允许 NULL → 无需再迁
            info = {row[1]: row for row in cur.execute("PRAGMA table_info(items)")}
            if "user_sub" in info and info["email_id"][3] == 0:
                return
            # pysqlite 的隐式事务只包 DML 不包 DDL，engine.begin() 的回滚管不住
            # RENAME/CREATE/DROP，所以迁移开显式事务并全部走裸 cursor（绕开
            # sqlite3 模块的隐式事务状态机），失败整体 ROLLBACK，表结构原样保留。
            cur.execute("BEGIN IMMEDIATE")
            try:
                cur.execute("ALTER TABLE items RENAME TO items_old")
                table = Base.metadata.tables["items"]
                cur.execute(str(CreateTable(table).compile(dialect=engine.dialect)))
                for index in table.indexes:
                    cur.execute(str(CreateIndex(index).compile(dialect=engine.dialect)))
                # _ensure_columns 已补过 importance/related_json，这里直接全部搬列 + 推导归属
                cur.execute(
                    "INSERT INTO items"
                    " (id, email_id, title, summary, category, due_date, importance, actionable,"
                    "  status, detail_md, related_json, created_at, done_at, user_sub)"
                    " SELECT o.id, o.email_id, o.title, o.summary, o.category, o.due_date,"
                    "        o.importance, o.actionable, o.status, o.detail_md, o.related_json,"
                    "        o.created_at, o.done_at, a.user_sub"
                    " FROM items_old o"
                    " JOIN emails e ON e.id = o.email_id"
                    " JOIN accounts a ON a.id = e.account_id"
                )
                old_count = cur.execute("SELECT COUNT(*) FROM items_old").fetchone()[0]
                new_count = cur.execute("SELECT COUNT(*) FROM items").fetchone()[0]
                if old_count != new_count:
                    raise RuntimeError(
                        f"items 迁移失败：{old_count - new_count} 行无法推导归属（邮件链断裂），"
                        "已回滚，请人工修复后再启动"
                    )
                cur.execute("DROP TABLE items_old")
                cur.execute("COMMIT")
            except BaseException:
                cur.execute("ROLLBACK")
                raise
        finally:
            cur.close()


def _backfill_caldav_identity(engine: Engine) -> None:
    """回填 items 的 CalDAV 身份列（caldav_uid / updated_at）。

    为什么回填：新列对既有行都是 NULL，而 CalDAV 资源名/ETag 依赖这两列，
    不补齐会让存量条目无法在集合里稳定寻址。为什么用 SQL 不用 Python 逐行
    循环：全表两条 UPDATE 就完成，且 randomblob 在 SQLite 内部生成，不经
    ORM 无默认值可绕。为什么幂等：只 UPDATE 仍为 NULL 的行，已有身份的行
    第二次运行不被触碰。为什么并发安全：两条 UPDATE 同处一个 engine.begin()
    写事务，SQLite 写事务串行，多进程同时启动也不会互相覆盖。
    注意：_migrate_items_manual 重建表后新列全是 NULL，靠紧随其后的本回填补齐。
    """
    with engine.begin() as conn:
        conn.execute(
            text("UPDATE items SET caldav_uid = upper(hex(randomblob(16))) WHERE caldav_uid IS NULL")
        )
        conn.execute(text("UPDATE items SET updated_at = created_at WHERE updated_at IS NULL"))


def init_db(engine: Engine) -> None:
    """建普通表（含 accounts/emails/items）与 FTS5 虚表 + 触发器；对旧库就地补列。"""
    Base.metadata.create_all(engine)
    _ensure_columns(engine)
    _migrate_items_manual(engine)
    _backfill_caldav_identity(engine)
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
