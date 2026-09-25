// 邮箱账户移动端路由页测试：页面容器（玻璃面板 + 底栏留白）、数据源、找不到账户时的重定向。
// 这三页只在移动端渲染（桌面走 Dialog），所以全程用默认的「matchMedia 永不匹配」stub。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AccountDetailPage, AccountNewPage, AccountRemovePage } from '../src/pages/AccountPages';
import accountsSectionSource from '../src/components/accounts/AccountsSection.tsx?raw';
import { ThemeModeProvider } from '../src/lib/theme-mode';
import type { AccountInfo } from '../src/types';
import { allStyleText, ruleTextOf } from './glass-text-contrast.test-utils';

const api = vi.hoisted(() => ({
  fetchAccountsMock: vi.fn(),
  fetchStatusMock: vi.fn(),
  patchAccountMock: vi.fn(),
  deleteAccountMock: vi.fn(),
  createAccountMock: vi.fn(),
  requestMsAuthUrlMock: vi.fn(),
  submitMsAuthCodeMock: vi.fn(),
}));

vi.mock('../src/lib/api', () => ({
  fetchAccounts: api.fetchAccountsMock,
  fetchStatus: api.fetchStatusMock,
  patchAccount: api.patchAccountMock,
  deleteAccount: api.deleteAccountMock,
  createAccount: api.createAccountMock,
  requestMsAuthUrl: api.requestMsAuthUrlMock,
  submitMsAuthCode: api.submitMsAuthCodeMock,
}));

function makeAccount(partial: Partial<AccountInfo> = {}): AccountInfo {
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** 挂三条账户路由 + 一个 /settings 占位页，用于断言重定向确实落到设置页 */
function renderAt(initial: string) {
  return render(
    <ThemeModeProvider>
      <ThemeProvider theme={createTheme()}>
        <MemoryRouter initialEntries={[initial]} useTransitions={false}>
          <Routes>
            <Route path="/settings" element={<div>设置页占位</div>} />
            <Route path="/settings/accounts/new" element={<AccountNewPage />} />
            <Route path="/settings/accounts/:id" element={<AccountDetailPage />} />
            <Route path="/settings/accounts/:id/remove" element={<AccountRemovePage />} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    </ThemeModeProvider>,
  );
}

describe('账户路由页的页面容器', () => {
  it('底部留白给固定底栏让位：用 calc + env(safe-area-inset-bottom)，不是原来的 32px', async () => {
    api.fetchAccountsMock.mockResolvedValue([makeAccount()]);
    const { container } = renderAt('/settings/accounts/1');
    await screen.findByLabelText('名称');

    const shell = container.firstElementChild as HTMLElement;
    const paddingBottom = getComputedStyle(shell).paddingBottom;
    // 底栏是 position: fixed 的，页面不留出这段就会把最下面的动作按钮压在底栏底下
    expect(paddingBottom).toContain('env(safe-area-inset-bottom)');
    expect(paddingBottom).not.toBe('32px');
  });

  it('三个页面的内容都坐在恰好一块 data-glass="panel" 玻璃面板上', async () => {
    api.fetchAccountsMock.mockResolvedValue([makeAccount()]);

    const detail = renderAt('/settings/accounts/1');
    await screen.findByLabelText('名称');
    expect(detail.container.querySelectorAll('[data-glass="panel"]')).toHaveLength(1);
    expect(detail.container.querySelector('[data-glass="panel"]')?.textContent).toContain('移除账户');
    cleanup();

    const remove = renderAt('/settings/accounts/1/remove');
    await screen.findByText('移除账户');
    expect(remove.container.querySelectorAll('[data-glass="panel"]')).toHaveLength(1);
    cleanup();

    const add = renderAt('/settings/accounts/new');
    await screen.findByText('添加邮箱账户');
    const panels = add.container.querySelectorAll('[data-glass="panel"]');
    expect(panels).toHaveLength(1);
    expect(panels[0].textContent).toContain('添加邮箱账户');
  });

  it('玻璃面板不下发 background：材质归 data-glass 配方，局部 sx 覆盖会盖掉它', async () => {
    api.fetchAccountsMock.mockResolvedValue([makeAccount()]);
    const { container } = renderAt('/settings/accounts/1');
    await screen.findByLabelText('名称');

    // jsdom 的 computed 背景恒为 rgba(0,0,0,0)（配方在 rakko-glass.css，测试环境不加载），
    // 所以断言的是面板自己那条 emotion 规则里没有 background 声明
    const panel = container.querySelector('[data-glass="panel"]') as HTMLElement;
    const rule = ruleTextOf(allStyleText(), panel);
    expect(rule, '面板应有自己的 emotion 规则（圆角与内边距）').toContain('border-radius');
    expect(rule).not.toContain('background');
  });
});

describe('账户路由页与桌面 Dialog 的材质一致', () => {
  it('移动端页面容器的 panel 配方与桌面 Dialog 纸面挂的是同一个 data-glass 值', async () => {
    api.fetchAccountsMock.mockResolvedValue([makeAccount()]);
    const { container } = renderAt('/settings/accounts/1');
    await screen.findByLabelText('名称');

    expect(container.querySelector('[data-glass="panel"]')).not.toBeNull();
    // AccountsSection 的桌面 Dialog 用同一个值（同一份内容不该因断点换材质）；
    // 覆盖玻璃背景时必须写成 &[data-glass="panel"] 并带回 inset 内唇
    expect(accountsSectionSource).toContain("'data-glass': 'panel'");
    expect(accountsSectionSource).toContain('dialogPanelGlassSx');
  });
});

describe('账户路由页的数据源与重定向', () => {
  it('详情页走 GET /api/accounts，不再借 /api/status 顺带把 pending_llm 拉回来', async () => {
    api.fetchAccountsMock.mockResolvedValue([makeAccount({ id: 7, name: '工作邮箱' })]);
    renderAt('/settings/accounts/7');

    await screen.findByLabelText('名称');
    expect(api.fetchAccountsMock).toHaveBeenCalledTimes(1);
    expect(api.fetchStatusMock).not.toHaveBeenCalled();
  });

  it('账户不在列表里（已删 / 越权）：重定向回设置页', async () => {
    api.fetchAccountsMock.mockResolvedValue([makeAccount({ id: 1 })]);
    renderAt('/settings/accounts/999');

    expect(await screen.findByText('设置页占位')).toBeTruthy();
  });

  it('id 不是数字：不发请求，直接重定向回设置页', async () => {
    api.fetchAccountsMock.mockResolvedValue([makeAccount()]);
    renderAt('/settings/accounts/abc');

    expect(await screen.findByText('设置页占位')).toBeTruthy();
    expect(api.fetchAccountsMock).not.toHaveBeenCalled();
  });

  it('加载失败：错误 Alert 同样坐在玻璃面板上，不裸在壁纸上', async () => {
    api.fetchAccountsMock.mockRejectedValue(new Error('boom'));
    const { container } = renderAt('/settings/accounts/1');

    await screen.findByText('加载账户失败');
    const panel = container.querySelector('[data-glass="panel"]');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('加载账户失败');
    await waitFor(() =>
      expect(getComputedStyle(container.firstElementChild as HTMLElement).paddingBottom).toContain(
        'env(safe-area-inset-bottom)',
      ),
    );
  });
});
