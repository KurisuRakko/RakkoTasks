// ItemDialog 测试：关联邮件区渲染、「复制给 AI」成功/失败、详情加载中复制按钮禁用。
// fetch 按 URL 分发 mock：/detail、/emails/、/status、/export。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ItemDialog from '../src/components/ItemDialog';
import type { Item } from '../src/types';

function makeItem(partial: Partial<Item>): Item {
  return {
    id: 1,
    email_id: 1,
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
