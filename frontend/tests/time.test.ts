// todayIso 测试：本地日期 → YYYY-MM-DD，与 toISOString().slice(0,10) 的 UTC 口径对比。
// 本机时区若恰好是 UTC，凌晨/深夜构造不出「本地日 ≠ UTC 日」，那条用例退化为断言
// todayIso 的输出等于按本地分量手拼的结果（见用例内注释）。

import { describe, expect, it } from 'vitest';
import { todayIso } from '../src/lib/time';

/** 与实现口径相同的「手拼本地日期」参考值：本地年/月/日分量 */
function localDateString(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

describe('todayIso', () => {
  it('晚间时刻仍算本地当天：todayIso(new Date(2026, 8, 7, 23, 30)) → 2026-09-07', () => {
    // 9 月 7 日 23:30（本地）：不跨到「明天」。toISOString 的 UTC 口径在本地时区
    // 偏西时会给出 9 月 8 日，这里断言的是本地日。
    expect(todayIso(new Date(2026, 8, 7, 23, 30))).toBe('2026-09-07');
  });

  it('月/日补零：todayIso(new Date(2026, 0, 5, 0, 10)) → 2026-01-05', () => {
    expect(todayIso(new Date(2026, 0, 5, 0, 10))).toBe('2026-01-05');
  });

  it('凌晨边界：给的是本地日而非 UTC 日（与 toISOString().slice(0, 10) 口径对比）', () => {
    // 本地 1 月 5 日 00:10。本地时区在 UTC 以东（如中国 / 悉尼）时此刻的 UTC 日
    // 还是 1 月 4 日，toISOString().slice(0,10) 会给出「昨天」——todayIso 必须给
    // 本地日 1 月 5 日。
    const local = new Date(2026, 0, 5, 0, 10);
    expect(todayIso(local)).toBe('2026-01-05');
    // 恒成立的兜底：todayIso 永远等于按本地分量手拼的结果
    expect(todayIso(local)).toBe(localDateString(local));
    const utcSlice = local.toISOString().slice(0, 10);
    if (utcSlice !== '2026-01-05') {
      // 本机时区能让两者分道（UTC 以东）：断言 todayIso 不是 UTC 那天
      expect(todayIso(local)).not.toBe(utcSlice);
    }
    // 本机时区为 UTC 时 utcSlice === '2026-01-05'，走不到上面分支，无法构造差异；
    // 此时上面的本地分量断言已覆盖口径。
  });
});
