"""共享 fixtures：StaticPool 内存库（FTS5 虚表在连接间可见）+ 鉴权缓存清理。"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool

from app.db import init_db, make_session_factory


@pytest.fixture
def session_factory():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    init_db(engine)
    return make_session_factory(engine)


@pytest.fixture(autouse=True)
def _clean_auth_cache():
    from app import auth

    auth._cache.clear()
    yield
    auth._cache.clear()
