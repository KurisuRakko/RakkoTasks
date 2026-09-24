// SyncStatusProvider 测试：轮询节奏与收尾判定。
// - 忙（current 非空或 pending_request）时每 SYNC_POLL_MS 拉一次；闲时不排任何定时器，
//   推进 10 秒也只有挂载那一次；
// - 从「进行中」变为「current 为 null + 新的 last」时：completion 记下这一轮的结果与
//   新增条数，且无论手动还是定时都调用 list-cache 的 refreshLists（列表重拉）；
// - 定时轮次同样重拉列表，但不出完成提示（顶栏不该为后台自己的事抢标题）。
// api 与 list-cache 的 refreshLists 都换成替身，这里只验证「什么时候调、结果是什么」。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SYNC_POLL_MS, SyncStatusProvider, useSyncStatus } from '../src/lib/sync-status';
import { makeAccount, makeRun, makeStatus } from './sync-fixtures';

const { fetchSyncStatusMock, triggerSyncMock } = vi.hoisted(() => ({
  fetchSyncStatusMock: vi.fn(),
  triggerSyncMock: vi.fn(),
}));
const { refreshListsMock } = vi.hoisted(() => ({ refreshListsMock: vi.fn() }));

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return { ...actual, fetchSyncStatus: fetchSyncStatusMock, triggerSync: triggerSyncMock };
});

vi.mock('../src/lib/list-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/list-cache')>();
  return { ...actual, refreshLists: refreshListsMock };
});

/** 把上下文里可断言的字段摊成文本，免得每个用例各写一套渲染 */
function Probe() {
  const { status, completion, trigger } = useSyncStatus();
  const phase =
    status === null ? 'null' : status.current !== null || status.pending_request ? 'busy' : 'idle';
  return (
    <>
      <span data-testid="phase">{phase}</span>
      <span data-testid="completion">
        {completion === null ? 'none' : `${completion.state}:${completion.created}`}
      </span>
      <button onClick={trigger}>probe-trigger</button>
    </>
  );
}

function renderProvider() {
  return render(
    <SyncStatusProvider>
      <Probe />
    </SyncStatusProvider>,
  );
}

/** 推进到下一拍轮询并让响应落定（假定时器下必须异步推进，否则微任务不跑） */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchSyncStatusMock.mockReset();
  triggerSyncMock.mockReset();
  refreshListsMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('SyncStatusProvider 轮询节奏', () => {
  it('current 为 running 时每 1500ms 轮询一次（推进 4500ms 至少 3 次）', async () => {
    fetchSyncStatusMock.mockResolvedValue(
      makeStatus({ current: makeRun({ state: 'running', finished_at: null }) }),
    );

    renderProvider();
    await act(async () => {});
    // 挂载先拉一次
    expect(fetchSyncStatusMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('phase').textContent).toBe('busy');

    await advance(SYNC_POLL_MS * 3);
    expect(fetchSyncStatusMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('current 为 null 且 pending_request 为 false 时不轮询：推进 10 秒仍只有挂载那一次', async () => {
    fetchSyncStatusMock.mockResolvedValue(makeStatus());

    renderProvider();
    await act(async () => {});
    expect(fetchSyncStatusMock).toHaveBeenCalledTimes(1);

    await advance(10_000);
    expect(fetchSyncStatusMock).toHaveBeenCalledTimes(1);
  });
});

describe('SyncStatusProvider 收尾判定', () => {
  it('手动轮次收尾：completion 记下 state 与新增条数，并调用 refreshLists', async () => {
    fetchSyncStatusMock
      .mockResolvedValueOnce(
        makeStatus({ current: makeRun({ id: 12, state: 'running', finished_at: null }) }),
      )
      .mockResolvedValue(makeStatus({ last: makeRun({ id: 12, state: 'done' }) }));

    renderProvider();
    await act(async () => {});
    expect(screen.getByTestId('completion').textContent).toBe('none');
    expect(refreshListsMock).not.toHaveBeenCalled();

    await advance(SYNC_POLL_MS);
    expect(screen.getByTestId('phase').textContent).toBe('idle');
    // 夹具的 classify.created = 2
    expect(screen.getByTestId('completion').textContent).toBe('done:2');
    expect(refreshListsMock).toHaveBeenCalledTimes(1);
  });

  it('失败轮次：completion.state 为 failed', async () => {
    fetchSyncStatusMock
      .mockResolvedValueOnce(
        makeStatus({ current: makeRun({ id: 7, state: 'running', finished_at: null }) }),
      )
      .mockResolvedValue(
        makeStatus({
          last: makeRun({
            id: 7,
            state: 'failed',
            stages: {
              fetch: { state: 'failed', error: '1 个邮箱拉取失败', accounts: [makeAccount()] },
              classify: { state: 'pending', error: null, total: 0, done: 0, created: 0 },
              detail: { state: 'pending', error: null, total: 0, done: 0 },
            },
          }),
        }),
      );

    renderProvider();
    await act(async () => {});
    await advance(SYNC_POLL_MS);

    expect(screen.getByTestId('completion').textContent).toBe('failed:0');
    expect(refreshListsMock).toHaveBeenCalledTimes(1);
  });

  it('定时轮次收尾：仍然重拉列表，但不发完成提示（顶栏不抢标题）', async () => {
    fetchSyncStatusMock
      .mockResolvedValueOnce(
        makeStatus({
          current: makeRun({ id: 20, trigger: 'scheduled', state: 'running', finished_at: null }),
        }),
      )
      .mockResolvedValue(makeStatus({ last: makeRun({ id: 20, trigger: 'scheduled' }) }));

    renderProvider();
    await act(async () => {});
    await advance(SYNC_POLL_MS);

    expect(refreshListsMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('completion').textContent).toBe('none');
  });

  it('点过刷新后 worker 才醒（pending_request）：这一轮算手动，收尾时给完成提示', async () => {
    fetchSyncStatusMock
      .mockResolvedValueOnce(makeStatus())
      .mockResolvedValue(makeStatus({ last: makeRun({ id: 31, state: 'done' }) }));
    triggerSyncMock.mockResolvedValue({ accepted: true, already_running: false });

    renderProvider();
    await act(async () => {});
    expect(screen.getByTestId('phase').textContent).toBe('idle');

    // 点「刷新」：接受请求后本地立刻停在忙态（worker 还没醒时 current 仍是 null）
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'probe-trigger' }));
    });
    expect(triggerSyncMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('phase').textContent).toBe('busy');

    await advance(SYNC_POLL_MS);
    expect(screen.getByTestId('completion').textContent).toBe('done:2');
    expect(refreshListsMock).toHaveBeenCalledTimes(1);
  });
});
