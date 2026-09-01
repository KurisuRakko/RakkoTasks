"""worker 分块睡眠与主循环测试：假时钟驱动，不触网、秒级完成。"""
from types import SimpleNamespace

import pytest

from app import worker


class FakeTime:
    """替身 time 模块：sleep 让假时钟前进，并记录每次调用。"""

    def __init__(self):
        self.now = 0.0
        self.sleeps = []

    def monotonic(self) -> float:
        return self.now

    def sleep(self, n: float) -> None:
        self.sleeps.append(n)
        self.now += n


def test_sleep_until_waits_full_interval(monkeypatch):
    """间隔正确：900 秒的间隔睡满，且每次 sleep 不超过 1 秒。"""
    fake = FakeTime()
    monkeypatch.setattr(worker, "time", fake)
    try:
        worker._sleep_until(fake.monotonic() + 900)
    finally:
        worker._stop = False
    assert fake.now == pytest.approx(900)
    assert len(fake.sleeps) == 900
    assert all(s <= 1.0 for s in fake.sleeps)


def test_sleep_until_stops_quickly_when_interrupted(monkeypatch):
    """能被打断：_stop 置位后立即返回，不再继续睡。"""
    fake = FakeTime()
    calls = {"n": 0}
    real_sleep = fake.sleep

    def interrupting_sleep(n):
        calls["n"] += 1
        if calls["n"] == 3:
            worker._stop = True
        real_sleep(n)

    fake.sleep = interrupting_sleep
    monkeypatch.setattr(worker, "time", fake)
    try:
        worker._sleep_until(fake.monotonic() + 900)
    finally:
        worker._stop = False
    assert fake.now < 900
    assert calls["n"] == 3


def test_main_loop_continues_after_run_once_exception(monkeypatch):
    """run_once 抛异常不中断循环：下一轮照常执行，且两轮之间睡满一个间隔。"""
    fake = FakeTime()
    calls = {"n": 0}
    run_at = []

    def fake_run_once(session_factory, settings=None):
        calls["n"] += 1
        run_at.append(fake.now)
        if calls["n"] == 1:
            raise RuntimeError("boom")
        worker._stop = True  # 第二轮成功后结束循环
        return {"accounts": {}, "pending_llm": 0}

    monkeypatch.setattr(worker, "time", fake)
    monkeypatch.setattr(worker, "run_once", fake_run_once)
    monkeypatch.setattr(
        worker, "get_settings",
        lambda: SimpleNamespace(sync_interval_minutes=15, database_path=":memory:"),
    )
    monkeypatch.setattr(worker, "make_engine", lambda path: object())
    monkeypatch.setattr(worker, "init_db", lambda engine: None)
    monkeypatch.setattr(worker, "make_session_factory", lambda engine: object())
    monkeypatch.setattr(worker, "signal", SimpleNamespace(SIGTERM=15, signal=lambda *a: None))
    monkeypatch.setattr(worker, "logging", SimpleNamespace(INFO=20, basicConfig=lambda **kw: None))
    monkeypatch.setattr(worker, "sys", SimpleNamespace(exit=lambda code: None))
    try:
        worker.main()
    finally:
        worker._stop = False
    assert calls["n"] == 2
    assert run_at[1] - run_at[0] == pytest.approx(900)
    assert len(fake.sleeps) == 900
