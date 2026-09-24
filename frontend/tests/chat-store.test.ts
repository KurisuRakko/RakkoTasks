// chat store（模块级聊天状态）测试：历史截断、发送/失败回滚、重置语义、
// 以及写操作回执同步进列表缓存的口径。
// 状态只能经 hook 读（模块级变量不对外暴露），所以用 renderHook 取一份切片快照。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import {
  GENERIC_MESSAGE,
  HISTORY_ASSISTANT_CHARS,
  HISTORY_LIMIT,
  RATE_LIMITED_MESSAGE,
  TIMEOUT_MESSAGE,
  buildHistory,
  resetChat,
  sendMessage,
  setDraft,
  syncListCache,
  useChatDraft,
  useChatError,
  useChatPending,
  useChatTurns,
} from '../src/lib/chat';
import type { ChatTurn } from '../src/lib/chat';
import { DONE_KEY, openKey, readList, resetLists, writeList } from '../src/lib/list-cache';
import type { ChatAction, EmailCitation, Item } from '../src/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 当前聊天状态的一份切片快照；每次状态变化由 store 通知重渲 */
function chatState() {
  return renderHook(() => ({
    turns: useChatTurns(),
    draft: useChatDraft(),
    pending: useChatPending(),
    error: useChatError(),
  }));
}

function assistantTurn(id: number, content = '回答'): ChatTurn {
  return { id, role: 'assistant', content, citations: [], actions: [] };
}

const CITATION: EmailCitation = {
  email_id: 7,
  subject: '发票邮件',
  sent_at: '2026-09-20T01:02:03',
};

function makeItem(partial: Partial<Item>): Item {
  return {
    id: 1,
    email_id: null,
    email_sent_at: null,
    title: '交电费',
    summary: null,
    category: '账单',
    due_date: null,
    importance: 'normal',
    actionable: true,
    status: 'open',
    detail_md: null,
    related: [],
    reminders: [],
    created_at: '2026-09-01T00:00:00Z',
    done_at: null,
    ...partial,
  };
}

function action(kind: ChatAction['kind'], item: Item, fields: ChatAction['fields'] = []): ChatAction {
  return { kind, item, fields };
}

/** 一个可手动放行的 fetch：请求停在 await 上，用例自己决定什么时候返回 */
function deferredFetch(): { mock: ReturnType<typeof vi.fn>; release: (r: Response) => void } {
  let resolve!: (r: Response) => void;
  const mock = vi.fn(() => new Promise<Response>((res) => { resolve = res; }));
  // 转发一层而不是直接返回 resolve：它要到 mock 被调用时才被赋值
  return { mock, release: (r: Response) => resolve(r) };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('phainon.access', 'test-token');
  resetChat();
  setDraft('');
  resetLists();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('buildHistory', () => {
  it('至多取 HISTORY_LIMIT 条，且丢掉开头的 assistant 直到第一条 user', () => {
    const turns: ChatTurn[] = [];
    for (let i = 0; i < 16; i += 1) {
      turns.push(
        i % 2 === 0
          ? assistantTurn(i, `a${i}`)
          : { id: i, role: 'user', content: `u${i}` },
      );
    }

    const history = buildHistory(turns);

    expect(history.length).toBeLessThanOrEqual(HISTORY_LIMIT);
    expect(history[0]).toEqual({ role: 'user', content: 'u5' });
    expect(history[history.length - 1]).toEqual({ role: 'user', content: 'u15' });
  });

  it('切片里一条 user 都没有时返回空数组', () => {
    expect(buildHistory([assistantTurn(1), assistantTurn(2)])).toEqual([]);
  });

  it('助理内容截到 HISTORY_ASSISTANT_CHARS，用户内容原样', () => {
    const long = 'x'.repeat(HISTORY_ASSISTANT_CHARS + 120);
    const history = buildHistory([
      { id: 1, role: 'user', content: long },
      assistantTurn(2, long),
    ]);

    expect(history[0]).toEqual({ role: 'user', content: long });
    expect(history[1].content).toHaveLength(HISTORY_ASSISTANT_CHARS);
  });
});

describe('sendMessage', () => {
  it('草稿只有空白字符时不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    setDraft('   \n ');
    const view = chatState();

    await act(async () => {
      await sendMessage();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(view.result.current.turns).toHaveLength(0);
  });

  it('已有一轮在途时再调用一次仍然是只发一个请求', async () => {
    const { mock, release } = deferredFetch();
    vi.stubGlobal('fetch', mock);
    setDraft('第一个问题');
    const view = chatState();

    let sending!: Promise<void>;
    act(() => {
      sending = sendMessage();
    });
    await act(async () => {
      await sendMessage();
    });

    expect(mock).toHaveBeenCalledTimes(1);
    expect(view.result.current.turns).toHaveLength(1);

    release(json({ answer_md: '回答', citations: [], actions: [] }));
    await act(async () => {
      await sending;
    });
  });

  it('成功：POST /api/assistant/chat，body.messages 等于含新 user 的 buildHistory，today / tz 合法', async () => {
    const answer = {
      answer_md: '**已办**',
      citations: [CITATION],
      actions: [action('created', makeItem({ id: 5 }))],
    };
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => json(answer));
    vi.stubGlobal('fetch', fetchMock);
    setDraft('  帮我建一条交电费  ');
    const view = chatState();

    await act(async () => {
      await sendMessage();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/assistant/chat');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body)) as { messages: unknown; today: string; tz: string };
    expect(body.messages).toEqual(
      buildHistory([{ id: 0, role: 'user', content: '帮我建一条交电费' }]),
    );
    expect(body.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof body.tz).toBe('string');
    expect(body.tz).not.toBe('');

    // 回复整体上屏：回答原文 + 引用 + 回执，草稿清空、pending 复位
    // id 是模块级自增（跨用例不重置），只断言两条的相对大小与角色内容
    const { turns, draft, pending, error } = view.result.current;
    expect(turns).toHaveLength(2);
    const [user, assistant] = turns;
    expect(user).toMatchObject({ role: 'user', content: '帮我建一条交电费' });
    expect(assistant).toMatchObject({
      role: 'assistant',
      content: '**已办**',
      citations: [CITATION],
      actions: answer.actions,
    });
    expect(assistant.id).toBeGreaterThan(user.id);
    expect(draft).toBe('');
    expect(pending).toBe(false);
    expect(error).toBeNull();
  });

  it('第二次发送把上一轮带进历史：messages 等于 buildHistory(上一轮 + 新 user)', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      json({ answer_md: '第一轮回答', citations: [], actions: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const view = chatState();
    setDraft('第一个问题');
    await act(async () => {
      await sendMessage();
    });

    const before = view.result.current.turns;
    setDraft('第二个问题');
    await act(async () => {
      await sendMessage();
    });

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { messages: unknown };
    expect(body.messages).toEqual(
      buildHistory([...before, { id: 999, role: 'user', content: '第二个问题' }]),
    );
    expect(body.messages).toHaveLength(3);
  });

  it('429 失败：错误为限流文案、撤回用户那条、草稿回填原文', async () => {
    const fetchMock = vi.fn(async () => json({ code: 'rate_limited' }, 429));
    vi.stubGlobal('fetch', fetchMock);
    setDraft('十万火急');
    const view = chatState();

    await act(async () => {
      await sendMessage();
    });

    expect(view.result.current.error).toBe(RATE_LIMITED_MESSAGE);
    expect(view.result.current.turns).toHaveLength(0);
    expect(view.result.current.draft).toBe('十万火急');
    expect(view.result.current.pending).toBe(false);
  });

  it('AbortError 失败：错误为超时文案', async () => {
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw abortError;
    }));
    setDraft('会超时的问题');
    const view = chatState();

    await act(async () => {
      await sendMessage();
    });

    expect(view.result.current.error).toBe(TIMEOUT_MESSAGE);
  });

  it('502 失败：错误为通用文案', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'assistant_error' }, 502)));
    setDraft('会失败的问题');
    const view = chatState();

    await act(async () => {
      await sendMessage();
    });

    expect(view.result.current.error).toBe(GENERIC_MESSAGE);
  });

  it('请求期间用户又改了草稿：失败后不回填、不覆盖新草稿', async () => {
    const { mock, release } = deferredFetch();
    vi.stubGlobal('fetch', mock);
    setDraft('原来的问题');
    const view = chatState();

    let sending!: Promise<void>;
    act(() => {
      sending = sendMessage();
    });
    act(() => {
      setDraft('用户新敲的内容');
    });
    await act(async () => {
      release(json({ code: 'assistant_error' }, 502));
      await sending;
    });

    expect(view.result.current.error).toBe(GENERIC_MESSAGE);
    expect(view.result.current.draft).toBe('用户新敲的内容');
    expect(view.result.current.turns).toHaveLength(0);
  });
});

describe('resetChat', () => {
  it('清空 turns 与 error，保留草稿', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ answer_md: '回答', citations: [], actions: [] })));
    const view = chatState();
    setDraft('第一问');
    await act(async () => {
      await sendMessage();
    });
    // 再制造一个非空 error
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'assistant_error' }, 502)));
    setDraft('第二问');
    await act(async () => {
      await sendMessage();
    });
    expect(view.result.current.error).toBe(GENERIC_MESSAGE);
    expect(view.result.current.turns).toHaveLength(2);

    act(() => {
      setDraft('留着的新草稿');
    });
    act(() => {
      resetChat();
    });

    expect(view.result.current.turns).toHaveLength(0);
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.draft).toBe('留着的新草稿');
  });

  it('有请求在途时不生效：在途回复与回执照常落地', async () => {
    const { mock, release } = deferredFetch();
    vi.stubGlobal('fetch', mock);
    setDraft('在途的问题');
    const view = chatState();

    let sending!: Promise<void>;
    act(() => {
      sending = sendMessage();
    });
    act(() => {
      resetChat();
    });

    expect(view.result.current.turns).toHaveLength(1);
    expect(view.result.current.pending).toBe(true);

    release(
      json({
        answer_md: '回答',
        citations: [],
        actions: [action('created', makeItem({ id: 9 }))],
      }),
    );
    await act(async () => {
      await sending;
    });

    expect(view.result.current.turns).toHaveLength(2);
    expect(view.result.current.turns[1].role).toBe('assistant');
  });
});

describe('syncListCache', () => {
  const seeded = makeItem({ id: 1, title: '旧标题' });
  const listed = makeItem({ id: 2, title: '列表里的那条' });

  beforeEach(() => {
    writeList(openKey(null), [seeded, listed]);
    writeList(DONE_KEY, []);
  });

  it('created：新条目按 open 列表口径插进去', () => {
    const created = makeItem({ id: 3, title: '新条目', category: '工作' });

    syncListCache([action('created', created)]);

    const open = readList(openKey(null));
    expect(open?.map((i) => i.id)).toContain(3);
    expect(open?.find((i) => i.id === 3)?.title).toBe('新条目');
  });

  it('completed：从 open 移到 done', () => {
    syncListCache([action('completed', listed)]);

    expect(readList(openKey(null))?.map((i) => i.id)).toEqual([1]);
    expect(readList(DONE_KEY)?.map((i) => i.id)).toEqual([2]);
    expect(readList(DONE_KEY)?.[0].status).toBe('done');
  });

  it('reopened：从 done 移回 open', () => {
    writeList(DONE_KEY, [{ ...listed, status: 'done' }]);

    syncListCache([action('reopened', listed)]);

    expect(readList(DONE_KEY)).toEqual([]);
    expect(readList(openKey(null))?.map((i) => i.id)).toContain(2);
    expect(readList(openKey(null))?.find((i) => i.id === 2)?.status).toBe('open');
  });

  it('updated（条目仍是 open）：在 open 列表原位替换', () => {
    const updated = { ...seeded, title: '改过的标题' };

    syncListCache([action('updated', updated, ['title'])]);

    const open = readList(openKey(null));
    expect(open?.[0].title).toBe('改过的标题');
    expect(open?.map((i) => i.id)).toEqual([1, 2]);
  });

  it('updated（条目已完成）：在 done 列表原位替换', () => {
    const doneItem = { ...listed, status: 'done' as const, title: '完成态改了标题' };
    writeList(DONE_KEY, [{ ...listed, status: 'done' }]);

    syncListCache([action('updated', doneItem, ['title'])]);

    expect(readList(DONE_KEY)?.[0].title).toBe('完成态改了标题');
    expect(readList(DONE_KEY)).toHaveLength(1);
  });
});
