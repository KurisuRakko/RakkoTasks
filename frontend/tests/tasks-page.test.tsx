// TasksPage 测试：high 条目渲染「重要」Chip，normal/low 条目不渲染；「重要」组标题出现。
// 另覆盖容器变换与 portal 相关行为：悬浮按钮挂在 body 下（不被路由转场盒子的
// transform 困住）、打 data-vt-shell 标记、勾选推进 LEAVE_DURATION 后发 PATCH done
// 且条目从列表消失；切回页面命中模块级缓存（list-cache）时不再闪加载圈。
// haze 底衬覆盖：分组标题的雾挂 ListSubheader 内层（外层 sticky 不动、无 data-glass）、
// chips 行的雾在滚动容器外层（滚动留在内层 Stack）、全页 haze 数 = 分组数 + 1。
// 加号现在打开的是 AiAddDialog——基座占位实现渲染 null，保存路径的用例改用 vi.mock
// 替身驱动其 onSubmit（替身细节见「TasksPage 手动添加」describe 上方），只验证
// TasksPage 的编排；AiAddDialog 内部渲染由 quick-add.test.tsx 同款替身专测。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TasksPage from '../src/pages/TasksPage';
import type { AiAddDialogProps } from '../src/components/AiAddDialog';
import chipsSource from '../src/components/CategoryChips.tsx?raw';
import tasksSource from '../src/pages/TasksPage.tsx?raw';
import { resetLists } from '../src/lib/list-cache';
import { LEAVE_DURATION } from '../src/lib/motion';
import { cardRowSx } from '../src/lib/surface';
import { MOTION, NEUTRAL_LIGHT, RADIUS } from '../src/rakko-tokens';
import { VT_SHELL_ATTR, VT_NAMES } from '../src/lib/view-transition';
import { DUE_SOON_DAYS } from '../src/lib/grouping';
import type { AccountInfo, Item } from '../src/types';
import { allStyleText, ownEmotionClass, renderWithAppTheme, ruleTextOf } from './glass-text-contrast.test-utils';

// vi.mock 工厂提升到 import 之前执行，只能引用字面量，文案在此内联
vi.mock('../src/components/AiAddDialog', () => ({
  // 替身也认 open：真组件常驻挂载、由 Dialog 按 open 跑入退场，替身若无视 open
  // 就会一直在场，「点加号才打开」这条断言等于没测
  default: (props: AiAddDialogProps) =>
    props.open ? (
      <div>
        <button
          onClick={() =>
            props.onSubmit([{ title: '买牛奶', summary: '两盒', category: '个人', due_date: null }])
          }
        >
          替身-保存
        </button>
      </div>
    ) : null,
}));

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

function makeAccount(partial: Partial<AccountInfo>): AccountInfo {
  return {
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
    ...partial,
  };
}

/** TasksPage 内部会调用带方向导航的 hook（空态「前往设置接入」按钮），渲染需要 Router */
function renderPage() {
  return render(
    <MemoryRouter useTransitions={false}>
      <TasksPage />
    </MemoryRouter>,
  );
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

    renderPage();

    expect(await screen.findByText('重要任务')).toBeTruthy();
    expect(await screen.findByText('普通任务')).toBeTruthy();
    expect(await screen.findByText('低重要任务')).toBeTruthy();

    // high 条目行内有「重要」Chip
    const highRow = screen.getByText('重要任务').closest('li');
    expect(highRow).not.toBeNull();
    expect(within(highRow!).getAllByText('重要').length).toBeGreaterThan(0);

    // 标签成组：行内「重要」Chip 收在横向 Stack 里；Stack 独占两段 grid 的第二行
    // （grid-area: chips），不与标题同排——布局细节断言见「列表行两段布局」describe
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

    renderPage();

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

    renderPage();

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
  it('页面存在右下角「新建待办」悬浮按钮', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: [] })));

    renderPage();

    expect(await screen.findByRole('button', { name: '新建待办' })).toBeTruthy();
  });

  it('点「新建待办」打开 AI 添加对话框（替身驱动 onSubmit），保存后 POST /api/items 且新标题出现在列表', async () => {
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

    renderPage();

    // 加号打开的是 AiAddDialog（占位实现渲染 null），用替身的「保存」驱动 onSubmit
    fireEvent.click(await screen.findByRole('button', { name: '新建待办' }));
    fireEvent.click(await screen.findByRole('button', { name: '替身-保存' }));

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
    expect(await screen.findByText('已保存：买牛奶')).toBeTruthy();
  });
});

/** 某元素自有 emotion 类的**全部**规则块拼起来（含 @media 里的那些）。
 *  ruleTextOf 只取第一个块，响应式 sx 落在 media 块里就取不到。 */
function allRulesFor(el: Element): string {
  const cls = ownEmotionClass(el);
  if (!cls) return '';
  const css = allStyleText();
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const start = css.indexOf(`.${cls}{`, from);
    if (start < 0) break;
    const end = css.indexOf('}', start);
    if (end < 0) break;
    blocks.push(css.slice(start, end));
    from = end + 1;
  }
  return blocks.join('\n');
}

describe('TasksPage 容器变换与 portal', () => {
  it('「新建待办」悬浮按钮的 parentElement 是 document.body（portal 生效）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: [] })));

    renderPage();

    const fab = await screen.findByRole('button', { name: '新建待办' });
    expect(fab.parentElement).toBe(document.body);
  });

  it('悬浮按钮打 data-vt-shell 标记（持名由样式层按转场种类下发）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: [] })));

    renderPage();

    const fab = await screen.findByRole('button', { name: '新建待办' });
    expect(fab.getAttribute(VT_SHELL_ATTR)).toBe(VT_NAMES.fab);
  });

  // 加号 ↔ 速记面板的编排：加号只过渡 transform，打开下沉让位、关闭延后回位。
  // 面板那一侧（Slide 的 enter/exit 时长、退场跑完才卸载）在 ai-add-dialog.test.tsx。
  it('加号让位：关闭态 translateY(0)、打开态位移出视口，且只过渡 transform', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: [] })));

    render(
      <MemoryRouter useTransitions={false}>
        <TasksPage />
      </MemoryRouter>,
    );
    const fab = await screen.findByRole('button', { name: '新建待办' });

    const closed = getComputedStyle(fab);
    expect(closed.transform).toBe('translateY(0)');
    // 关闭方向要等面板先落下去一截，所以回位是带延迟的
    expect(closed.transitionDelay).toBe(`${MOTION.fadeOut}ms`);
    expect(closed.transition).toBe(`transform ${MOTION.state}ms ${MOTION.easeStandard}`);
    // 禁 transition: all（会连带动画布局与浏览器私有属性）
    expect(closed.transition).not.toContain('all');

    fireEvent.click(fab);

    // 打开态的位移是响应式的（sx 传对象），emotion 把它放进 @media 块，而且带
    // env(safe-area-inset-bottom) 让 jsdom 的 CSS 解析器整条丢弃——computed style
    // 和只取首个规则块的 ruleTextOf 都读不到，得把该类的全部规则块收齐再看
    const openCss = allRulesFor(fab);
    expect(openCss).toContain('translateY(calc(100%');
    expect(openCss).toContain('env(safe-area-inset-bottom)');
    expect(getComputedStyle(fab).transitionDelay).toBe('0ms'); // 打开立刻让位，不拖泥带水
  });

  it('加号的让位位移与它自己的 bottom 同源（不写死魔数，安全区照样能出视口）', () => {
    // xs 档：16px 间距 + 64px 底栏 + 安全区，位移 = 自身高度 + 这些 + 8px 余量
    expect(tasksSource).toContain("xs: 'calc(16px + 64px + env(safe-area-inset-bottom))'");
    expect(tasksSource).toContain(
      'xs: `translateY(calc(100% + ${FAB_BOTTOM.xs} + 8px))`',
    );
    expect(tasksSource).toContain(
      'md: `translateY(calc(100% + ${FAB_BOTTOM.md} + 8px))`',
    );
  });

  it('reduced-motion 下加号不做位移过渡', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: [] })));
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        onchange: null,
        dispatchEvent: vi.fn(),
      })),
    );

    render(
      <MemoryRouter useTransitions={false}>
        <TasksPage />
      </MemoryRouter>,
    );
    const fab = await screen.findByRole('button', { name: '新建待办' });
    expect(getComputedStyle(fab).transition).toBe('none');
  });

  it('勾选条目后推进 LEAVE_DURATION：PATCH {"status":"done"} 且条目从列表消失', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === 'PATCH' && u === '/api/items/1') return json({});
      if (u.startsWith('/api/items')) return json({ items: ITEMS });
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
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
    renderPage();
    await screen.findByText('重要任务');
    cleanup();

    // 再次挂载（模拟切走再切回）：缓存命中，无加载圈、列表同步渲染
    renderPage();
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

    render(
      <MemoryRouter useTransitions={false}>
        <TasksPage />
      </MemoryRouter>,
    );
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

    render(
      <MemoryRouter useTransitions={false}>
        <TasksPage />
      </MemoryRouter>,
    );
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

describe('列表行布局（标签竖排在右侧，且不挤压标题）', () => {
  // jsdom 给不出 grid 布局的可靠 computed 值，布局断言走 emotion 规则文本：
  // sx 经 emotion 编译成 css-* 类规则插入 <style>，可逐字断言（utils 文件头说明）。
  // 行按钮的 sx 是数组（cardRowSx + 行布局对象），保险起见把元素上全部 css-* 类
  // 的规则都拼起来再查，不赌 emotion 合并成一个类。

  /** 元素身上全部 css-* 局部类对应规则块的拼接 */
  function ownRules(css: string, el: Element): string {
    return Array.from(el.classList)
      .filter((c) => c.startsWith('css-'))
      .map((c) => {
        const start = css.indexOf(`.${c}{`);
        if (start < 0) return '';
        const end = css.indexOf('}', start);
        return end < 0 ? '' : css.slice(start, end);
      })
      .join(' ');
  }

  it('行按钮是单行四列 grid：标签不再独占一整行（grid-template-areas）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: ITEMS })));
    render(
      <MemoryRouter useTransitions={false}>
        <TasksPage />
      </MemoryRouter>,
    );
    await screen.findByText('重要任务');

    const rowBtn = screen.getByText('重要任务').closest(
      '.MuiListItemButton-root',
    ) as HTMLElement;
    const rule = ownRules(allStyleText(), rowBtn);
    expect(rule, '行内是 grid，不是单行 flex').toContain('display:grid');
    // 标题列必须是 minmax(0, 1fr)：grid 项默认 min-width 是 auto，写 1fr 会让长标题
    // 撑出自己的列、反过来挤扁元信息列
    expect(rule, '列 = 蓝点 12px / 勾选 auto / 标题可收缩 / 元信息按内容').toContain(
      'grid-template-columns:12px auto minmax(0, 1fr) auto',
    );
    expect(rule, '单行四区：dot / cb / text / meta').toContain(
      'grid-template-areas:"dot cb text meta"',
    );
    expect(rule, '标签不再独占第二行').not.toContain('". . chips"');
  });

  it('标签竖排在 meta 列，有 maxWidth 护住标题，不再回到 flexShrink: 0 挤标题的老路', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: ITEMS })));
    render(
      <MemoryRouter useTransitions={false}>
        <TasksPage />
      </MemoryRouter>,
    );
    await screen.findByText('重要任务');

    const highRow = screen.getByText('重要任务').closest('li') as HTMLElement;
    const chip = within(highRow).getAllByText('重要')[0];
    const stack = chip.closest('.MuiStack-root') as HTMLElement;
    expect(stack).not.toBeNull();
    const rule = ownRules(allStyleText(), stack);
    expect(rule, '标签落在右侧元信息列').toContain('grid-area:meta');
    // MUI Stack 默认 flex-direction: column，这里正是要竖排；断言它没有被改回横排
    expect(rule, '标签竖着码，不是横着一长排').not.toContain('flex-direction:row');
    expect(rule, 'maxWidth 是标题的护栏：标签再多也不许吃掉标题的宽度').toContain('max-width:8.5rem');
    expect(rule, '不许回到用 flexShrink: 0 抢宽度的老写法').not.toContain('flex-shrink:0');
    // column 方向的 flexWrap 只有容器限高时才生效：光写 wrap 不写 maxHeight 是死配置，
    // 四个标签会排成一列把行撑成一段楼梯
    expect(rule, '超过两个标签要折成第二列').toContain('flex-wrap:wrap');
    expect(rule, 'wrap 靠限高触发，不写 maxHeight 那条 wrap 不生效').toContain('max-height:43px');
    // Stack 默认把 spacing 编译成相邻兄弟的 margin-top：换列时第二列的头一个标签
    // 仍是相邻兄弟，会多出一截与第一列错位。useFlexGap 让它走 gap。
    expect(rule, '间距必须走 gap，不能是 margin').toContain('gap:3px');
    expect(rule, '不许回到 margin 实现的 spacing').not.toContain('margin-top:3px');
  });

  it('标签比 MUI 的 small 再小一档：竖排时不把行撑成一段楼梯', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: ITEMS })));
    render(
      <MemoryRouter useTransitions={false}>
        <TasksPage />
      </MemoryRouter>,
    );
    await screen.findByText('重要任务');

    const highRow = screen.getByText('重要任务').closest('li') as HTMLElement;
    const chipRoot = within(highRow)
      .getAllByText('重要')[0]
      .closest('.MuiChip-root') as HTMLElement;
    const rule = ownRules(allStyleText(), chipRoot);
    // MUI size="small" 本身是 24px / 13px，这里再压一档
    expect(rule, '高度压到 20px').toContain('height:20px');
    expect(rule, '字号取 caption 档').toContain('font-size:0.6875rem');
  });
});

describe('TasksPage haze 底衬（分组标题与 chips 行）', () => {
  // 从 ?raw 源码里取出 data-glass="haze" 所在 JSX 开标签的整段文本（含属性与 sx）。
  // jsdom 对 emotion 生成的样式给不出可靠的 computed 值，宽度/bleed 这类写法断言
  // 一律落回源码原文，否则会写出永远为真的假断言。
  function hazeHostTag(source: string): string {
    const attrStart = source.indexOf('data-glass="haze"');
    expect(attrStart).toBeGreaterThan(-1);
    const tagStart = source.lastIndexOf('<Box', attrStart);
    expect(tagStart).toBeGreaterThan(-1);
    const tagEnd = source.indexOf('>', attrStart);
    expect(tagEnd).toBeGreaterThan(-1);
    return source.slice(tagStart, tagEnd);
  }

  it('分组标题文字被 data-glass="haze" 包着，且 haze 在 ListSubheader 内层而非其本身', async () => {
    const fetchMock = vi.fn(async () => json({ items: ITEMS }));
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(
      <MemoryRouter useTransitions={false}>
        <TasksPage />
      </MemoryRouter>,
    );
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

    const { container } = render(
      <MemoryRouter useTransitions={false}>
        <TasksPage />
      </MemoryRouter>,
    );
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

    render(
      <MemoryRouter useTransitions={false}>
        <TasksPage />
      </MemoryRouter>,
    );
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
    const hazeTag = hazeHostTag(chipsSource);
    expect(hazeTag).not.toContain('overflowX');

    // haze 开标签结束后紧跟内层滚动 Stack（data-glass 没被挪进 Stack）
    const attrStart = chipsSource.indexOf('data-glass="haze"');
    const hazeTagEnd = chipsSource.indexOf('>', attrStart);
    expect(hazeTagEnd).toBeGreaterThan(-1);
    const stackStart = chipsSource.indexOf('<Stack', hazeTagEnd);
    expect(stackStart).toBeGreaterThan(-1);
    const stackTag = chipsSource.slice(stackStart, chipsSource.indexOf('>', stackStart));
    expect(stackTag).toContain('overflowX');
  });

  it('全页 data-glass="haze" 数量 = 分组数 + 1（chips 行），不多不少', async () => {
    const fetchMock = vi.fn(async () => json({ items: ITEMS }));
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(
      <MemoryRouter useTransitions={false}>
        <TasksPage />
      </MemoryRouter>,
    );
    await screen.findByText('重要任务');

    // 每个分组标题一团雾（它们之间隔着整组卡片，距离远超 bleed，不重叠），
    // 外加 chips 行一团
    const groupCount = container.querySelectorAll('.MuiListSubheader-root').length;
    expect(container.querySelectorAll('[data-glass="haze"]')).toHaveLength(groupCount + 1);
  });

  it('没有任何 data-glass="haze" 元素带 data-haze 属性（cloud 是默认形态，不写该属性）', async () => {
    const fetchMock = vi.fn(async () => json({ items: ITEMS }));
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(
      <MemoryRouter useTransitions={false}>
        <TasksPage />
      </MemoryRouter>,
    );
    await screen.findByText('重要任务');

    // 分组标题雾 + chips 行雾各一团（前述用例已断言数量）。cloud 是上游配方默认形态，
    // 默认不写 data-haze——只有切到 veil 才写该属性（对照上游 showcase 的
    // `data-haze={hazeShape}`，hazeShape 平时就是 undefined）
    const hazes = Array.from(container.querySelectorAll('[data-glass="haze"]'));
    expect(hazes.length).toBeGreaterThan(0);
    for (const haze of hazes) {
      expect(haze.hasAttribute('data-haze')).toBe(false);
    }
  });

  it('chips 行雾盒收缩不再靠 inline-block：源码开标签含 max-content、不含 inline-block', () => {
    // jsdom 对 emotion 编译出的类名给不出可靠的 computed display，退回源码断言：
    // 定位 CategoryChips 里 data-glass="haze" 所在的开标签——宽度必须走上游 showcase 的
    // width: max-content 写法。本项目旧的 display: inline-block 收缩已被上游用法取代，
    // 谁把它加回来（或把雾盒改回撑满整列的块级）此断言先翻。
    const hazeTag = hazeHostTag(chipsSource);
    expect(hazeTag).toContain('max-content');
    expect(hazeTag).not.toContain('inline-block');
  });

  it('两处 haze 的 bleed 都是 calc(0.3 × 上游 token) 形式：引用 GLASS.hazeBleed、无写死 px', () => {
    // 分组标题与 chips 行的雾都取上游 .glass-review__label 档（0.3 × 28px = 8.4px）。
    // 引用 token 才能让上游改 bleed 时这里跟着变——任何人写回本项目旧的 14px / 10px，
    // 或把 0.3×28 手工折成 8.4px，此断言先翻。
    for (const [label, tag] of [
      ['分组标题（TasksPage）', hazeHostTag(tasksSource)],
      ['chips 行（CategoryChips）', hazeHostTag(chipsSource)],
    ] as const) {
      expect(tag, `${label}: bleed 必须是 0.3 × token 的 calc 形式`).toContain('calc(0.3 *');
      expect(tag, `${label}: 必须引用 GLASS.hazeBleed，不许写死数值`).toContain(
        '${GLASS.hazeBleed}',
      );
      expect(tag, `${label}: bleed 不许出现写死的 px 数值`).not.toMatch(
        /--glass-haze-bleed[^,]*?\dpx/,
      );
    }
  });
});

describe('TasksPage 行上下文菜单', () => {
  /** 找到指定标题所在行的 ListItemButton（行玻璃） */
  function rowButton(title: string): HTMLElement {
    const btn = screen.getByText(title).closest('.MuiListItemButton-root');
    expect(btn).not.toBeNull();
    return btn as HTMLElement;
  }

  it('右键行弹出上下文菜单：菜单纸面带 data-glass="panel"，含 完成/编辑/删除 三项', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: ITEMS })));

    render(
      <MemoryRouter useTransitions={false}>
        <TasksPage />
      </MemoryRouter>,
    );
    await screen.findByText('重要任务');

    fireEvent.contextMenu(rowButton('重要任务'), { clientX: 210, clientY: 96 });

    // 菜单出现，纸面挂 panel 玻璃（材质由 rakko-glass.css 配方提供）
    const menu = await screen.findByRole('menu');
    const paper = menu.closest('.MuiPaper-root');
    expect(paper).not.toBeNull();
    expect(paper!.getAttribute('data-glass')).toBe('panel');
    // 三项文案按顺序在菜单里（操作列表：DropdownMenu 档）
    for (const label of ['完成', '编辑', '删除']) {
      expect(screen.getByRole('menuitem', { name: label })).toBeTruthy();
    }
  });

  it('点菜单「完成」走既有勾选流程：离场后 PATCH {"status":"done"} 且行移出列表', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === 'PATCH' && u === '/api/items/1') return json({});
      if (u.startsWith('/api/items')) return json({ items: ITEMS });
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter useTransitions={false}>
        <TasksPage />
      </MemoryRouter>,
    );
    await screen.findByText('重要任务');

    fireEvent.contextMenu(rowButton('重要任务'), { clientX: 40, clientY: 40 });
    fireEvent.click(await screen.findByRole('menuitem', { name: '完成' }));

    // 与勾选 checkbox 同一流程：离场动画（LEAVE_DURATION）结束后才 PATCH 并移出列表
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true);
    });
    const patchCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === 'PATCH',
    ) as [string, RequestInit] | undefined;
    expect(patchCall).toBeDefined();
    expect(patchCall![0]).toBe('/api/items/1');
    expect(JSON.parse(String(patchCall![1].body))).toEqual({ status: 'done' });
    await waitFor(() => expect(screen.queryByText('重要任务')).toBeNull());
  });

  it('菜单打开时全页只有一份 RowContextMenu（菜单纸面 ≤1），且不构成嵌套玻璃', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: ITEMS })));

    render(
      <MemoryRouter useTransitions={false}>
        <TasksPage />
      </MemoryRouter>,
    );
    await screen.findByText('重要任务');

    // 打开前页面上没有菜单纸面（按需挂载）
    expect(document.querySelectorAll('.MuiMenu-paper[data-glass="panel"]')).toHaveLength(0);

    fireEvent.contextMenu(rowButton('普通任务'), { clientX: 30, clientY: 30 });
    await screen.findByRole('menu');

    // 只挂一份：菜单纸面（.MuiMenu-paper）恰好一个。列表行的 panel 玻璃在
    // ListItemButton 上，不是菜单实例，不计入
    expect(document.querySelectorAll('.MuiMenu-paper[data-glass="panel"]')).toHaveLength(1);

    // 打开时不构成嵌套玻璃：没有一个 data-glass 元素是另一个 data-glass 的后代
    // （菜单 portal 到 body，与行只是视觉重叠；行玻璃之间也互不为后代）
    for (const el of Array.from(document.querySelectorAll('[data-glass]'))) {
      expect(el.parentElement?.closest('[data-glass]') ?? null).toBeNull();
    }
  });
});

describe('列表行摘要文字色（玻璃上没有次级色的守卫）', () => {
  // 行摘要直接压在 data-glass="panel" 玻璃上（纸色 58% 仍透壁纸）：MUI 默认给
  // ListItemText secondary 的 text.secondary（n7）在四张壁纸 × 深浅主题下实测对比度
  // 只有 2.4–2.6，AA 正文要 ≥4.5；玻璃上没有次级色空间，层级只靠字号字重，摘要
  // 必须用 text.primary（n9 = NEUTRAL_LIGHT[8]）。jsdom 解析不了 emotion 的级联与
  // computed，但规则文本（非 speedy 插入 <style>）可逐字断言（utils 文件头说明）。
  it('摘要 Typography 的样式规则颜色是 n9（text.primary），不是 n7（text.secondary）', async () => {
    const withSummary: Item[] = [
      makeItem({ id: 1, title: '任务甲', summary: '两盒牛奶，记得看保质期' }),
      makeItem({ id: 2, title: '任务乙', summary: '下周三前交实验报告' }),
    ];
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: withSummary })));
    const { container } = renderWithAppTheme(
      <MemoryRouter useTransitions={false}>
        <TasksPage />
      </MemoryRouter>,
    );
    await screen.findByText('任务甲');

    // 摘要节点：ListItemText 的 secondary 渲染成 .MuiListItemText-secondary span
    const summaries = container.querySelectorAll('.MuiListItemText-secondary');
    expect(summaries).toHaveLength(withSummary.length);
    const css = allStyleText();
    for (const span of Array.from(summaries)) {
      expect(ownEmotionClass(span), '摘要 Typography 应带 emotion 局部类').not.toBeNull();
      const rule = ruleTextOf(css, span);
      expect(rule, '摘要颜色必须是 text.primary（n9）').toContain(`color:${NEUTRAL_LIGHT[8]}`);
      expect(rule, '摘要不得回落到 MUI 默认的 text.secondary（n7）').not.toContain(
        `color:${NEUTRAL_LIGHT[6]}`,
      );
    }
  });
});

describe('TasksPage 空态账户引导', () => {
  it('条目为空且账户列表为空：先显示「没有待办任务」，账户探测返回后切换成引导', async () => {
    // /api/status 用可控 promise：模拟「探测还没回来」的窗口，验证空态文案不依赖账户探测
    let resolveStatus!: (v: Response) => void;
    const statusPromise = new Promise<Response>((resolve) => {
      resolveStatus = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes('/api/status')) return statusPromise;
      return json({ items: [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    // 探测未返回：不打断原有「没有待办任务」文案
    expect(await screen.findByText('没有待办任务')).toBeTruthy();
    resolveStatus(json({ accounts: [], pending_llm: 0 }));

    // 确认无账户后切换成设置引导，旧文案消失
    expect(await screen.findByText('还没有接入邮箱')).toBeTruthy();
    expect(screen.getByText(/邮件里的待办整理到这里/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '前往设置接入' })).toBeTruthy();
    expect(screen.queryByText('没有待办任务')).toBeNull();
    // 只在列表为空时查一次 /api/status（后续刷新不再重复打）
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/status'))).toHaveLength(1),
    );
  });

  it('条目为空但有账户：显示「没有待办任务」，不出现设置引导', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes('/api/status')) {
        return json({ accounts: [makeAccount({})], pending_llm: 0 });
      }
      return json({ items: [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    expect(await screen.findByText('没有待办任务')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '前往设置接入' })).toBeNull();
  });
});

describe('截止日标记的三档（逾期 / 临期 / 更远）', () => {
  /** today + n 天的 YYYY-MM-DD（与列表页读的是同一个「今天」） */
  function inDays(n: number): string {
    const t = new Date();
    const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() + n);
    const pad = (x: number) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /** 渲染三条任务：昨天到期 / 一周后到期 / 远期到期，返回各自的截止日 Chip 根元素 */
  async function renderThree(): Promise<Record<'overdue' | 'soon' | 'far', HTMLElement>> {
    const items: Item[] = [
      makeItem({ id: 11, title: '逾期的', due_date: inDays(-1) }),
      makeItem({ id: 12, title: '快到期的', due_date: inDays(7) }),
      makeItem({ id: 13, title: '还早的', due_date: inDays(DUE_SOON_DAYS + 10) }),
    ];
    vi.stubGlobal('fetch', vi.fn(async () => json({ items })));
    render(
      <MemoryRouter useTransitions={false}>
        <TasksPage />
      </MemoryRouter>,
    );
    await screen.findByText('逾期的');

    const chipOf = (title: string): HTMLElement => {
      const row = screen.getByText(title).closest('li') as HTMLElement;
      const chip = within(row)
        .getAllByText(/月\d{1,2}日$/)[0]
        .closest('.MuiChip-root');
      expect(chip, `${title} 应有截止日标记`).not.toBeNull();
      return chip as HTMLElement;
    };
    return { overdue: chipOf('逾期的'), soon: chipOf('快到期的'), far: chipOf('还早的') };
  }

  it('逾期用实心主色（梅），不再用语义 error 色', async () => {
    const { overdue } = await renderThree();
    expect(overdue.className).toMatch(/MuiChip-colorPrimary/);
    expect(overdue.className).toMatch(/MuiChip-filled/);
    expect(overdue.className).not.toMatch(/colorError/);
  });

  it('今天起 DUE_SOON_DAYS 天内到期用描边主色：与逾期同色系，但分得出轻重', async () => {
    const { soon } = await renderThree();
    expect(soon.className).toMatch(/MuiChip-colorPrimary/);
    expect(soon.className).toMatch(/MuiChip-outlined/);
  });

  it('更远的截止日保持中性：不让所有带截止日的条目糊成一片红', async () => {
    const { far } = await renderThree();
    expect(far.className).not.toMatch(/MuiChip-colorPrimary/);
  });
});
