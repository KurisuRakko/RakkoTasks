// 同步相关测试的夹具工厂：契约里的 Run / Stage / Acct 三种形状各一个出口，
// provider / 顶栏按钮 / 状态页三个测试文件共用，同一份 JSON 不抄三遍。
// 默认值取「刚跑完的一轮手动同步」，用例只覆写自己关心的字段。

import type { SyncAccountProgress, SyncRun, SyncStatus } from '../src/types';

/** 一轮同步 */
export function makeRun(partial: Partial<SyncRun> = {}): SyncRun {
  return {
    id: 12,
    trigger: 'manual',
    state: 'done',
    started_at: '2026-09-24T09:41:03',
    finished_at: '2026-09-24T09:41:45',
    error: null,
    stages: {
      fetch: { state: 'done', error: null, accounts: [] },
      classify: { state: 'done', error: null, total: 12, done: 12, created: 2 },
      detail: { state: 'done', error: null, total: 3, done: 3 },
    },
    ...partial,
  };
}

/** GET /api/sync/status 返回体：默认「没有进行中的轮次、也从没跑过」 */
export function makeStatus(partial: Partial<SyncStatus> = {}): SyncStatus {
  return { current: null, last: null, pending_request: false, ...partial };
}

/** 拉取阶段里的一个邮箱 */
export function makeAccount(partial: Partial<SyncAccountProgress> = {}): SyncAccountProgress {
  return { email: 'a@b.com', state: 'done', new_count: 3, error: null, ...partial };
}
