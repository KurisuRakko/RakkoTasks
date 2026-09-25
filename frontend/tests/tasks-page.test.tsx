// TasksPage 测试：high 条目渲染「重要」Chip，normal/low 条目不渲染；「重要」组标题出现。
// 另覆盖容器变换与 portal 相关行为：悬浮按钮挂在 body 下（不被路由转场盒子的
// transform 困住）、勾选推进 LEAVE_DURATION 后发 PATCH done
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
import { ROW_CHIP_HEIGHT_PX, cardRowSx } from '../src/lib/surface';
import { MOTION, NEUTRAL_LIGHT, RADIUS } from '../src/rakko-tokens';
import { DUE_SOON_DAYS } from '../src/lib/grouping';
import type { AccountInfo, Item } from '../src/types';
import {
  allStyleText,
  ownEmotionClass,
  ownRules,
  renderWithAppTheme,
  ruleTextOf,
} from './glass-text-contrast.test-utils';

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

describe('今日新邮件标记点', () => {
  it('今天发送的条目显示今日点，旧条目不显示', async () => {
    const items: Item[] = [
      makeItem({ id: 11, title: '今天的新条目', email_sent_at: new Date().toISOString() }),
      makeItem({ id: 12, title: '旧条目', email_sent_at: '2026-08-01T00:00:00+00:00' }),
    ];
    const fetchMock = vi.fn(async () => json({ items }));
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    await screen.findByText('今天的新条目');

    // 只有发送于今天的那条带今日点
    expect(screen.getAllByLabelText('今日新邮件')).toHaveLength(1);

    // 今日点位于新条目所在行内
    const newRow = screen.getByText('今天的新条目').closest('li');
    expect(newRow).not.toBeNull();
    expect(within(newRow!).getByLabelText('今日新邮件')).toBeTruthy();

    // 旧条目行内没有今日点
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

describe('列表行布局（chip 恒横排在标题首行右侧，且不挤压标题）', () => {
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
    // 撑出自己的列、反过来挤扁元信息列。meta 列必须是 max-content（不可压缩），
    // 见下面「chip 不被压缩」那条用例
    expect(rule, '列 = 今日点 12px / 勾选 auto / 标题可收缩 / 元信息按内容封顶').toContain(
      'grid-template-columns:12px auto minmax(0, 1fr) max-content',
    );
    expect(rule, '单行四区：dot / cb / text / meta').toContain(
      'grid-template-areas:"dot cb text meta"',
    );
    expect(rule, '标签不再独占第二行').not.toContain('". . chips"');
  });

  it('chip 恒横排在 meta 列并与标题首行同中线：任何宽度下不换行、不竖排、不被压缩', async () => {
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
    // 方向恒为 row：MUI Stack 默认 flex-direction: column，这里是横排，不许被改回纵向
    expect(rule, '标签横着码，不是一列竖着码').toContain('flex-direction:row');
    expect(rule, '与今日点、勾选框共用标题首行中线').toContain('align-items:center');
    // maxWidth 护栏已删：meta 列改由 grid 的 max-content 轨道封顶（不可压缩），
    // 再挂一条 maxWidth 只会重新引入一个会压扁 chip 的上限
    expect(rule, 'meta 列宽由内容封顶，不要 maxWidth 护栏').not.toContain('max-width');
    expect(rule, '不许回到用 flexShrink: 0 抢宽度的老写法').not.toContain('flex-shrink:0');
    // 折成两列（column + wrap + maxHeight）的写法已删：column 方向的 wrap 一旦换列，
    // 视觉阅读顺序与 DOM 顺序对不上，第一列剩下的标签孤零零挂在左下；且两列宽度合计
    // 会顶出卡片。nowrap 是 flex 默认值，这里要的是它被显式写死（历史故障正出在
    // flexWrap 上），所以断言的是具体声明而不是「不含 flex-wrap」。
    expect(rule, '换行必须显式写死为 nowrap：不许再折成两列').toContain('flex-wrap:nowrap');
    expect(rule, '不许再写死限高触发折叠').not.toContain('max-height');
    // 间距断言按 gap 的实现写：useFlexGap 把 spacing 编译成容器上的 gap；不开它的
    // 话 MUI 会用后代选择器隔空改写子元素 margin（相邻兄弟逐个加、其余重置成 0）
    expect(rule, '间距必须走 gap，不能是 margin').toContain('gap:4px');
    expect(rule, '不许回到 margin 实现的 spacing').not.toContain('margin-top:4px');
  });

  it('chip 在任何视口宽度下都不被压扁截断：让宽度失去影响力的三条 CSS 不变量', async () => {
    // jsdom 没有排版引擎，窗口宽度不影响这些值，所以不做「窄屏」用例，改钉三条结构性声明：
    // 它们才是决定结果的东西——只要三条都在，chip 被压缩或换行在结构上就不可能发生，
    // 与容器多宽无关。
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: ITEMS })));
    render(
      <MemoryRouter useTransitions={false}>
        <TasksPage />
      </MemoryRouter>,
    );
    await screen.findByText('重要任务');

    const title = screen.getByText('重要任务');
    const css = allStyleText();

    // ① meta 轨道 max-content：不可压缩，chip 永远拿得到完整宽度。
    //    写 auto 的话轨道最小尺寸是 min-content，而 .MuiChip-label 带 overflow: hidden，
    //    它作为 flex 项的自动最小尺寸会解析成 0——chip 就会被压成一个省略号。
    const rowBtn = title.closest('.MuiListItemButton-root') as HTMLElement;
    const rowRule = ownRules(css, rowBtn);
    expect(rowRule, 'meta 轨道不可压缩才谈得上不截断').toContain(
      'grid-template-columns:12px auto minmax(0, 1fr) max-content',
    );

    // ② meta 容器 row + nowrap：方向与换行都不是默认值兜底，而是写死的声明
    const chip = within(title.closest('li') as HTMLElement).getAllByText('重要')[0];
    const stackRule = ownRules(css, chip.closest('.MuiStack-root') as HTMLElement);
    expect(stackRule, '横排是写死的').toContain('flex-direction:row');
    expect(stackRule, '不换行是写死的').toContain('flex-wrap:nowrap');

    // ③ 标题列才是让位的那一方：轨道 minmax(0, 1fr) 能收缩，ListItemText 自身也得能
    //    收缩到轨道下限。这条 min-width: 0 不是本仓写的，来自 MUI ListItemText 的根样式；
    //    本仓不重复声明它（同值重复就是冗余），但标题让位依赖它，所以在这里钉住——
    //    上游哪天删了，这条会红，那时再由本仓补上。
    const textRule = ownRules(css, title.closest('.MuiListItemText-root') as HTMLElement);
    expect(textRule, 'ListItemText 自己也得能收缩，否则 minmax(0,1fr) 是空转的').toContain(
      'min-width:0',
    );
  });

  it('行高有富余时整行内容居中：align-content:center，而列内对齐仍是 start', async () => {
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
    // 两件事别混：align-items 决定四列内部以标题首行对齐（今日点/勾选框/chip 的中线），
    // align-content 决定单行隐式轨道在有富余高度时整体居中——无摘要的单行任务不贴行顶
    expect(rule, '整条轨道在有富余高度时居中').toContain('align-content:center');
    expect(rule, '列内仍以标题首行对齐，别被居中改掉').toContain('align-items:start');
  });

  it('行高改由 ROW_MIN_HEIGHT_PX 决定后，6px 竖向内边距魔数已删', async () => {
    // 行高现在由 lib/surface 的 ROW_MIN_HEIGHT_PX（写在 motion.rowSx 的 & > * 上）决定，
    // 那 4px 魔数没有存在理由；且 6px 不在 8px 网格上、也不在任何间距梯度里。
    // 竖向内边距回到 ListItemButton 的 MUI 默认 8px。
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
    // 为什么必须用「恰好一条」而不是 toContain('padding-top:8px')：ListItemButton 的根样式
    // 与行内 sx 落在同一个 css-* 类里，根样式无条件输出 padding-top:8px；sx 若再写
    // py: '7px'，规则文本里是两条并存（后者生效），toContain('padding-top:8px') 照样为真
    // ——那种断言防不住任何回归。改断「竖向内边距只允许 MUI 默认的 8px 这一条声明」：
    // 任何 py 覆盖都会多出第二条 padding-top，6px / 7px / 10px 一律被抓到。
    expect(rule.match(/padding-top:[^;]+/g), '竖向内边距只允许 MUI 默认的 8px 这一条声明').toEqual(
      ['padding-top:8px'],
    );
    expect(rule.match(/padding-bottom:[^;]+/g), '同上').toEqual(['padding-bottom:8px']);
  });

  it('长标题让位给 chip：标题可任意断行，不会溢出压到 chip 上', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: ITEMS })));
    render(
      <MemoryRouter useTransitions={false}>
        <TasksPage />
      </MemoryRouter>,
    );
    await screen.findByText('重要任务');

    // overflow-wrap: anywhere 是给「一长串不含空格的西文 / URL 标题」补断点的：
    // 中文本来能逐字换行，西文长串不给断点会直接溢出压到 chip 上。标题不设行数上限
    // ——待办的标题是主信息，截断会让用户看不到自己写的东西。
    const primary = screen
      .getByText('重要任务')
      .closest('.MuiListItemText-primary') as HTMLElement;
    expect(primary, '找到的是标题的 primary Typography 节点').not.toBeNull();
    const rule = ownRules(allStyleText(), primary);
    expect(rule, '长串西文/URL 标题必须能在任意位置断行').toContain('overflow-wrap:anywhere');
  });

  it('行左侧今日点、勾选框与标题首行共用同一条中线', async () => {
    // email_sent_at 必须是今天：否则 isNewToday 为假、今日点不渲染（参照上方
    // 「今日新邮件标记点」describe 的夹具写法）
    const items: Item[] = [
      makeItem({ id: 11, title: '今日到达的条目', email_sent_at: new Date().toISOString() }),
    ];
    vi.stubGlobal('fetch', vi.fn(async () => json({ items })));
    render(
      <MemoryRouter useTransitions={false}>
        <TasksPage />
      </MemoryRouter>,
    );
    await screen.findByText('今日到达的条目');

    const row = screen.getByText('今日到达的条目').closest('li') as HTMLElement;
    expect(row).not.toBeNull();

    // 中线基准：TITLE_LINE_H 由 TYPE_SCALE['copy-14'] 推出（14 × 1.57 四舍五入 → 22），
    // 与 theme 的 body1（typeStyle('copy-14')）同源
    const dotBox = within(row).getByLabelText('今日新邮件').parentElement as HTMLElement;
    expect(dotBox).not.toBeNull();
    const dotRule = ownRules(allStyleText(), dotBox);
    expect(dotRule, '今日点的包裹盒与标题首行等高').toContain('height:22px');
    expect(dotRule, '今日点竖向居中于包裹盒').toContain('align-items:center');

    const cbBox = within(row)
      .getByRole('checkbox')
      .closest('.MuiCheckbox-root')!.parentElement as HTMLElement;
    expect(cbBox).not.toBeNull();
    const cbRule = ownRules(allStyleText(), cbBox);
    expect(cbRule, '勾选框的包裹盒与标题首行等高').toContain('height:22px');
    expect(cbRule, '勾选框竖向居中于包裹盒').toContain('align-items:center');

    // 勾选框自身不带 marginTop：那个 -4px 魔数只把中心从 21 挪到 17，离标题首行的
    // 11 还差 6px——三个元素三条中线的老毛病，不许有人偷偷加回来
    const cbRoot = within(row).getByRole('checkbox').closest('.MuiCheckbox-root') as HTMLElement;
    const cbRootRule = ownRules(allStyleText(), cbRoot);
    // ownRules 在元素上没有 css-* 类时返回空串，空串对下面那条 not.toContain 恒真——
    // 先证明确实读到了勾选框自己的规则，守卫才不会静默空转（不能拿 MUI 内部具体声明
    // 判非空，那是拿版本细节当契约）
    expect(
      cbRootRule,
      '守卫不能空转：必须真的读到勾选框自己的规则（空串会让下面那条 not.toContain 恒真）',
    ).not.toBe('');
    expect(cbRootRule, '勾选框自身不许带 marginTop 魔数').not.toContain('margin-top');
  });

  it('行内标签走契约字阶：label-12（12px）+ 22px 盒高，压得住标题首行', async () => {
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
    expect(rule, '没读到 chip 自身的 css-* 规则，断言会空转').not.toBe('');
    // MUI size="small" 本身是 24px / 13px；行内标签取契约字阶最小的一档 label-12，
    // 盒高与标题首行（TITLE_LINE_H = 22）同值，三列元素才压在同一条中线上
    expect(rule, '盒高与标题首行同高（22px）').toContain(`height:${ROW_CHIP_HEIGHT_PX}px`);
    expect(rule, '字号取契约 label-12（12px）').toContain('font-size:12px');
    expect(rule, '11px 不在契约字阶上，不许回退').not.toContain('font-size:0.6875rem');
  });

  it('行体三档状态层按 motion 契约：hover / pressed / focus-visible + primary 描边环', async () => {
    // jsdom 求不出 :hover/:active 的实际值，但 emotion 把选择器与声明原样插进 <style>，
    // 可以逐字断言（同本文件其余样式断言的做法）。状态层住在嵌套规则块里
    // （`.<行体类名>:hover{…}`），ownRules 只到第一个嵌套块结束，所以这里改按
    // 「以本元素自己的类名开头 + 伪类」直接定位到那一条规则——只认本元素的类，
    // 别的元素恰好也写了 outline 之类的假通过可以排除。
    // 用应用真实主题渲染（renderWithAppTheme）：描边色取的是 theme.palette.primary.main，
    // 默认主题下那是 MUI 的蓝（#1976d2），只有真主题才验得到 Rakko 的梅色
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: ITEMS })));
    renderWithAppTheme(
      <MemoryRouter useTransitions={false}>
        <TasksPage />
      </MemoryRouter>,
    );
    await screen.findByText('重要任务');

    const rowBtn = screen.getByText('重要任务').closest(
      '.MuiListItemButton-root',
    ) as HTMLElement;
    const classes = Array.from(rowBtn.classList).filter((c) => c.startsWith('css-'));
    expect(classes, '行体没挂 emotion 局部类，下面的断言会空转').not.toHaveLength(0);
    const css = allStyleText();

    // 三档状态层：MUI 的 ListItemButton 只有 hover 与 focus，pressed（12%）要自己补。
    // 逐个状态都要求「行体自己的类名带出该伪类」，别的元素顺带写的选择器不算数。
    for (const [label, suffix] of [
      ['hover 状态层', ':hover'],
      ['pressed 状态层（MUI 没有这一档）', ':active'],
      ['focus-visible 状态层', '.Mui-focusVisible'],
    ] as const) {
      const own = classes.map((cls) => `.${cls}${suffix}`);
      expect(
        own.some((sel) => css.includes(sel)),
        `${label}：需要行体自己的类名带出 ${suffix}`,
      ).toBe(true);
    }

    // 某个伪类下的全部声明：emotion 会把同一条规则拆进多个 style 标签（MUI 根样式与
    // sx 各插一份），所以要按「以本元素的类名 + 伪类开头」把所有片段收起来再断言，
    // 不能只取第一次出现的那段——第一段可能只有底色、没有描边。
    const declsFor = (suffix: string): string =>
      css
        .split('}\n')
        .filter((chunk) =>
          classes.some((cls) => chunk.includes(`.${cls}${suffix}`)),
        )
        .join(' ');
    const hoverDecls = declsFor(':hover');
    expect(hoverDecls, 'hover 状态层没读到').not.toBe('');
    expect(hoverDecls, 'hover 状态层必须有底色').toContain('background-color');
    // 键盘焦点用 primary 描边环，不能只靠 MUI 的涟漪（涟漪只在按下时出现）
    const focusDecls = declsFor('.Mui-focusVisible');
    expect(focusDecls, 'focus-visible 规则没读到').not.toBe('');
    expect(focusDecls, 'focus-visible 用 primary 描边环').toContain('outline:2px solid');
    expect(focusDecls, '描边的偏移量').toContain('outline-offset:2px');
    expect(focusDecls, '描边色取主题的 primary.main').toContain('#c56473');
    // 状态层时长必须来自 motion 契约的 state 档（160ms），不是 MUI 默认的 150ms
    expect(css, '状态层过渡时长取 motion 契约的 state 档').toContain(
      'transition:background-color 160ms cubic-bezier(0.4, 0, 0.2, 1)',
    );
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

  it('分类筛选 chip 的字号锁在契约字阶 label-12（12px），不再是 11px', async () => {
    const fetchMock = vi.fn(async () => json({ items: ITEMS }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter useTransitions={false}>
        <TasksPage />
      </MemoryRouter>,
    );
    await screen.findByText('重要任务');

    const chip = screen.getByText('全部').closest('.MuiChip-root') as HTMLElement;
    expect(chip).not.toBeNull();
    const rule = ownRules(allStyleText(), chip);
    expect(rule, '没读到 chip 自身的 css-* 规则，断言会空转').not.toBe('');
    // 11px（0.6875rem）不在 Rakko 的字阶上；12px 是 label-12，也是全站 chip 的统一字号。
    // 高度与圆角不在这里断言：它们分别由字号推出的行高与主题层的 MuiChip.root 决定。
    expect(rule, '筛选 chip 字号取 label-12（12px）').toContain('font-size:12px');
    expect(rule, '11px 不在契约字阶上，不许回退').not.toContain('font-size:0.6875rem');
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

describe('截止日标记的三档（逾期 / 今天 / 更远）', () => {
  /** today + n 天的 YYYY-MM-DD（与列表页读的是同一个「今天」） */
  function inDays(n: number): string {
    const t = new Date();
    const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() + n);
    const pad = (x: number) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /** 渲染四条任务：昨天 / 今天 / 一周后 / 远期到期，返回各自的截止日 Chip 根元素 */
  async function renderThree(): Promise<
    Record<'overdue' | 'today' | 'soon' | 'far', HTMLElement>
  > {
    const items: Item[] = [
      makeItem({ id: 11, title: '逾期的', due_date: inDays(-1) }),
      makeItem({ id: 14, title: '今天的', due_date: inDays(0) }),
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
    return {
      overdue: chipOf('逾期的'),
      today: chipOf('今天的'),
      soon: chipOf('快到期的'),
      far: chipOf('还早的'),
    };
  }

  it('逾期用实心语义 error：不再用主色（梅）表达「已经出事了」', async () => {
    const { overdue } = await renderThree();
    expect(overdue.className).toMatch(/MuiChip-colorError/);
    expect(overdue.className).toMatch(/MuiChip-filled/);
    expect(overdue.className).not.toMatch(/MuiChip-colorPrimary/);
  });

  it('今天到期用描边 warning：今天之内要处理，但还没出事', async () => {
    const { today } = await renderThree();
    expect(today.className).toMatch(/MuiChip-colorWarning/);
    expect(today.className).toMatch(/MuiChip-outlined/);
    expect(today.className).not.toMatch(/MuiChip-colorPrimary/);
  });

  it('窗口内但还没到今天的保持中性：警告不被常态化', async () => {
    const { soon } = await renderThree();
    expect(soon.className).toMatch(/MuiChip-colorDefault/);
    expect(soon.className).not.toMatch(/MuiChip-colorWarning/);
  });

  it('更远的截止日保持中性：不让所有带截止日的条目糊成一片语义色', async () => {
    const { far } = await renderThree();
    expect(far.className).toMatch(/MuiChip-colorDefault/);
    expect(far.className).not.toMatch(/MuiChip-colorPrimary/);
    expect(far.className).not.toMatch(/MuiChip-colorWarning/);
    expect(far.className).not.toMatch(/MuiChip-colorError/);
  });
});
