// 时间工具：ISO 时间 → 「刚刚 / N 分钟前 / N 小时前 / N 天前」的相对时间，
// 浏览器本地日期 → YYYY-MM-DD（AI 解析端点要以「今天」作基准日），
// 以及提醒时刻的展示与 datetime-local 输入框之间的互转。

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 */
export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/**
 * 浏览器本地日期 → YYYY-MM-DD。
 *
 * 不许用 toISOString().slice(0, 10)——那是 UTC 日期：本地时区在 UTC 以东时，夜里
 * 会把「今天」算成「明天」（UTC 日已翻页）；以西时清晨又算成「昨天」。这里按本地
 * 年/月/日分量手拼，口径与 lib/grouping.ts 的 parseDueDate 一致（都按本地分量算）。
 * 参数 now 默认取当前时刻，测试可注入固定日期。
 */
export function todayIso(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}


/** 本地 IANA 时区名（AI 解析要用它把模型输出的墙上时刻换算成绝对时刻） */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** 两位补零 */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 提醒时刻（带偏移的 ISO 8601）→ 展示文案，按浏览器本地时区。
 * 与 grouping.formatDueDate 的「9月8日」口径对齐，后面补时刻；今天/明天用相对词。
 * 无法解析时原样返回，不抛。
 */
export function formatReminder(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const dayDiff =
    Math.round(
      (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
        new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) /
        86_400_000,
    );
  if (dayDiff === 0) return `今天 ${clock}`;
  if (dayDiff === 1) return `明天 ${clock}`;
  if (dayDiff === -1) return `昨天 ${clock}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${clock}`;
}

/**
 * 提醒时刻（带偏移的 ISO 8601）→ `<input type="datetime-local">` 的 value
 * （本地墙上时刻 "YYYY-MM-DDTHH:MM"）。不能用 toISOString().slice(0,16)——那是 UTC。
 */
export function toDatetimeLocalValue(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  );
}

/**
 * `<input type="datetime-local">` 的 value（本地墙上时刻）→ 带 UTC 偏移的
 * ISO 8601，供 POST/PATCH 的 reminders 用——后端拒收不带偏移的串。
 * 空串或非法返回 null。
 */
export function fromDatetimeLocalValue(value: string): string | null {
  if (!value) return null;
  // datetime-local 的值没有时区，new Date 会按本地时区解释，正是我们要的
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const offset = `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:00${offset}`
  );
}
