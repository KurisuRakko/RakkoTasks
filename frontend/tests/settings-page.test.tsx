// SettingsPage 测试：已停用账户的变暗必须由 filter 实现，不能靠 opacity——
// 入场动画 animation-fill-mode: both 会把关键帧终态 opacity: 1 保持在元素上
// （动画值优先级高于普通声明），静态 opacity 声明会被压掉、变暗失效。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import SettingsPage from '../src/pages/SettingsPage';
import { ThemeModeProvider } from '../src/lib/theme-mode';
import type { StatusResponse } from '../src/types';

const STATUS: StatusResponse = {
  accounts: [
    {
      id: 1,
      name: 'Gmail',
      kind: 'gmail',
      email: 'you@gmail.com',
      status: 'error',
      enabled: false,
      last_sync_at: null,
      last_error: '停用前同步出错',
    },
  ],
  pending_llm: 0,
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SettingsPage 已停用账户', () => {
  it('enabled=false 时卡片显示「已停用」Chip，且变暗走 filter 而非 opacity', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(STATUS)));
    const { container } = render(
      <ThemeModeProvider>
        <SettingsPage />
      </ThemeModeProvider>,
    );

    expect(await screen.findByText('已停用')).toBeTruthy();
    expect(screen.queryByText('同步中')).toBeNull();

    const card = container.querySelector('.MuiCard-root');
    expect(card).not.toBeNull();
    const styles = getComputedStyle(card!);
    // 变暗必须走 filter：退回旧的 opacity 写法时，opacity 计算值为 '0.6' 且
    // filter 不含 opacity(0.6)，两条断言都会失败
    expect(styles.filter).toContain('opacity(0.6)');
    // jsdom 对未声明的属性返回空串（浏览器中为 '1'）——这里断言不能是 '0.6'，
    // 即变暗不允许落在 opacity 属性上
    expect(styles.opacity).not.toBe('0.6');
  });
});

describe('SettingsPage 日历订阅', () => {
  function makeFetchMock(): ReturnType<typeof vi.fn> {
    return vi.fn(async (url: string | URL) => {
      const u = String(url);
      // GET /api/calendar 返回令牌；其余请求按账户状态处理
      if (u.includes('/api/calendar')) return json({ token: 'abc' });
      return json(STATUS);
    });
  }

  it('fetch 返回令牌时展示订阅链接输入框，值以 /api/calendar/abc.ics 结尾', async () => {
    vi.stubGlobal('fetch', makeFetchMock());

    render(
      <ThemeModeProvider>
        <SettingsPage />
      </ThemeModeProvider>,
    );

    const input = (await screen.findByLabelText('订阅链接')) as HTMLInputElement;
    expect(input.value.endsWith('/api/calendar/abc.ics')).toBe(true);
  });

  it('「在 iPhone 上订阅」是 webcal:// 开头的链接', async () => {
    vi.stubGlobal('fetch', makeFetchMock());

    render(
      <ThemeModeProvider>
        <SettingsPage />
      </ThemeModeProvider>,
    );

    const link = await screen.findByRole('link', { name: '在 iPhone 上订阅' });
    expect(link.getAttribute('href')).toMatch(/^webcal:\/\//);
  });
});
