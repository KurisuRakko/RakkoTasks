// TasksPage 测试：high 条目渲染「重要」Chip，normal/low 条目不渲染；「重要」组标题出现。
// 另覆盖容器变换与 portal 相关行为：悬浮按钮挂在 body 下（不被路由转场盒子的
// transform 困住）、打 data-vt-shell 标记、勾选推进 LEAVE_DURATION 后发 PATCH done
// 且条目从列表消失；切回页面命中模块级缓存（list-cache）时不再闪加载圈。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import TasksPage from '../src/pages/TasksPage';
import { resetLists } from '../src/lib/list-cache';
import { LEAVE_DURATION } from '../src/lib/motion';
import { VT_SHELL_ATTR, VT_NAMES } from '../src/lib/view-transition';
import type { Item } from '../src/types';

function makeItem(partial: Partial<Item>): Item {
  return {
    id: 1,
    email_id: 1,
    email_sent_at: null,
    title: 't',
    summary: null,
    category: '工作',
    due_date: null,
    importance: 'normal',
    actionable: true,
    status: 'open',
    detail_md: null,
    related: [],
    created_at: '2026-08-01T00:00:00Z',
    done_at: null,
    ...partial,
  };
}

const ITEMS: Item[] = [
  makeItem({ id: 1, title: '重要任务', importance: 'high' }),
  makeItem({ id: 2, title: '普通任务', importance: 'normal', category: '学业' }),
  makeItem({ id: 3, title: '低重要任务', importance: 'low', category: '个人' }),
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

describe('TasksPage 重要度标记', () => {
  it('high 条目渲染「重要」Chip，normal/low 条目不渲染', async () => {
    const fetchMock = vi.fn(async () => json({ items: ITEMS }));
    vi.stubGlobal('fetch', fetchMock);

    render(<TasksPage />);

    expect(await screen.findByText('重要任务')).toBeTruthy();
    expect(await screen.findByText('普通任务')).toBeTruthy();
    expect(await screen.findByText('低重要任务')).toBeTruthy();

    // high 条目行内有「重要」Chip
    const highRow = screen.getByText('重要任务').closest('li');
    expect(highRow).not.toBeNull();
    expect(within(highRow!).getAllByText('重要').length).toBeGreaterThan(0);

    // 标签成组：行内「重要」Chip 收在横向 Stack 里（整组不被长标题挤压）
    const chip = within(highRow!).getAllByText('重要')[0];
    expect(chip.closest('.MuiStack-root')).not.toBeNull();

    // normal / low 条目行内没有「重要」Chip
    for (const title of ['普通任务', '低重要任务']) {
      const row = screen.getByText(title).closest('li');
      expect(row).not.toBeNull();
      expect(within(row!).queryByText('重要')).toBeNull();
    }
  });

  it('无日期 high 条目进「重要」组：分组标题与条目同时出现', async () => {
    const fetchMock = vi.fn(async () => json({ items: ITEMS }));
    vi.stubGlobal('fetch', fetchMock);

    render(<TasksPage />);

    await screen.findByText('重要任务');

    // 文本「重要」出现两次：一次是分组标题（ListSubheader），一次是 high 条目的 Chip
    expect(screen.getAllByText('重要')).toHaveLength(2);
  });
});

describe('今日新邮件蓝点', () => {
  it('今天发送的条目显示蓝点，旧条目不显示', async () => {
    const items: Item[] = [
      makeItem({ id: 11, title: '今天的新条目', email_sent_at: new Date().toISOString() }),
      makeItem({ id: 12, title: '旧条目', email_sent_at: '2026-08-01T00:00:00+00:00' }),
    ];
    const fetchMock = vi.fn(async () => json({ items }));
    vi.stubGlobal('fetch', fetchMock);

    render(<TasksPage />);

    await screen.findByText('今天的新条目');

    // 只有发送于今天的那条带蓝点
    expect(screen.getAllByLabelText('今日新邮件')).toHaveLength(1);

    // 蓝点位于新条目所在行内
    const newRow = screen.getByText('今天的新条目').closest('li');
    expect(newRow).not.toBeNull();
    expect(within(newRow!).getByLabelText('今日新邮件')).toBeTruthy();

    // 旧条目行内没有蓝点
    const oldRow = screen.getByText('旧条目').closest('li');
    expect(oldRow).not.toBeNull();
    expect(within(oldRow!).queryByLabelText('今日新邮件')).toBeNull();
  });
});

describe('TasksPage 手动添加', () => {
  it('页面存在右下角「添加任务」悬浮按钮', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: [] })));

    render(<TasksPage />);

    expect(await screen.findByRole('button', { name: '添加任务' })).toBeTruthy();
  });

  it('点「添加任务」打开编辑器，保存后 POST /api/items 且新标题出现在列表', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === 'POST') {
        // 契约：201 + 完整 Item（email_id null 的手动条目）
        return json(
          makeItem({
            id: 101,
            email_id: null,
            title: '买牛奶',
            summary: '两盒',
            category: '个人',
            status: 'open',
          }),
          201,
        );
      }
      if (u.startsWith('/api/items')) return json({ items: [] });
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<TasksPage />);

    fireEvent.click(await screen.findByRole('button', { name: '添加任务' }));
    const textarea = await screen.findByLabelText('任务内容');
    fireEvent.change(textarea, { target: { value: '买牛奶\n两盒' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true);
    });
    const postCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === 'POST',
    ) as [string, RequestInit];
    expect(postCall[0]).toBe('/api/items');
    expect(JSON.parse(String(postCall[1].body))).toEqual({
      title: '买牛奶',
      summary: '两盒',
      category: '个人',
      due_date: null,
    });

    // 新条目出现在列表中，并提示「已添加」
    expect(await screen.findByText('买牛奶')).toBeTruthy();
    expect(await screen.findByText('已添加')).toBeTruthy();
  });
});

describe('TasksPage 容器变换与 portal', () => {
  it('「添加任务」悬浮按钮的 parentElement 是 document.body（portal 生效）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: [] })));

    render(<TasksPage />);

    const fab = await screen.findByRole('button', { name: '添加任务' });
    expect(fab.parentElement).toBe(document.body);
  });

  it('悬浮按钮打 data-vt-shell 标记（持名由样式层按转场种类下发）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: [] })));

    render(<TasksPage />);

    const fab = await screen.findByRole('button', { name: '添加任务' });
    expect(fab.getAttribute(VT_SHELL_ATTR)).toBe(VT_NAMES.fab);
  });

  it('勾选条目后推进 LEAVE_DURATION：PATCH {"status":"done"} 且条目从列表消失', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === 'PATCH' && u === '/api/items/1') return json({});
      if (u.startsWith('/api/items')) return json({ items: ITEMS });
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<TasksPage />);
    await screen.findByText('重要任务');

    vi.useFakeTimers();
    try {
      const row = screen.getByText('重要任务').closest('li') as HTMLElement;
      expect(row).not.toBeNull();
      fireEvent.click(within(row).getByRole('checkbox'));

      // 离场动画结束（LEAVE_DURATION）后条目才移除并 PATCH done
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LEAVE_DURATION);
      });

      const patchCall = fetchMock.mock.calls.find(
        ([, init]) => init?.method === 'PATCH',
      ) as [string, RequestInit] | undefined;
      expect(patchCall).toBeDefined();
      expect(patchCall![0]).toBe('/api/items/1');
      expect(JSON.parse(String(patchCall![1].body))).toEqual({ status: 'done' });
      expect(screen.queryByText('重要任务')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('切回页面命中缓存：第二次挂载不显示加载圈、同步渲染列表，且仍会后台重新请求', async () => {
    const fetchMock = vi.fn(async () => json({ items: ITEMS }));
    vi.stubGlobal('fetch', fetchMock);

    // 首次挂载：先加载后渲染，数据落进模块级缓存
    render(<TasksPage />);
    await screen.findByText('重要任务');
    cleanup();

    // 再次挂载（模拟切走再切回）：缓存命中，无加载圈、列表同步渲染
    render(<TasksPage />);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByText('重要任务')).toBeTruthy();
    // 命中缓存仍会发起一次后台刷新
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
