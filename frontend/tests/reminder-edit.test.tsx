// 「已有条目的提醒无法编辑」功能空洞的修补测试：ItemEditor（真实 ItemEditor ×
// 真实 ItemFieldsForm，不 mock 组件）现在能看能改能删现有提醒，保存载荷恒带
// reminders（空数组 = 删光）；ItemDialog 把现有提醒按时间升序带进编辑器，编辑
// 保存走 PATCH 整体替换。组件一律用真实件；ItemDialog 用例只 stub fetch。
// 时刻一律经 fromDatetimeLocalValue 从本地墙上时刻构造（与组件同一套换算），
// 在哪个时区跑都自洽；对账用 toDatetimeLocalValue，不硬编码偏移。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ItemDialog from '../src/components/ItemDialog';
import ItemEditor from '../src/components/ItemEditor';
import { fromDatetimeLocalValue, toDatetimeLocalValue } from '../src/lib/time';
import type { Item, ItemFields, Reminder } from '../src/types';

/** 本地墙上时刻串 → 带偏移 ISO；测试自检：非法输入直接抛，不静默放过 */
function remind(wall: string): string {
  const iso = fromDatetimeLocalValue(wall);
  if (iso === null) throw new Error(`无法解析墙上时刻 ${wall}`);
  return iso;
}

function mkReminder(id: number, remindAt: string): Reminder {
  return { id, remind_at: remindAt };
}

/** 互不相同且远离今天/明天的时刻（2030 年，展示文案稳定） */
const R1 = remind('2030-01-05T09:30');
const R2 = remind('2030-01-05T10:30');

function makeItem(partial: Partial<Item>): Item {
  return {
    id: 7,
    email_id: null,
    email_sent_at: null,
    title: '手动任务',
    summary: null,
    category: '个人',
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

function renderEditor(opts: {
  initial?: ItemFields;
  onSubmit?: (fields: ItemFields) => void;
} = {}) {
  return render(
    <ItemEditor
      heading="编辑任务"
      initial={opts.initial}
      submitting={false}
      onSubmit={opts.onSubmit ?? vi.fn<(fields: ItemFields) => void>()}
      onClose={vi.fn()}
    />,
  );
}

/** 提醒编辑区的全部 datetime-local 行（详情页本身没有这种输入框，命中即编辑器内） */
function reminderInputs(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]'));
}

/** 无提醒的完整编辑初值 */
function baseInitial(): ItemFields {
  return { title: '买牛奶', summary: '两盒', category: '个人', due_date: null };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ItemEditor 接进提醒编辑区', () => {
  it('1. 传 initial.reminders 两项：渲染出 2 个 datetime-local，value 是本地墙上时刻', () => {
    renderEditor({ initial: { ...baseInitial(), reminders: [R1, R2] } });

    const inputs = reminderInputs();
    expect(inputs).toHaveLength(2);
    expect(inputs[0].value).toBe(toDatetimeLocalValue(R1));
    expect(inputs[1].value).toBe(toDatetimeLocalValue(R2));
  });

  it('2a. 新建（不传 initial）：提醒编辑区仍渲染（onRemindersChange 已接），但 0 行', () => {
    renderEditor({});

    expect(screen.getByText('提醒')).toBeTruthy();
    expect(screen.getByRole('button', { name: '加提醒' })).toBeTruthy();
    expect(reminderInputs()).toHaveLength(0);
  });

  it('2b. 新建场景点「加提醒」：加出一行（明天 10:00 的默认时刻）', () => {
    renderEditor({});

    fireEvent.click(screen.getByRole('button', { name: '加提醒' }));

    const inputs = reminderInputs();
    expect(inputs).toHaveLength(1);
    const value = inputs[0].value;
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T10:00$/);
    // 默认时刻 = 明天（本地日期分量，与 ItemFieldsForm 的 tomorrowDefaultReminder 同口径）
    const t = new Date();
    t.setDate(t.getDate() + 1);
    const pad = (n: number) => String(n).padStart(2, '0');
    expect(value.startsWith(`${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`)).toBe(
      true,
    );
  });

  it('3. 删掉一个提醒后按「保存」：onSubmit 载荷的 reminders 恰好剩另一个', () => {
    const onSubmit = vi.fn<(fields: ItemFields) => void>();
    renderEditor({ initial: { ...baseInitial(), reminders: [R1, R2] }, onSubmit });

    fireEvent.click(screen.getByRole('button', { name: '删除提醒 1' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0].reminders).toEqual([R2]);
  });

  it('4. 把最后一个提醒删掉再保存：载荷里 reminders 是 []（不是 undefined、不是缺键）', () => {
    const onSubmit = vi.fn<(fields: ItemFields) => void>();
    renderEditor({ initial: { ...baseInitial(), reminders: [R1] }, onSubmit });

    fireEvent.click(screen.getByRole('button', { name: '删除提醒 1' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    // 缺键/undefined 时 toEqual([]) 同样失败，这一条同时钉死「键在且为空数组」
    expect(onSubmit.mock.calls[0][0].reminders).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(onSubmit.mock.calls[0][0], 'reminders')).toBe(
      true,
    );
  });

  it('5. 完全不动提醒直接保存：载荷 reminders 与 initial.reminders 一致', () => {
    const onSubmit = vi.fn<(fields: ItemFields) => void>();
    renderEditor({ initial: { ...baseInitial(), reminders: [R1, R2] }, onSubmit });

    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0].reminders).toEqual([R1, R2]);
  });
});

describe('ItemDialog 把现有提醒带进编辑器', () => {
  it('6. 带 2 个提醒的条目点「编辑」：编辑器里能看到那 2 个提醒（行数与 value）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL) => json({}, 404)),
    );

    render(
      <ItemDialog
        item={makeItem({
          reminders: [mkReminder(1, R1), mkReminder(2, R2)],
        })}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    await screen.findByLabelText('任务内容');

    const inputs = reminderInputs();
    expect(inputs).toHaveLength(2);
    expect(inputs[0].value).toBe(toDatetimeLocalValue(R1));
    expect(inputs[1].value).toBe(toDatetimeLocalValue(R2));
  });

  it('7. 编辑器里删掉一个提醒并保存：PATCH /api/items/{id} 请求体 reminders 恰好 1 项且带偏移', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === 'PATCH' && u === '/api/items/7') {
        return json(makeItem({}));
      }
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ItemDialog
        item={makeItem({
          reminders: [mkReminder(1, R1), mkReminder(2, R2)],
        })}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    await screen.findByLabelText('任务内容');
    fireEvent.click(screen.getByRole('button', { name: '删除提醒 2' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([url, init]) => String(url) === '/api/items/7' && (init as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(patchCall).toBeDefined();
      const body = JSON.parse(String((patchCall![1] as RequestInit).body));
      expect(body.reminders).toHaveLength(1);
      expect(body.reminders[0]).toMatch(/[+-]\d{2}:\d{2}$/);
      expect(toDatetimeLocalValue(body.reminders[0])).toBe(toDatetimeLocalValue(R1));
    });
  });

  it('9. 提醒故意乱序喂进 ItemDialog：编辑器里第一行是最早的那个（升序初始化）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL) => json({}, 404)),
    );

    render(
      <ItemDialog
        item={makeItem({
          reminders: [mkReminder(2, R2), mkReminder(1, R1)], // 晚的在前，乱序
        })}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    await screen.findByLabelText('任务内容');

    const inputs = reminderInputs();
    expect(inputs).toHaveLength(2);
    expect(inputs[0].value).toBe(toDatetimeLocalValue(R1));
    expect(inputs[1].value).toBe(toDatetimeLocalValue(R2));
  });
});
