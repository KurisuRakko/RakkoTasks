// refreshLists 的广播测试：同步跑完后列表要自己重拉，靠的是模块级刷新代数。
// 这里只验证「代数一变，已挂载的 useCachedList 重跑 fetcher 并拿到新数据」，
// 以及没有变化时不会平白多拉一次。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { openKey, refreshLists, resetLists, useCachedList, writeList } from '../src/lib/list-cache';
import type { Item } from '../src/types';

function makeItem(partial: Partial<Item> = {}): Item {
  return {
    id: 1,
    email_id: null,
    email_sent_at: null,
    title: 't',
    summary: null,
    category: '学业',
    due_date: null,
    importance: 'normal',
    actionable: true,
    status: 'open',
    detail_md: null,
    related: [],
    reminders: [],
    created_at: '2026-08-01T00:00:00Z',
    done_at: null,
    ...partial,
  };
}

beforeEach(() => {
  resetLists();
});

afterEach(() => {
  cleanup();
});

describe('refreshLists', () => {
  it('调用后已挂载的 useCachedList 重跑 fetcher，并把新数据写回缓存', async () => {
    const old = makeItem({ id: 1, title: '同步前' });
    const fresh = makeItem({ id: 2, title: '同步后' });
    const fetcher = vi.fn().mockResolvedValue([old]);
    const { result } = renderHook(() => useCachedList(openKey(null), fetcher));

    await act(async () => {});
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.items).toEqual([old]);

    // 下一次拉取返回同步刚写进来的新条目
    fetcher.mockResolvedValue([old, fresh]);
    await act(async () => {
      refreshLists();
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.items).toEqual([old, fresh]);
  });

  it('没有调用时不额外拉取（代数不变，effect 不重跑）', async () => {
    const fetcher = vi.fn().mockResolvedValue([makeItem()]);
    renderHook(() => useCachedList(openKey(null), fetcher));

    await act(async () => {});
    expect(fetcher).toHaveBeenCalledTimes(1);

    // 只是写缓存（后台刷新的正常路径）：列表快照变了，但刷新代数没变
    await act(async () => {
      writeList(openKey(null), [makeItem({ id: 3 })]);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('连续两次调用：每次都会重跑一次', async () => {
    const fetcher = vi.fn().mockResolvedValue([makeItem()]);
    renderHook(() => useCachedList(openKey(null), fetcher));
    await act(async () => {});

    await act(async () => {
      refreshLists();
    });
    await act(async () => {
      refreshLists();
    });

    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
