// AppShell 壳层测试：
// - 「设置」入口按断点互斥：桌面端（md = 900px 起）常驻抽屉左下角已有「设置」项，
//   AppBar 按钮只在没有抽屉的移动端渲染，桌面端不重复放；
// - 壳层三件套（AppBar / 抽屉 paper / 移动底栏 Paper）只打 data-vt-shell 标记、
//   不直接持 view-transition-name，何时下发名字由样式层按转场种类决定；
// - AppBar 标题跟随路由：从任务页点「设置」进入设置页后标题变为「设置」，
//   且导航索引 -1 使 AppBar 内不再有「设置」按钮。
// 断点用 useMediaQuery(theme.breakpoints.up('md'))，即查询 '(min-width:900px)'；
// tests/setup.ts 的 matchMedia 永不匹配（模拟移动端），桌面用例在渲染前替换它。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { MemoryRouter } from 'react-router-dom';
import AppShell from '../src/components/AppShell';
import { ThemeModeProvider } from '../src/lib/theme-mode';
import { VT_SHELL_ATTR, VT_NAMES } from '../src/lib/view-transition';

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

/** 统一 stub fetch：任务页返回空列表；进入设置页时 /api/status 按 StatusResponse 形状给 */
function renderShell() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes('/api/status')) return json({ accounts: [], pending_llm: 0 });
      if (u.includes('/api/items')) return json({ items: [] });
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
