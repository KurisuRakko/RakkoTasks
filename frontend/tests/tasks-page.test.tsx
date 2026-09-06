// TasksPage 测试：high 条目渲染「重要」Chip，normal/low 条目不渲染；「重要」组标题出现。
// 另覆盖容器变换与 portal 相关行为：悬浮按钮挂在 body 下（不被路由转场盒子的
// transform 困住）、打 data-vt-shell 标记、勾选推进 LEAVE_DURATION 后发 PATCH done
// 且条目从列表消失；切回页面命中模块级缓存（list-cache）时不再闪加载圈。
// haze 底衬覆盖：分组标题的雾挂 ListSubheader 内层（外层 sticky 不动、无 data-glass）、
// chips 行的雾在滚动容器外层（滚动留在内层 Stack）、全页 haze 数 = 分组数 + 1。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import TasksPage from '../src/pages/TasksPage';
import chipsSource from '../src/components/CategoryChips.tsx?raw';
import { resetLists } from '../src/lib/list-cache';
import { LEAVE_DURATION } from '../src/lib/motion';
import { cardRowSx } from '../src/lib/surface';
import { RADIUS } from '../src/rakko-tokens';
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

describe('列表行玻璃视觉（cardRowSx）', () => {
  it('cardRowSx 不再下发纸底与边框（那些归 data-glass 配方），只返回圆角', () => {
    const sx = cardRowSx() as unknown as Record<string, string>;
    expect(sx.backgroundColor).toBeUndefined();
    expect(sx.border).toBeUndefined();
    expect(sx.borderRadius).toBe(`${RADIUS.card}px`);
  });

  it('列表行的可点击元素（ListItemButton）带 data-glass="panel"（每行一块玻璃）', async () => {
    const fetchMock = vi.fn(async () => json({ items: ITEMS }));
    vi.stubGlobal('fetch', fetchMock);

    render(<TasksPage />);
    await screen.findByText('重要任务');

    for (const title of ['重要任务', '普通任务', '低重要任务']) {
      const rowBtn = screen.getByText(title).closest('.MuiListItemButton-root');
      expect(rowBtn).not.toBeNull();
      expect(rowBtn!.getAttribute('data-glass')).toBe('panel');
    }
  });

  it('列表行的 ListItemButton 挂上了 sx（emotion 局部类），圆角样式实际应用到行', async () => {
    const fetchMock = vi.fn(async () => json({ items: ITEMS }));
    vi.stubGlobal('fetch', fetchMock);

    render(<TasksPage />);
    await screen.findByText('重要任务');

    const rowBtn = screen.getByText('重要任务').closest(
      '.MuiListItemButton-root',
    ) as HTMLElement;
    expect(rowBtn).not.toBeNull();
    // sx 经 emotion 编译成 css-* 局部类挂在按钮上。jsdom 解析不了 glass 配方与
    // color-mix 的计算结果（那是浏览器渲染层的事），这里只断言「sx 确实应用到了行」；
    // 材质本身由 data-glass="panel" 从 rakko-glass.css 取。
    expect(rowBtn.className).toMatch(/(?:^|\s)css-[A-Za-z0-9_-]+/);
  });
});

describe('TasksPage haze 底衬（分组标题与 chips 行）', () => {
  it('分组标题文字被 data-glass="haze" 包着，且 haze 在 ListSubheader 内层而非其本身', async () => {
    const fetchMock = vi.fn(async () => json({ items: ITEMS }));
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(<TasksPage />);
    await screen.findByText('重要任务');

    // ITEMS 全部无截止日期：high 进「重要」组，其余进「无期限」组；今天/本周是空组不渲染
    const subheaders = Array.from(container.querySelectorAll('.MuiListSubheader-root'));
    expect(subheaders.map((s) => s.textContent).sort()).toEqual(['无期限', '重要']);
    expect(subheaders).toHaveLength(2);

    for (const sh of subheaders) {
      // 坑一：ListSubheader 默认 position: sticky，haze 配方的 position: relative 会把
      // 吸顶顶掉，所以 haze 挂内层——subheader 自身不允许出现 data-glass
      expect(sh.getAttribute('data-glass')).toBeNull();
      // 内层 haze 元素存在且包住了整段标题文字
      const haze = sh.querySelector('[data-glass="haze"]');
      expect(haze).not.toBeNull();
      expect(haze!.textContent).toBe(sh.textContent);
    }

    // 每个渲染出的分组标题都恰有一团雾（文字节点直接落在 haze 元素里）
    for (const title of ['重要', '无期限']) {
      const wrapped = screen
        .getAllByText(title)
        .filter((el) => el.closest('[data-glass="haze"]') !== null);
      expect(wrapped).toHaveLength(1);
    }
  });

  it('分组标题不再吸顶：ListSubheader 渲染结果不含 MuiListSubheader-sticky 类', async () => {
    const fetchMock = vi.fn(async () => json({ items: ITEMS }));
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(<TasksPage />);
    await screen.findByText('重要任务');

    // MUI 源码里 sticky 类由 `!disableSticky && 'sticky'` 决定，disableSticky 时不会加，
    // 这是可靠的判定；不要去测 computed position——jsdom 不解析 emotion 生成的样式，
    // 那样会写出永远为真的假断言。
    const subheaders = Array.from(container.querySelectorAll('.MuiListSubheader-root'));
    expect(subheaders.length).toBeGreaterThan(0);
    for (const sh of subheaders) {
      expect(sh.classList.contains('MuiListSubheader-sticky')).toBe(false);
    }
  });

  it('分类 chips 行的雾在滚动容器外层：haze 元素本身不滚动，直接子元素是滚动 Stack', async () => {
    const fetchMock = vi.fn(async () => json({ items: ITEMS }));
    vi.stubGlobal('fetch', fetchMock);

    render(<TasksPage />);
    await screen.findByText('重要任务');

    // 从 chips 行的文字往上层找它所在的唯一 haze（分类 chips 行在加载条件之外，同步渲染）
    const haze = screen.getByText('全部').closest('[data-glass="haze"]') as HTMLElement | null;
    expect(haze).not.toBeNull();

    // 坑二：haze 元素自己不是滚动容器（Stack 的 overflowX: auto 会把雾的负 inset 溢出
    // 裁成硬边方块），雾元素身上没有 MuiStack 类
    expect(haze!.classList.contains('MuiStack-root')).toBe(false);
    // 滚动留在 haze 的直接子元素（内层 Stack）上
    const scroller = haze!.firstElementChild;
    expect(scroller).not.toBeNull();
    expect(scroller!.classList.contains('MuiStack-root')).toBe(true);

    // jsdom 拿不到可靠的 computed overflow，改从源码断言坑二的布局：haze 元素的开标签
    // （含其 sx）里不许有 overflowX，滚动必须落在它后面紧跟的 Stack 开标签上。
    // 若有人把滚动挪回外层雾盒（负 inset 溢出会被裁成硬边方块）或把 data-glass 挪进
    // Stack，此断言会先翻。
    const hazeTagStart = chipsSource.indexOf('<Box data-glass="haze"');
    expect(hazeTagStart).toBeGreaterThan(-1);
    const hazeTagEnd = chipsSource.indexOf('>', hazeTagStart);
    const hazeTag = chipsSource.slice(hazeTagStart, hazeTagEnd);
    expect(hazeTag).not.toContain('overflowX');

    const stackStart = chipsSource.indexOf('<Stack', hazeTagEnd);
    expect(stackStart).toBeGreaterThan(-1);
    const stackTag = chipsSource.slice(stackStart, chipsSource.indexOf('>', stackStart));
    expect(stackTag).toContain('overflowX');
  });

  it('全页 data-glass="haze" 数量 = 分组数 + 1（chips 行），不多不少', async () => {
    const fetchMock = vi.fn(async () => json({ items: ITEMS }));
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(<TasksPage />);
    await screen.findByText('重要任务');

    // 每个分组标题一团雾（它们之间隔着整组卡片，距离远超 bleed，不重叠），
    // 外加 chips 行一团
    const groupCount = container.querySelectorAll('.MuiListSubheader-root').length;
    expect(container.querySelectorAll('[data-glass="haze"]')).toHaveLength(groupCount + 1);
  });

  it('页面上每个 data-glass="haze" 元素都带 data-haze="veil"（一页一种形态，不混 cloud）', async () => {
    const fetchMock = vi.fn(async () => json({ items: ITEMS }));
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(<TasksPage />);
    await screen.findByText('重要任务');

    // 分组标题雾 + chips 行雾各一团（前述用例已断言数量）
    const hazes = Array.from(container.querySelectorAll('[data-glass="haze"]'));
    expect(hazes.length).toBeGreaterThan(0);
    for (const haze of hazes) {
      expect(haze.getAttribute('data-haze')).toBe('veil');
    }
  });

  it('chips 行雾盒收缩到内容宽度：sx 含 inline-block，bleed 为 10px', () => {
    // jsdom 对 emotion 编译出的类名给不出可靠的 computed display，退回源码断言：
    // 定位 CategoryChips 里 data-glass="haze" 所在的开标签，它必须同时带 inline-block
    // 与 10px bleed——少了任何一项（有人改回撑满整列的块级、或加回 14px 溢出）此断言先翻。
    const hazeTagStart = chipsSource.indexOf('<Box data-glass="haze"');
    expect(hazeTagStart).toBeGreaterThan(-1);
    const hazeTagEnd = chipsSource.indexOf('>', hazeTagStart);
    expect(hazeTagEnd).toBeGreaterThan(-1);
    const hazeTag = chipsSource.slice(hazeTagStart, hazeTagEnd);
    expect(hazeTag).toContain('data-haze="veil"');
    // 源码里 sx 的属性值带引号（display: 'inline-block'），按源码原文断言
    expect(hazeTag).toContain("display: 'inline-block'");
    expect(hazeTag).toContain("'--glass-haze-bleed': '10px'");
  });
});
