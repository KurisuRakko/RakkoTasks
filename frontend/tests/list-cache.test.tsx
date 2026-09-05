// list-cache 测试：缓存键划分、与后端一致的 compareItems 排序、moveItem /
// upsertOpenItem / replaceItem / removeItem 的跨列表同步（含「不创建不存在的键」），
// 以及 useCachedList 的 stale-while-revalidate 行为：命中缓存立即展示、animateEnter
// 只在首次拿到数据时 true、后台刷新替换、刷新失败静默保留、卸载后不写缓存。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import {
  compareItems,
  DONE_KEY,
  moveItem,
  openKey,
  readList,
  removeItem,
  replaceItem,
  resetLists,
  upsertOpenItem,
  useCachedList,
  writeList,
} from '../src/lib/list-cache';
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
    created_at: '2026-08-01T00:00:00Z',
    done_at: null,
    ...partial,
  };
}

/** 预置四个键：全量 open、学业、工作、done（模拟任务页 / 已完成页都加载过） */
function seedKeys(): void {
  writeList(openKey(null), []);
  writeList(openKey('学业'), []);
  writeList(openKey('工作'), []);
  writeList(DONE_KEY, []);
}

beforeEach(() => {
  resetLists();
});

afterEach(() => {
  cleanup();
});

describe('compareItems', () => {
  it('无 due_date 的条目沉底', () => {
    const withDue = makeItem({ id: 1, due_date: '2026-09-01' });
    const noDue = makeItem({ id: 2, due_date: null });
    expect([noDue, withDue].sort(compareItems).map((i) => i.id)).toEqual([1, 2]);
  });

  it('有 due_date 按日期升序', () => {
    const later = makeItem({ id: 1, due_date: '2026-09-03' });
    const mid = makeItem({ id: 2, due_date: '2026-09-02' });
    const earlier = makeItem({ id: 3, due_date: '2026-09-01' });
    expect([later, mid, earlier].sort(compareItems).map((i) => i.id)).toEqual([3, 2, 1]);
  });

  it('同 due_date 按 created_at 降序', () => {
    const older = makeItem({ id: 1, created_at: '2026-08-01T00:00:00Z' });
    const newer = makeItem({ id: 2, created_at: '2026-08-02T00:00:00Z' });
    expect([older, newer].sort(compareItems).map((i) => i.id)).toEqual([2, 1]);
  });
});

describe('moveItem', () => {
  it('open → done：从所有 open 键移除，done 含它且按 compareItems 排序、status 为 done', () => {
    seedKeys();
    const a = makeItem({ id: 1, category: '学业', created_at: '2026-08-03T00:00:00Z' });
    // 三个 open 键都预置该条目，验证它会被从每个键移除
    writeList(openKey(null), [a]);
    writeList(openKey('学业'), [a]);
    writeList(openKey('工作'), [a]);
    const doneNewer = makeItem({
      id: 8,
      due_date: '2026-09-01',
      created_at: '2026-08-02T00:00:00Z',
      status: 'done',
    });
    const doneOlder = makeItem({
      id: 9,
      due_date: '2026-09-01',
      created_at: '2026-08-01T00:00:00Z',
      status: 'done',
    });
    writeList(DONE_KEY, [doneOlder, doneNewer]);

    moveItem(a, 'done');

    expect(readList(openKey(null))).toEqual([]);
    expect(readList(openKey('学业'))).toEqual([]);
    expect(readList(openKey('工作'))).toEqual([]);
    const done = readList(DONE_KEY)!;
    // a 无 due_date 沉底；两个带日期条目按 created_at 降序
    expect(done.map((i) => i.id)).toEqual([8, 9, 1]);
    expect(done[2].status).toBe('done');
  });

  it('done → open：回全量键与匹配分类键（按排序），不匹配分类键与 done 不再含，不创建新键', () => {
    seedKeys();
    const study = makeItem({
      id: 1,
      category: '学业',
      created_at: '2026-08-03T00:00:00Z',
      status: 'done',
    });
    writeList(DONE_KEY, [study]);
    writeList(openKey('学业'), [
      makeItem({ id: 2, category: '学业', due_date: '2026-09-01', created_at: '2026-08-01T00:00:00Z' }),
    ]);
    writeList(openKey('工作'), [makeItem({ id: 3, category: '工作', due_date: '2026-09-01' })]);

    moveItem(study, 'open');

    expect(readList(DONE_KEY)).toEqual([]);
    expect(readList(openKey(null))!.map((i) => i.id)).toEqual([1]);
    const studyList = readList(openKey('学业'))!;
    // study 无 due_date，沉在带日期条目之后
    expect(studyList.map((i) => i.id)).toEqual([2, 1]);
    expect(studyList[1].status).toBe('open');
    expect(readList(openKey('工作'))!.map((i) => i.id)).toEqual([3]);
    // 未预置过的分类键不会被凭空创建
    expect(readList(openKey('个人'))).toBeUndefined();
  });
});

describe('upsertOpenItem', () => {
  it('已有条目改分类：旧分类键移除，新分类键与全量键都含新版本', () => {
    seedKeys();
    const a = makeItem({ id: 1, category: '学业', title: '旧标题', due_date: '2026-09-01' });
    writeList(openKey(null), [a]);
    writeList(openKey('学业'), [a]);

    upsertOpenItem({ ...a, category: '工作', title: '新标题' });

    expect(readList(openKey('学业'))).toEqual([]);
    const all = readList(openKey(null))!;
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe('新标题');
    expect(all[0].category).toBe('工作');
    const work = readList(openKey('工作'))!;
    expect(work).toHaveLength(1);
    expect(work[0].title).toBe('新标题');
  });

  it('列表里不存在的条目按 compareItems 排序插入', () => {
    seedKeys();
    const older = makeItem({
      id: 2,
      title: '旧',
      due_date: '2026-09-01',
      created_at: '2026-07-01T00:00:00Z',
    });
    writeList(openKey(null), [older]);

    upsertOpenItem(
      makeItem({ id: 1, title: '新', due_date: '2026-09-01', created_at: '2026-08-01T00:00:00Z' }),
    );

    // 同日期的按 created_at 降序：新的在前
    expect(readList(openKey(null))!.map((i) => i.id)).toEqual([1, 2]);
  });
});

describe('replaceItem / removeItem', () => {
  it('replaceItem：所有列表里的同 id 条目就地替换（位置不变）', () => {
    seedKeys();
    const a = makeItem({ id: 1, title: 'a', due_date: '2026-09-01' });
    const b = makeItem({ id: 2, title: 'b', due_date: '2026-09-02' });
    writeList(openKey(null), [a, b]);
    writeList(DONE_KEY, [a]);

    replaceItem({ ...a, title: 'a2' });

    const list = readList(openKey(null))!;
    // 位置不变：a 仍在前，没有被按排序挪到 b 之后
    expect(list.map((i) => i.id)).toEqual([1, 2]);
    expect(list[0].title).toBe('a2');
    expect(readList(DONE_KEY)![0].title).toBe('a2');
  });

  it('removeItem：同 id 条目从所有键移除', () => {
    seedKeys();
    const a = makeItem({ id: 1 });
    writeList(openKey(null), [a]);
    writeList(DONE_KEY, [a]);

    removeItem(1);

    expect(readList(openKey(null))).toEqual([]);
    expect(readList(DONE_KEY)).toEqual([]);
  });
});

describe('useCachedList', () => {
  it('无缓存首挂：loading true、items undefined、animateEnter true；fetch 落定后有数据', async () => {
    let resolve!: (items: Item[]) => void;
    const fetcher = vi.fn(() => new Promise<Item[]>((r) => (resolve = r)));
    const { result } = renderHook(() => useCachedList(openKey(null), fetcher));

    expect(result.current.loading).toBe(true);
    expect(result.current.items).toBeUndefined();
    expect(result.current.error).toBe(false);
    expect(result.current.animateEnter).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);

    const items = [makeItem({ id: 1 })];
    await act(async () => {
      resolve(items);
    });

    expect(result.current.items).toBe(items);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe(false);
    // 从无到有拿到数据的这次挂载保持 animateEnter，供页面跑入场 stagger
    expect(result.current.animateEnter).toBe(true);
  });

  it('同 key 再挂：命中缓存立即有值、loading false、animateEnter false，仍后台刷新并替换', async () => {
    const first = makeItem({ id: 1, title: '旧数据' });
    const fetcher1 = vi.fn(async () => [first]);
    const firstHook = renderHook(() => useCachedList(DONE_KEY, fetcher1));
    await act(async () => {});
    expect(firstHook.result.current.items).toEqual([first]);
    firstHook.unmount();

    let resolve!: (items: Item[]) => void;
    const second = makeItem({ id: 2, title: '新数据' });
    const fetcher2 = vi.fn(() => new Promise<Item[]>((r) => (resolve = r)));
    const secondHook = renderHook(() => useCachedList(DONE_KEY, fetcher2));

    expect(secondHook.result.current.items).toEqual([first]);
    expect(secondHook.result.current.loading).toBe(false);
    expect(secondHook.result.current.error).toBe(false);
    expect(secondHook.result.current.animateEnter).toBe(false);
    // 命中缓存仍会发起一次后台刷新
    expect(fetcher2).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve([first, second]);
    });
    expect(secondHook.result.current.items).toEqual([first, second]);
    secondHook.unmount();
  });

  it('无缓存且 fetch 失败：error true、loading false', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('boom');
    });
    const { result } = renderHook(() => useCachedList('k', fetcher));

    expect(result.current.loading).toBe(true);
    await act(async () => {});
    expect(result.current.error).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.items).toBeUndefined();
  });

  it('命中缓存且刷新失败：保留旧数据、error false（静默不打扰）', async () => {
    const old = [makeItem({ id: 1, title: '旧' })];
    writeList(DONE_KEY, old);
    const fetcher = vi.fn(async () => {
      throw new Error('boom');
    });
    const { result } = renderHook(() => useCachedList(DONE_KEY, fetcher));

    expect(result.current.items).toEqual(old);
    expect(result.current.loading).toBe(false);
    await act(async () => {});
    expect(result.current.items).toEqual(old);
    expect(result.current.error).toBe(false);
  });

  it('卸载后 Promise 才落定：alive 守卫不写缓存', async () => {
    let resolve!: (items: Item[]) => void;
    const fetcher = vi.fn(() => new Promise<Item[]>((r) => (resolve = r)));
    const { unmount } = renderHook(() => useCachedList('k', fetcher));
    expect(fetcher).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      resolve([makeItem({ id: 1 })]);
    });
    expect(readList('k')).toBeUndefined();
  });
});
