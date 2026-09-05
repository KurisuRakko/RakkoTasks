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
  it('GET /api/items?status=open&category=工作，解析 {"items":[...]} 信封返回数组本身', async () => {
    const item = {
      id: 1,
      email_id: 2,
      email_sent_at: null,
      title: '写周报',
      summary: null,
      category: '工作',
      due_date: null,
      actionable: true,
      status: 'open',
      detail_md: null,
      created_at: '2026-08-01T00:00:00Z',
      done_at: null,
    };
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      json({ items: [item] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.fetchItems({ status: 'open', category: '工作' });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('/api/items?status=open&category=%E5%B7%A5%E4%BD%9C');
    // 信封解包：返回的是数组本身，可直接迭代
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('写周报');
  });

  it('空信封时返回空数组', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      json({ items: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.fetchItems();

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('/api/items');
    expect(result).toEqual([]);
  });
});

describe('fetchCaldavInfo', () => {
  it('GET /api/caldav，带 Bearer，解析 username/path/configured 三字段', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      json({ username: 'a@x.com', path: '/caldav/', configured: false }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.fetchCaldavInfo();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe('/api/caldav');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
    expect(result.username).toBe('a@x.com');
    expect(result.path).toBe('/caldav/');
    expect(result.configured).toBe(false);
  });
});

describe('generateCaldavPassword', () => {
  it('POST /api/caldav/password，带 Bearer，返回 data.password', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      json({ password: 'p'.repeat(32) }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.generateCaldavPassword();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe('/api/caldav/password');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
    expect(result).toBe('p'.repeat(32));
  });
});

describe('caldavTarget', () => {
  it('API_BASE_URL 为空时 host 取 window.location.host，url 以 /caldav/ 结尾', () => {
    const target = api.caldavTarget('/caldav/');
    expect(target.host).toBe(window.location.host);
    expect(target.url).toBe(`${window.location.origin}/caldav/`);
  });
});
