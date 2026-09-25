// DueChip 测试：截止日标签的三档语义配色、行内小标签的度量（label-12 / 22px）与读屏文案。
// 列表行与详情对话框共用这一个组件，配色与尺寸的口径只在这里断言一次。

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import DueChip from '../src/components/DueChip';
import { DUE_SOON_DAYS } from '../src/lib/grouping';
import { ROW_CHIP_HEIGHT_PX } from '../src/lib/surface';
import { allStyleText, ownRules, renderWithAppTheme } from './glass-text-contrast.test-utils';
import type { Item } from '../src/types';

/** 固定 today：2026-08-05（本地时区） */
const today = new Date(2026, 7, 5);

function inDays(n: number): string {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + n);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function makeItem(due: string | null): Item {
  return {
    id: 1,
    email_id: 1,
    email_sent_at: null,
    title: 't',
    summary: null,
    category: '工作',
    due_date: due,
    importance: 'normal',
    actionable: true,
    status: 'open',
    detail_md: null,
    related: [],
    reminders: [],
    created_at: '2026-08-01T00:00:00Z',
    done_at: null,
  };
}

function chipOf(due: string | null): HTMLElement | null {
  const { container } = render(<DueChip item={makeItem(due)} today={today} />);
  return container.querySelector('.MuiChip-root');
}

afterEach(cleanup);

describe('DueChip 配色三档', () => {
  it('已逾期 → 实心 error（语义就是已经出事了）', () => {
    const chip = chipOf(inDays(-1)) as HTMLElement;
    expect(chip.className).toMatch(/MuiChip-colorError/);
    expect(chip.className).toMatch(/MuiChip-filled/);
    // 蓝色系（回退成 primary 主色）不再代表逾期：accent 是焦点色，不是语义色
    expect(chip.className).not.toMatch(/MuiChip-colorPrimary/);
  });

  it('今天到期 → 描边 warning；窗口内但还没到今天的仍是中性', () => {
    const todayChip = chipOf(inDays(0)) as HTMLElement;
    expect(todayChip.className).toMatch(/MuiChip-colorWarning/);
    expect(todayChip.className).toMatch(/MuiChip-outlined/);
    expect(todayChip.className).not.toMatch(/MuiChip-colorPrimary/);
    expect(todayChip.className).not.toMatch(/MuiChip-colorError/);
    cleanup();

    // 明天到期不再是「临期」：旧口径的 DUE_SOON_DAYS 窗口把警告常态化了，
    // 现在中档只锚「就是今天」这一格
    const tomorrow = chipOf(inDays(1)) as HTMLElement;
    expect(tomorrow.className).not.toMatch(/MuiChip-colorWarning/);
    expect(tomorrow.className).not.toMatch(/MuiChip-colorError/);
    cleanup();

    // 窗口最后一天同样只是中性（DUE_SOON_DAYS 仍是分组逻辑的口径，与配色无关）
    const edge = chipOf(inDays(DUE_SOON_DAYS)) as HTMLElement;
    expect(edge.className).toMatch(/MuiChip-colorDefault/);
    expect(edge.className).not.toMatch(/MuiChip-colorWarning/);
  });

  it('更远 → 中性（default 色、无任何语义色），档位形态与改配色之前一致', () => {
    const chip = chipOf(inDays(DUE_SOON_DAYS + 1)) as HTMLElement;
    expect(chip.className).toMatch(/MuiChip-colorDefault/);
    expect(chip.className).toMatch(/MuiChip-filled/);
    expect(chip.className).not.toMatch(/MuiChip-colorPrimary/);
    expect(chip.className).not.toMatch(/MuiChip-colorWarning/);
    expect(chip.className).not.toMatch(/MuiChip-colorError/);
  });

  it('没有截止日 → 整个标签不渲染（调用方不必自己判空）', () => {
    expect(chipOf(null)).toBeNull();
  });
});

describe('DueChip 行内小标签的度量', () => {
  it('字阶与盒高走 label-12 / 22px：与行左侧今日点、勾选框共用标题首行中线', () => {
    const chip = chipOf(inDays(0)) as HTMLElement;
    const rule = ownRules(allStyleText(), chip);
    // 断言容器要先证明真的读到了 chip 自己的规则，否则下面的 toContain 全是假通过
    expect(rule, '没读到 chip 自身的 css-* 规则，断言会空转').not.toBe('');
    // 12px 是契约字阶上最小的一档（label-12）；11px（0.6875rem）不在字阶上
    expect(rule, '字号取契约 label-12').toContain('font-size:12px');
    expect(rule, '字号不许回落到 11px').not.toContain('font-size:0.6875rem');
    // 22px = 标题首行行盒（copy-14 的 14 × 1.57 → 22），三列元素压在同一条中线上
    expect(rule, '盒高与标题首行同高（22px）').toContain(`height:${ROW_CHIP_HEIGHT_PX}px`);
  });

  it('chip 圆角来自主题层（RADIUS.chip），组件自己不重复写一份', () => {
    // 用真实应用主题渲染：圆角的唯一来源是 theme.ts 的 MuiChip.root =
    // RADIUS.chip（4px）。组件里再写一份就成了两处会各自漂移的数字；哪天主题层把
    // 这条删了，chip 会静默退回 MUI 的 16px 药丸，这条断言先红。
    renderWithAppTheme(<DueChip item={makeItem(inDays(0))} today={today} />);
    const chip = document.querySelector('.MuiChip-root') as HTMLElement;
    expect(chip).not.toBeNull();
    const rule = ownRules(allStyleText(), chip);
    expect(rule, 'chip 圆角必须由主题层的 MuiChip.root 下发').toContain('border-radius:4px');
  });
});

describe('DueChip 读屏文案', () => {
  it('面上只有一个日期，读屏要能听出这是截止日以及是否逾期/今天到期', () => {
    render(<DueChip item={makeItem(inDays(-1))} today={today} />);
    expect(screen.getByLabelText(/^截止 .+，已逾期$/)).toBeTruthy();
    cleanup();

    render(<DueChip item={makeItem(inDays(0))} today={today} />);
    expect(screen.getByLabelText(/^截止 .+，今天到期$/)).toBeTruthy();
    cleanup();

    render(<DueChip item={makeItem(inDays(DUE_SOON_DAYS + 5))} today={today} />);
    const far = screen.getByLabelText(/^截止 [^，]+$/);
    expect(far).toBeTruthy();
    // 颜色不是可访问的信息通道：远期不能只靠「没上色」来表达
    expect(far.getAttribute('aria-label')).not.toContain('逾期');
    expect(far.getAttribute('aria-label')).not.toContain('今天到期');
  });
});
