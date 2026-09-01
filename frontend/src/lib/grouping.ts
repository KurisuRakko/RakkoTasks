// 纯函数：条目分组为 今天 / 本周 / 重要 / 无期限，并标记逾期。
// 日期比较一律基于「传入的 today」的本地年/月/日分量，不依赖真实当前时间，便于测试。
// 分组优先级（每条目只进一个组）：today（due ≤ 今天，含逾期）→ thisWeek（明天~本周日）
// → important（以上都不属于且 importance==='high'）→ later（其余）。

import type { Item } from '../types';

export interface GroupedResult {
  /** 今天及以前（含逾期） */
  today: Item[];
  /** 明天 ~ 本周日 */
  thisWeek: Item[];
  /** 无近期日期但标为 high：重要但没截止日期，不沉底 */
  important: Item[];
  /** 其余无日期或超出本周 */
  later: Item[];
}

/** 解析 YYYY-MM-DD 为本地时区 Date（避免 Date('YYYY-MM-DD') 的 UTC 偏移） */
export function parseDueDate(date: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return new Date(NaN);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** 条目是否已逾期（due_date 非空且早于 today） */
export function isOverdue(item: Item, today: Date): boolean {
  if (!item.due_date) return false;
  const due = parseDueDate(item.due_date);
  const t = startOfDay(today);
  return due.getTime() < t.getTime();
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** today 所在周的周日（本地时区；若 today 恰是周日则返回当天） */
export function endOfThisWeek(today: Date): Date {
  const t = startOfDay(today);
  const day = t.getDay(); // 0 = 周日
  const offset = day === 0 ? 0 : 7 - day;
  return new Date(t.getFullYear(), t.getMonth(), t.getDate() + offset);
}

/** 按截止日期分组；today 由调用方传入，保证可测 */
export function groupItems(items: Item[], today: Date): GroupedResult {
  const result: GroupedResult = { today: [], thisWeek: [], important: [], later: [] };
  const t = startOfDay(today);
  const weekEnd = endOfThisWeek(today);
  for (const item of items) {
    const due = item.due_date ? parseDueDate(item.due_date) : null;
    if (!due) {
      // 无日期：high 进「重要」组顶上来，其余进「无期限」
      if (item.importance === 'high') {
        result.important.push(item);
      } else {
        result.later.push(item);
      }
    } else if (due.getTime() <= t.getTime()) {
      result.today.push(item);
    } else if (due.getTime() <= weekEnd.getTime()) {
      result.thisWeek.push(item);
    } else if (item.importance === 'high') {
      result.important.push(item);
    } else {
      result.later.push(item);
    }
  }
  return result;
}

/** 展示用短日期：M月D日 */
export function formatDueDate(date: string): string {
  const d = parseDueDate(date);
  if (Number.isNaN(d.getTime())) return date;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
