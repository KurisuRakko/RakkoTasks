// 相对时间工具：ISO 时间 → 「刚刚 / N 分钟前 / N 小时前 / N 天前」。

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
