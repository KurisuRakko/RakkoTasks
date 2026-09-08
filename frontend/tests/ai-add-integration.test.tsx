// 集成测试：真实 AiAddDialog（三阶段状态机）× 真实 TasksPage（编排层）的配对闭环。
// 组件支线（ai-add-dialog.test.tsx）与编排支线（quick-add / tasks-page）各自都用
// 替身对话框测过，但真实对话框与真实页面的配对零覆盖——props 语义接错、阶段切换
// 后保存载荷丢字段、速记开关受控回路断掉这类 bug 只会在配对里现形。
// 铁律：本文件不做任何组件替身（AiAddDialog / ItemFieldsForm / ItemEditor /
// TasksPage 全部真渲染），网络层只 stub fetch；三段状态机、字段区、速记持久化与
// 落库编排全部真跑。
//
// 速记开关 localStorage 键与 TasksPage 内部常量一致（读不到一律回落「关」）。
// jsdom 无 View Transitions / prefers-reduced-motion 不命中：runViewTransition 走
// 同步降级路径，无需特殊处理；阶段切换包在 Collapse/Fade 里，落地断言一律用
// findBy/waitFor。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TasksPage from '../src/pages/TasksPage';
import { resetLists } from '../src/lib/list-cache';
import { localTimeZone, todayIso } from '../src/lib/time';
import type { Item, ParsedTask } from '../src/types';

const QUICK_MODE_KEY = 'rakkotasks.quick-mode';
const TEXT = '明天提醒我去把空调修了';

/** AI 解析结果：importance/actionable 必须从 parse 响应穿过对话框内部状态、
 *  再穿过 TasksPage.handleCreate、最终原样进 POST /api/items 载荷，不能丢。 */
const PARSED: ParsedTask = {
  title: '修空调',
  summary: '联系师傅上门维修',
  category: '个人',
  due_date: '2026-09-08',
  importance: 'high',
  actionable: false,
  reminders: [],
};

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

/** 手动放行的门闩：网络层挂起解析响应，由测试决定何时给结果（保证骨架阶段可见） */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * 渲染 TasksPage 并 stub fetch：POST 全部交给 handler，GET 返回空列表（fetchMock
 * 兜底，与 quick-add.test.tsx 的 renderPage 同款桩形状）。返回 fetchMock，
 * 调用记录形如 [url, init]。
 */
function renderPage(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
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

/** 点开「+」并等真实对话框的输入阶段落地 */
async function openDialog(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: '新建待办' }));
  await screen.findByLabelText('待办内容');
}

/** 非速记走到 fields 阶段：输入原文 → 点「解析」→ parse 返回 PARSED → 预览落地 */
async function parseIntoFields(fetchMock: ReturnType<typeof vi.fn>): Promise<void> {
  fireEvent.change(await screen.findByLabelText('待办内容'), { target: { value: TEXT } });
  fireEvent.click(screen.getByRole('button', { name: '解析' }));
  await waitFor(() => {
    expect(
      fetchMock.mock.calls.some(([url]) => url === '/api/items/parse'),
    ).toBe(true);
  });
  await screen.findByLabelText('任务内容');
}

function findPost(fetchMock: ReturnType<typeof vi.fn>, url: string): RequestInit {
  const call = fetchMock.mock.calls.find(
    ([u, init]) => init?.method === 'POST' && u === url,
  ) as [string, RequestInit] | undefined;
  expect(call, `应有 POST ${url}`).toBeDefined();
  return call![1];
}

beforeEach(() => {
  localStorage.clear();
  // list-cache 是模块级缓存，跨用例残留会互相污染，每个用例从空缓存开始
  resetLists();
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('非速记模式：真实对话框 × 真实页面闭环', () => {
  it('AI 解析预填 → 保存：importance/actionable 从 parse 响应一路穿进 POST /api/items', async () => {
    // 网络层用门闩卡住 parse 响应，保证先看到「正在识别」骨架再落地
    const gate = deferred();
    const fetchMock = renderPage(async (url) => {
      if (url === '/api/items/parse') {
        await gate.promise;
        return json({ tasks: [PARSED] });
      }
      return json(
        makeItem({ id: 11, title: PARSED.title, category: PARSED.category }),
        201,
      );
    });

    await openDialog();
    fireEvent.change(screen.getByLabelText('待办内容'), { target: { value: TEXT } });
    fireEvent.click(screen.getByRole('button', { name: '解析' }));

    // 骨架出现（响应被门闩卡住，此刻必在 parsing）
    expect(await screen.findByLabelText('正在识别')).toHaveAttribute('aria-busy', 'true');
    // parse 请求体：原文 + 本地基准日
    expect(JSON.parse(String(findPost(fetchMock, '/api/items/parse').body))).toEqual({
      text: TEXT,
      today: todayIso(),
      tz: localTimeZone(),
    });

    // 放行解析 → fields 阶段：标题+详情、分类、日期全部由解析结果预填
    await act(async () => {
      gate.resolve();
    });
    expect(await screen.findByLabelText('任务内容')).toHaveValue('修空调\n联系师傅上门维修');
    expect(screen.getByRole('radio', { name: '个人' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByLabelText('截止日期')).toHaveValue('2026-09-08');
    // 主按钮文案随阶段切换：input「解析」→ fields「保存」
    expect(screen.getByRole('button', { name: '保存' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([u, init]) => init?.method === 'POST' && u === '/api/items'),
      ).toBe(true);
    });
    expect(JSON.parse(String(findPost(fetchMock, '/api/items').body))).toEqual({
      title: '修空调',
      summary: '联系师傅上门维修',
      category: '个人',
      due_date: '2026-09-08',
      importance: 'high',
      actionable: false,
    });

    // 保存成功：对话框收回，新条目上了列表
    await waitFor(() => expect(screen.queryByLabelText('任务内容')).toBeNull());
    expect(await screen.findByText('修空调')).toBeTruthy();
  });

  it('解析后用户改过再存：载荷反映改动，importance/actionable 仍是 AI 给的那两个', async () => {
    const fetchMock = renderPage(async (url) => {
      if (url === '/api/items/parse') return json({ tasks: [PARSED] });
      return json(makeItem({ id: 12, title: '自己修空调' }), 201);
    });

    await openDialog();
    await parseIntoFields(fetchMock);

    // 改标题+详情、改分类、清掉日期
    fireEvent.change(screen.getByLabelText('任务内容'), {
      target: { value: '自己修空调\n去五金店买配件' },
    });
    fireEvent.click(screen.getByRole('radio', { name: '工作' }));
    expect(screen.getByRole('radio', { name: '工作' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: '清除日期' }));
    expect(screen.getByLabelText('截止日期')).toHaveValue('');

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([u, init]) => init?.method === 'POST' && u === '/api/items'),
      ).toBe(true);
    });
    // 用户没有动重要度（fields 阶段有 chip 控件、默认选中 AI 给的档位）：
    // 透传 AI 判断（high / false），不被用户改动污染；actionable 无编辑控件，同样透传
    expect(JSON.parse(String(findPost(fetchMock, '/api/items').body))).toEqual({
      title: '自己修空调',
      summary: '去五金店买配件',
      category: '工作',
      due_date: null,
      importance: 'high',
      actionable: false,
    });
  });
});

describe('速记模式：真实对话框 × 真实页面闭环', () => {
  it('点「解析」打 /api/items/quick 不打 /parse：关窗、Snackbar 带「查看」、新条目上列表', async () => {
    const fetchMock = renderPage(async (url) => {
      if (url === '/api/items/quick') {
        return json(
          { items: [makeItem({ id: 9, title: '把空调修好' })], ai_parsed: true },
          201,
        );
      }
      return json({}, 500);
    });

    await openDialog();
    // 拨速记开关：受控回路（对话框 prop ← TasksPage 状态 ← localStorage 持久化）
    fireEvent.click(screen.getByRole('switch', { name: '速记模式' }));
    expect(await screen.findByText('速记模式已开启，提交后直接保存')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('待办内容'), { target: { value: TEXT } });
    fireEvent.click(screen.getByRole('button', { name: '解析' }));

    // 打的是 quick（不是 parse / 不是 items），请求体含原文与本地基准日
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) => url === '/api/items/quick'),
      ).toBe(true);
    });
    expect(
      fetchMock.mock.calls.filter(([url]) => url === '/api/items/parse'),
    ).toHaveLength(0);
    expect(JSON.parse(String(findPost(fetchMock, '/api/items/quick').body))).toEqual({
      text: TEXT,
      today: todayIso(),
      tz: localTimeZone(),
    });

    // 对话框立刻收回：输入框消失，悬浮按钮还在
    await waitFor(() => expect(screen.queryByLabelText('待办内容')).toBeNull());
    expect(screen.getByRole('button', { name: '新建待办' })).toBeTruthy();

    // ai_parsed=true：Snackbar「已保存：<title>」带文案恰为「查看」的按钮
    expect(await screen.findByText('已保存：把空调修好')).toBeTruthy();
    expect(screen.getByRole('button', { name: '查看' })).toBeTruthy();
    // 新条目进了列表（upsertOpenItem 生效）
    const row = screen.getByText('把空调修好').closest('li');
    expect(row).not.toBeNull();
  });

  it('quick 返回 201 且 ai_parsed=false：按原文保存的提示，不进「保存失败」错误分支', async () => {
    const fetchMock = renderPage(async (url) => {
      if (url === '/api/items/quick') {
        return json(
          { items: [makeItem({ id: 9, title: TEXT })], ai_parsed: false },
          201,
        );
      }
      return json({}, 500);
    });

    await openDialog();
    fireEvent.click(screen.getByRole('switch', { name: '速记模式' }));
    fireEvent.change(screen.getByLabelText('待办内容'), { target: { value: TEXT } });
    fireEvent.click(screen.getByRole('button', { name: '解析' }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) => url === '/api/items/quick'),
      ).toBe(true);
    });
    expect(await screen.findByText('未能识别内容，已按原文保存')).toBeTruthy();
    // 正常返回只有兜底文案：证明没走 catch 错误分支
    expect(screen.queryByText('保存失败')).toBeNull();
  });
});

describe('解析失败与速记持久化', () => {
  it('parse 500 → 回 input 原文保留，「按原文保存」载荷无 importance/actionable', async () => {
    const fetchMock = renderPage(async (url) => {
      if (url === '/api/items/parse') return json({ detail: 'boom' }, 500);
      return json(makeItem({ id: 13, title: TEXT }), 201);
    });

    await openDialog();
    fireEvent.change(screen.getByLabelText('待办内容'), { target: { value: TEXT } });
    fireEvent.click(screen.getByRole('button', { name: '解析' }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) => url === '/api/items/parse'),
      ).toBe(true);
    });
    // 失败兜底 UI：回 input 阶段、原文没被清空、「按原文保存」出现
    expect(await screen.findByRole('button', { name: '按原文保存' })).toBeTruthy();
    expect(screen.getByText(/未能识别内容/)).toBeTruthy();
    expect((screen.getByLabelText('待办内容') as HTMLTextAreaElement).value).toBe(TEXT);

    fireEvent.click(screen.getByRole('button', { name: '按原文保存' }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([u, init]) => init?.method === 'POST' && u === '/api/items'),
      ).toBe(true);
    });
    // 解析失败没有 AI 判断可透传：载荷里不带 importance/actionable 两个键
    expect(JSON.parse(String(findPost(fetchMock, '/api/items').body))).toEqual({
      title: TEXT,
      summary: '',
      category: '其他',
      due_date: null,
    });
  });

  it('速记开关跨真实对话框重开持久化：关闭再打开仍为开，localStorage 已写入', async () => {
    renderPage(async () => json({}, 500)); // 本用例不发任何业务 POST

    await openDialog();
    fireEvent.click(screen.getByRole('switch', { name: '速记模式' }));
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: '速记模式' })).toHaveAttribute(
        'aria-checked',
        'true',
      ),
    );
    expect(localStorage.getItem(QUICK_MODE_KEY)).toBe('on');

    // 关掉对话框再重开：真实对话框卸载后重挂载，开关状态仍在（状态在 TasksPage）
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    await waitFor(() =>
      expect(screen.queryByRole('switch', { name: '速记模式' })).toBeNull(),
    );

    fireEvent.click(await screen.findByRole('button', { name: '新建待办' }));
    const reopened = await screen.findByRole('switch', { name: '速记模式' });
    expect(reopened).toHaveAttribute('aria-checked', 'true');
    expect(localStorage.getItem(QUICK_MODE_KEY)).toBe('on');
  });

  it('速记成功点「查看」打开条目详情对话框（Snackbar 收起）', async () => {
    renderPage(async (url) => {
      if (url === '/api/items/quick') {
        return json(
          { items: [makeItem({ id: 9, title: '把空调修好' })], ai_parsed: true },
          201,
        );
      }
      return json({}, 500);
    });

    await openDialog();
    fireEvent.click(screen.getByRole('switch', { name: '速记模式' }));
    fireEvent.change(screen.getByLabelText('待办内容'), { target: { value: TEXT } });
    fireEvent.click(screen.getByRole('button', { name: '解析' }));

    fireEvent.click(await screen.findByRole('button', { name: '查看' }));

    // ItemDialog 实际渲染锚点：AppBar 标题「任务详情」+ 条目标题 h6 heading
    // （手动条目 summary 为空 → 「暂无详情」，无懒生成请求）
    expect(await screen.findByRole('heading', { name: '任务详情' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '把空调修好' })).toBeTruthy();
    expect(screen.getByText('暂无详情')).toBeTruthy();
    // Snackbar 已随「查看」关闭
    await waitFor(() => expect(screen.queryByText('已保存：把空调修好')).toBeNull());
  });
});

describe('一段话多条：真实对话框 × 真实页面闭环', () => {
  /** 用户原句拆出的四件事，各带自己的提醒时刻 */
  const FOUR: ParsedTask[] = [
    { ...PARSED, title: '买奶茶', summary: '', due_date: null, importance: 'normal', actionable: true },
    { ...PARSED, title: '接斯卡蒂', summary: '', due_date: null, importance: 'normal', actionable: true },
    { ...PARSED, title: '玩一把原神', summary: '', due_date: null, importance: 'low', actionable: true },
    { ...PARSED, title: '卖 TQQQ', summary: '', due_date: null, importance: 'high', actionable: true },
  ];
  const LONG = '明天3点提醒我去买奶茶，明天6点提醒我去接斯卡蒂，下午7点玩一把原神，9点记得去把TQQQ卖了';

  it('非速记：解析出四条 → 列表预览 → 保存打四次 POST /api/items，四条都上列表', async () => {
    let created = 0;
    const fetchMock = renderPage(async (url) => {
      if (url === '/api/items/parse') return json({ tasks: FOUR });
      if (url === '/api/items') {
        created += 1;
        return json(makeItem({ id: 100 + created, title: FOUR[created - 1].title }), 201);
      }
      return json({}, 404);
    });

    await openDialog();
    fireEvent.change(screen.getByLabelText('待办内容'), { target: { value: LONG } });
    fireEvent.click(screen.getByRole('button', { name: '解析' }));

    // 四条列成四行，默认收起
    expect(await screen.findByText('识别出 4 条，点开可修改')).toBeTruthy();
    expect(screen.getByRole('button', { name: '第 1 条：买奶茶' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '第 4 条：卖 TQQQ' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(
        ([u, init]) => u === '/api/items' && (init as RequestInit)?.method === 'POST',
      );
      expect(posts).toHaveLength(4);
    });
    const titles = fetchMock.mock.calls
      .filter(([u, init]) => u === '/api/items' && (init as RequestInit)?.method === 'POST')
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)).title);
    expect(titles).toEqual(['买奶茶', '接斯卡蒂', '玩一把原神', '卖 TQQQ']);
    // importance 逐条穿到底，没有被统一成 normal
    const importances = fetchMock.mock.calls
      .filter(([u, init]) => u === '/api/items' && (init as RequestInit)?.method === 'POST')
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)).importance);
    expect(importances).toEqual(['normal', 'normal', 'low', 'high']);

    // 关窗 + 四条都进了列表
    await waitFor(() => expect(screen.queryByLabelText('待办内容')).toBeNull());
    expect(await screen.findByText('已保存 4 条')).toBeTruthy();
  });

  it('删掉解析错的一条再保存：只打三次 POST，被删的那条不在其中', async () => {
    let created = 0;
    const fetchMock = renderPage(async (url) => {
      if (url === '/api/items/parse') return json({ tasks: FOUR });
      if (url === '/api/items') {
        created += 1;
        return json(makeItem({ id: 200 + created }), 201);
      }
      return json({}, 404);
    });

    await openDialog();
    fireEvent.change(screen.getByLabelText('待办内容'), { target: { value: LONG } });
    fireEvent.click(screen.getByRole('button', { name: '解析' }));
    await screen.findByText('识别出 4 条，点开可修改');

    fireEvent.click(screen.getByRole('button', { name: '删除第 3 条' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(
        ([u, init]) => u === '/api/items' && (init as RequestInit)?.method === 'POST',
      );
      expect(posts).toHaveLength(3);
    });
    const titles = fetchMock.mock.calls
      .filter(([u, init]) => u === '/api/items' && (init as RequestInit)?.method === 'POST')
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)).title);
    expect(titles).toEqual(['买奶茶', '接斯卡蒂', '卖 TQQQ']);
  });

  it('速记：quick 返回四条 → 全部进列表，Snackbar 报条数且不给「查看」', async () => {
    localStorage.setItem(QUICK_MODE_KEY, 'on');
    renderPage(async (url) => {
      if (url === '/api/items/quick') {
        return json(
          { items: FOUR.map((t, i) => makeItem({ id: 300 + i, title: t.title })), ai_parsed: true },
          201,
        );
      }
      return json({}, 404);
    });

    await openDialog();
    fireEvent.change(screen.getByLabelText('待办内容'), { target: { value: LONG } });
    fireEvent.click(screen.getByRole('button', { name: '解析' }));

    expect(await screen.findByText('已保存 4 条')).toBeTruthy();
    // 多条没有唯一目标可看，不给「查看」
    expect(screen.queryByRole('button', { name: '查看' })).toBeNull();
    expect(await screen.findByText('卖 TQQQ')).toBeTruthy();
  });

  it('部分失败：四条里第二条 500 → 其余三条照常入库，提示带失败条数', async () => {
    let n = 0;
    renderPage(async (url) => {
      if (url === '/api/items/parse') return json({ tasks: FOUR });
      if (url === '/api/items') {
        n += 1;
        if (n === 2) return json({ code: 'boom' }, 500);
        return json(makeItem({ id: 400 + n, title: FOUR[n - 1].title }), 201);
      }
      return json({}, 404);
    });

    await openDialog();
    fireEvent.change(screen.getByLabelText('待办内容'), { target: { value: LONG } });
    fireEvent.click(screen.getByRole('button', { name: '解析' }));
    await screen.findByText('识别出 4 条，点开可修改');

    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    // 成功的三条不该被失败的那条连累掉
    expect(await screen.findByText('已保存 3 条，1 条失败')).toBeTruthy();
  });
});
