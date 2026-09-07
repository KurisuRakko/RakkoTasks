// grouping 纯函数测试：日期边界全部基于传入的 today 动态构造，不依赖真实“现在”。

import { describe, expect, it } from 'vitest';
import { formatDueDate, groupItems, isNewToday, isOverdue, parseDueDate } from '../src/lib/grouping';
import { effectiveDate } from '../src/lib/grouping';
import { fromDatetimeLocalValue } from '../src/lib/time';
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
    email_sent_at: null,
    title: 't',
    summary: null,
    category: '工作',
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

/** 本地年/月/日/时/分 → 绝对时刻的 ISO 串（解析回本地仍是同一天同一钟点） */
function remindIso(y: number, mo: number, d: number, h: number, mi: number): string {
  return new Date(y, mo - 1, d, h, mi).toISOString();
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

  it('提醒时刻已过、截止日在未来 → 不逾期（isOverdue 只看 due_date）', () => {
    const item = makeItem({
      due_date: '2026-09-01',
      reminders: [{ id: 1, remind_at: remindIso(2026, 7, 1, 9, 0) }],
    });
    expect(isOverdue(item, today)).toBe(false);
  });

  it('截止日已过 → 逾期（即使未来还有提醒）', () => {
    const item = makeItem({
      due_date: '2026-08-04',
      reminders: [{ id: 1, remind_at: remindIso(2026, 9, 1, 9, 0) }],
    });
    expect(isOverdue(item, today)).toBe(true);
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

  it('无日期且 high → 重要组（不沉底）', () => {
    const item = makeItem({ id: 6, due_date: null, importance: 'high' });
    const g = groupItems([item], today);
    expect(g.important.map((i) => i.id)).toEqual([6]);
    expect(g.later).toHaveLength(0);
  });

  it('无日期且 normal → 无期限组', () => {
    const item = makeItem({ id: 7, due_date: null, importance: 'normal' });
    const g = groupItems([item], today);
    expect(g.later.map((i) => i.id)).toEqual([7]);
    expect(g.important).toHaveLength(0);
  });

  it('今天到期且 high → 今天组（日期优先于重要度）', () => {
    const item = makeItem({ id: 8, due_date: dateStr(today), importance: 'high' });
    const g = groupItems([item], today);
    expect(g.today.map((i) => i.id)).toEqual([8]);
    expect(g.important).toHaveLength(0);
  });

  it('下周到期且 high → 重要组（不是无期限）', () => {
    const item = makeItem({ id: 9, due_date: dateStr(nextMonday), importance: 'high' });
    const g = groupItems([item], today);
    expect(g.important.map((i) => i.id)).toEqual([9]);
    expect(g.later).toHaveLength(0);
    expect(g.thisWeek).toHaveLength(0);
  });
});

describe('isNewToday', () => {
  // email_sent_at 一律由本地时刻经 toISOString() 生成（绝对瞬间），
  // 与固定 today 的本地日期比较，保证任意时区下结果确定。
  it('today 当天 00:00:00（本地）→ true', () => {
    const sent = new Date(2026, 7, 5, 0, 0, 0).toISOString();
    expect(isNewToday(makeItem({ email_sent_at: sent }), today)).toBe(true);
  });

  it('today 当天 23:59:59（本地）→ true', () => {
    const sent = new Date(2026, 7, 5, 23, 59, 59).toISOString();
    expect(isNewToday(makeItem({ email_sent_at: sent }), today)).toBe(true);
  });

  it('前一天 23:59:59（本地）→ false', () => {
    const sent = new Date(2026, 7, 4, 23, 59, 59).toISOString();
    expect(isNewToday(makeItem({ email_sent_at: sent }), today)).toBe(false);
  });

  it('次日 00:00:00（本地）→ false', () => {
    const sent = new Date(2026, 7, 6, 0, 0, 0).toISOString();
    expect(isNewToday(makeItem({ email_sent_at: sent }), today)).toBe(false);
  });

  it('email_sent_at 为 null → false', () => {
    expect(isNewToday(makeItem({ email_sent_at: null }), today)).toBe(false);
  });

  it('非法字符串 → false', () => {
    expect(isNewToday(makeItem({ email_sent_at: 'not-a-date' }), today)).toBe(false);
  });
});

describe('formatDueDate', () => {
  it('输出 M月D日', () => {
    expect(formatDueDate('2026-08-05')).toBe('8月5日');
  });
});

describe('groupItems：提醒参与分组（键 = 最早提醒与截止日中较早者）', () => {
  const weekDay = new Date(today); // 本周内（非周日）的一天
  weekDay.setDate(weekDay.getDate() + 2);
  const nextMonth = new Date(2026, 8, 10); // 2026-09-10，超出本周

  it('只有提醒、提醒在今天 → 今天组（不沉到 later）', () => {
    const item = makeItem({
      id: 11,
      due_date: null,
      reminders: [{ id: 1, remind_at: remindIso(2026, 8, 5, 10, 0) }],
    });
    const g = groupItems([item], today);
    expect(g.today.map((i) => i.id)).toEqual([11]);
    expect(g.thisWeek).toHaveLength(0);
    expect(g.important).toHaveLength(0);
    expect(g.later).toHaveLength(0);
  });

  it('只有提醒、提醒在本周内 → 本周组', () => {
    const item = makeItem({
      id: 12,
      due_date: null,
      reminders: [{ id: 1, remind_at: remindIso(weekDay.getFullYear(), weekDay.getMonth() + 1, weekDay.getDate(), 9, 0) }],
    });
    const g = groupItems([item], today);
    expect(g.thisWeek.map((i) => i.id)).toEqual([12]);
    expect(g.today).toHaveLength(0);
    expect(g.later).toHaveLength(0);
  });

  it('提醒比截止早（提醒今天、截止下月）→ 今天组，证明取的是 min', () => {
    const item = makeItem({
      id: 13,
      due_date: dateStr(nextMonth),
      reminders: [{ id: 1, remind_at: remindIso(2026, 8, 5, 10, 0) }],
    });
    const g = groupItems([item], today);
    expect(g.today.map((i) => i.id)).toEqual([13]);
    expect(g.thisWeek).toHaveLength(0);
    expect(g.later).toHaveLength(0);
  });

  it('截止比提醒早（截止今天、提醒下月）→ 今天组', () => {
    const item = makeItem({
      id: 14,
      due_date: dateStr(today),
      reminders: [
        { id: 1, remind_at: remindIso(nextMonth.getFullYear(), nextMonth.getMonth() + 1, nextMonth.getDate(), 9, 0) },
      ],
    });
    const g = groupItems([item], today);
    expect(g.today.map((i) => i.id)).toEqual([14]);
    expect(g.thisWeek).toHaveLength(0);
    expect(g.later).toHaveLength(0);
  });

  it('多个提醒乱序挂上 → 取最早的那个算分组', () => {
    // 数组里先放晚的再放早的，模拟后端未按时间升序返回
    const item = makeItem({
      id: 15,
      due_date: null,
      reminders: [
        { id: 2, remind_at: remindIso(2026, 8, 9, 9, 0) }, // 本周内晚些时候
        { id: 1, remind_at: remindIso(2026, 8, 5, 10, 0) }, // 今天（最早）
      ],
    });
    const g = groupItems([item], today);
    expect(g.today.map((i) => i.id)).toEqual([15]);
    expect(g.thisWeek).toHaveLength(0);
    expect(g.later).toHaveLength(0);
  });

  it('提醒与截止都没有且 high → 重要组（回归，行为不变）', () => {
    const item = makeItem({ id: 16, due_date: null, importance: 'high' });
    const g = groupItems([item], today);
    expect(g.important.map((i) => i.id)).toEqual([16]);
    expect(g.later).toHaveLength(0);
  });

  it('提醒与截止都没有且 normal → 无期限组（回归，行为不变）', () => {
    const item = makeItem({ id: 17, due_date: null, importance: 'normal' });
    const g = groupItems([item], today);
    expect(g.later.map((i) => i.id)).toEqual([17]);
    expect(g.important).toHaveLength(0);
  });
});

describe('effectiveDate', () => {
  it('只有截止 → 返回截止日本地零点', () => {
    const d = effectiveDate(makeItem({ due_date: '2026-09-10' }));
    expect(d?.getFullYear()).toBe(2026);
    expect(d?.getMonth()).toBe(8);
    expect(d?.getDate()).toBe(10);
  });

  it('只有提醒 → 返回提醒日本地零点', () => {
    const d = effectiveDate(
      makeItem({ reminders: [{ id: 1, remind_at: remindIso(2026, 8, 5, 10, 0) }] }),
    );
    expect(d?.getFullYear()).toBe(2026);
    expect(d?.getMonth()).toBe(7);
    expect(d?.getDate()).toBe(5);
  });

  it('提醒与截止都有 → 取更早的那个', () => {
    const item = makeItem({
      due_date: '2026-09-10',
      reminders: [{ id: 1, remind_at: remindIso(2026, 8, 5, 10, 0) }],
    });
    const d = effectiveDate(item);
    expect(d?.getFullYear()).toBe(2026);
    expect(d?.getMonth()).toBe(7);
    expect(d?.getDate()).toBe(5);
  });

  it('两者都没有 → null', () => {
    expect(effectiveDate(makeItem())).toBeNull();
  });

  it('非法 remind_at（"nope"）跳过不抛，取剩下合法提醒里的最早', () => {
    const item = makeItem({
      due_date: null,
      reminders: [
        { id: 2, remind_at: 'nope' },
        { id: 1, remind_at: remindIso(2026, 8, 6, 9, 0) },
      ],
    });
    const d = effectiveDate(item);
    expect(d?.getFullYear()).toBe(2026);
    expect(d?.getMonth()).toBe(7);
    expect(d?.getDate()).toBe(6);
  });

  it('remind_at 全部非法且无截止 → null', () => {
    expect(
      effectiveDate(makeItem({ reminders: [{ id: 1, remind_at: 'nope' }] })),
    ).toBeNull();
  });

  it('remind_at 的 UTC 日期与本地日期不同天时，仍返回本地那天', () => {
    const offsetMin = new Date(2026, 7, 5, 12, 0).getTimezoneOffset();
    let remindAt: string;
    if (offsetMin === 0) {
      // 本机恰为 UTC：任何时刻的 UTC 日期 == 本地日期，构造不出跨天差异；
      // 退而用基座 fromDatetimeLocalValue 造一个带偏移的当地时刻，只验证本地日期正确
      // （该差异无法在本机时区复现，见执行报告 unresolved）。
      remindAt = fromDatetimeLocalValue('2026-08-05T00:30') as string;
    } else {
      // UTC+X（offsetMin<0）：当地凌晨 → UTC 还是前一天；UTC−X（offsetMin>0）：
      // 当地深夜 → UTC 已翻到次日。两种情况 UTC 日期都与本地日期不同天。
      const hour = offsetMin < 0 ? 0 : 23;
      const minute = offsetMin < 0 ? 15 : 30;
      remindAt = new Date(2026, 7, 5, hour, minute).toISOString();
      // 前置条件自检：这条 ISO 的 UTC 日期确实 ≠ 2026-08-05（否则本分支没测到跨天差异）
      const parsed = new Date(remindAt);
      const utcDay = `${parsed.getUTCFullYear()}-${parsed.getUTCMonth() + 1}-${parsed.getUTCDate()}`;
      expect(utcDay).not.toBe('2026-08-05');
    }

    const d = effectiveDate(
      makeItem({ due_date: null, reminders: [{ id: 1, remind_at: remindAt }] }),
    );
    expect(d?.getFullYear()).toBe(2026);
    expect(d?.getMonth()).toBe(7);
    expect(d?.getDate()).toBe(5);
  });
});
