// api 客户端测试：PATCH item 与 search 的 URL / 方法 / body 正确，且带 Bearer 头。

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Api from '../src/lib/api';

let api: typeof Api;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeAll(async () => {
  // 与真实环境一致：同源 API、Phainon 外域
  vi.stubEnv('VITE_API_BASE_URL', '');
  vi.stubEnv('VITE_PHAINON_API_BASE', 'https://api.rakko.cn');
  api = await import('../src/lib/api');
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('phainon.access', 'test-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('patchItem', () => {
  it('PATCH /api/items/3，body {"status":"done"}，带 Bearer', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      json({ id: 3, status: 'done' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.patchItem(3, { status: 'done' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe('/api/items/3');
    expect(init?.method).toBe('PATCH');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
    expect(JSON.parse(String(init?.body))).toEqual({ status: 'done' });
  });
});

describe('search', () => {
  it('POST /api/search，body {"question":"…"}', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      json({ answer_md: '**回答**', citations: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.search('下周有什么截止？');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe('/api/search');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
    expect(JSON.parse(String(init?.body))).toEqual({ question: '下周有什么截止？' });
    expect(result.answer_md).toBe('**回答**');
  });
});

describe('fetchItems', () => {
  it('GET /api/items?status=open&category=工作', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => json([]));
    vi.stubGlobal('fetch', fetchMock);

    await api.fetchItems({ status: 'open', category: '工作' });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('/api/items?status=open&category=%E5%B7%A5%E4%BD%9C');
  });

  it('无筛选时不带查询参数', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => json([]));
    vi.stubGlobal('fetch', fetchMock);

    await api.fetchItems();

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('/api/items');
  });
});
