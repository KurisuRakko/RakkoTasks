// 纯函数：条目分组为 今天 / 本周 / 重要 / 无期限、标记逾期，并负责「今日新邮件」判定。
// 日期比较一律基于「传入的 today」的本地年/月/日分量，不依赖真实当前时间，便于测试。
// 分组优先级（每条目只进一个组）：today（effectiveDate ≤ 今天，含逾期）→ thisWeek
// （明天~本周日）→ important（以上都不属于且 importance==='high'）→ later（其余）。
// effectiveDate = 最早提醒与截止日两者中更早的那个（见下方函数注释）。

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

/**
 * 条目「这天要管这件事」的本地日期：最早提醒与截止日两者中更早的那个（当地零点 Date）。
 *
 * 为什么取更早的那个（min）：提醒是「这天敲你」、截止是「这天要交」，两者都是
 * 「这天要管这件事」的信号。分组只看 due_date 的话，「明天 10:00 提醒我修空调、
 * 没有截止日」这类只有提醒的条目会掉进「无期限」组沉底——明天就要做的事跑到
 * 列表最底下，没用。
 *
 * 提醒是带 UTC 偏移的 ISO 时刻，必须先按本地时区折成当地零点再参与比较（口径与
 * parseDueDate 一致；不许 slice(0, 10)——那是 UTC 日期，本地时区一偏就差一天）。
 * 非法/无法解析的 remind_at 直接跳过，不抛。两者都没有返回 null。
 */
export function effectiveDate(item: Item): Date | null {
  // 显式在全部提醒里找最早的那条（按各自本地零点比较），别依赖 reminders 已按时间升序排好
  let earliestReminder: Date | null = null;
  for (const reminder of item.reminders) {
    const at = new Date(reminder.remind_at);
    if (Number.isNaN(at.getTime())) continue; // 非法时刻跳过，不抛
    const local = new Date(at.getFullYear(), at.getMonth(), at.getDate());
    if (earliestReminder === null || local.getTime() < earliestReminder.getTime()) {
      earliestReminder = local;
    }
  }
  const due = item.due_date ? parseDueDate(item.due_date) : null;
  if (earliestReminder === null) return due;
  if (due === null) return earliestReminder;
  return earliestReminder.getTime() <= due.getTime() ? earliestReminder : due;
}

/**
 * 条目是否已逾期（due_date 非空且早于 today）。
 * 这里只看 due_date、不掺 reminders：「逾期」说的是**过了截止日**；一个提醒时刻
 * 已过但截止日还在未来的条目不算逾期，红色高亮不该给它（提醒迟了是提醒层的表达）。
 */
export function isOverdue(item: Item, today: Date): boolean {
  if (!item.due_date) return false;
  const due = parseDueDate(item.due_date);
  const t = startOfDay(today);
  return due.getTime() < t.getTime();
}

/** 条目源邮件是否发送于 today 所在的本地日期（用于「今日新邮件」标记） */
export function isNewToday(item: Item, today: Date): boolean {
  if (!item.email_sent_at) return false;
  const sent = new Date(item.email_sent_at).getTime();
  if (Number.isNaN(sent)) return false;
  const start = startOfDay(today).getTime();
  const end = start + 86_400_000;
  return sent >= start && sent < end;
}

/** 截止日「快到了」的天数窗口：今天起 DUE_SOON_DAYS 天内到期算临期。 */
export const DUE_SOON_DAYS = 15;

/**
 * 条目是否临期（due_date 非空、尚未逾期、且在今天起 DUE_SOON_DAYS 天内到期）。
 * 与 isOverdue 互斥：已过截止日的走 isOverdue，这里只管「还没到但快到了」，
 * 两者在列表行里分别对应实心与描边的主色标记。
 */
export function isDueSoon(item: Item, today: Date): boolean {
  if (!item.due_date) return false;
  const due = parseDueDate(item.due_date);
  if (Number.isNaN(due.getTime())) return false;
  const t = startOfDay(today);
  if (due.getTime() < t.getTime()) return false; // 已逾期，归 isOverdue
  const limit = new Date(t.getFullYear(), t.getMonth(), t.getDate() + DUE_SOON_DAYS);
  return due.getTime() <= limit.getTime();
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

/** 按 effectiveDate（最早提醒与截止日中较早者）分组；today 由调用方传入，保证可测 */
export function groupItems(items: Item[], today: Date): GroupedResult {
  const result: GroupedResult = { today: [], thisWeek: [], important: [], later: [] };
  const t = startOfDay(today);
  const weekEnd = endOfThisWeek(today);
  for (const item of items) {
    const due = effectiveDate(item);
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
