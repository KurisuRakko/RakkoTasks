// 提醒 UI 集成测试：ItemFieldsForm 的提醒行编辑（增/删/改/清空、排序去重出参、
// 上限与默认时刻）、TasksPage 列表行不再渲染提醒 chip、ItemDialog 详情
// 的只读提醒列表、AiAddDialog 解析结果预填提醒并随保存载荷提交。
//
// 时刻一律经 fromDatetimeLocalValue 从本地墙上时刻构造（与组件同一套换算），
// 用例运行在哪个时区都自洽：往返断言用 toDatetimeLocalValue 对账，不硬编码偏移。
// 展示断言用远离今天的 2030 年时刻，formatReminder 输出稳定的「M月D日 HH:MM」，
// 不赌相对词边界。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AiAddDialog from '../src/components/AiAddDialog';
import ItemDialog from '../src/components/ItemDialog';
import ItemFieldsForm from '../src/components/ItemFieldsForm';
import TasksPage from '../src/pages/TasksPage';
import { resetLists } from '../src/lib/list-cache';
import {
  formatReminder,
  fromDatetimeLocalValue,
  toDatetimeLocalValue,
} from '../src/lib/time';
import type { Category, Importance, Item, ItemFields, ParsedTask, Reminder } from '../src/types';

/** 本地墙上时刻串 → 带偏移 ISO；测试自检：非法输入直接抛，不静默放过 */
function remind(wall: string): string {
  const iso = fromDatetimeLocalValue(wall);
  if (iso === null) throw new Error(`无法解析墙上时刻 ${wall}`);
  return iso;
}

function mkReminder(id: number, remindAt: string): Reminder {
  return { id, remind_at: remindAt };
}

/** 两个互不相同且远离今天/明天的时刻（2030 年，formatReminder 输出稳定） */
const R1 = remind('2030-01-05T09:30');
const R2 = remind('2030-01-05T10:30');

function makeItem(partial: Partial<Item>): Item {
  return {
    id: 1,
    email_id: 1,
    email_sent_at: null,
    title: 't',
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

/** 明天的 YYYY-MM-DD（本地分量） */
function tomorrowIso(): string {
  const t = new Date();
  t.setDate(t.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

function renderForm(opts: {
  reminders?: string[];
  onRemindersChange?: (next: string[]) => void;
} = {}) {
  const props = {
    text: '买牛奶',
    category: '个人' as Category,
    importance: 'normal' as Importance,
    onImportanceChange: vi.fn<(next: Importance) => void>(),
    date: '',
    invalid: false,
    helper: '',
    onTextChange: vi.fn<(next: string) => void>(),
    onCategoryChange: vi.fn<(next: Category) => void>(),
    onDateChange: vi.fn<(next: string) => void>(),
    reminders: opts.reminders ?? [],
    onRemindersChange: opts.onRemindersChange ?? vi.fn<(next: string[]) => void>(),
  };
  render(<ItemFieldsForm {...props} />);
  return props;
}

function reminderInputs(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]'));
}

/** 无提醒的解析样例（保存载荷形状的既有断言依赖它） */
const PARSED: ParsedTask = {
  title: '标题',
  summary: '详情',
  category: '工作',
  due_date: null,
  importance: 'normal',
  actionable: true,
  reminders: [],
};

function renderDialog(opts: {
  onParse?: (text: string) => Promise<ParsedTask[]>;
  onSubmit?: (fieldsList: ItemFields[]) => void;
} = {}) {
  const props = {
    open: true,
    quickMode: false,
    onQuickModeChange: vi.fn<(next: boolean) => void>(),
    onParse: opts.onParse ?? vi.fn(async () => [PARSED]),
    onSubmit: opts.onSubmit ?? vi.fn<(fieldsList: ItemFields[]) => void>(),
    onQuickSubmit: vi.fn<(text: string) => void>(),
    submitting: false,
    onClose: vi.fn<() => void>(),
  };
  render(<AiAddDialog {...props} />);
  return props;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ItemFieldsForm 提醒行编辑', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('1. 传 2 个提醒：渲染 2 个 datetime-local 输入框，value 是对应本地墙上时刻', () => {
    renderForm({ reminders: [R1, R2] });

    const inputs = reminderInputs();
    expect(inputs).toHaveLength(2);
    expect(inputs[0].value).toBe(toDatetimeLocalValue(R1));
    expect(inputs[1].value).toBe(toDatetimeLocalValue(R2));
    // 行删除按钮序号从 1 起
    expect(screen.getByRole('button', { name: '删除提醒 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除提醒 2' })).toBeTruthy();
  });

  it('2. 点「加提醒」：出参多一项，新项是明天 10:00 的本地时刻', () => {
    const onChange = vi.fn<(next: string[]) => void>();
    renderForm({ reminders: [R1, R2], onRemindersChange: onChange });

    fireEvent.click(screen.getByRole('button', { name: '加提醒' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next).toHaveLength(3);
    expect(reminderInputs()).toHaveLength(3);
    // 新项 = 明天 DEFAULT_REMIND_HOUR 点：本地墙上值以明天日期开头、以 T10:00 结尾
    const added = next.find((iso) => {
      const v = toDatetimeLocalValue(iso);
      return v.startsWith(tomorrowIso()) && v.endsWith('T10:00');
    });
    expect(added).toBeDefined();
  });

  it('3. 已有 5 个提醒：「加提醒」禁用，旁示「最多 5 个」', () => {
    const five = [
      remind('2030-02-01T09:00'),
      remind('2030-02-02T09:00'),
      remind('2030-02-03T09:00'),
      remind('2030-02-04T09:00'),
      remind('2030-02-05T09:00'),
    ];
    renderForm({ reminders: five });

    const add = screen.getByRole('button', { name: '加提醒' });
    expect(add).toBeDisabled();
    expect(screen.getByText('最多 5 个')).toBeTruthy();
  });

  it('4. 点行删除按钮：出参少一项，剩下的还是原来那条时刻', () => {
    const onChange = vi.fn<(next: string[]) => void>();
    renderForm({ reminders: [R1, R2], onRemindersChange: onChange });

    fireEvent.click(screen.getByRole('button', { name: '删除提醒 1' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next).toHaveLength(1);
    expect(toDatetimeLocalValue(next[0])).toBe(toDatetimeLocalValue(R2));
  });

  it('5. 改某一行的时刻：出参里该项是带偏移的 ISO 串', () => {
    const onChange = vi.fn<(next: string[]) => void>();
    renderForm({ reminders: [R1, R2], onRemindersChange: onChange });

    fireEvent.change(reminderInputs()[0], { target: { value: '2030-01-06T14:05' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next).toHaveLength(2);
    // 原 R1 行被改成 1 月 6 日（晚于 R2 的 1 月 5 日）：排序后新值在末位，且带时区偏移
    expect(next[1]).toBe(remind('2030-01-06T14:05'));
    expect(next[1]).toMatch(/[+-]\d{2}:\d{2}$/);
    expect(toDatetimeLocalValue(next[0])).toBe(toDatetimeLocalValue(R2));
  });

  it('6. 出参按时间升序且去重：改早于首行的时刻顺序反转；改成相同只剩一项', () => {
    const onChange = vi.fn<(next: string[]) => void>();
    renderForm({ reminders: [R1, R2], onRemindersChange: onChange });

    // 把第二行改成比第一行（01-05 09:30）更早 → 出参顺序反转
    fireEvent.change(reminderInputs()[1], { target: { value: '2030-01-05T08:00' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    let next = onChange.mock.calls[0][0];
    expect(next).toHaveLength(2);
    expect(next[0]).toBe(remind('2030-01-05T08:00'));
    expect(toDatetimeLocalValue(next[1])).toBe(toDatetimeLocalValue(R1));

    // 再把第二行改成与第一行相同 → 出参只剩一项
    fireEvent.change(reminderInputs()[1], { target: { value: '2030-01-05T09:30' } });
    expect(onChange).toHaveBeenCalledTimes(2);
    next = onChange.mock.calls[1][0];
    expect(next).toHaveLength(1);
    expect(toDatetimeLocalValue(next[0])).toBe(toDatetimeLocalValue(R1));
  });

  it('7. 清空某一行：该项从出参消失，但输入框还在（行不被抽走）', () => {
    const onChange = vi.fn<(next: string[]) => void>();
    renderForm({ reminders: [R1, R2], onRemindersChange: onChange });

    fireEvent.change(reminderInputs()[0], { target: { value: '' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next).toHaveLength(1);
    expect(toDatetimeLocalValue(next[0])).toBe(toDatetimeLocalValue(R2));
    // 输入框仍为两行，被清空的那行留在原地（value 为空）
    const inputs = reminderInputs();
    expect(inputs).toHaveLength(2);
    expect(inputs[0].value).toBe('');
  });
});

describe('TasksPage 列表行不再有提醒 chip', () => {
  beforeEach(() => {
    localStorage.clear();
    resetLists();
  });

  it('9. 同时有提醒和截止日期：行内只剩截止 chip，提醒只在详情对话框展示', async () => {
    const items: Item[] = [
      makeItem({
        id: 1,
        title: '两个都有',
        due_date: '2030-06-01',
        reminders: [mkReminder(1, R1)],
      }),
    ];
    vi.stubGlobal('fetch', vi.fn(async () => json({ items })));

    render(
      <MemoryRouter useTransitions={false}>
        <TasksPage />
      </MemoryRouter>,
    );
    await screen.findByText('两个都有');

    const row = screen.getByText('两个都有').closest('li') as HTMLElement;
    expect(row).not.toBeNull();
    // 列表行不再渲染提醒 chip：提醒信息只在详情对话框（ItemDialog 只读提醒列表）展示
    expect(within(row).queryByLabelText(/^提醒 /)).toBeNull();
    expect(within(row).queryByText(/🔔/)).toBeNull();
    // 截止 chip 保留
    expect(within(row).getByText('6月1日')).toBeTruthy();
  });
});

describe('ItemDialog 详情里的提醒列表', () => {
  it('10. 有提醒：出现「提醒列表」，行数等于提醒数且按升序；无提醒：整块不渲染', () => {
    // 手动条目：不发任何请求；提醒乱序喂（R2 晚于 R1），展示必须升序
    render(
      <ItemDialog
        item={makeItem({
          id: 1,
          email_id: null,
          title: '带提醒条目',
          reminders: [mkReminder(2, R2), mkReminder(1, R1)],
        })}
        onClose={vi.fn()}
      />,
    );

    const list = screen.getByLabelText('提醒列表');
    const rows = within(list).getAllByText(/🔔/);
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toBe(`🔔 ${formatReminder(R1)}`);
    expect(rows[1].textContent).toBe(`🔔 ${formatReminder(R2)}`);
  });

  it('10b. 无提醒的条目：提醒列表整块不渲染', () => {
    render(
      <ItemDialog
        item={makeItem({ id: 1, email_id: null, title: '无提醒条目' })}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText('提醒列表')).toBeNull();
  });
});

describe('AiAddDialog 的提醒预填与保存', () => {
  function deferred() {
    let resolve!: (parsed: ParsedTask[]) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<ParsedTask[]>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it('11. onParse 返回带 2 个 reminders：fields 阶段渲染 2 行；保存载荷带那两个带偏移串', async () => {
    const parsed: ParsedTask = {
      title: '交房租',
      summary: '',
      category: '个人',
      due_date: null,
      importance: 'normal',
      actionable: true,
      reminders: [R1, R2],
    };
    const d = deferred();
    const onSubmit = vi.fn<(fieldsList: ItemFields[]) => void>();
    renderDialog({ onParse: vi.fn(() => d.promise), onSubmit });

    fireEvent.change(screen.getByLabelText('待办内容'), { target: { value: '交房租' } });
    fireEvent.click(screen.getByRole('button', { name: '解析' }));
    await act(async () => {
      d.resolve([parsed]);
    });

    // fields 阶段：提醒编辑区出现，解析出的两个时刻各占一行
    await screen.findByLabelText('任务内容');
    const reminderBoxes = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]'),
    );
    expect(reminderBoxes).toHaveLength(2);
    expect(reminderBoxes[0].value).toBe(toDatetimeLocalValue(R1));
    expect(reminderBoxes[1].value).toBe(toDatetimeLocalValue(R2));

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toHaveLength(1);
    expect(onSubmit.mock.calls[0][0][0].reminders).toEqual([R1, R2]);
  });

  it('12. input 阶段没有提醒编辑区（查不到「加提醒」与 datetime-local 输入框）', () => {
    renderDialog();

    expect(screen.queryByRole('button', { name: '加提醒' })).toBeNull();
    expect(document.querySelector('input[type="datetime-local"]')).toBeNull();
  });

  it('13. 解析失败走「按原文保存」：onSubmit 载荷不含 reminders', async () => {
    const d = deferred();
    const onSubmit = vi.fn<(fieldsList: ItemFields[]) => void>();
    renderDialog({ onParse: vi.fn(() => d.promise), onSubmit });

    fireEvent.change(screen.getByLabelText('待办内容'), { target: { value: '交房租' } });
    fireEvent.click(screen.getByRole('button', { name: '解析' }));
    await act(async () => {
      d.reject(new Error('解析服务不可用'));
    });

    fireEvent.click(screen.getByRole('button', { name: '按原文保存' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toEqual([
      { title: '交房租', summary: '', category: '其他', due_date: null },
    ]);
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('reminders');
  });
});
