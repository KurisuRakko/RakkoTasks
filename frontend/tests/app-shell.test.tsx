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
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { MemoryRouter } from 'react-router-dom';
import AppShell from '../src/components/AppShell';
import { ThemeModeProvider } from '../src/lib/theme-mode';
import { NAV_ITEMS } from '../src/lib/nav';
import { ACCENT, GLASS_NAV_RAIL_LIGHT, NEUTRAL_LIGHT } from '../src/rakko-tokens';
import { VT_SHELL_ATTR, VT_NAMES } from '../src/lib/view-transition';
import { setWallpaper } from '../src/lib/wallpaper';
import { AppThemeProvider, allStyleText, ownRules } from './glass-text-contrast.test-utils';
import type { Item } from '../src/types';

/** 拼接规则块里某条声明的整段值（从 `prop:` 到该块结尾，声明之间用 ';' 分隔）。
 *  用于「这条声明的值里必须同时有 A 和 B」这类断言——要求确有该声明，而不是靠
 *  `toContain` 在整段 CSS 文本里碰运气。 */
function declarationValue(rule: string, prop: string): string {
  const at = rule.indexOf(`${prop}:`);
  expect(at, `规则里应有 ${prop} 声明：${rule}`).toBeGreaterThanOrEqual(0);
  return rule.slice(at);
}

/** 底栏那块 Paper（玻璃条）：外层 chrome + 内层 BottomNavigation。
 *  scope 是查询根（用例里渲染两次时给局部 container）：document.querySelector 只返回
 *  第一个匹配，同一用例里二次渲染会让旧那棵树的节点先被选中，断言就落在死节点上。 */
function bottomNavPaper(scope: ParentNode = document): HTMLElement {
  const nav = scope.querySelector('.MuiBottomNavigation-root');
  expect(nav).not.toBeNull();
  const paper = nav!.parentElement;
  expect(paper).not.toBeNull();
  return paper as HTMLElement;
}

function bottomNavList(scope: ParentNode = document): HTMLElement {
  const nav = scope.querySelector('.MuiBottomNavigation-root');
  expect(nav).not.toBeNull();
  return nav as HTMLElement;
}

/** 已删除的内容玻璃底板的旧共享元素名。VT_NAMES 里对应项已随底板一并移除，
 * 这里保留字面量只为防回归：底板若被重新引入，下面两条断言会红。 */
const REMOVED_CONTENT_GLASS_NAME = 'rtk-content-glass';

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
    reminders: [],
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

/**
 * 统一 stub fetch：任务页返回传入的条目（默认空列表）；进入设置页时 /api/status 按
 * StatusResponse 形状给。注意任务页空态会在条目为空时多查一次 /api/status：返回带
 * 账户（与「没有待办任务」文案对应），不带账户会显示「还没有接入邮箱」引导。
 */
function renderShell(items: Item[] = [], initial = '/') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes('/api/status')) {
        return json({
          accounts: [
            {
              id: 1,
              name: 'Gmail',
              kind: 'gmail',
              email: 'you@gmail.com',
              status: 'ok',
              enabled: true,
              has_credentials: true,
              ms_client_id: null,
              last_sync_at: null,
              last_error: null,
            },
          ],
          pending_llm: 0,
        });
      }
      if (u.includes('/api/items')) return json({ items });
      return json({}, 404);
    }),
  );
  return render(
    <ThemeModeProvider>
      <ThemeProvider theme={createTheme()}>
        <MemoryRouter initialEntries={[initial]} useTransitions={false}>
          <AppShell />
        </MemoryRouter>
      </ThemeProvider>
    </ThemeModeProvider>,
  );
}

/** 与 renderShell 相同但挂应用真实主题（浅色）：底栏文字色守卫断言 token 原值用。
 *  initial 默认 '/'（各守卫用例的起点都是首页）；指示条那条要落在设置页（navIndex -1）时传路径。 */
function renderRealThemeShell(items: Item[] = [], initial = '/') {
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
    <AppThemeProvider>
      <MemoryRouter initialEntries={[initial]} useTransitions={false}>
        <AppShell />
      </MemoryRouter>
    </AppThemeProvider>,
  );
}

function appBar(scope: ParentNode = document): HTMLElement {
  const el = scope.querySelector('.MuiAppBar-root');
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

  it('移动端 /settings/accounts/new：标题为邮箱账户且有返回按钮，点击返回设置页', async () => {
    renderShell([], '/settings/accounts/new');

    const bar = appBar();
    // 邮箱账户子页标题不再是「设置」
    expect(await within(bar).findByText('邮箱账户')).toBeTruthy();
    // 返回箭头在 AppBar 内且可点，方向导航去 /settings
    const back = within(bar).getByRole('button', { name: '返回' });
    expect(back).toBeTruthy();
    fireEvent.click(back);

    // 回到设置页：标题变回「设置」、返回箭头消失（子页专属）
    expect(await within(bar).findByText('设置')).toBeTruthy();
    expect(within(bar).queryByRole('button', { name: '返回' })).toBeNull();
  });

  it('桌面端访问 /settings/accounts/new：重定向回 /settings（桌面只用 Dialog）', async () => {
    installDesktopMedia();
    renderShell([], '/settings/accounts/new');

    // 页面级 <Navigate replace>：标题与列表都落在设置页
    const bar = appBar();
    expect(await within(bar).findByText('设置')).toBeTruthy();
    expect(await screen.findByText('邮箱账户')).toBeTruthy();
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

  it('没有壁纸时没有内容玻璃底板（玻璃板旧共享名标记不存在）；壳层玻璃不依赖壁纸开关', async () => {
    renderShell();
    await screen.findByText('没有待办任务');

    // 玻璃板曾只在设壁纸时渲染：现在它整体消失，这个标记在任意壁纸状态下都不该出现
    expect(document.querySelector(`[${VT_SHELL_ATTR}="${REMOVED_CONTENT_GLASS_NAME}"]`)).toBeNull();
    // 壳层 chrome 与壁纸无关：空列表时 panel 行数为 0，chrome 仍是三件套
    expect(document.querySelectorAll('[data-glass="chrome"]')).toHaveLength(3);
    expect(document.querySelectorAll('[data-glass="panel"]')).toHaveLength(0);
  });

  it('设了壁纸也没有任何 data-glass 元素同时是 fixed 玻璃底板（玻璃板确实删干净）', async () => {
    setWallpaper('data:image/jpeg;base64,AAAA');
    renderShell();
    await screen.findByText('没有待办任务');

    // 旧内容玻璃板的三样特征——共享元素名转场标记 / aria-hidden / fixed 底板——
    // 一样都不能残留；fixed 定位的底栏 Paper 是壳层 chrome，不是内容底板
    expect(document.querySelector(`[${VT_SHELL_ATTR}="${REMOVED_CONTENT_GLASS_NAME}"]`)).toBeNull();
    for (const el of Array.from(document.querySelectorAll('[data-glass]'))) {
      expect(el.getAttribute(VT_SHELL_ATTR)).not.toBe(REMOVED_CONTENT_GLASS_NAME);
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

// 底栏未选中标签的文字色守卫：底栏整块 data-glass="chrome"（纸色 45%，比列表行的
// panel 更透），MUI 默认给 BottomNavigationAction 未选中态的 text.secondary（n7）
// 实测对比度低到 1.67（亮壁纸浅色），AA 正文要 ≥4.5，只有 text.primary（n9）才有
// 数量级改善。选中态是 accent（primary.main），与可读性无关——覆盖必须用
// :not(.Mui-selected) 精确排除选中项。样式规则文本断言机制同列表页守卫
// （jsdom 解析不了 emotion 级联，但规则文本可逐字读，见 glass-text-contrast.test-utils）。
describe('底栏未选中标签文字色（chrome 玻璃上没有次级色的守卫）', () => {
  it('未选中项的样式覆盖存在：:not(.Mui-selected) 精确选择器，颜色 = text.primary（n9）', async () => {
    renderRealThemeShell(SHELL_ITEMS);
    await screen.findByText('任务一');

    const css = allStyleText();
    // 覆盖规则只落在未选中项上（:not(.Mui-selected)），颜色解析成 n9
    expect(css).toContain(
      `.MuiBottomNavigationAction-root:not(.Mui-selected){color:${NEUTRAL_LIGHT[8]}`,
    );
    // 不许出现不带 :not 的整盖规则：谁把它写成 `& .MuiBottomNavigationAction-root`
    // （selector 到 `-root{` 为止），这条断言先翻
    expect(css).not.toContain('.MuiBottomNavigationAction-root{color:');
    // 选中态规则仍在（MUI 默认链：`.Mui-selected → primary.main`），没被覆盖抹掉
    expect(css).toContain(`MuiBottomNavigationAction-root.Mui-selected{color:${ACCENT.light}`);
  });

  it('点「已完成」后 Mui-selected 只落在该项上（选中态机制完好，覆盖没把选中态一起盖掉）', async () => {
    renderRealThemeShell(SHELL_ITEMS);
    await screen.findByText('任务一');

    const nav = document.querySelector('.MuiBottomNavigation-root');
    expect(nav).not.toBeNull();
    const bar = nav as HTMLElement;

    // 初始选中「任务」（/ → 索引 0）
    const initiallySelected = within(bar)
      .getAllByRole('button')
      .filter((b) => b.classList.contains('Mui-selected'));
    expect(initiallySelected).toHaveLength(1);
    expect(initiallySelected[0]!.textContent).toContain(NAV_ITEMS[0].label);

    fireEvent.click(within(bar).getByRole('button', { name: NAV_ITEMS[2].label }));
    await waitFor(() => {
      const selected = within(bar)
        .getAllByRole('button')
        .filter((b) => b.classList.contains('Mui-selected'));
      expect(selected).toHaveLength(1);
      expect(selected[0]!.textContent).toContain(NAV_ITEMS[2].label);
    });

    // 选中态的颜色仍由 MUI 默认链提供（primary.main = accent）：我们的覆盖只存在于
    // :not(.Mui-selected) 形态（上个用例已断言），jsdom 内用规则文本锁定 accent 值
    expect(allStyleText()).toContain(
      `MuiBottomNavigationAction-root.Mui-selected{color:${ACCENT.light}`,
    );
  });
});

// 底栏对齐上游 BottomNav 契约（Rakko-Design commit b2deb8b：templates/snippets/bottom-nav.html、
// react/src/bottom-nav/bottom-nav.css、references/components.md 的 BottomNav 一节、
// docs/2026-09-20-bottom-nav.md）。本项目用 MUI 不用 @rakko/react（该包不在 npm，Docker
// 构建装不到，与 rakko-glass.css / rakko-tokens.ts 同样只能移植），所以这里逐条钉契约的
// 四项：导航语义（<nav> + aria-label）、发丝线画法（box-shadow 不占布局盒子）、里层列表
// 限宽居中、顶边指示条（纯 CSS 定位 + navIndex 为 -1 时不显示）。
describe('底栏对齐 BottomNav 契约（nav 语义 / 发丝线 / 限宽 / 指示条）', () => {
  it('底栏外层是 nav 元素并带 aria-label="主导航"，内层项仍是按钮角色', async () => {
    renderShell();
    await screen.findByText('没有待办任务');

    const paper = bottomNavPaper();
    expect(paper.tagName).toBe('NAV');
    expect(paper.getAttribute('aria-label')).toBe('主导航');
    // 内层不许改成 tablist：本项目没有 Tabs primitive，没有 tabpanel 的假语义比现状更差
    expect(paper).not.toHaveAttribute('role', 'tablist');
    const list = bottomNavList();
    expect(list.getAttribute('role')).not.toBe('tablist');
    expect(within(list).getAllByRole('button')).toHaveLength(NAV_ITEMS.length);
  });

  it('发丝线：用 [data-glass="chrome"] 抬特异性赢过配方，且不抹掉配方的内唇高光', async () => {
    renderShell();
    await screen.findByText('没有待办任务');

    const rule = ownRules(allStyleText(), bottomNavPaper());
    // 打赢级联的能力就看这条：App.tsx 的 injectFirst 把 emotion 插在 <head> 最前，
    // rakko-glass.css 的 [data-glass='chrome'] 在其后且同为 (0,1,0)，裸 .css-* 类
    // 必输；带上属性选择器抬到 (0,2,0) 才赢。
    expect(rule).toContain('[data-glass="chrome"]{');
    // 只认带属性选择器的那一条：没有它，真机上这条规则进不了场（见上）
    expect(rule).toContain('[data-glass="chrome"]{box-shadow:');
    // box-shadow 是整条替换：既要有顶边发丝线，也要原样带上 Aero 配方那层内唇高光
    const shadow = declarationValue(rule, 'box-shadow');
    expect(shadow).toContain('inset 0 1px 0 var(--glass-lip)');
    expect(shadow).toContain('0 -1px 0 var(--color-border)');
    // border 会占布局盒子（底栏高度多 1px），契约只允许改 box-shadow
    expect(rule).not.toContain('border-top');
  });

  it('内层列表限宽居中（max-width 取 --rk-bottom-nav-max-width，回落 640px）', async () => {
    renderShell();
    await screen.findByText('没有待办任务');

    const rule = ownRules(allStyleText(), bottomNavList());
    expect(rule).toContain('max-width:var(--rk-bottom-nav-max-width, 640px)');
    expect(rule).toContain('margin-inline:auto');
  });

  it('指示条：首页（navIndex 0）可见，设置页（navIndex -1）不可见', async () => {
    // 用应用真实主题渲染：指示条色是 theme.palette.primary.main，只有真实主题下才等于
    // token 的 ACCENT.light（renderShell 用的裸 createTheme 是 MUI 默认蓝）
    const home = renderRealThemeShell(SHELL_ITEMS);
    await screen.findByText('任务一');

    // 宽度与位移是纯 CSS 算的（项数固定、等宽平分），锁规则文本：jsdom 连
    // getComputedStyle(el, '::before') 都没实现（直接抛 "Not implemented"），假元素
    // 的生效值在这里读不到，能读到的只有 emotion 注入的规则文本。
    const homeRules = ownRules(allStyleText(), bottomNavList(home.container));
    expect(homeRules).toContain('::before{');
    expect(homeRules).toContain(`width:calc(100% / ${NAV_ITEMS.length})`);
    expect(homeRules).toContain('height:2px');
    // 圆角必须带单位：sx 的数值 borderRadius 是乘数（乘 theme.shape.borderRadius = 6），
    // 写 border-radius:1 会出来 6px，2px 高的指示条就成了个药丸
    expect(homeRules).toContain('border-radius:1px');
    expect(homeRules).not.toContain('border-radius:6px');
    expect(homeRules).toContain(`background-color:${ACCENT.light}`);
    expect(homeRules).toContain('opacity:1');
    expect(homeRules).toContain('translate:0% 0');
    // 过渡只动 translate，且时长/缓动来自 theme.transitions（不手写毫秒）
    expect(homeRules).toMatch(/transition:translate \d+ms cubic-bezier\(/);

    // 设置页：navIndex -1 时只靠 opacity 隐藏，位移钳在第一格。
    // 先把首页那棵树卸掉：同一个用例里两次渲染会并存，document 上的查询会落到旧节点。
    cleanup();
    const settings = renderRealThemeShell([], '/settings');
    // 与「点 AppBar 设置按钮进设置页」那条同款等待：标题跟随路由落到设置页
    await within(appBar(settings.container)).findByText('设置');

    const settingsRules = ownRules(allStyleText(), bottomNavList(settings.container));
    expect(settingsRules).toContain('opacity:0');
    // 位移不跟着 -1 走：transition 只列了 translate，opacity 是瞬变，若位移到 -100%
    // 从设置页回首页时会看见指示条从左边缘扫进来——任务书明确禁止的甩出屏幕
    expect(settingsRules).toContain('translate:0% 0');
    expect(settingsRules).not.toContain('translate:-100% 0');
    // 指示条元素本身照旧存在（不是靠不渲染来隐藏），首页那条断言已锁它的全部度量
    expect(settingsRules).toContain('::before{');
    expect(settingsRules).toContain(`width:calc(100% / ${NAV_ITEMS.length})`);
  });
});

// 桌面常驻侧栏的浅色削白改写：值是 rakko-tokens 的 GLASS_NAV_RAIL_LIGHT，落点是 AppShell
// 的 navRailGlassSx（挂在那块 permanent Drawer 的 paper 上，不是 :root）。chrome 档同时是
// 顶栏、侧栏、移动底栏三块表面，改 :root 会连带改掉手机端的两块；本组把「改写只落在侧栏
// 且只在浅色下」钉死。观感是否「不再发白」要由真机判定，这里只锁作用范围与变量值。
describe('桌面侧栏浅色削白（只动侧栏那一块 chrome）', () => {
  // jsdom 给不出真实渲染，玻璃变量走 emotion 规则文本。Drawer paper 的样式分在多个
  // css-* 类上（styled 一个、sx 一个），只取第一个类不够 —— 用共享的 ownRules，
  // 它把元素身上全部 css-* 类对应的规则块拼起来（写法同 tasks-page.test.tsx）。

  afterEach(() => {
    // theme-mode 是 localStorage 持久化的三态：不清会让后续用例跟着停在深色
    localStorage.clear();
  });

  it('浅色桌面：侧栏 paper 的规则文本里是削白后的三个白值', async () => {
    installDesktopMedia();
    renderRealThemeShell(SHELL_ITEMS);
    await screen.findByText('任务一');

    // 期望串从 token 拼出而不是手抄字面量：改了 token 这里跟着变，不会两边各说各话
    const rule = ownRules(allStyleText(), drawerPaper());
    for (const [key, value] of Object.entries(GLASS_NAV_RAIL_LIGHT)) {
      expect(rule, `侧栏 paper 应重声明 ${key}`).toContain(`${key}:${value}`);
    }
  });

  it('浅色桌面：侧栏 paper 不带暗端与纸色变量（改写范围只有三个白）', async () => {
    installDesktopMedia();
    renderRealThemeShell(SHELL_ITEMS);
    await screen.findByText('任务一');

    const rule = ownRules(allStyleText(), drawerPaper());
    for (const forbidden of [
      '--glass-sheen-3',
      '--glass-rim-inner',
      '--glass-panel-opacity',
      '--glass-surface-opacity',
    ]) {
      expect(rule, `侧栏改写不许带 ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('深色桌面：侧栏 paper 不带任何 --glass- 重声明', async () => {
    // 深底本身自带暗侧，那套 sheen（13%/5%）振幅已经够低，不需要再削
    localStorage.setItem('rakkotasks.theme-mode', 'dark');
    installDesktopMedia();
    renderRealThemeShell(SHELL_ITEMS);
    await screen.findByText('任务一');

    expect(ownRules(allStyleText(), drawerPaper())).not.toContain('--glass-');
  });

  it('削白只落在桌面侧栏：顶栏与底栏的规则文本都不含 sheen-1', async () => {
    installDesktopMedia();
    renderRealThemeShell(SHELL_ITEMS);
    await screen.findByText('任务一');

    // 顶栏与侧栏同挂 data-glass="chrome"，但顶栏必须原样：它背后是内容、没有满屏高的
    // 白纱问题，且 AppBar 与移动端顶栏是同一个组件。
    expect(
      ownRules(allStyleText(), appBar()),
      '顶栏是同档 chrome，不许吃侧栏的改写',
    ).not.toContain('--glass-sheen-1');

    // 底栏 Paper 无条件在 DOM 里，断点只影响它的 display，所以同一次渲染就能取到；
    // 顶栏与底栏同挂 chrome，必须都拿不到侧栏的改写
    const bottomNav = document.querySelector('.MuiBottomNavigation-root');
    expect(bottomNav).not.toBeNull();
    expect(
      ownRules(allStyleText(), bottomNav!.parentElement!),
      '底栏不许吃侧栏的改写',
    ).not.toContain('--glass-sheen-1');
  });
});
