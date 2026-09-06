// AppShell 壳层测试：
// - 「设置」入口按断点互斥：桌面端（md = 900px 起）常驻抽屉左下角已有「设置」项，
//   AppBar 按钮只在没有抽屉的移动端渲染，桌面端不重复放；
// - 壳层三件套（AppBar / 抽屉 paper / 移动底栏 Paper）只打 data-vt-shell 标记、
//   不直接持 view-transition-name，何时下发名字由样式层按转场种类决定；
// - AppBar 标题跟随路由：从任务页点「设置」进入设置页后标题变为「设置」，
//   且导航索引 -1 使 AppBar 内不再有「设置」按钮。
// 断点用 useMediaQuery(theme.breakpoints.up('md'))，即查询 '(min-width:900px)'；
// tests/setup.ts 的 matchMedia 永不匹配（模拟移动端），桌面用例在渲染前替换它。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { MemoryRouter } from 'react-router-dom';
import AppShell from '../src/components/AppShell';
import { ThemeModeProvider } from '../src/lib/theme-mode';
import { VT_SHELL_ATTR, VT_NAMES } from '../src/lib/view-transition';
import { setWallpaper } from '../src/lib/wallpaper';
import type { Item } from '../src/types';

/** setup.ts 装好的永不匹配 stub；桌面用例覆盖后由 afterEach 还原 */
const neverMatch = window.matchMedia;

/** 模拟桌面端：只对 md 断点查询（(min-width:900px)）返回 matches: true */
function installDesktopMedia() {
  window.matchMedia = ((query: string): MediaQueryList => ({
    matches: query === '(min-width:900px)',
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

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

/** 列表行玻璃计数用：任务页三条可见行 */
const SHELL_ITEMS: Item[] = [
  makeItem({ id: 1, title: '任务一' }),
  makeItem({ id: 2, title: '任务二', category: '学业' }),
  makeItem({ id: 3, title: '任务三', category: '个人' }),
];

/** 统一 stub fetch：任务页返回传入的条目（默认空列表）；进入设置页时 /api/status 按
 *  StatusResponse 形状给 */
function renderShell(items: Item[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes('/api/status')) return json({ accounts: [], pending_llm: 0 });
      if (u.includes('/api/items')) return json({ items });
      return json({}, 404);
    }),
  );
  return render(
    <ThemeModeProvider>
      <ThemeProvider theme={createTheme()}>
        <MemoryRouter initialEntries={['/']} useTransitions={false}>
          <AppShell />
        </MemoryRouter>
      </ThemeProvider>
    </ThemeModeProvider>,
  );
}

function appBar(): HTMLElement {
  const el = document.querySelector('.MuiAppBar-root');
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

function drawerPaper(): HTMLElement {
  const el = document.querySelector('.MuiDrawer-paper');
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.matchMedia = neverMatch;
});

describe('AppShell 设置入口与壳层标记', () => {
  it('移动端：AppBar 右上角有「设置」按钮（无抽屉时的唯一入口）', async () => {
    renderShell();
    // 等任务页加载完（fetch 的异步更新在 act 内落定）
    await screen.findByText('没有待办任务');

    const bar = appBar();
    expect(within(bar).getByRole('button', { name: '设置' })).toBeTruthy();
  });

  it('桌面端：AppBar 无「设置」按钮，抽屉左下角是唯一入口', async () => {
    installDesktopMedia();
    renderShell();
    await screen.findByText('没有待办任务');

    // 与抽屉 display: { xs: 'none', md: 'block' } 同断点：桌面不重复放入口
    const bar = appBar();
    expect(within(bar).queryByRole('button', { name: '设置' })).toBeNull();

    // 抽屉常驻入口仍在（md 起可见）
    expect(within(drawerPaper()).getByRole('button', { name: '设置' })).toBeTruthy();
  });

  it('壳层三件套只打 data-vt-shell 标记，不直接持名', async () => {
    renderShell();
    await screen.findByText('没有待办任务');

    expect(appBar().getAttribute(VT_SHELL_ATTR)).toBe(VT_NAMES.appBar);
    expect(drawerPaper().getAttribute(VT_SHELL_ATTR)).toBe(VT_NAMES.navDrawer);
    // 底栏标记挂在包裹 BottomNavigation 的 Paper 上
    const bottomNav = document.querySelector('.MuiBottomNavigation-root');
    expect(bottomNav?.parentElement?.getAttribute(VT_SHELL_ATTR)).toBe(VT_NAMES.bottomNav);
  });

  it('点 AppBar「设置」进设置页：标题变为「设置」且按钮消失（navIndex -1）', async () => {
    renderShell();
    await screen.findByText('没有待办任务');

    const bar = appBar();
    fireEvent.click(within(bar).getByRole('button', { name: '设置' }));

    // 标题跟随路由变为「设置」
    expect(await within(bar).findByText('设置')).toBeTruthy();
    // 设置页没有导航位，AppBar 按钮随之消失
    expect(within(bar).queryByRole('button', { name: '设置' })).toBeNull();
  });
});

// 壳层与列表行玻璃：内容玻璃板已删，玻璃不再按「壁纸开关 + 固定总数」预算——顶栏 /
// 侧边栏 / 底栏是常驻 chrome，列表每行自己是一块 data-glass="panel" 玻璃（对上游
// anti-patterns "A glass surface per list item" 的明知偏离，见 surface.ts 文件头）。
// 断言按角色走：chrome 三件套逐件查属性，panel 数 = 可见行数；不再断言固定总数。
describe('AppShell 壳层与列表行玻璃', () => {
  beforeEach(() => {
    // 模块级壁纸状态跨用例共享，逐个重置成「无壁纸」
    setWallpaper(null);
  });

  afterEach(() => {
    setWallpaper(null);
  });

  it('顶栏带 data-glass="chrome"，且不带 data-reveal（滚动渐显起点全透明会裸在壁纸上）', async () => {
    renderShell();
    await screen.findByText('没有待办任务');

    const bar = appBar();
    expect(bar.getAttribute('data-glass')).toBe('chrome');
    expect(bar.hasAttribute('data-reveal')).toBe(false);
  });

  it('没有壁纸时没有内容玻璃底板（contentGlass 标记不存在）；壳层玻璃不依赖壁纸开关', async () => {
    renderShell();
    await screen.findByText('没有待办任务');

    // 玻璃板曾只在设壁纸时渲染：现在它整体消失，这个标记在任意壁纸状态下都不该出现
    expect(document.querySelector(`[${VT_SHELL_ATTR}="${VT_NAMES.contentGlass}"]`)).toBeNull();
    // 壳层 chrome 与壁纸无关：空列表时 panel 行数为 0，chrome 仍是三件套
    expect(document.querySelectorAll('[data-glass="chrome"]')).toHaveLength(3);
    expect(document.querySelectorAll('[data-glass="panel"]')).toHaveLength(0);
  });

  it('设了壁纸也没有任何 data-glass 元素同时是 fixed 玻璃底板（玻璃板确实删干净）', async () => {
    setWallpaper('data:image/jpeg;base64,AAAA');
    renderShell();
    await screen.findByText('没有待办任务');

    // 旧内容玻璃板的三样特征——contentGlass 转场标记 / aria-hidden / fixed 底板——
    // 一样都不能残留；fixed 定位的底栏 Paper 是壳层 chrome，不是内容底板
    expect(document.querySelector(`[${VT_SHELL_ATTR}="${VT_NAMES.contentGlass}"]`)).toBeNull();
    for (const el of Array.from(document.querySelectorAll('[data-glass]'))) {
      expect(el.getAttribute(VT_SHELL_ATTR)).not.toBe(VT_NAMES.contentGlass);
      expect(el.getAttribute('aria-hidden')).toBeNull();
    }
  });

  it('桌面断点：顶栏 AppBar 是唯一的 AppBar chrome，抽屉 paper 带 data-glass="chrome"', async () => {
    installDesktopMedia();
    renderShell();
    await screen.findByText('没有待办任务');

    // 顶栏 chrome 唯一：壳层只有一个 AppBar，且它就是那块 chrome
    const bars = document.querySelectorAll('.MuiAppBar-root');
    expect(bars).toHaveLength(1);
    expect((bars[0] as HTMLElement).getAttribute('data-glass')).toBe('chrome');
    // 桌面常驻抽屉：paper 自己挂 chrome（右侧发丝线仍由主题层 MuiDrawer.paper 提供）
    expect(drawerPaper().getAttribute('data-glass')).toBe('chrome');
  });

  it('移动断点：底栏 Paper 带 data-glass="chrome"', async () => {
    renderShell();
    await screen.findByText('没有待办任务');

    expect(appBar().getAttribute('data-glass')).toBe('chrome');
    const bottomNav = document.querySelector('.MuiBottomNavigation-root');
    expect(bottomNav).not.toBeNull();
    expect(bottomNav!.parentElement!.getAttribute('data-glass')).toBe('chrome');
  });

  it('列表渲染出 N 行时 [data-glass="panel"] 恰好 N 个（每行一块玻璃），行内可点击元素都是 panel', async () => {
    renderShell(SHELL_ITEMS);
    await screen.findByText('任务一');

    const panels = document.querySelectorAll('[data-glass="panel"]');
    expect(panels).toHaveLength(SHELL_ITEMS.length);
    for (const item of SHELL_ITEMS) {
      const rowBtn = screen.getByText(item.title).closest('.MuiListItemButton-root');
      expect(rowBtn).not.toBeNull();
      expect(rowBtn!.getAttribute('data-glass')).toBe('panel');
    }
  });

  it('没有 [data-glass] 元素是另一个 [data-glass] 的后代（契约禁止嵌套玻璃）', async () => {
    setWallpaper('data:image/jpeg;base64,AAAA');
    // 有行有壳层时仍不得嵌套：chrome 三件套与每行 panel 互为兄弟层级
    renderShell(SHELL_ITEMS);
    await screen.findByText('任务一');

    const all = document.querySelectorAll('[data-glass]');
    // 顶栏 + 抽屉 paper + 底栏 Paper 三块 chrome，外加三行 panel
    expect(all.length).toBeGreaterThan(3);
    for (const el of Array.from(all)) {
      expect(el.parentElement?.closest('[data-glass]') ?? null).toBeNull();
    }
  });
});
