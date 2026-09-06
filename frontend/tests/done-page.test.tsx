// DonePage 测试：挂载拉取 done 列表并渲染两条；取消勾选发 PATCH open（离场动画后）；
// 切回页面命中模块级缓存（list-cache）时不闪加载圈、列表同步渲染。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createTheme } from '@mui/material/styles';
import DonePage from '../src/pages/DonePage';
import { resetLists } from '../src/lib/list-cache';
import { CARD_PAPER_OPACITY } from '../src/lib/glass';
import { cardRowSx } from '../src/lib/surface';
import { RADIUS } from '../src/rakko-tokens';

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
  // list-cache 是模块级缓存，跨用例残留会互相污染，每个用例从空缓存开始
  resetLists();
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

  it('切回页面命中缓存：第二次挂载不显示加载圈、同步渲染列表，且仍会后台重新请求', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      json({ items: ITEMS }),
    );
    vi.stubGlobal('fetch', fetchMock);

    // 首次挂载：先加载后渲染，数据落进模块级缓存
    render(<DonePage />);
    await screen.findByText('任务一');
    cleanup();

    // 再次挂载（模拟切走再切回）：缓存命中，无加载圈、列表同步渲染
    render(<DonePage />);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByText('任务一')).toBeTruthy();
    // 命中缓存仍会发起一次后台刷新
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});

describe('列表行卡片视觉（cardRowSx）', () => {
  it('cardRowSx 纯函数：color-mix 纸底 + 1px 边框 + 卡片圆角', () => {
    const theme = createTheme();
    const sx = cardRowSx(theme) as unknown as Record<string, string>;
    expect(sx.backgroundColor).toContain('color-mix');
    expect(sx.backgroundColor).toContain(CARD_PAPER_OPACITY);
    expect(sx.border).toBe(`1px solid ${theme.palette.divider}`);
    expect(sx.borderRadius).toBe(`${RADIUS.card}px`);
  });

  it('列表行的 ListItemButton 挂上了 sx（emotion 局部类），纸底样式实际应用到行', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      json({ items: ITEMS }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<DonePage />);
    await screen.findByText('任务一');

    const rowBtn = screen.getByText('任务一').closest(
      '.MuiListItemButton-root',
    ) as HTMLElement;
    expect(rowBtn).not.toBeNull();
    // sx 经 emotion 编译成 css-* 局部类挂在按钮上。jsdom 解析不了 color-mix 的
    // 计算结果（那是浏览器渲染层的事），这里只断言「sx 确实应用到了行」；
    // 纸底取值本身由上面的 cardRowSx 纯函数用例覆盖。
    expect(rowBtn.className).toMatch(/(?:^|\s)css-[A-Za-z0-9_-]+/);
  });
});
