// DonePage 测试：挂载拉取 done 列表并渲染两条；取消勾选发 PATCH open（离场动画后）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import DonePage from '../src/pages/DonePage';

const ITEMS = [
  {
    id: 1,
    email_id: 1,
    email_sent_at: null,
    title: '任务一',
    summary: null,
    category: '工作',
    due_date: null,
    actionable: true,
    status: 'done',
    detail_md: null,
    created_at: '2026-08-01T00:00:00Z',
    done_at: '2026-08-02T00:00:00Z',
  },
  {
    id: 2,
    email_id: 2,
    email_sent_at: null,
    title: '任务二',
    summary: null,
    category: '学业',
    due_date: null,
    actionable: true,
    status: 'done',
    detail_md: null,
    created_at: '2026-08-01T00:00:00Z',
    done_at: '2026-08-02T00:00:00Z',
  },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DonePage', () => {
  it('挂载时 GET /api/items?status=done，渲染两条标题', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      json({ items: ITEMS }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<DonePage />);

    expect(await screen.findByText('任务一')).toBeTruthy();
    expect(await screen.findByText('任务二')).toBeTruthy();
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('/api/items?status=done');
  });

  it('列表渲染后每条目的复选框默认勾选（checked 为 true）', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      json({ items: ITEMS }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<DonePage />);
    await screen.findByText('任务一');

    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes).toHaveLength(2);
    expect(boxes[0].checked).toBe(true);
    expect(boxes[1].checked).toBe(true);
  });

  it('点击第一条 checkbox 后发 PATCH /api/items/1，body {"status":"open"}', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === 'PATCH') return json({ id: 1, status: 'open' });
      if (u.startsWith('/api/items')) return json({ items: ITEMS });
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<DonePage />);
    await screen.findByText('任务一');

    fireEvent.click(screen.getAllByRole('checkbox')[0]);

    // 离场动画 260ms 结束后才发请求，waitFor 等待真实定时器到期
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true);
    });
    const patchCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === 'PATCH',
    ) as [string, RequestInit] | undefined;
    expect(patchCall).toBeDefined();
    const [url, init] = patchCall!;
    expect(url).toBe('/api/items/1');
    expect(JSON.parse(String(init.body))).toEqual({ status: 'open' });
  });
});
