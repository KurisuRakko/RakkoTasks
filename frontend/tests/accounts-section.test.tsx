// AccountsSection 测试：设置页「邮箱账户」分区的展示与断点分流。
// 移动端点「添加邮箱」/账户卡片走路由页；桌面端（matchMedia 使 md 匹配）走 Dialog。
// 展示断言：账户卡片（名称/类型/上次同步）、待授权 Chip、AI 待处理行。fetchStatus mock。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import AccountsSection from '../src/components/accounts/AccountsSection';
import { ThemeModeProvider } from '../src/lib/theme-mode';
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
    <ThemeModeProvider>
      <ThemeProvider theme={createTheme()}>
        <MemoryRouter initialEntries={['/']} useTransitions={false}>
          <Routes>
            <Route path="/" element={<AccountsSection />} />
            <Route path="/settings/accounts/new" element={<div>添加邮箱页面</div>} />
            <Route path="/settings/accounts/:id" element={<div>账户详情页面</div>} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    </ThemeModeProvider>,
  );
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
