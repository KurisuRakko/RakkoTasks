// grouping 纯函数测试：日期边界全部基于传入的 today 动态构造，不依赖真实“现在”。

import { describe, expect, it } from 'vitest';
import { formatDueDate, groupItems, isOverdue, parseDueDate } from '../src/lib/grouping';
import type { Item } from '../src/types';

/** 固定 today：2026-08-05（本地时区） */
const today = new Date(2026, 7, 5);

function dateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function makeItem(partial: Partial<Item> = {}): Item {
  return {
    id: 1,
    email_id: 1,
    title: 't',
    summary: null,
    category: '工作',
    due_date: null,
    actionable: true,
    status: 'open',
    detail_md: null,
    created_at: '2026-08-01T00:00:00Z',
    done_at: null,
    ...partial,
  };
}

describe('parseDueDate', () => {
  it('解析 YYYY-MM-DD 为本地时区日期', () => {
    const d = parseDueDate('2026-08-05');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7);
    expect(d.getDate()).toBe(5);
  });

  it('非法格式返回 Invalid Date', () => {
    expect(Number.isNaN(parseDueDate('2026-8-5').getTime())).toBe(true);
  });
});

describe('isOverdue', () => {
  it('昨天到期 → 逾期', () => {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    expect(isOverdue(makeItem({ due_date: dateStr(yesterday) }), today)).toBe(true);
  });

  it('今天到期 → 不逾期', () => {
    expect(isOverdue(makeItem({ due_date: dateStr(today) }), today)).toBe(false);
  });

  it('无截止日期 → 不逾期', () => {
    expect(isOverdue(makeItem({ due_date: null }), today)).toBe(false);
  });
});

describe('groupItems', () => {
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  // 本周日（today 所在周的边界）
  const sunday = new Date(today);
  sunday.setDate(sunday.getDate() + (7 - sunday.getDay()));
  // 下周一（超出本周）
  const nextMonday = new Date(sunday);
  nextMonday.setDate(nextMonday.getDate() + 1);

  it('昨天到期 → 今天组', () => {
    const item = makeItem({ id: 1, due_date: dateStr(yesterday) });
    const g = groupItems([item], today);
    expect(g.today.map((i) => i.id)).toEqual([1]);
    expect(g.thisWeek).toHaveLength(0);
    expect(g.later).toHaveLength(0);
  });

  it('今天到期 → 今天组', () => {
    const item = makeItem({ id: 2, due_date: dateStr(today) });
    const g = groupItems([item], today);
    expect(g.today.map((i) => i.id)).toEqual([2]);
    expect(g.thisWeek).toHaveLength(0);
    expect(g.later).toHaveLength(0);
  });

  it('本周日边界 → 本周组', () => {
    const item = makeItem({ id: 3, due_date: dateStr(sunday) });
    const g = groupItems([item], today);
    expect(g.thisWeek.map((i) => i.id)).toEqual([3]);
    expect(g.today).toHaveLength(0);
    expect(g.later).toHaveLength(0);
  });

  it('下周一 → 无期限组', () => {
    const item = makeItem({ id: 4, due_date: dateStr(nextMonday) });
    const g = groupItems([item], today);
    expect(g.later.map((i) => i.id)).toEqual([4]);
    expect(g.today).toHaveLength(0);
    expect(g.thisWeek).toHaveLength(0);
  });

  it('无截止日期 → 无期限组', () => {
    const item = makeItem({ id: 5, due_date: null });
    const g = groupItems([item], today);
    expect(g.later.map((i) => i.id)).toEqual([5]);
    expect(g.today).toHaveLength(0);
    expect(g.thisWeek).toHaveLength(0);
  });

  it('多条目混合分组互不干扰', () => {
    const items = [
      makeItem({ id: 1, due_date: dateStr(yesterday) }),
      makeItem({ id: 2, due_date: dateStr(sunday) }),
      makeItem({ id: 3, due_date: null }),
    ];
    const g = groupItems(items, today);
    expect(g.today.map((i) => i.id)).toEqual([1]);
    expect(g.thisWeek.map((i) => i.id)).toEqual([2]);
    expect(g.later.map((i) => i.id)).toEqual([3]);
  });
});

describe('formatDueDate', () => {
  it('输出 M月D日', () => {
    expect(formatDueDate('2026-08-05')).toBe('8月5日');
  });
});
