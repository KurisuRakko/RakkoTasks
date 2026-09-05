// ItemDialog 测试：关联邮件区渲染、「复制给 AI」成功/失败、详情加载中复制按钮禁用。
// fetch 按 URL 分发 mock：/detail、/emails/、/status、/export。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ItemDialog from '../src/components/ItemDialog';
import { VT_NAMES } from '../src/lib/view-transition';
import type { Item } from '../src/types';

function makeItem(partial: Partial<Item>): Item {
  return {
    id: 1,
    email_id: 1,
    email_sent_at: null,
    title: '测试任务',
    summary: null,
    category: '工作',
    due_date: null,
    importance: 'normal',
    actionable: true,
    status: 'open',
    detail_md: null,
    related: [],
    created_at: '2026-08-01T00:00:00Z',
    done_at: null,
    ...partial,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// 详情接口返回的关联邮件：日期取 sent_at 前 10 位展示（2026-08-01）
const DETAIL_RESPONSE = {
  id: 1,
  detail_md: '**详情**',
  related: [
    {
      email_id: 9,
      subject: '退款来源',
      sender: 'a@b',
      sent_at: '2026-08-01T00:00:00',
      reason: '这是那笔 50 元的原始订单',
    },
  ],
};

function makeFetchMock(): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes('/detail')) return json(DETAIL_RESPONSE);
    if (u.includes('/emails/')) {
      return json({
        id: 9,
        account_id: 1,
        subject: '邮件主题',
        sender: 'a@b',
        recipients: null,
        sent_at: '2026-08-01T00:00:00',
        text_body: '邮件正文',
        html: null,
      });
    }
    if (u.includes('/status')) return json({ accounts: [], pending_llm: 0 });
    if (u.includes('/export')) return json({ text: '# 导出内容' });
    return json({}, 404);
  });
}

// jsdom 没有 ClipboardItem，copyText 必然走 writeText 回退；这里只 mock writeText
function stubClipboardWriteText(writeText: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

function copyButton(): HTMLElement {
  return screen.getByRole('button', { name: /复制给 AI/ });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (navigator as { clipboard?: unknown }).clipboard;
});

describe('ItemDialog', () => {
  it('详情加载后渲染关联邮件区：标题、主题与关联原因', async () => {
    vi.stubGlobal('fetch', makeFetchMock());

    render(<ItemDialog item={makeItem({})} onClose={vi.fn()} />);

    expect(await screen.findByText('退款来源')).toBeTruthy();
    expect(screen.getByText('关联邮件')).toBeTruthy();
    // 原因与日期拼在同一 secondary 文本里，用正则断言
    expect(screen.getByText(/这是那笔 50 元的原始订单/)).toBeTruthy();
    expect(screen.getByText(/2026-08-01/)).toBeTruthy();
  });

  it('点「复制给 AI」请求 export，把 Markdown 写入剪贴板并提示成功', async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    const writeText = vi.fn(async () => undefined);
    stubClipboardWriteText(writeText);

    render(<ItemDialog item={makeItem({})} onClose={vi.fn()} />);
    // 详情加载完成前复制按钮禁用，先等它可用
    await screen.findByText('退款来源');

    fireEvent.click(copyButton());

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/items/1/export'))).toBe(
        true,
      );
      expect(writeText).toHaveBeenCalledWith('# 导出内容');
    });
    expect(await screen.findByText('已复制到剪贴板')).toBeTruthy();
  });

  it('剪贴板写入失败时提示「复制失败」', async () => {
    vi.stubGlobal('fetch', makeFetchMock());
    stubClipboardWriteText(
      vi.fn(async () => {
        throw new Error('denied');
      }),
    );

    render(<ItemDialog item={makeItem({})} onClose={vi.fn()} />);
    await screen.findByText('退款来源');

    fireEvent.click(copyButton());

    expect(await screen.findByText('复制失败')).toBeTruthy();
  });

  it('detail_md 为 null 且详情请求在途时「复制给 AI」禁用，返回后解除', async () => {
    let resolveDetail!: (r: Response) => void;
    const detailGate = new Promise<Response>((resolve) => {
      resolveDetail = resolve;
    });
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/detail')) return detailGate;
      if (u.includes('/emails/')) return json({ id: 9, account_id: 1, subject: 's', sender: null, recipients: null, sent_at: null, text_body: 'b', html: null });
      if (u.includes('/status')) return json({ accounts: [], pending_llm: 0 });
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    stubClipboardWriteText(vi.fn(async () => undefined));

    render(<ItemDialog item={makeItem({})} onClose={vi.fn()} />);

    expect(copyButton()).toBeDisabled();

    resolveDetail(json(DETAIL_RESPONSE));
    await waitFor(() => {
      expect(copyButton()).toBeEnabled();
    });
  });
});

describe('ItemDialog 手动条目（email_id 为 null）', () => {
  it('不请求 detail/email，summary 两行都渲染；无 AI 详情/原邮件区；有编辑与删除按钮', async () => {
    const fetchMock = vi.fn(async (_url: string | URL) => json({}, 404));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ItemDialog
        item={makeItem({
          id: 7,
          email_id: null,
          title: '手动任务',
          summary: '第一行\n第二行',
          category: '个人',
          due_date: '2026-09-10',
        })}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByText('手动任务')).toBeTruthy();

    // 手动条目专属操作按钮
    expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除' })).toBeTruthy();

    // 邮件条目专属内容一律不出现
    expect(screen.queryByText('AI 详情')).toBeNull();
    expect(screen.queryByText('显示原邮件')).toBeNull();
    expect(screen.queryByText('关联邮件')).toBeNull();
    expect(screen.queryByText('来源账户：…')).toBeNull();

    // summary 两行都渲染出来（SafeMarkdown breaks 保留换行）
    const dialog = screen.getAllByRole('dialog')[0];
    expect(dialog.textContent).toContain('第一行');
    expect(dialog.textContent).toContain('第二行');

    // 不请求 /detail（AI 详情懒生成）与 /emails/（原邮件）
    const calls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(calls.some((u) => u.includes('/detail'))).toBe(false);
    expect(calls.some((u) => u.includes('/emails/'))).toBe(false);
  });

  it('邮件条目（email_id 非 null）不出现编辑/删除按钮', async () => {
    vi.stubGlobal('fetch', makeFetchMock());

    render(<ItemDialog item={makeItem({})} onClose={vi.fn()} />);
    await screen.findByText('退款来源');

    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull();
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
  });

  it('删除：确认框点「删除」后 DELETE /api/items/{id}，onDeleted 收到 id、onClose 被调', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === 'DELETE' && u === '/api/items/7') {
        return new Response(null, { status: 204 });
      }
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    const onDeleted = vi.fn();
    const onClose = vi.fn();

    render(
      <ItemDialog
        item={makeItem({ id: 7, email_id: null, title: '待删任务' })}
        onClose={onClose}
        onDeleted={onDeleted}
      />,
    );

    // 打开删除确认框
    fireEvent.click(await screen.findByRole('button', { name: '删除' }));
    const prompt = await screen.findByText('删除这条任务？此操作不可撤销。');
    const confirmDialog = prompt.closest('[role="dialog"]') as HTMLElement;
    fireEvent.click(within(confirmDialog).getByRole('button', { name: '删除' }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true);
      expect(onDeleted).toHaveBeenCalledWith(7);
      expect(onClose).toHaveBeenCalled();
    });
  });
});

describe('ItemDialog 容器变换共享名', () => {
  it('对话框 paper 的样式规则带 viewTransitionName: VT_NAMES.sheet', async () => {
    vi.stubGlobal('fetch', makeFetchMock());

    render(<ItemDialog item={makeItem({})} onClose={vi.fn()} />);
    await screen.findByText('退款来源');

    const paper = document.querySelector('.MuiDialog-paper') as HTMLElement | null;
    expect(paper).not.toBeNull();
    // sx 经 emotion 生成类名规则（jsdom 无法求值计算样式），
    // 直接核对：paper 上存在某 emotion 类，其规则体含 view-transition-name: rtk-sheet
    const cssText = Array.from(document.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .join('\n');
    const vtSelector = Array.from(paper!.classList).find((c) =>
      new RegExp(`\\.${c}[^{]*\\{[^}]*view-transition-name\\s*:\\s*${VT_NAMES.sheet}`).test(
        cssText,
      ),
    );
    expect(vtSelector).toBeDefined();
  });
});

describe('ItemDialog 与内容列重合的样式', () => {
  it('md 起对话框与内容列重合的样式规则已注入', async () => {
    vi.stubGlobal('fetch', makeFetchMock());

    render(<ItemDialog item={makeItem({})} onClose={vi.fn()} />);
    await screen.findByText('退款来源');

    // sx 生成的是媒体查询内的容器/paper 规则（jsdom 无法求值计算样式），
    // 直接核对 style 文本：md 断点（900px）下容器让出抽屉宽（240px）、
    // paper 去横向边距、封顶内容列宽（840px）
    const cssText = Array.from(document.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .join('\n');
    expect(cssText).toContain('@media (min-width:900px)');
    expect(cssText).toContain('padding-left:240px');
    expect(cssText).toContain('max-width:840px');
  });
});
