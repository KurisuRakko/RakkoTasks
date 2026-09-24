// ItemDialog 测试：关联邮件区渲染、「复制给 AI」成功/失败、详情加载中复制按钮禁用。
// fetch 按 URL 分发 mock：/detail、/emails/、/status、/export。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ItemDialog from '../src/components/ItemDialog';
import { VT_NAMES } from '../src/lib/view-transition';
import { allStyleText, ownRules } from './glass-text-contrast.test-utils';
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
    reminders: [],
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

  it('手动条目（email_id 为 null）的编辑与删除按钮都在（原有行为不变）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL) => json({}, 404)));

    render(
      <ItemDialog
        item={makeItem({ id: 7, email_id: null, title: '手动任务' })}
        onClose={vi.fn()}
      />,
    );
    await screen.findByText('手动任务');

    expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除' })).toBeTruthy();
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

describe('ItemDialog 邮件条目的编辑放开', () => {
  it('邮件条目（email_id 非 null）有「编辑」按钮、无「删除」按钮', async () => {
    vi.stubGlobal('fetch', makeFetchMock());

    render(<ItemDialog item={makeItem({})} onClose={vi.fn()} />);
    await screen.findByText('退款来源');

    // 编辑入口对所有条目渲染
    expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy();
    // 回归保护：删除按钮仍然只对手动条目显示（后端对邮件条目仍拒删）
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
  });

  it('打开 low 邮件条目的编辑器：重要度控件选中「次要」，不退回默认「普通」', async () => {
    vi.stubGlobal('fetch', makeFetchMock());

    render(
      <ItemDialog
        item={makeItem({ id: 3, importance: 'low', title: '低优先邮件任务' })}
        onClose={vi.fn()}
      />,
    );
    await screen.findByText('退款来源');

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    await screen.findByLabelText('任务内容');

    // initial 载荷带 current.importance：AI 判的 low 显示在控件上（选中「次要」）
    expect(screen.getByRole('radio', { name: '次要' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: '普通' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('radio', { name: '重要' })).toHaveAttribute('aria-checked', 'false');
  });

  it('邮件条目编辑器点「重要」保存：PATCH /api/items/{id} 载荷 importance 为 high', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === 'PATCH' && u === '/api/items/1') {
        return json(makeItem({ importance: 'high' }));
      }
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
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ItemDialog
        item={makeItem({ id: 1, importance: 'low', title: '修打印机' })}
        onClose={vi.fn()}
      />,
    );
    await screen.findByText('退款来源');

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    await screen.findByLabelText('任务内容');
    fireEvent.click(screen.getByRole('radio', { name: '重要' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === '/api/items/1' &&
          (init as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(patchCall).toBeDefined();
      const body = JSON.parse(String((patchCall![1] as RequestInit).body));
      expect(body.importance).toBe('high');
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

describe('ItemDialog 截止日与列表同一口径', () => {
  it('详情里的截止日也按逾期标主色：此前详情页无论逾期与否都是中性，两处不一致', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const pad = (x: number) => String(x).padStart(2, '0');
    const due = `${yesterday.getFullYear()}-${pad(yesterday.getMonth() + 1)}-${pad(yesterday.getDate())}`;

    render(
      <ItemDialog
        item={makeItem({ id: 1, email_id: null, title: '逾期条目', due_date: due })}
        onClose={vi.fn()}
      />,
    );

    const chip = screen.getByLabelText(/^截止 .+，已逾期$/).closest('.MuiChip-root') as HTMLElement;
    expect(chip).not.toBeNull();
    expect(chip.className).toMatch(/MuiChip-colorPrimary/);
  });
});

describe('ItemDialog 正文里的长串不把整张对话框撑出横向滚动', () => {
  // 无空格长串：URL / 订单号 / 邮箱地址这类内容没有自然断点，缺了断点就会撑宽 paper。
  // 两个用例都走 email_id: null 的手动条目——不触发详情/邮件请求，无需 fetch mock。
  const LONG = 'a'.repeat(200);

  it('正文容器自带 overflow-wrap:anywhere：长串在正文宽度内折行', () => {
    render(
      <ItemDialog
        item={makeItem({ email_id: null, title: LONG, summary: LONG })}
        onClose={vi.fn()}
      />,
    );

    // 正文容器是 paper 的直接 div 子元素（AppBar 渲染成 header，不在其内；
    // 编辑/删除的对话框与 Snackbar 都挂在 portal 里，也不在 paper 下）
    const paper = document.querySelector('.MuiDialog-paper') as HTMLElement;
    expect(paper).not.toBeNull();
    const body = paper.querySelector(':scope > div') as HTMLElement | null;
    expect(body).not.toBeNull();

    const rule = ownRules(allStyleText(), body!);
    expect(rule, '正文容器没读到自身的 css-* 规则，下面的断言会空转').not.toBe('');
    expect(rule, '长串必须能在任意位置断行，否则整张 paper 横向可滚').toContain(
      'overflow-wrap:anywhere',
    );
  });

  it('分类 / 截止日那一行 Stack 自带 flex-wrap:wrap：两枚 Chip 放不下时折行而不是互相挤压', () => {
    // 分类是 Category 闭合联合（最长两个字）、截止日渲染成「8月1日」，两枚 Chip 今天
    // 本来放得下；这条钉的是不变量——放不下时换行，而不是挤成省略号或溢出正文。
    render(
      <ItemDialog
        item={makeItem({ email_id: null, category: '工作', due_date: '2026-08-01' })}
        onClose={vi.fn()}
      />,
    );

    const stack = screen.getByText('工作').closest('.MuiStack-root') as HTMLElement | null;
    expect(stack).not.toBeNull();

    const rule = ownRules(allStyleText(), stack!);
    expect(rule, 'Stack 上没读到自身的 css-* 规则，下面的断言会空转').not.toBe('');
    expect(rule, '两枚 Chip 放不下时折行，不要互相挤压').toContain('flex-wrap:wrap');
  });
});
