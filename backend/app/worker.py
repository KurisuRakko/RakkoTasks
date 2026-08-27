"""常驻 worker：每 SYNC_INTERVAL_MINUTES 循环调 sync.run_once，SIGTERM 优雅退出。

启动方式：python -m app.worker
"""
from __future__ import annotations

import logging
import signal
import sys
import time

from app.config import get_settings
from app.db import init_db, make_engine, make_session_factory
from app.sync import run_once

logger = logging.getLogger("rakkotasks.worker")

_stop = False


def _handle_sigterm(_signum, _frame) -> None:
    global _stop
    _stop = True
    logger.info("收到 SIGTERM，退出")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    signal.signal(signal.SIGTERM, _handle_sigterm)

    settings = get_settings()
    engine = make_engine(settings.database_path)
    init_db(engine)
    session_factory = make_session_factory(engine)
    interval = settings.sync_interval_minutes * 60
    logger.info("worker 启动：每 %s 分钟同步一轮", settings.sync_interval_minutes)

    while not _stop:
        started = time.monotonic()
        try:
            summary = run_once(session_factory, settings=settings)
            logger.info("同步完成：%s", summary)
        except Exception:
            logger.exception("本轮同步异常，继续下一轮")
        # 睡眠至下一轮；中途收到 SIGTERM 立即退出
        remaining = interval - (time.monotonic() - started)
        if remaining > 0 and not _stop:
            try:
                time.sleep(min(remaining, 1.0))
            except KeyboardInterrupt:
                break
    logger.info("worker 退出")
    sys.exit(0)


if __name__ == "__main__":
    main()
