// ItemDialog 测试：关联邮件区渲染、「复制给 AI」成功/失败、详情加载中复制按钮禁用。
// fetch 按 URL 分发 mock：/detail、/emails/、/status、/export。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createTheme, getContrastRatio } from '@mui/material/styles';
import ItemDialog from '../src/components/ItemDialog';
import { VT_NAMES } from '../src/lib/view-transition';
import { buildThemeOptions } from '../src/theme';
import { NEUTRAL_LIGHT, TEXT_CONTRAST_MIN } from '../src/rakko-tokens';
import {
  allStyleText,
  ownEmotionClass,
  ownRules,
  renderWithAppTheme,
  ruleTextOf,
} from './glass-text-contrast.test-utils';
import source from '../src/components/ItemDialog.tsx?raw';
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
  it('详情里的截止日也按逾期标语义色：此前详情页无论逾期与否都是中性，两处不一致', () => {
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
    expect(chip.className).toMatch(/MuiChip-colorError/);
    expect(chip.className).not.toMatch(/MuiChip-colorPrimary/);
  });
});

describe('ItemDialog 实色纸面、文字层级与按钮层级', () => {
  it('对话框 paper 不挂 data-glass：详情纸面是不透明实色，不是毛玻璃', () => {
    vi.stubGlobal('fetch', makeFetchMock());

    render(<ItemDialog item={makeItem({})} onClose={vi.fn()} />);

    const paper = document.querySelector('.MuiDialog-paper') as HTMLElement | null;
    expect(paper).not.toBeNull();
    expect(paper!.hasAttribute('data-glass')).toBe(false);
    // 纸面上也不该有别的 data-glass（整张详情面只有这一层纸）
    expect(paper!.querySelector('[data-glass]')).toBeNull();
  });

  it('paper 的材质配置：实色纸底 + 压掉 overlay 渐变 + 无文字光晕，且不覆写阴影', () => {
    // 与 row-context-menu.test.tsx 同款源码断言：jsdom 不解析样式表，内联材质断言
    // 一律落回源码原文（?raw），否则会写出永远为真的假断言。
    const constStart = source.indexOf('const DIALOG_PAPER_PROPS');
    expect(constStart).toBeGreaterThan(-1);
    const constEnd = source.indexOf('};', constStart);
    expect(constEnd).toBeGreaterThan(-1);
    const paperProps = source.slice(constStart, constEnd + 2);

    expect(paperProps).toContain('viewTransitionName: VT_NAMES.sheet');
    expect(paperProps).toContain('backgroundColor: theme.palette.background.paper');
    expect(paperProps).toContain("backgroundImage: 'none'");
    expect(paperProps).toContain("textShadow: 'none'");
    // 阴影交回主题的 Dialog 默认 elevation：这里覆写 boxShadow 就改了纸面的浮起档位
    expect(paperProps).not.toContain('boxShadow');
    expect(paperProps).not.toContain('border');
  });

  it('paper 的实色底与 view-transition-name 走同一组 emotion 规则：底色 = background.paper', async () => {
    vi.stubGlobal('fetch', makeFetchMock());

    // 断言主题真的下发给组件的那一档纸色：必须用应用主题渲染，否则读到的是 MUI 默认纸色
    renderWithAppTheme(<ItemDialog item={makeItem({})} onClose={vi.fn()} />);
    await screen.findByText('退款来源');

    const paper = document.querySelector('.MuiDialog-paper') as HTMLElement | null;
    expect(paper).not.toBeNull();
    expect(
      ownEmotionClass(paper!),
      '没读到 paper 的 emotion 局部类，下面的断言会空转',
    ).not.toBeNull();
    const theme = createTheme(buildThemeOptions('light'));
    const rule = ownRules(allStyleText(), paper!);
    expect(rule, 'paper 没读到自身的 css-* 规则，下面的断言会空转').not.toBe('');
    expect(rule).toContain(`background-color:${theme.palette.background.paper}`);
    expect(rule, 'overlay 渐变必须压掉，否则纸底不是纯实色').toContain('background-image:none');
    expect(rule, '实色纸面上不要文字光晕').toContain('text-shadow:none');
    // 行↔详情的容器变换共享名仍在（材质改了，过渡不动）
    expect(rule).toContain(`view-transition-name:${VT_NAMES.sheet}`);
    // 阴影用主题的 Dialog 默认 elevation（MUI 给 paper 的 elevation 是 24）：这里不覆写
    // box-shadow，paper 上内联的 --Paper-shadow 就是 theme.shadows[24]
    expect(rule).toContain('box-shadow:var(--Paper-shadow)');
    expect(paper!.getAttribute('style')).toContain(`--Paper-shadow: ${theme.shadows[24]}`);
  });

  it('辅助文字取 text.secondary，且 n7 对 background.paper 在深浅两套都过 AA 4.5', async () => {
    // 决策前提：text.secondary（n7）是不透明纸面上的辅助档，深浅都要够 4.5 才允许用它；
    // 哪一套不达标，那一套的辅助文字就得退回 text.primary。
    for (const mode of ['light', 'dark'] as const) {
      const theme = createTheme(buildThemeOptions(mode));
      const paper = theme.palette.background.paper;
      const ratio = getContrastRatio(theme.palette.text.secondary, paper);
      expect(
        ratio,
        `${mode}：text.secondary 对 background.paper 只有 ${ratio.toFixed(2)}，` +
          `够不到 AA 正文的 ${TEXT_CONTRAST_MIN}，辅助文字必须退回 text.primary`,
      ).toBeGreaterThanOrEqual(TEXT_CONTRAST_MIN);
      // 层级还成立：次级档必须弱于正文档，不然「降一级」是假的
      expect(
        ratio,
        `${mode}：text.secondary 不该强过 text.primary，层级反了`,
      ).toBeLessThan(getContrastRatio(theme.palette.text.primary, paper));

      // 渲染层：同一模式下的辅助文字真的落在 text.secondary 上
      cleanup();
      localStorage.setItem('rakkotasks.theme-mode', mode);
      vi.stubGlobal('fetch', makeFetchMock());
      renderWithAppTheme(<ItemDialog item={makeItem({})} onClose={vi.fn()} />);
      await screen.findByText('退款来源');

      // 「来源账户」走自己的 sx
      const account = screen.getByText(/^来源账户：/);
      expect(
        ownEmotionClass(account),
        `${mode}：没读到来源账户的 emotion 局部类，断言会空转`,
      ).not.toBeNull();
      expect(
        ruleTextOf(allStyleText(), account),
        `${mode}：来源账户是辅助文字，取 text.secondary`,
      ).toContain(`color:${theme.palette.text.secondary}`);

      // 关联邮件的 secondary 行走 MUI 默认的 color="textSecondary"（Typescript 组件把
      // 这个旧名映射到同一个 palette.text.secondary），颜色落在元素自己的规则体里
      const secondary = screen
        .getByText('退款来源')
        .closest('.MuiListItemText-root')!
        .querySelector('.MuiListItemText-secondary') as HTMLElement;
      expect(secondary).not.toBeNull();
      expect(
        ownEmotionClass(secondary),
        `${mode}：没读到 secondary 行的 emotion 局部类，断言会空转`,
      ).not.toBeNull();
      expect(
        ruleTextOf(allStyleText(), secondary),
        `${mode}：关联邮件的日期/原因取 text.secondary`,
      ).toContain(`color:${theme.palette.text.secondary}`);
    }
  });

  it('段间距统一走同一个常量：三处分隔线不许各写一个 my', () => {
    // 段与段之间的分隔只用 Divider 一种，间距也只有一个数（gap-4 = 16px）。数一数
    // 源码里三处 <Divider .../> 用的都是 SECTION_DIVIDER_SX、没有任何行内 my 字面量。
    const dividerUses = source.match(/<Divider[^>]*\/>/g) ?? [];
    expect(dividerUses, '分隔线数量变了，重新核对段间距口径').toHaveLength(3);
    for (const tag of dividerUses) {
      expect(tag, `分隔线写法必须统一：${tag}`).toContain('sx={SECTION_DIVIDER_SX}');
      expect(tag, '不许某一处自己写一个行内 my').not.toContain('my:');
    }
    expect(source, '段间距常量取 gap-4（16px）').toContain('const SECTION_DIVIDER_SX = { my: 2 }');
  });

  it('删除确认框的按钮层级：取消 = text inherit，最终确认 = contained error', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return json({}, 404);
    }));

    render(
      <ItemDialog
        item={makeItem({ id: 7, email_id: null, title: '待删任务' })}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: '删除' }));
    const prompt = await screen.findByText('删除这条任务？此操作不可撤销。');
    const confirmDialog = prompt.closest('[role="dialog"]') as HTMLElement;

    const cancel = within(confirmDialog).getByRole('button', { name: '取消' });
    expect(cancel.className).toMatch(/MuiButton-text/);
    expect(cancel.className).toMatch(/MuiButton-colorInherit/);

    const confirm = within(confirmDialog).getByRole('button', { name: '删除' });
    expect(confirm.className).toMatch(/MuiButton-contained/);
    expect(confirm.className).toMatch(/MuiButton-colorError/);
  });

  it('标题栏的删除入口用 error 色（进入危险流程的入口），编辑/关闭保持 inherit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 404)));

    render(
      <ItemDialog
        item={makeItem({ id: 7, email_id: null, title: '手动任务' })}
        onClose={vi.fn()}
      />,
    );
    await screen.findByText('手动任务');

    expect(screen.getByRole('button', { name: '删除' }).className).toMatch(/MuiIconButton-colorError/);
    expect(screen.getByRole('button', { name: '编辑' }).className).toMatch(
      /MuiIconButton-colorInherit/,
    );
    expect(screen.getByRole('button', { name: '关闭' }).className).toMatch(
      /MuiIconButton-colorInherit/,
    );
  });
});

describe('ItemDialog 实色纸面上的次级文字（玻璃时代的 n9 提色已不需要）', () => {
  it('关联邮件的日期/原因 secondary 回落到 MUI 默认的 text.secondary（n7）', async () => {
    // 玻璃上 n7 对半透底只有 2.4–2.6，上一轮才把这一行提到 n9；纸面改成不透明实色后
    // n7 对 background.paper 是 6.01（见上面的对比度守卫），次级档可以正常用回来。
    vi.stubGlobal('fetch', makeFetchMock());

    renderWithAppTheme(<ItemDialog item={makeItem({})} onClose={vi.fn()} />);
    const subject = await screen.findByText('退款来源');
    const item = subject.closest('.MuiListItemText-root') as HTMLElement;
    const secondary = item.querySelector('.MuiListItemText-secondary') as HTMLElement;
    expect(secondary).not.toBeNull();
    const theme = createTheme(buildThemeOptions('light'));
    // n7 由 Typography 的 color="textSecondary" 变体下发（MUI 把这两种写法映射到同一个
    // palette.text.secondary），所以颜色落在元素自己的规则体里，直接读它。
    const own = ownEmotionClass(secondary);
    expect(own, '没读到 secondary 行的 emotion 局部类，断言会空转').not.toBeNull();
    expect(
      ruleTextOf(allStyleText(), secondary),
      '纸面改成实色后次级档要真的用回 text.secondary（n7）',
    ).toContain(`color:${theme.palette.text.secondary}`);
    expect(theme.palette.text.secondary).toBe(NEUTRAL_LIGHT[6]);
    expect(
      ruleTextOf(allStyleText(), secondary),
      '不许再把颜色抬回 text.primary（那是玻璃时代没有次级色空间的补丁）',
    ).not.toContain(`color:${theme.palette.text.primary}`);
  });
});

describe('ItemDialog 正文里的长串不把整张对话框撑出横向滚动', () => {
  // 无空格长串：URL / 订单号 / 邮箱地址这类内容没有自然断点，缺了断点就会撑宽 paper。
  // 用例走 email_id: null 的手动条目——不触发详情/邮件请求，无需 fetch mock。
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
});
