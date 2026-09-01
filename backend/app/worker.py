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


def _sleep_until(deadline: float) -> None:
    """睡到 deadline，但每次最多睡 1 秒，以便 SIGTERM 能及时中断。

    必须分块睡眠而不能一次长 sleep：SIGTERM 处理函数只置位 _stop，
    进程要等 sleep 返回后回到循环条件判断处才能退出；若一次睡满整个
    间隔，优雅退出最长会被拖延一个间隔。
    """
    while not _stop:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        time.sleep(min(1.0, remaining))


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
        # 睡满整个间隔；_sleep_until 内部逐秒检查 _stop，SIGTERM 一到即退出
        try:
            _sleep_until(started + interval)
        except KeyboardInterrupt:
            break
    logger.info("worker 退出")
    sys.exit(0)


if __name__ == "__main__":
    main()
