// TasksPage 的 AI 快速添加编排测试：加号打开的是 AiAddDialog（基座占位实现渲染
// null，这里 vi.mock 成可控测试替身驱动回调，只验证编排、不验证对话框内部渲染）。
// 覆盖：速记模式点确定先关窗、后台 POST /api/items/quick（body 含 text 与 today）；
// ai_parsed true/false 与网络失败三种结果提示；「查看」开详情；新条目进列表缓存；
// 速记开关 localStorage 持久化与抛异常兜底；非速记保存走 POST /api/items 且
// importance/actionable 透传不丢；onParse 打 POST /api/items/parse。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TasksPage from '../src/pages/TasksPage';
import type { AiAddDialogProps } from '../src/components/AiAddDialog';
import { resetLists } from '../src/lib/list-cache';
import { localTimeZone, todayIso } from '../src/lib/time';
import type { Item } from '../src/types';

const QUICK_MODE_KEY = 'rakkotasks.quick-mode';
const QUICK_TEXT = '明天提醒我去把空调修了';

// vi.mock 工厂会被提升到 import 之前执行，只能引用字面量与 vi.hoisted 值，
// 因此文案在此内联，不能引用文件里的 QUICK_TEXT 常量。
vi.mock('../src/components/AiAddDialog', () => ({
  // 替身认 open：真组件常驻挂载、由 Dialog 按 open 跑入退场并在退场后卸载内容，
  // 替身若无视 open 就永远在场，「点确定立刻关窗」这条断言等于没测
  default: (props: AiAddDialogProps) =>
    !props.open ? null : (
    <div>
      <button onClick={() => props.onQuickSubmit('明天提醒我去把空调修了')}>替身-速记提交</button>
      <button
        onClick={() =>
          props.onSubmit([
            {
              title: '买牛奶',
              summary: '两盒',
              category: '个人',
              due_date: null,
              importance: 'high',
              actionable: true,
            },
          ])
        }
      >
        替身-普通保存
      </button>
      <button onClick={() => void props.onParse('测试文本')}>替身-解析</button>
      <button onClick={() => props.onQuickModeChange(true)}>替身-切速记</button>
      <span>速记模式：{props.quickMode ? '开' : '关'}</span>
    </div>
  ),
}));

function makeItem(partial: Partial<Item>): Item {
  return {
    id: 1,
    email_id: null, // 手动条目：打开详情时 ItemDialog 不会发懒生成请求
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
    reminders: [],
    created_at: '2026-08-01T00:00:00Z',
    done_at: null,
    ...partial,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function quickResponse(over: Partial<{ items: Item[]; ai_parsed: boolean }> = {}): Response {
  return json(
    { items: [makeItem({ id: 9, title: QUICK_TEXT })], ai_parsed: true, ...over },
    201,
  );
}

/**
 * 渲染页面并 stub fetch：handler 只处理业务路由（GET 空列表兜底由 fetchMock 负责）。
 * 返回 fetchMock，调用记录形如 [url, init]。
 */
function renderPage(handler: (url: string, init?: RequestInit) => Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'POST') return handler(u, init);
    if (u.startsWith('/api/items')) return json({ items: [] });
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(
      <MemoryRouter useTransitions={false}>
        <TasksPage />
      </MemoryRouter>,
    );
  return fetchMock;
}

/** 点开「+」，返回对话框替身里的速记提交按钮 */
async function openDialogAndQuickSubmit(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: '新建待办' }));
  return screen.findByRole('button', { name: '替身-速记提交' });
}

beforeEach(() => {
  localStorage.clear();
  resetLists();
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('速记模式后台落库', () => {
  it('点确定立刻关窗，POST /api/items/quick，请求体含 text、today 与 tz', async () => {
    const fetchMock = renderPage(() => quickResponse());
    fireEvent.click(await screen.findByRole('button', { name: '新建待办' }));
    // 对话框替身已渲染（addOpen 为 true）
    expect(await screen.findByText('速记模式：关')).toBeTruthy();

    fireEvent.click(await screen.findByRole('button', { name: '替身-速记提交' }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) => url === '/api/items/quick'),
      ).toBe(true);
    });
    const quickCall = fetchMock.mock.calls.find(
      ([url]) => url === '/api/items/quick',
    ) as [string, RequestInit];
    expect(quickCall[1].method).toBe('POST');
    expect(JSON.parse(String(quickCall[1].body))).toEqual({
      text: QUICK_TEXT,
      today: todayIso(),
      tz: localTimeZone(),
    });

    // 对话框已收回（addOpen false），悬浮按钮仍在
    await waitFor(() => expect(screen.queryByText('替身-速记提交')).toBeNull());
    expect(screen.getByRole('button', { name: '新建待办' })).toBeTruthy();
  });

  it('ai_parsed=true：Snackbar 文案「已保存：<title>」，带「查看」按钮', async () => {
    renderPage(() => quickResponse({ items: [makeItem({ id: 9, title: '预约空调维修' })] }));
    fireEvent.click(await openDialogAndQuickSubmit());

    expect(await screen.findByText('已保存：预约空调维修')).toBeTruthy();
    expect(screen.getByRole('button', { name: '查看' })).toBeTruthy();
  });

  it('ai_parsed=false（HTTP 仍是 201）：提示「未能识别内容，已按原文保存」，不是「保存失败」', async () => {
    renderPage(() =>
      quickResponse({ items: [makeItem({ id: 9, title: QUICK_TEXT })], ai_parsed: false }),
    );
    fireEvent.click(await openDialogAndQuickSubmit());

    expect(await screen.findByText('未能识别内容，已按原文保存')).toBeTruthy();
    // 证明没走 catch 分支：正常返回只有兜底文案，绝不出现「保存失败」
    expect(screen.queryByText('保存失败')).toBeNull();
  });

  it('quick 请求网络失败：提示「保存失败」，无「查看」按钮', async () => {
    const fetchMock = renderPage(() => {
      throw new Error('network down');
    });
    fireEvent.click(await openDialogAndQuickSubmit());

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url === '/api/items/quick')).toBe(true);
    });
    expect(await screen.findByText('保存失败')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '查看' })).toBeNull();
  });

  it('点「查看」打开条目详情对话框', async () => {
    renderPage(() => quickResponse({ items: [makeItem({ id: 9, title: '预约空调维修' })] }));
    fireEvent.click(await openDialogAndQuickSubmit());

    fireEvent.click(await screen.findByRole('button', { name: '查看' }));

    // ItemDialog 内容出现（AppBar 标题只存在于详情对话框），Snackbar 已关
    expect(await screen.findByText('任务详情')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('已保存：预约空调维修')).toBeNull());
  });

  it('quick 成功的新条目进了列表缓存（upsertOpenItem 生效，列表能看到标题）', async () => {
    renderPage(() => quickResponse({ items: [makeItem({ id: 9, title: '把空调修好' })] }));
    fireEvent.click(await openDialogAndQuickSubmit());

    // 标题出现在列表行（Snackbar 里的整句「已保存：…」是另一个文本节点，精确匹配不会撞上）
    expect(await screen.findByText('把空调修好')).toBeTruthy();
    const row = screen.getByText('把空调修好').closest('li');
    expect(row).not.toBeNull();
  });
});

describe('速记模式开关', () => {
  it('默认关：初次渲染 quickMode 为 false', async () => {
    renderPage(() => quickResponse());
    fireEvent.click(await screen.findByRole('button', { name: '新建待办' }));
    expect(await screen.findByText('速记模式：关')).toBeTruthy();
  });

  it('localStorage 预置 on：重新渲染后 quickMode 为 true', async () => {
    localStorage.setItem(QUICK_MODE_KEY, 'on');
    renderPage(() => quickResponse());
    fireEvent.click(await screen.findByRole('button', { name: '新建待办' }));
    expect(await screen.findByText('速记模式：开')).toBeTruthy();
  });

  it('调用 onQuickModeChange(true)：状态翻转为开并写入 localStorage', async () => {
    renderPage(() => quickResponse());
    fireEvent.click(await screen.findByRole('button', { name: '新建待办' }));
    await screen.findByText('速记模式：关');

    fireEvent.click(screen.getByRole('button', { name: '替身-切速记' }));

    expect(await screen.findByText('速记模式：开')).toBeTruthy();
    expect(localStorage.getItem(QUICK_MODE_KEY)).toBe('on');
  });

  it('localStorage.getItem 抛异常时不崩：读不到开关回落默认关，页面照常可用', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage denied');
    });
    renderPage(() => quickResponse());

    const fab = await screen.findByRole('button', { name: '新建待办' });
    expect(fab).toBeTruthy();
    fireEvent.click(fab);
    expect(await screen.findByText('速记模式：关')).toBeTruthy();
  });
});

describe('非速记模式路径', () => {
  it('普通保存：POST /api/items（不是 /quick），importance 与 actionable 原样透传', async () => {
    const fetchMock = renderPage(() =>
      json(makeItem({ id: 11, email_id: null, title: '买牛奶', status: 'open' }), 201),
    );
    fireEvent.click(await screen.findByRole('button', { name: '新建待办' }));

    fireEvent.click(await screen.findByRole('button', { name: '替身-普通保存' }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) => url === '/api/items' && !url.includes('/quick')),
      ).toBe(true);
    });
    const postCall = fetchMock.mock.calls.find(
      ([url]) => url === '/api/items' && !url.includes('/quick'),
    ) as [string, RequestInit];
    expect(postCall[1].method).toBe('POST');
    expect(JSON.parse(String(postCall[1].body))).toEqual({
      title: '买牛奶',
      summary: '两盒',
      category: '个人',
      due_date: null,
      importance: 'high',
      actionable: true,
    });
  });

  it('onParse：POST /api/items/parse，请求体含 text、today 与 tz', async () => {
    const fetchMock = renderPage(() =>
      json({
        title: '解析结果',
        summary: '',
        category: '工作',
        due_date: null,
        importance: 'normal',
        actionable: true,
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: '新建待办' }));

    fireEvent.click(await screen.findByRole('button', { name: '替身-解析' }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url === '/api/items/parse')).toBe(true);
    });
    const parseCall = fetchMock.mock.calls.find(
      ([url]) => url === '/api/items/parse',
    ) as [string, RequestInit];
    expect(parseCall[1].method).toBe('POST');
    expect(JSON.parse(String(parseCall[1].body))).toEqual({
      text: '测试文本',
      today: todayIso(),
      tz: localTimeZone(),
    });
  });
});
