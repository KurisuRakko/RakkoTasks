// SyncTitleBar 测试：五个形态的文案与点击行为，以及「同步完成」停留 2.4 秒后自动收起。
// 状态由真实的 SyncStatusProvider 驱动（api 换替身），不假造上下文——「点刷新调用
// triggerSync」这条要一路走到 api 才算数。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SyncTitleBar, { DONE_HOLD_MS } from '../src/components/SyncTitleBar';
import { SYNC_POLL_MS, SyncStatusProvider } from '../src/lib/sync-status';
import { makeRun, makeStatus } from './sync-fixtures';

const { fetchSyncStatusMock, triggerSyncMock } = vi.hoisted(() => ({
  fetchSyncStatusMock: vi.fn(),
  triggerSyncMock: vi.fn(),
}));

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return { ...actual, fetchSyncStatus: fetchSyncStatusMock, triggerSync: triggerSyncMock };
});

function renderBar() {
  return render(
    <MemoryRouter>
      <SyncStatusProvider>
        <SyncTitleBar />
      </SyncStatusProvider>
    </MemoryRouter>,
  );
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** 失败轮次的完整夹具：fetch 阶段挂一个失败的邮箱，classify / detail 没轮到 */
function failedRun() {
  return makeRun({
    id: 7,
    state: 'failed',
    stages: {
      fetch: { state: 'failed', error: '1 个邮箱拉取失败', accounts: [] },
      classify: { state: 'pending', error: null, total: 0, done: 0, created: 0 },
      detail: { state: 'pending', error: null, total: 0, done: 0 },
    },
  });
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

describe('SyncTitleBar 空闲态', () => {
  it('渲染「刷新」，点击调用 triggerSync 并立刻转成进行中的形态', async () => {
    fetchSyncStatusMock.mockResolvedValue(makeStatus());
    triggerSyncMock.mockResolvedValue({ accepted: true, already_running: false });

    renderBar();
    await act(async () => {});

    const refresh = screen.getByRole('button', { name: '刷新' });
    expect(refresh.textContent).toContain('刷新');

    await act(async () => {
      fireEvent.click(refresh);
    });

    expect(triggerSyncMock).toHaveBeenCalledTimes(1);
    // 请求已受理（202）：不等下一拍轮询，按钮立刻换成进行中的文案
    expect(screen.getByRole('button', { name: '查看同步状态' })).toBeTruthy();
  });
});

describe('SyncTitleBar 进行中', () => {
  it('手动轮次：文字变「查看同步状态」，图标是转圈', async () => {
    fetchSyncStatusMock.mockResolvedValue(
      makeStatus({ current: makeRun({ state: 'running', finished_at: null }) }),
    );

    renderBar();
    await act(async () => {});

    const button = screen.getByRole('button', { name: '查看同步状态' });
    expect(button.textContent).toContain('查看同步状态');
    expect(screen.getByRole('progressbar')).toBeTruthy();
  });

  it('定时轮次：只转圈，文字仍是「刷新」（不抢标题）', async () => {
    fetchSyncStatusMock.mockResolvedValue(
      makeStatus({
        current: makeRun({ trigger: 'scheduled', state: 'running', finished_at: null }),
      }),
    );

    renderBar();
    await act(async () => {});

    const button = screen.getByRole('button', { name: '刷新' });
    expect(button.textContent).toContain('刷新');
    expect(screen.getByRole('progressbar')).toBeTruthy();
  });
});

describe('SyncTitleBar 完成态', () => {
  it('done：报「同步完成，新增 2 条待办」，停留 2.4 秒后回到「刷新」', async () => {
    fetchSyncStatusMock
      .mockResolvedValueOnce(
        makeStatus({ current: makeRun({ id: 12, state: 'running', finished_at: null }) }),
      )
      // 夹具的 classify.created = 2
      .mockResolvedValue(makeStatus({ last: makeRun({ id: 12, state: 'done' }) }));

    renderBar();
    await act(async () => {});
    await advance(SYNC_POLL_MS);

    expect(screen.getByText('同步完成，新增 2 条待办')).toBeTruthy();

    await advance(DONE_HOLD_MS);
    expect(screen.getByRole('button', { name: '刷新' })).toBeTruthy();
    expect(screen.queryByText('同步完成，新增 2 条待办')).toBeNull();
  });

  it('failed：报「同步失败」且不自动消失（等用户处置）', async () => {
    fetchSyncStatusMock
      .mockResolvedValueOnce(
        makeStatus({ current: makeRun({ id: 7, state: 'running', finished_at: null }) }),
      )
      .mockResolvedValue(makeStatus({ last: failedRun() }));

    renderBar();
    await act(async () => {});
    await advance(SYNC_POLL_MS);

    // 读屏名带上「查看详情」，与可见文字不同
    const button = screen.getByRole('button', { name: '同步失败，查看详情' });
    expect(button.textContent).toContain('同步失败');

    await advance(DONE_HOLD_MS + 1000);
    expect(screen.getByRole('button', { name: '同步失败，查看详情' })).toBeTruthy();
  });
});
