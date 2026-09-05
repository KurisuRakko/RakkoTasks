// SettingsPage 测试：已停用账户的变暗必须由 filter 实现，不能靠 opacity——
// 入场动画 animation-fill-mode: both 会把关键帧终态 opacity: 1 保持在元素上
// （动画值优先级高于普通声明），静态 opacity 声明会被压掉、变暗失效。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
      // CalDAV 分支写在日历分支之前（/api/caldav 与 /api/calendar 互不包含，顺序仅为将来防误伤）
      if (u.includes('/api/caldav')) {
        return json({ username: 'you@gmail.com', path: '/caldav/', configured: false });
      }
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

describe('SettingsPage 提醒事项同步', () => {
  const DAV = { username: 'a@x.com', path: '/caldav/', configured: false };

  function makeFetchMock(dav: unknown): ReturnType<typeof vi.fn> {
    return vi.fn(async (url: string | URL) => {
      const u = String(url);
      // CalDAV 分支写在日历分支之前（/api/caldav 与 /api/calendar 互不包含，顺序仅为将来防误伤）
      if (u.includes('/api/caldav/password')) return json({ password: 'p'.repeat(32) });
      if (u.includes('/api/caldav')) return json(dav);
      if (u.includes('/api/calendar')) return json({ token: 'abc' });
      return json(STATUS);
    });
  }

  it('configured=false 时出现「生成同步密码」按钮，无「同步密码」输入框，用户名显示 a@x.com', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ ...DAV, configured: false }));

    render(
      <ThemeModeProvider>
        <SettingsPage />
      </ThemeModeProvider>,
    );

    expect(await screen.findByRole('button', { name: '生成同步密码' })).toBeTruthy();
    expect(screen.queryByLabelText('同步密码')).toBeNull();
    const user = (await screen.findByLabelText('用户名')) as HTMLInputElement;
    expect(user.value).toBe('a@x.com');
  });

  it('点击生成只发一次 POST，随后出现 32 位同步密码与「只显示一次」告警', async () => {
    const fetchMock = makeFetchMock({ ...DAV, configured: false });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ThemeModeProvider>
        <SettingsPage />
      </ThemeModeProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: '生成同步密码' }));

    const pw = (await screen.findByLabelText('同步密码')) as HTMLInputElement;
    expect(pw.value).toBe('p'.repeat(32));
    expect(screen.getByText(/只显示一次/)).toBeTruthy();
    expect(screen.getByText('已生成')).toBeTruthy();
    // 生成成功后按钮区切换为「重新生成密码」，不再出现「生成同步密码」
    expect(screen.queryByRole('button', { name: '生成同步密码' })).toBeNull();
    expect(screen.queryByRole('button', { name: '重新生成密码' })).not.toBeNull();
    const postCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/caldav/password'));
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0][1]?.method).toBe('POST');
  });

  it('configured=true 时出现「重新生成密码」，不出现「生成同步密码」，页面文本不含 32 个 p', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ ...DAV, configured: true }));

    render(
      <ThemeModeProvider>
        <SettingsPage />
      </ThemeModeProvider>,
    );

    expect(await screen.findByRole('button', { name: '重新生成密码' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '生成同步密码' })).toBeNull();
    expect(screen.queryByLabelText('同步密码')).toBeNull();
    expect(document.body.textContent ?? '').not.toContain('p'.repeat(32));
  });

  it('/api/caldav 返回 500 时出现失败告警，「日历订阅」分区不受影响', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/api/caldav')) return new Response('oops', { status: 500 });
      if (u.includes('/api/calendar')) return json({ token: 'abc' });
      return json(STATUS);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ThemeModeProvider>
        <SettingsPage />
      </ThemeModeProvider>,
    );

    expect(await screen.findByText('加载提醒事项同步配置失败')).toBeTruthy();
    const link = (await screen.findByLabelText('订阅链接')) as HTMLInputElement;
    expect(link.value.endsWith('/api/calendar/abc.ics')).toBe(true);
  });
});
