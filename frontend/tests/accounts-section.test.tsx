// AccountsSection 测试：设置页「邮箱账户」分区的展示与断点分流。
// 移动端点「添加邮箱」/账户卡片走路由页；桌面端（matchMedia 使 md 匹配）走 Dialog。
// 展示断言：账户卡片（名称/类型/上次同步）、待授权 Chip、AI 待处理行。fetchStatus mock。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import AccountsSection from '../src/components/accounts/AccountsSection';
import accountsSectionSource from '../src/components/accounts/AccountsSection.tsx?raw';
import { MOTION } from '../src/rakko-tokens';
import { statusChipMeta } from '../src/components/accounts/meta';
import { AppThemeProvider, allStyleText } from './glass-text-contrast.test-utils';
import type { AccountInfo, StatusResponse } from '../src/types';

const api = vi.hoisted(() => ({ fetchStatusMock: vi.fn() }));

vi.mock('../src/lib/api', () => ({ fetchStatus: api.fetchStatusMock }));

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

const STATUS: StatusResponse = {
  accounts: [
    makeAccount({
      id: 2,
      name: 'Outlook',
      kind: 'microsoft',
      email: 'you@outlook.com',
      status: 'pending',
      has_credentials: false,
    }),
    makeAccount({ id: 1 }),
  ],
  pending_llm: 3,
};

/** 桌面端 stub：只有 md 断点查询（(min-width:900px)）返回 matches: true */
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

/** 默认移动端 stub（setup.ts 安装的永不匹配；桌面用例后由 afterEach 还原） */
const neverMatch = window.matchMedia;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.matchMedia = neverMatch;
});

/** 带路由出口的渲染：/ 上是分区本身，账户子页路径渲染占位内容以便断言跳转 */
function renderSection() {
  return render(
    <AppThemeProvider>
      <MemoryRouter initialEntries={['/']} useTransitions={false}>
        <Routes>
          <Route path="/" element={<AccountsSection />} />
          <Route path="/settings/accounts/new" element={<div>添加邮箱页面</div>} />
          <Route path="/settings/accounts/:id" element={<div>账户详情页面</div>} />
        </Routes>
      </MemoryRouter>
    </AppThemeProvider>,
  );
}

/** 状态 Chip 的元素：按文案定位后回到它的 MuiChip 根 */
function chipOf(label: string): HTMLElement {
  const chip = screen.getByText(label).closest('.MuiChip-root') as HTMLElement | null;
  expect(chip, `应能找到「${label}」状态芯片`).not.toBeNull();
  return chip!;
}

/** 芯片自己的 emotion 规则文本（MUI 的 color 类下在全局样式表里，这里取局部那条） */
function chipRule(chip: HTMLElement): string {
  const css = allStyleText();
  const own = Array.from(chip.classList).find((c) => c.startsWith('css-'));
  expect(own, '芯片应挂着自己的 emotion 类').toBeTruthy();
  const start = css.indexOf(`.${own}`);
  return start < 0 ? '' : css.slice(start, css.indexOf('}', start) + 1);
}

describe('AccountsSection 账户列表', () => {
  it('渲染账户卡片：类型与上次同步、待授权 Chip（pending 且无凭据）、AI 待处理行', async () => {
    api.fetchStatusMock.mockResolvedValue(STATUS);
    renderSection();

    // 两张卡片：名称 + 邮箱 + 类型行 + Chip
    expect(await screen.findByText('Outlook')).toBeTruthy();
    expect(screen.getByText('you@outlook.com')).toBeTruthy();
    expect(screen.getByText(/Outlook · 上次同步：从未/)).toBeTruthy();
    // pending 且没有凭据 → 待授权（warning）
    expect(screen.getByText('待授权')).toBeTruthy();
    // ok 账户 → 正常
    expect(screen.getByText('正常')).toBeTruthy();
    // 底部 AI 待处理行
    expect(screen.getByText('AI 待处理 3 封')).toBeTruthy();
  });

  it('移动端：点「添加邮箱」去 /settings/accounts/new，点卡片去 /settings/accounts/:id', async () => {
    api.fetchStatusMock.mockResolvedValue(STATUS);
    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: '添加邮箱' }));
    expect(await screen.findByText('添加邮箱页面')).toBeTruthy();
    expect(api.fetchStatusMock).toHaveBeenCalledTimes(1);
  });

  it('移动端：点账户卡片去 /settings/accounts/:id', async () => {
    api.fetchStatusMock.mockResolvedValue(STATUS);
    renderSection();

    // 点卡片主体（卡片整块可点）进入该账户详情路由
    fireEvent.click(await screen.findByText('Outlook'));
    expect(await screen.findByText('账户详情页面')).toBeTruthy();
  });
});

describe('AccountsSection 桌面端 Dialog', () => {
  it('桌面态点「添加邮箱」打开 Dialog（内容为添加向导），关闭后重新 fetchStatus', async () => {
    installDesktopMedia();
    api.fetchStatusMock.mockResolvedValue(STATUS);
    renderSection();

    await screen.findByText('Outlook');
    fireEvent.click(screen.getByRole('button', { name: '添加邮箱' }));

    // 同一个 Dialog：向导标题可读、可选类型卡片在对话框里
    expect(await screen.findByRole('dialog', { name: '添加邮箱账户' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Gmail' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Outlook · Microsoft 365' })).toBeTruthy();

    // 关闭后回到列表并重新拉一次状态
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(api.fetchStatusMock).toHaveBeenCalledTimes(2));
  });
});

describe('AccountsSection 已停用账户', () => {
  it('enabled=false 时账户行显示「已停用」Chip，且变暗走 filter 而非 opacity', async () => {
    api.fetchStatusMock.mockResolvedValue({
      accounts: [makeAccount({ enabled: false })],
      pending_llm: 0,
    } satisfies StatusResponse);
    renderSection();

    const chip = await screen.findByText('已停用');
    expect(screen.queryByText('同步中')).toBeNull();

    // 行本体挂 data-account-row：变暗与入场动画都落在它身上
    const row = chip.closest('[data-account-row]') as HTMLElement | null;
    expect(row).not.toBeNull();
    const styles = getComputedStyle(row!);
    // 变暗必须走 filter：退回旧的 opacity 写法时，opacity 计算值为 '0.6' 且
    // filter 不含 opacity(0.6)，两条断言都会失败
    expect(styles.filter).toContain('opacity(0.6)');
    // jsdom 对未声明的属性返回空串（浏览器中为 '1'）——这里断言不能是 '0.6'，
    // 即变暗不允许落在 opacity 属性上
    expect(styles.opacity).not.toBe('0.6');
  });

  it('账户行不再套 outlined 卡片：分区玻璃之上没有第二层框', async () => {
    api.fetchStatusMock.mockResolvedValue(STATUS);
    const { container } = renderSection();
    await screen.findByText('Outlook');
    // 外层分区已是玻璃面板，行再挂 MuiCard 就是两层框
    expect(container.querySelector('.MuiCard-root')).toBeNull();
    expect(container.querySelectorAll('[data-account-row]').length).toBe(STATUS.accounts.length);
  });
});

describe('AccountsSection 桌面 Dialog 的入退场', () => {
  /** 让 supportsViewTransitions() 为真：dialogTransitionProps() 正是在这种浏览器上把过渡清零的 */
  function withViewTransitions(): () => void {
    // jsdom 默认没有这个 API，与 dialog-transition.test.tsx 同一套 stub / 还原口径
    (document as { startViewTransition?: unknown }).startViewTransition = vi.fn();
    return () => {
      delete (document as { startViewTransition?: unknown }).startViewTransition;
    };
  }

  it('支持 View Transitions 的浏览器上关闭仍有真实退场：内容不是瞬间消失', async () => {
    const restore = withViewTransitions();
    vi.useFakeTimers();
    try {
      installDesktopMedia();
      api.fetchStatusMock.mockResolvedValue(STATUS);
      renderSection();
      await vi.waitFor(() => expect(screen.getByText('Outlook')).toBeTruthy());

      fireEvent.click(screen.getByRole('button', { name: '添加邮箱' }));
      await vi.waitFor(() => expect(screen.getByText('添加邮箱账户')).toBeTruthy());

      fireEvent.click(screen.getByRole('button', { name: '关闭' }));
      // 退场刚跑到一半：内容还在，用户看得到它往下滑。
      // dialogTransitionProps() 会把时长设成 0 去给一个不会发生的 VT 让位，
      // 那样这里内容已经没了 —— 开关都是瞬切。
      await act(async () => {
        vi.advanceTimersByTime(Math.floor(MOTION.largeExit / 2));
      });
      expect(screen.queryByText('添加邮箱账户')).not.toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(MOTION.largeExit + 50);
      });
      expect(screen.queryByText('添加邮箱账户')).toBeNull();
    } finally {
      vi.useRealTimers();
      restore();
    }
  });

  it('退场途中再点一次关闭：内容不被抹掉，退场照常跑完', async () => {
    vi.useFakeTimers();
    try {
      installDesktopMedia();
      api.fetchStatusMock.mockResolvedValue(STATUS);
      renderSection();
      await vi.waitFor(() => expect(screen.getByText('Outlook')).toBeTruthy());

      fireEvent.click(screen.getByRole('button', { name: '添加邮箱' }));
      await vi.waitFor(() => expect(screen.getByText('添加邮箱账户')).toBeTruthy());

      // 退场期间内容仍然挂着、关闭按钮也还能点——第二次点不该把正在退场的内容抹掉
      fireEvent.click(screen.getByRole('button', { name: '关闭' }));
      await act(async () => {
        vi.advanceTimersByTime(Math.floor(MOTION.largeExit / 3));
      });
      fireEvent.click(screen.getByRole('button', { name: '关闭' }));
      await act(async () => {
        vi.advanceTimersByTime(Math.floor(MOTION.largeExit / 3));
      });
      expect(screen.queryByText('添加邮箱账户')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('源码不再用 dialogTransitionProps：那是给容器变换出来的对话框用的', () => {
    expect(accountsSectionSource).not.toContain('{...dialogTransitionProps()}');
    expect(accountsSectionSource).toContain('TransitionComponent={SlideUp}');
  });
});

describe('AccountsSection 状态语义色', () => {
  /** 五态 → 颜色名的一张表：文案由 meta 给，颜色是本组要钉死的设计决定 */
  const CASES: readonly {
    name: string;
    account: Partial<AccountInfo>;
    label: string;
    color: string;
  }[] = [
    { name: '正常', account: { status: 'ok' }, label: '正常', color: 'success' },
    { name: '出错', account: { status: 'error' }, label: '出错', color: 'error' },
    {
      name: '有凭据待同步',
      account: { status: 'pending', has_credentials: true },
      label: '等待首次同步',
      color: 'info',
    },
    {
      name: '无凭据待授权',
      account: { status: 'pending', has_credentials: false },
      label: '待授权',
      color: 'warning',
    },
    { name: '已停用', account: { enabled: false }, label: '已停用', color: 'default' },
  ];

  it.each(CASES)('$name → $label / MuiChip-color$color（outlined 小芯片）', async (c) => {
    api.fetchStatusMock.mockResolvedValue({
      accounts: [makeAccount(c.account)],
      pending_llm: 0,
    } satisfies StatusResponse);
    renderSection();
    await screen.findByText('Gmail');

    const chip = chipOf(c.label);
    // 五种状态统一用一种零件：outlined + size small
    expect(chip.className).toMatch(/MuiChip-outlined\b/);
    expect(chip.className).toMatch(/MuiChip-sizeSmall/);
    expect(chip.className).toContain(`MuiChip-color${c.color[0].toUpperCase()}${c.color.slice(1)}`);
    // 未选中的芯片不铺纸：它坐在玻璃面板上
    expect(chipRule(chip)).toContain('background-color:transparent');
    // 文案映射与 meta 单一来源一致（改一处不会与另一处漂移）
    expect(statusChipMeta(makeAccount(c.account))).toEqual({ label: c.label, color: c.color });
  });

  it('「等首次同步」用语义色 info，不再是中性色：中性色只留给「已停用」', async () => {
    api.fetchStatusMock.mockResolvedValue({
      accounts: [makeAccount({ status: 'pending', has_credentials: true })],
      pending_llm: 0,
    } satisfies StatusResponse);
    renderSection();
    await screen.findByText('Gmail');

    const chip = chipOf('等待首次同步');
    expect(chip.className).not.toMatch(/MuiChip-colorDefault/);
    expect(statusChipMeta(makeAccount({ status: 'pending', has_credentials: true })).color).toBe('info');
  });
});

describe('AccountsSection 行结构与桌面 Dialog 玻璃', () => {
  it('账户行用与设置页同一套行形状：最小高度 48px、左右 8px、相邻行一条 inset 伪元素发丝线', async () => {
    api.fetchStatusMock.mockResolvedValue(STATUS);
    const { container } = renderSection();
    await screen.findByText('Outlook');

    const rows = Array.from(container.querySelectorAll('[data-setting-row]')) as HTMLElement[];
    expect(rows).toHaveLength(STATUS.accounts.length);
    for (const row of rows) {
      const cs = getComputedStyle(row);
      expect(cs.minHeight).toBe('48px');
      expect(cs.paddingLeft).toBe('8px');
      expect(cs.alignItems).toBe('center');
    }
    // 分隔线由 `& + &::before` 的伪元素画：行自己不带 border，也就没有
    // 「首行上方 / 末行下方多一条线」的边界特判，线的左端由伪元素的 left 定位而不是
    // 给相邻行补内边距。jsdom 的 getComputedStyle 不在每个 ButtonBase 包装层内部
    // 解析兄弟选择器，所以这里断言的是规则本身在位。
    expect(accountsSectionSource).toContain('rowSeparatorSx');
  });

  it('账户行与它的错误行之间没有分隔线：错误行是行内追加信息，不是第二个设置行', async () => {
    api.fetchStatusMock.mockResolvedValue({
      accounts: [
        makeAccount({ id: 1, name: 'Gmail', status: 'error', last_error: '同步失败：凭据已失效' }),
        makeAccount({ id: 2, name: 'Outlook', kind: 'microsoft', email: 'you@outlook.com' }),
      ],
      pending_llm: 0,
    } satisfies StatusResponse);
    const { container } = renderSection();
    await screen.findByText('Outlook');

    const rows = Array.from(container.querySelectorAll('[data-setting-row]')) as HTMLElement[];
    // 两个账户各自一个设置行；错误行不是设置行，所以不会把两条账户行之间的线顶掉、
    // 也不会给自己拉一条线（旧写法 `& + &` 会落在错误行上，第一条账户行反而多一条线）
    expect(rows).toHaveLength(2);
    const error = screen.getByText('同步失败：凭据已失效');
    expect(error.closest('[data-setting-row]')).toBeNull();
    expect(getComputedStyle(error).paddingLeft).toBe('52px');
  });

  it('「添加邮箱」是这一分区的主操作：contained', async () => {
    api.fetchStatusMock.mockResolvedValue(STATUS);
    renderSection();
    const add = await screen.findByRole('button', { name: '添加邮箱' });
    expect(add.className).toMatch(/MuiButton-contained/);
    expect(add.className).not.toMatch(/MuiButton-outlined/);
  });

  it('桌面 Dialog 的纸面挂 data-glass="panel"：与移动端 AccountPages 的面板同一档材质', async () => {
    installDesktopMedia();
    api.fetchStatusMock.mockResolvedValue(STATUS);
    renderSection();

    await screen.findByText('Outlook');
    fireEvent.click(screen.getByRole('button', { name: '添加邮箱' }));

    const dialog = await screen.findByRole('dialog', { name: '添加邮箱账户' });
    // role=dialog 的节点就是 paper 本身；材质从配方取，局部 sx 只做「覆盖也要带回内唇」
    expect(dialog.getAttribute('data-glass')).toBe('panel');
    const css = allStyleText();
    expect(css).toContain('[data-glass="panel"]');
    expect(css).toContain('var(--glass-lip)');
    expect(css).toContain('var(--glass-rim-inner)');
  });
});

describe('AccountsSection 待处理计数', () => {
  it('AI 待处理为 0 时不占一行', async () => {
    api.fetchStatusMock.mockResolvedValue({
      accounts: [makeAccount({})],
      pending_llm: 0,
    } satisfies StatusResponse);
    renderSection();

    await screen.findByText('Gmail');
    expect(screen.queryByText(/AI 待处理/)).toBeNull();
  });

  it('AI 待处理大于 0 时照常显示', async () => {
    api.fetchStatusMock.mockResolvedValue({
      accounts: [makeAccount({})],
      pending_llm: 4,
    } satisfies StatusResponse);
    renderSection();

    expect(await screen.findByText('AI 待处理 4 封')).toBeTruthy();
  });
});
