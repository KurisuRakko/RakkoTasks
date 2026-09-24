"""常驻 worker：每 SYNC_INTERVAL_MINUTES 循环调 sync.run_once，SIGTERM 优雅退出。

启动方式：python -m app.worker
web 进程通过 sync_runs 表里的请求行唤醒本进程（见 app.sync_state）。
"""
from __future__ import annotations

import logging
import signal
import sys
import time
from collections.abc import Callable

from app.config import get_settings
from app.db import init_db, make_engine, make_session_factory
from app.sync import run_once
from app.sync_state import MANUAL_DETAIL_WINDOW_DAYS, claim_request, has_request

logger = logging.getLogger("rakkotasks.worker")

_stop = False


def _handle_sigterm(_signum, _frame) -> None:
    global _stop
    _stop = True
    logger.info("收到 SIGTERM，退出")


def _sleep_until(deadline: float, wake: Callable[[], bool] | None = None) -> None:
    """睡到 deadline，但每次最多睡 1 秒，以便 SIGTERM 与手动唤醒都能及时中断。

    必须分块睡眠而不能一次长 sleep：SIGTERM 处理函数只置位 _stop，
    进程要等 sleep 返回后回到循环条件判断处才能退出；若一次睡满整个
    间隔，优雅退出最长会被拖延一个间隔。
    wake 由 main 传入「有没有待认领的手动请求」：为真就直接结束睡眠，让主循环
    立刻跑一轮。每块睡眠前查一次即可——手动轮次晚一秒开始没有区别，但整个
    间隔里每秒都查库没有必要。
    """
    while not _stop:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        if wake is not None and wake():
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
            # 先认领 web 进程写下的手动请求：认领到就跑手动轮次（详情只补最近 7 天），
            # 没有请求就跑定时轮次
            run_id = claim_request(session_factory)
            if run_id is not None:
                summary = run_once(
                    session_factory,
                    settings=settings,
                    trigger="manual",
                    run_id=run_id,
                    detail_window_days=MANUAL_DETAIL_WINDOW_DAYS,
                )
            else:
                summary = run_once(session_factory, settings=settings)
            logger.info("同步完成：%s", summary)
        except Exception:
            logger.exception("本轮同步异常，继续下一轮")
        # 睡满整个间隔；_sleep_until 内部逐秒检查 _stop，SIGTERM 一到即退出；
        # 睡眠期间出现手动请求则提前醒来。手动轮跑完后 started 重置，定时计时
        # 从头算起——这是刻意的：刚被唤醒过，不必紧接着再跑一轮定时同步。
        try:
            _sleep_until(started + interval, wake=lambda: has_request(session_factory))
        except KeyboardInterrupt:
            break
    logger.info("worker 退出")
    sys.exit(0)


if __name__ == "__main__":
    main()
