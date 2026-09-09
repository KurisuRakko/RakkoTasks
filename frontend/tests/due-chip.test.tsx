// DueChip 测试：截止日标签的三档配色与读屏文案。列表行与详情对话框共用这一个组件，
// 配色口径只在这里断言一次。

import { describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach } from 'vitest';
import DueChip from '../src/components/DueChip';
import { DUE_SOON_DAYS } from '../src/lib/grouping';
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
  it('已逾期 → 实心主色（梅）', () => {
    const chip = chipOf(inDays(-1)) as HTMLElement;
    expect(chip.className).toMatch(/MuiChip-colorPrimary/);
    expect(chip.className).toMatch(/MuiChip-filled/);
  });

  it('窗口内到期 → 描边主色；窗口最后一天仍算', () => {
    expect((chipOf(inDays(3)) as HTMLElement).className).toMatch(/MuiChip-outlined/);
    cleanup();
    const edge = chipOf(inDays(DUE_SOON_DAYS)) as HTMLElement;
    expect(edge.className).toMatch(/MuiChip-colorPrimary/);
    expect(edge.className).toMatch(/MuiChip-outlined/);
  });

  it('更远 → 中性，不带主色', () => {
    expect((chipOf(inDays(DUE_SOON_DAYS + 1)) as HTMLElement).className).not.toMatch(
      /MuiChip-colorPrimary/,
    );
  });

  it('没有截止日 → 整个标签不渲染（调用方不必自己判空）', () => {
    expect(chipOf(null)).toBeNull();
  });
});

describe('DueChip 读屏文案', () => {
  it('面上只有一个日期，读屏要能听出这是截止日以及是否逾期', () => {
    render(<DueChip item={makeItem(inDays(-1))} today={today} />);
    expect(screen.getByLabelText(/^截止 .+，已逾期$/)).toBeTruthy();
    cleanup();

    render(<DueChip item={makeItem(inDays(3))} today={today} />);
    expect(screen.getByLabelText(new RegExp(`^截止 .+，${DUE_SOON_DAYS} 天内到期$`))).toBeTruthy();
    cleanup();

    render(<DueChip item={makeItem(inDays(DUE_SOON_DAYS + 5))} today={today} />);
    const far = screen.getByLabelText(/^截止 [^，]+$/);
    expect(far).toBeTruthy();
    // 颜色不是可访问的信息通道：远期不能只靠「没上色」来表达
    expect(far.getAttribute('aria-label')).not.toContain('逾期');
  });
});
