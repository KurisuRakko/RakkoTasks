// TasksPage 测试：high 条目渲染「重要」Chip，normal/low 条目不渲染；「重要」组标题出现。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import TasksPage from '../src/pages/TasksPage';
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
