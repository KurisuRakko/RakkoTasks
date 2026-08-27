// phainon 登录客户端测试：exchange 落 token、错误 hash、401 刷新重放、单飞锁。

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Phainon from '../src/lib/phainon';

let phainon: typeof Phainon;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeAll(async () => {
  vi.stubEnv('VITE_PHAINON_API_BASE', 'https://api.rakko.cn');
  vi.stubEnv('VITE_PHAINON_APP_ID', 'rakkotasks');
  phainon = await import('../src/lib/phainon');
});

beforeEach(() => {
  localStorage.clear();
  // 清掉历史 hash，保证每个用例从干净的地址开始
  history.replaceState(null, '', '/');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('consumeCallback', () => {
  it('hash 带 login_code 时调用 exchange、token 落 localStorage、hash 被清', async () => {
    const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      if (String(url).includes('/exchange')) {
        return json({ access_token: 'at-1', refresh_token: 'rt-1' });
      }
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    window.location.hash = '#login_code=code-abc';
    await phainon.consumeCallback();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(String(url)).toBe('https://api.rakko.cn/auth/priestess/oidc/exchange');
    expect(JSON.parse(String(init?.body))).toEqual({ login_code: 'code-abc' });
    expect(localStorage.getItem('phainon.access')).toBe('at-1');
    expect(localStorage.getItem('phainon.refresh')).toBe('rt-1');
    expect(window.location.hash).toBe('');
  });

  it('hash 带 auth_error 时抛错且不调用 exchange、hash 被清', async () => {
    const fetchMock = vi.fn(async () => json({}));
    vi.stubGlobal('fetch', fetchMock);

    window.location.hash = '#auth_error=access_denied&auth_error_description=%E7%94%A8%E6%88%B7%E6%8B%92%E7%BB%9D';
    await expect(phainon.consumeCallback()).rejects.toThrow('用户拒绝');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.getItem('phainon.access')).toBeNull();
    expect(window.location.hash).toBe('');
  });

  it('hash 无 login_code 也无 error 时静默返回', async () => {
    const fetchMock = vi.fn(async () => json({}));
    vi.stubGlobal('fetch', fetchMock);
    await phainon.consumeCallback();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('authedFetch', () => {
  it('401 时刷新一次并重放请求', async () => {
    localStorage.setItem('phainon.access', 'at-old');
    localStorage.setItem('phainon.refresh', 'rt-old');

    let refreshCalls = 0;
    let apiCalls = 0;
    const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/refresh')) {
        refreshCalls += 1;
        return json({ access_token: 'at-new', refresh_token: 'rt-new' });
      }
      if (u.endsWith('/api/items/1')) {
        apiCalls += 1;
        if (apiCalls === 1) return json({ error: 'unauthorized' }, 401);
        return json({ id: 1, title: 't' }, 200);
      }
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await phainon.authedFetch('/api/items/1');

    expect(res.status).toBe(200);
    expect(refreshCalls).toBe(1);
    expect(apiCalls).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // 第一次与重放均带 Bearer；重放时用刷新后的新 token
    const authHeaders = fetchMock.mock.calls.map(
      (c) => (c[1]?.headers as Record<string, string> | undefined)?.Authorization,
    );
    expect(authHeaders).toContain('Bearer at-old');
    expect(authHeaders).toContain('Bearer at-new');
    // 刷新后 token 轮转落 localStorage
    expect(localStorage.getItem('phainon.access')).toBe('at-new');
    expect(localStorage.getItem('phainon.refresh')).toBe('rt-new');
  });

  it('两个并发 authedFetch 同时 401 时 refresh 只被调用一次（单飞锁）', async () => {
    localStorage.setItem('phainon.access', 'at-old');
    localStorage.setItem('phainon.refresh', 'rt-old');

    let refreshCalls = 0;
    // 每个业务 URL 首次调用 401，重放时 200；refresh 端点计数
    const apiCalls: Record<string, number> = {};
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/refresh')) {
        refreshCalls += 1;
        return json({ access_token: 'at-new', refresh_token: 'rt-new' });
      }
      if (u.includes('/api/')) {
        apiCalls[u] = (apiCalls[u] ?? 0) + 1;
        return apiCalls[u] === 1 ? json({ error: 'unauthorized' }, 401) : json({ ok: true }, 200);
      }
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    const [ra, rb] = await Promise.all([
      phainon.authedFetch('/api/a'),
      phainon.authedFetch('/api/b'),
    ]);

    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(apiCalls['/api/a']).toBe(2);
    expect(apiCalls['/api/b']).toBe(2);
    expect(refreshCalls).toBe(1);
  });
});
