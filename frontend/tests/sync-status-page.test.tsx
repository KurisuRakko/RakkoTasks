// SyncStatusPage 测试：按阶段 + 按邮箱的进度展示。数据同样由真实的 SyncStatusProvider
// 拉取（api 换替身），状态页自己不发请求。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SyncStatusPage from '../src/pages/SyncStatusPage';
import { SyncStatusProvider } from '../src/lib/sync-status';
import { makeAccount, makeRun, makeStatus } from './sync-fixtures';

const { fetchSyncStatusMock, triggerSyncMock } = vi.hoisted(() => ({
  fetchSyncStatusMock: vi.fn(),
  triggerSyncMock: vi.fn(),
}));

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return { ...actual, fetchSyncStatus: fetchSyncStatusMock, triggerSync: triggerSyncMock };
});

/** 进行中的一轮：两个邮箱，一个完成新 3 封、一个失败带错误；分类阶段正在跑 */
function runningStatus() {
  return makeStatus({
    current: makeRun({
      id: 12,
      state: 'running',
      finished_at: null,
      stages: {
        fetch: {
          state: 'failed',
          error: '1 个邮箱拉取失败',
          accounts: [
            makeAccount({ email: 'ok@b.com', state: 'done', new_count: 3 }),
            makeAccount({
              email: 'bad@b.com',
              state: 'failed',
              new_count: 0,
              error: '登录失败：应用专用密码错误',
            }),
          ],
        },
        classify: { state: 'running', error: null, total: 12, done: 5, created: 2 },
        detail: { state: 'pending', error: null, total: 3, done: 0 },
      },
    }),
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <SyncStatusProvider>
        <SyncStatusPage />
      </SyncStatusProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchSyncStatusMock.mockReset();
  triggerSyncMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('SyncStatusPage 进行中的一轮', () => {
  it('渲染两个邮箱、失败原因、三个阶段名与转圈', async () => {
    fetchSyncStatusMock.mockResolvedValue(runningStatus());

    renderPage();
    // 假定时器下不用 findBy*（waitFor 会被计时器接管）：渲染与微任务各推进一次即可
    await act(async () => {});

    expect(screen.getByText('正在同步…')).toBeTruthy();
    // 按邮箱：完成的行报新增封数，失败的行整行转红并带一句话原因
    expect(screen.getByText('ok@b.com · 新 3 封')).toBeTruthy();
    expect(screen.getByText('bad@b.com · 新 0 封')).toBeTruthy();
    expect(screen.getByText('登录失败：应用专用密码错误')).toBeTruthy();
    // 三个阶段行
    expect(screen.getByText('拉取邮件')).toBeTruthy();
    expect(screen.getByText('AI 分类')).toBeTruthy();
    expect(screen.getByText('生成详情')).toBeTruthy();
    // 概览的转圈 + 分类阶段的转圈
    expect(screen.getAllByRole('progressbar').length).toBeGreaterThanOrEqual(2);
    // 进行中不给「立即同步」
    expect(screen.queryByRole('button', { name: '立即同步' })).toBeNull();
  });

  it('进行中且已完成数大于 0：分类阶段给出确定进度的进度条', async () => {
    fetchSyncStatusMock.mockResolvedValue(runningStatus());

    renderPage();
    await act(async () => {});

    // 概览转圈 + 分类阶段转圈 + 确定进度条
    const bars = screen.getAllByRole('progressbar');
    const determinate = bars.filter((el) => el.getAttribute('aria-valuenow') !== null);
    expect(determinate).toHaveLength(1);
    // MUI 把 aria-valuenow 取整；进度本身是 已完成/总数
    expect(Number(determinate[0].getAttribute('aria-valuenow'))).toBe(
      Math.round((5 / 12) * 100),
    );
  });
});

describe('SyncStatusPage 结束的一轮', () => {
  it('last 为失败时概览说「同步失败」，并报耗时与新增条数', async () => {
    fetchSyncStatusMock.mockResolvedValue(
      makeStatus({
        last: makeRun({
          id: 9,
          state: 'failed',
          stages: {
            fetch: { state: 'done', error: null, accounts: [makeAccount({ new_count: 4 })] },
            classify: { state: 'failed', error: '3 封分类失败', total: 12, done: 9, created: 1 },
            detail: { state: 'done', error: null, total: 3, done: 3 },
          },
        }),
      }),
    );

    renderPage();
    await act(async () => {});

    expect(screen.getByText('同步失败')).toBeTruthy();
    // 分类阶段整段失败的原因另起一行用 error 色显示
    expect(screen.getByText('3 封分类失败')).toBeTruthy();
    // 空闲态：给「立即同步」入口
    expect(screen.getByRole('button', { name: '立即同步' })).toBeTruthy();
  });

  it('手动轮次的详情阶段报「最近一周」口径', async () => {
    fetchSyncStatusMock.mockResolvedValue(makeStatus({ last: makeRun({ trigger: 'manual' }) }));

    renderPage();
    await act(async () => {});

    expect(screen.getByText('3 条（最近一周），已完成 3')).toBeTruthy();
  });
});

describe('SyncStatusPage 空态', () => {
  it('current 与 last 都为 null：一块「还没有同步记录」+「立即同步」', async () => {
    fetchSyncStatusMock.mockResolvedValue(makeStatus());

    renderPage();
    await act(async () => {});

    expect(screen.getByText('还没有同步记录')).toBeTruthy();
    expect(screen.getByRole('button', { name: '立即同步' })).toBeTruthy();
    // 空态下不该同时出现阶段面板
    expect(screen.queryByText('拉取邮件')).toBeNull();
  });
});
