"""进程内每用户滑动窗口限流：保护会产生 LLM 费用的端点。"""
from __future__ import annotations

import time
from collections import deque

_KEYS_MAX = 1024  # 防随机 key 撑爆内存，同 auth 缓存的容量思路


class RateLimiter:
    def __init__(self, max_calls: int, window_seconds: float, now_fn=time.monotonic):
        self.max_calls = max_calls
        self.window = window_seconds
        self._now = now_fn
        self._hits: dict[str, deque[float]] = {}

    def allow(self, key: str) -> bool:
        now = self._now()
        dq = self._hits.get(key)
        if dq is None:
            if len(self._hits) >= _KEYS_MAX:
                self._prune(now)
            dq = self._hits.setdefault(key, deque())
        while dq and dq[0] <= now - self.window:
            dq.popleft()
        if len(dq) >= self.max_calls:
            return False
        dq.append(now)
        return True

    def _prune(self, now: float) -> None:
        stale = [k for k, dq in self._hits.items() if not dq or dq[-1] <= now - self.window]
        for k in stale:
            del self._hits[k]
        if len(self._hits) >= _KEYS_MAX:
            self._hits.clear()
