// 助理页测试：多轮聊天（发送 / 快捷键 / 失败回滚 / 模块级缓存）、回执卡与引用邮件的
// 打开路径、以及玻璃与配色的两条守卫（haze 数、panel 数、玻璃不嵌套、n9 文字色）。
// 输入台的快捷键语义分三条独立用例：Enter / Shift+Enter / 输入法组合中的 Enter
// （Safari 的 keyCode 229 单独一条），任何一条放宽都会真发出一条消息。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import AssistantPage from '../src/pages/AssistantPage';
import NewChatButton from '../src/components/NewChatButton';
import {
  RATE_LIMITED_MESSAGE,
  resetChat,
  sendMessage,
  setDraft,
  useChatDraft,
  useChatTurns,
} from '../src/lib/chat';
import { resetLists } from '../src/lib/list-cache';
import { NEUTRAL_LIGHT, RADIUS } from '../src/rakko-tokens';
import type { ChatAction, ChatActionField, ChatActionKind, Email, EmailCitation, Item } from '../src/types';
import { allStyleText, ownEmotionClass, ownRules, renderWithAppTheme, ruleTextOf } from './glass-text-contrast.test-utils';

const INPUT_LABEL = '给助理的消息';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeItem(partial: Partial<Item>): Item {
  return {
    // 回执里的是助理刚建/改的条目：手动条目（无源邮件），详情对话框因此只打 GET /api/items/{id}
    id: 42,
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

const ACTION_ITEM = makeItem({ id: 42, title: '交电费', category: '账单' });

const CITATION: EmailCitation = {
  email_id: 12,
  subject: '账单邮件主题',
  sent_at: '2026-09-20T01:02:03',
};

const EMAIL: Email = {
  id: 12,
  account_id: 1,
  subject: '账单邮件主题',
  sender: 'bill@example.com',
  recipients: 'me@example.com',
  sent_at: '2026-09-20T01:02:03',
  text_body: '本月账单 100 元',
  html: null,
};

function action(kind: ChatActionKind, fields: ChatActionField[] = []): ChatAction {
  return { kind, item: ACTION_ITEM, fields };
}

interface MockOptions {
  answer_md: string;
  citations?: EmailCitation[];
  actions?: ChatAction[];
  /** GET /api/items/{id} 的结果；'error' = 404 */
  item?: Item | 'error';
  /** GET /api/emails/{id} 的结果；'error' = 404 */
  email?: Email | 'error';
}

/** 统一的 fetch stub：助理端点返回给定回复，条目 / 邮件端点按传入结果返回，其余 404 */
function makeFetchMock(opts: MockOptions) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/assistant/chat' && init?.method === 'POST') {
      return json({
        answer_md: opts.answer_md,
        citations: opts.citations ?? [],
        actions: opts.actions ?? [],
      });
    }
    if (url.startsWith('/api/items/')) {
      return opts.item === undefined || opts.item === 'error'
        ? json({ code: 'not_found' }, 404)
        : json(opts.item);
    }
    if (url.startsWith('/api/emails/')) {
      return opts.email === undefined || opts.email === 'error'
        ? json({ code: 'not_found' }, 404)
        : json(opts.email);
    }
    return json({}, 404);
  });
}

/** 一个可手动放行的 fetch：请求停在 await 上，用例自己决定什么时候返回 */
function deferredFetch(): { mock: ReturnType<typeof vi.fn>; release: (r: Response) => void } {
  let resolve!: (r: Response) => void;
  const mock = vi.fn(() => new Promise<Response>((res) => { resolve = res; }));
  // 转发一层而不是直接返回 resolve：它要到 mock 被调用时才被赋值
  return { mock, release: (r: Response) => resolve(r) };
}

/** 渲染助理页并返回输入框 */
function renderPage() {
  render(<AssistantPage />);
  return screen.getByLabelText(INPUT_LABEL) as HTMLTextAreaElement;
}

/** 输入一段话并敲回车发送 */
function typeAndSend(textarea: HTMLTextAreaElement, text: string): void {
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: 'Enter' });
}

/** 当前聊天状态的一份快照（NewChatButton 用例直接读 store） */
function chatStore() {
  return renderHook(() => ({ turns: useChatTurns(), draft: useChatDraft() }));
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

describe('空态与建议', () => {
  it('空态渲染引导文案与三条建议', () => {
    vi.stubGlobal('fetch', makeFetchMock({ answer_md: '不会用到' }));

    render(<AssistantPage />);

    expect(screen.getByText('可以问我邮件里的事，也可以让我新建、完成或修改待办。')).toBeTruthy();
    expect(screen.getByText('这周有哪些快到期的待办？')).toBeTruthy();
    expect(screen.getByText('最近有什么账单邮件？')).toBeTruthy();
    expect(screen.getByText('提醒我明天上午 10 点交电费')).toBeTruthy();
  });

  it('点建议只把文字填进输入框并聚焦，不发请求', () => {
    const fetchMock = makeFetchMock({ answer_md: '不会用到' });
    vi.stubGlobal('fetch', fetchMock);
    const textarea = renderPage();

    fireEvent.click(screen.getByText('最近有什么账单邮件？'));

    expect(textarea.value).toBe('最近有什么账单邮件？');
    expect(document.activeElement).toBe(textarea);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('发送与快捷键', () => {
  it('Enter 发送一次 POST /api/assistant/chat，body.messages 最后一条是输入文本', async () => {
    const fetchMock = makeFetchMock({ answer_md: '收到。' });
    vi.stubGlobal('fetch', fetchMock);
    const textarea = renderPage();

    typeAndSend(textarea, '明天有什么要交的');
    await screen.findByText('收到。');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/assistant/chat');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] };
    expect(body.messages[body.messages.length - 1]).toEqual({
      role: 'user',
      content: '明天有什么要交的',
    });
  });

  it('Shift+Enter 只换行，不发请求', () => {
    const fetchMock = makeFetchMock({ answer_md: '不会用到' });
    vi.stubGlobal('fetch', fetchMock);
    const textarea = renderPage();

    fireEvent.change(textarea, { target: { value: '第一行' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('输入法组合中的 Enter（isComposing）不发请求', () => {
    const fetchMock = makeFetchMock({ answer_md: '不会用到' });
    vi.stubGlobal('fetch', fetchMock);
    const textarea = renderPage();

    fireEvent.change(textarea, { target: { value: 'ni hao' } });
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Safari 确认候选的那次回车（keyCode 229）不发请求', () => {
    const fetchMock = makeFetchMock({ answer_md: '不会用到' });
    vi.stubGlobal('fetch', fetchMock);
    const textarea = renderPage();

    fireEvent.change(textarea, { target: { value: '交电费' } });
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('回复渲染', () => {
  it('用户气泡渲染的是原文（纯文本，不走 Markdown）', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ answer_md: '好的。' }));
    const textarea = renderPage();

    typeAndSend(textarea, '**这不是加粗**');
    await screen.findByText('好的。');

    const bubble = screen.getByText('**这不是加粗**');
    expect(bubble.tagName).toBe('P');
    expect(bubble.querySelector('strong')).toBeNull();
    expect(bubble.closest('[data-glass="panel"]')).not.toBeNull();
  });

  it('回答里的 **粗体** 经 SafeMarkdown 渲染成 strong', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ answer_md: '这是**粗体**内容。' }));
    const textarea = renderPage();

    typeAndSend(textarea, '随便问问');
    await screen.findByText('粗体');

    expect(screen.getByText('粗体').tagName).toBe('STRONG');
  });

  it('回答里的远程图片语法不产生 img（提示注入的零点击外泄通道被掐掉）', async () => {
    const fetchMock = makeFetchMock({
      answer_md: '看这个 ![x](https://evil.example/a.png) 图片。',
    });
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<AssistantPage />);
    const textarea = screen.getByLabelText(INPUT_LABEL) as HTMLTextAreaElement;

    typeAndSend(textarea, '有什么图');
    await screen.findByText(/看这个/);

    expect(container.querySelector('img')).toBeNull();
  });
});

describe('回执卡的四种动作文案', () => {
  it('created 显示「新建了待办」', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ answer_md: '办好了。', actions: [action('created')] }));
    const textarea = renderPage();

    typeAndSend(textarea, '建一条交电费');
    await screen.findByText('办好了。');

    expect(screen.getByText('新建了待办')).toBeTruthy();
    expect(screen.getByText(ACTION_ITEM.title)).toBeTruthy();
  });

  it('completed 显示「标记为已完成」', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ answer_md: '办好了。', actions: [action('completed')] }));
    const textarea = renderPage();

    typeAndSend(textarea, '把交电费标完成');
    await screen.findByText('办好了。');

    expect(screen.getByText('标记为已完成')).toBeTruthy();
  });

  it('reopened 显示「重新打开了待办」', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ answer_md: '办好了。', actions: [action('reopened')] }));
    const textarea = renderPage();

    typeAndSend(textarea, '把交电费重新打开');
    await screen.findByText('办好了。');

    expect(screen.getByText('重新打开了待办')).toBeTruthy();
  });

  it('updated 按 fields 列出改过的字段名', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock({
        answer_md: '办好了。',
        actions: [action('updated', ['title', 'due_date'])],
      }),
    );
    const textarea = renderPage();

    typeAndSend(textarea, '把标题和截止日期改一下');
    await screen.findByText('办好了。');

    expect(screen.getByText('修改了标题、截止日期')).toBeTruthy();
  });
});

describe('回执与引用的打开路径', () => {
  it('点回执先取最新条目再打开详情对话框', async () => {
    const fetchMock = makeFetchMock({
      answer_md: '建好了。',
      actions: [action('created')],
      item: ACTION_ITEM,
    });
    vi.stubGlobal('fetch', fetchMock);
    const textarea = renderPage();
    typeAndSend(textarea, '建一条交电费');
    await screen.findByText('建好了。');

    fireEvent.click(screen.getByText('新建了待办'));

    // 打开之前先打 GET /api/items/42：回执里那份快照可能已经过时
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/items/42')).toBe(true);
    });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(ACTION_ITEM.title)).toBeTruthy();
  });

  it('条目已取不到时只弹 Snackbar，不打开详情对话框', async () => {
    const fetchMock = makeFetchMock({
      answer_md: '建好了。',
      actions: [action('created')],
      item: 'error',
    });
    vi.stubGlobal('fetch', fetchMock);
    const textarea = renderPage();
    typeAndSend(textarea, '建一条交电费');
    await screen.findByText('建好了。');

    fireEvent.click(screen.getByText('新建了待办'));

    expect(await screen.findByText('这条待办暂时打不开，可能已被删除。')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('点引用行打开「原邮件」对话框', async () => {
    const fetchMock = makeFetchMock({
      answer_md: '这封是账单。',
      citations: [CITATION],
      email: EMAIL,
    });
    vi.stubGlobal('fetch', fetchMock);
    const textarea = renderPage();
    typeAndSend(textarea, '最近有什么账单邮件');
    await screen.findByText('这封是账单。');

    fireEvent.click(screen.getByText(CITATION.subject));

    expect(await screen.findByText('原邮件')).toBeTruthy();
    expect(await screen.findByText('本月账单 100 元')).toBeTruthy();
  });
});

describe('在途与失败', () => {
  it('请求在途：发送按钮禁用，进度条落在输入台容器内', async () => {
    const { mock, release } = deferredFetch();
    vi.stubGlobal('fetch', mock);
    const textarea = renderPage();
    typeAndSend(textarea, '要等一会的问题');

    const sendButton = screen.getByRole('button', { name: '发送' });
    await vi.waitFor(() => {
      expect(sendButton).toBeDisabled();
    });
    const progress = screen.getByRole('progressbar');
    const host = progress.closest('[data-glass="panel"]');
    expect(host, '进度条不能裸在壁纸上，必须是输入台玻璃的后代').not.toBeNull();
    expect(host!.contains(progress)).toBe(true);

    release(json({ answer_md: '等到了。', citations: [], actions: [] }));
    await screen.findByText('等到了。');
  });

  it('429 失败：输入台内是限流文案、用户气泡撤回、输入框回填原文', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'rate_limited' }, 429)));
    const textarea = renderPage();
    typeAndSend(textarea, '十万火急的问题');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(RATE_LIMITED_MESSAGE);
    const host = alert.closest('[data-glass="panel"]');
    expect(host, '错误 Alert 不能裸在壁纸上，必须是输入台玻璃的后代').not.toBeNull();
    expect(host!.contains(alert)).toBe(true);
    // 撤回：消息流里只剩下空的对话记录（提问那条已被收走，草稿回到了输入框）
    expect(screen.getByRole('log')).toBeEmptyDOMElement();
    expect(textarea.value).toBe('十万火急的问题');
  });
});

describe('会话级缓存与滚动', () => {
  it('卸载后重新渲染，之前的对话仍在（模块级 store，刷新才丢）', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ answer_md: '我是上一次的回答。' }));
    const view = render(<AssistantPage />);
    const textarea = screen.getByLabelText(INPUT_LABEL) as HTMLTextAreaElement;
    typeAndSend(textarea, '上一次的问题');
    await screen.findByText('我是上一次的回答。');

    view.unmount();
    render(<AssistantPage />);

    expect(screen.getByText('上一次的问题')).toBeTruthy();
    expect(screen.getByText('我是上一次的回答。')).toBeTruthy();
  });

  it('收到回复后滚到底部', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ answer_md: '回答来了。' }));
    const textarea = renderPage();

    typeAndSend(textarea, '滚一下');
    await screen.findByText('回答来了。');

    expect(window.scrollTo).toHaveBeenCalled();
  });
});

describe('顶栏「新对话」按钮', () => {
  it('没有对话时禁用', () => {
    render(<NewChatButton />);

    expect(screen.getByRole('button', { name: '新对话' })).toBeDisabled();
  });

  it('有对话时点击清空消息、保留草稿', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ answer_md: '第一次回答。' }));
    const store = chatStore();
    setDraft('第一个问题');
    await act(async () => {
      await sendMessage();
    });
    expect(store.result.current.turns).toHaveLength(2);
    setDraft('留在输入框里的草稿');
    render(<NewChatButton />);

    fireEvent.click(screen.getByRole('button', { name: '新对话' }));

    expect(store.result.current.turns).toHaveLength(0);
    expect(store.result.current.draft).toBe('留在输入框里的草稿');
    expect(screen.getByRole('button', { name: '新对话' })).toBeDisabled();
  });

  it('请求在途时禁用（在途回执不能被清掉）', async () => {
    const { mock, release } = deferredFetch();
    vi.stubGlobal('fetch', mock);
    const store = chatStore();
    setDraft('在途的问题');
    let sending!: Promise<void>;
    act(() => {
      sending = sendMessage();
    });
    render(<NewChatButton />);

    expect(store.result.current.turns).toHaveLength(1);
    expect(screen.getByRole('button', { name: '新对话' })).toBeDisabled();

    release(json({ answer_md: '回答', citations: [], actions: [] }));
    await act(async () => {
      await sending;
    });
  });
});

// —— 玻璃与配色守卫 ——

/** 一轮带 1 条回执 + 1 条引用的回复；玻璃计数用例据此断言各档块数 */
function makeRoundTripMock(answer_md: string) {
  return makeFetchMock({
    answer_md,
    citations: [CITATION],
    actions: [action('created')],
    item: ACTION_ITEM,
    email: EMAIL,
  });
}

const ROUND_TRIP_ANSWER = '第一段正文。\n\n第二段正文，补充更多细节。';

/** 渲染助理页并跑完一轮「提问 → 回答（含回执与引用）」 */
async function renderRoundTrip() {
  vi.stubGlobal('fetch', makeRoundTripMock(ROUND_TRIP_ANSWER));
  const utils = render(<AssistantPage />);
  const textarea = screen.getByLabelText(INPUT_LABEL) as HTMLTextAreaElement;
  typeAndSend(textarea, '这一轮的问题');
  await screen.findByText('第一段正文。');
  return utils;
}

describe('玻璃不变量', () => {
  it('任何 [data-glass] 元素的祖先链上都没有另一块 [data-glass]', async () => {
    const { container } = await renderRoundTrip();

    const glasses = Array.from(container.querySelectorAll('[data-glass]'));
    expect(glasses.length).toBeGreaterThan(3);
    for (const glass of glasses) {
      expect(glass.parentElement!.closest('[data-glass]')).toBeNull();
    }
  });

  it('一轮含回执与引用的回复后：haze 恰 2 块（回答 + 引用标题）且都不带 data-haze，panel 恰 4 块', async () => {
    const { container } = await renderRoundTrip();

    const hazes = container.querySelectorAll('[data-glass="haze"]');
    expect(hazes).toHaveLength(2);
    for (const haze of Array.from(hazes)) {
      // cloud 是上游配方的默认形态，默认不写 data-haze——只有切 veil 才写该属性
      expect(haze.hasAttribute('data-haze')).toBe(false);
    }

    // 用户气泡 + 回执行 + 引用行 + 输入台
    const panels = container.querySelectorAll('[data-glass="panel"]');
    expect(panels).toHaveLength(4);
    const rowPanels = Array.from(panels).filter((p) => p.classList.contains('MuiListItemButton-root'));
    expect(rowPanels).toHaveLength(2);
  });

  it('回答雾包住全部 markdown 段落，段落自身没有 data-glass，雾里再无别的玻璃', async () => {
    await renderRoundTrip();

    const marker = screen.getByText('第一段正文。');
    expect(marker.tagName).toBe('P');
    const answerHaze = marker.closest('[data-glass="haze"]') as HTMLElement | null;
    expect(answerHaze).not.toBeNull();
    expect(answerHaze!.tagName).toBe('DIV'); // 宿主是 Box

    const paragraphs = Array.from(answerHaze!.querySelectorAll('p'));
    expect(paragraphs.length).toBeGreaterThan(1);
    for (const p of paragraphs) {
      expect(p.hasAttribute('data-glass')).toBe(false);
      expect(p.closest('[data-glass]')).toBe(answerHaze);
    }
    expect(answerHaze!.querySelectorAll('[data-glass]')).toHaveLength(0);
  });

  it('输入台容器内含输入框与发送按钮，且自身样式不下发 background', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ answer_md: '不会用到' }));
    renderWithAppTheme(<AssistantPage />);
    const textarea = screen.getByLabelText(INPUT_LABEL);
    const host = textarea.closest('[data-glass="panel"]') as HTMLElement | null;
    expect(host).not.toBeNull();

    expect(host!.contains(textarea)).toBe(true);
    expect(host!.contains(screen.getByRole('button', { name: '发送' }))).toBe(true);
    expect(textarea.hasAttribute('data-glass')).toBe(false);

    // 宿主规则 = 输入台 sx 生成的局部 emotion 类；一发 background 就盖掉玻璃配方
    expect(ownEmotionClass(host!), '宿主应带 emotion 局部类').not.toBeNull();
    const rule = ruleTextOf(allStyleText(), host!);
    expect(rule).not.toBe('');
    expect(rule, 'sx 只补配方不管的圆角').toContain(`border-radius:${RADIUS.card}px`);
    expect(rule).not.toContain('background');
  });

  it('回执行与引用行的文字色是 n9（text.primary），不是 n7', async () => {
    vi.stubGlobal('fetch', makeRoundTripMock(ROUND_TRIP_ANSWER));
    const { container } = renderWithAppTheme(<AssistantPage />);
    const textarea = screen.getByLabelText(INPUT_LABEL) as HTMLTextAreaElement;
    typeAndSend(textarea, '这一轮的问题');
    await screen.findByText('第一段正文。');

    const css = allStyleText();
    const actionLine = screen.getByText('新建了待办');
    expect(ownEmotionClass(actionLine), '回执动作文案应带 emotion 局部类').not.toBeNull();
    const actionRule = ruleTextOf(css, actionLine);
    expect(actionRule).not.toBe('');
    expect(actionRule, '回执文案必须是 text.primary（n9）').toContain(`color:${NEUTRAL_LIGHT[8]}`);
    expect(actionRule, '回执文案不得回落到 text.secondary（n7）').not.toContain(
      `color:${NEUTRAL_LIGHT[6]}`,
    );

    const summaries = container.querySelectorAll('.MuiListItemText-secondary');
    expect(summaries).toHaveLength(1);
    const summaryRule = ruleTextOf(css, summaries[0]);
    expect(summaryRule).not.toBe('');
    expect(summaryRule, '引用行摘要必须是 text.primary（n9）').toContain(`color:${NEUTRAL_LIGHT[8]}`);
    expect(summaryRule, '引用行摘要不得回落到 text.secondary（n7）').not.toContain(
      `color:${NEUTRAL_LIGHT[6]}`,
    );
  });

  it('输入台容器自身规则含 position:sticky，xs 档 bottom 让开移动端底栏', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ answer_md: '不会用到' }));
    renderWithAppTheme(<AssistantPage />);
    const textarea = screen.getByLabelText(INPUT_LABEL);
    const host = textarea.closest('[data-glass="panel"]') as HTMLElement | null;
    expect(host).not.toBeNull();

    const rule = ownRules(allStyleText(), host!);
    expect(rule, '应能读到宿主自己的 emotion 规则').not.toBe('');
    expect(rule).toContain('position:sticky');
    expect(rule).toContain('bottom:calc(64px + env(safe-area-inset-bottom) + 8px)');
    expect(rule).toContain('z-index:1');
  });
});
