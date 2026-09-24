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

describe('parseTask', () => {
  it('POST /api/items/parse，body {text, today, tz}，tz = 浏览器 IANA 时区', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      json({
        title: '修空调',
        summary: '',
        category: '个人',
        due_date: '2026-08-05',
        importance: 'normal',
        actionable: true,
        reminders: [],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.parseTask('明天修空调', '2026-08-05');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe('/api/items/parse');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
    expect(JSON.parse(String(init?.body))).toEqual({
      text: '明天修空调',
      today: '2026-08-05',
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });

  it('状态码不是 200 → 抛错（回归）', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      json({ error: 'boom' }, 500),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.parseTask('x', '2026-08-05')).rejects.toThrow('HTTP 500');
  });
});

describe('quickAddTask', () => {
  it('POST /api/items/quick，body {text, today, tz}，tz = 浏览器 IANA 时区', async () => {
    const item = {
      id: 1,
      email_id: null,
      email_sent_at: null,
      title: '修空调',
      summary: '',
      category: '个人',
      due_date: '2026-08-05',
      importance: 'normal',
      actionable: true,
      status: 'open',
      detail_md: null,
      related: [],
      reminders: [],
      created_at: '2026-08-01T00:00:00Z',
      done_at: null,
    };
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      json({ item, ai_parsed: true }, 201),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.quickAddTask('修空调', '2026-08-05');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe('/api/items/quick');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
    expect(JSON.parse(String(init?.body))).toEqual({
      text: '修空调',
      today: '2026-08-05',
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    expect(result.ai_parsed).toBe(true);
  });

  it('状态码不是 201 → 抛错（回归）', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      json({ error: 'boom' }, 500),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.quickAddTask('x', '2026-08-05')).rejects.toThrow('HTTP 500');
  });
});

// 同步接口的路径 / 方法 / 期望状态码是前后端共同遵守的契约，这里逐条钉住：
// 后端换路径或改掉 trigger 的成功码，这几条会先红。
describe('fetchSyncStatus', () => {
  it('GET /api/sync/status，带 Bearer，原样返回 current / last / pending_request', async () => {
    const status = { current: null, last: null, pending_request: false };
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => json(status));
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.fetchSyncStatus();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe('/api/sync/status');
    expect(init?.method ?? 'GET').toBe('GET');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
    expect(result).toEqual(status);
  });

  it('非 2xx → 抛错', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      json({ error: 'boom' }, 500),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.fetchSyncStatus()).rejects.toThrow('HTTP 500');
  });
});

describe('triggerSync', () => {
  it('POST /api/sync/trigger，空请求体，202 时返回 {accepted, already_running}', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      json({ accepted: true, already_running: true }, 202),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.triggerSync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe('/api/sync/trigger');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
    expect(result).toEqual({ accepted: true, already_running: true });
  });

  it('状态码不是 202 → 抛错', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      json({ error: 'boom' }, 500),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.triggerSync()).rejects.toThrow('HTTP 500');
  });
});
