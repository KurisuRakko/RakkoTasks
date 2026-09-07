// 时间工具：ISO 时间 → 「刚刚 / N 分钟前 / N 小时前 / N 天前」的相对时间，
// 以及浏览器本地日期 → YYYY-MM-DD（AI 解析端点要以「今天」作基准日）。

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
