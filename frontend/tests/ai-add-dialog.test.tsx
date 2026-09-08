// AiAddDialog 测试：三阶段状态机（input → parsing → fields）+ 速记模式分流 +
// 解析失败兜底。onParse/onSubmit/onQuickSubmit 由调用方注入（组件自身不打 fetch），
// 测试用 vi.fn() 桩 + 手工 resolve/reject 的 Promise 驱动阶段切换。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import AiAddDialog from '../src/components/AiAddDialog';
import type { ItemFields, ParsedTask } from '../src/types';

/** 解析结果样例：importance/actionable 用于断言保存时透传没丢 */
const PARSED: ParsedTask = {
  title: '标题',
  summary: '详情',
  category: '工作',
  due_date: '2026-09-10',
  importance: 'high',
  actionable: false,
  reminders: [],
};

function deferred() {
  let resolve!: (parsed: ParsedTask) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<ParsedTask>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface RenderDialogOpts {
  quickMode?: boolean;
  onParse?: (text: string) => Promise<ParsedTask>;
  onSubmit?: (fields: ItemFields) => void;
  onQuickSubmit?: (text: string) => void;
}

function renderDialog(opts: RenderDialogOpts = {}) {
  const props = {
    quickMode: opts.quickMode ?? false,
    onQuickModeChange: vi.fn<(next: boolean) => void>(),
    onParse: opts.onParse ?? vi.fn(async () => PARSED),
    onSubmit: opts.onSubmit ?? vi.fn<(fields: ItemFields) => void>(),
    onQuickSubmit: opts.onQuickSubmit ?? vi.fn<(text: string) => void>(),
    submitting: false,
    onClose: vi.fn<() => void>(),
  };
  render(<AiAddDialog {...props} />);
  return props;
}

afterEach(() => {
  cleanup();
});

describe('AiAddDialog 三阶段界面', () => {
  it('初始 input 阶段：只有「说一件事」输入框，无分类 chip、无日期输入', () => {
    renderDialog();

    expect(screen.getByLabelText('要记的事')).toBeTruthy();
    // 还没解析：字段区不出现
    expect(screen.queryByLabelText('分类')).toBeNull();
    expect(screen.queryByLabelText('截止日期')).toBeNull();
    expect(document.querySelector('input[type="date"]')).toBeNull();
    // 非速记模式提示文案
    expect(screen.getByText('确定后先给你看一眼解析结果')).toBeTruthy();
  });

  it('速记开关：aria-checked 反映 quickMode；quickMode=false 时拨动调 onQuickModeChange(true)', () => {
    const props = renderDialog();

    const sw = screen.getByRole('switch', { name: '速记模式' });
    expect(sw).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(sw);
    expect(props.onQuickModeChange).toHaveBeenCalledTimes(1);
    expect(props.onQuickModeChange).toHaveBeenCalledWith(true);
  });

  it('quickMode=true 时开关 aria-checked=true，input 提示文案切换为速记版', () => {
    renderDialog({ quickMode: true });

    expect(screen.getByRole('switch', { name: '速记模式' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByText('速记模式：确定后自动添加，不再确认')).toBeTruthy();
  });

  it('非速记点「确定」→ onParse 收到 trim 后原文；resolve 前骨架可见', async () => {
    const d = deferred();
    const props = renderDialog({ onParse: vi.fn(() => d.promise) });

    fireEvent.change(screen.getByLabelText('要记的事'), { target: { value: '  交房租  ' } });
    fireEvent.click(screen.getByRole('button', { name: '确定' }));

    expect(props.onParse).toHaveBeenCalledTimes(1);
    expect(props.onParse).toHaveBeenCalledWith('交房租');
    // 解析进行中：骨架卡可见
    expect(screen.getByLabelText('正在解析')).toHaveAttribute('aria-busy', 'true');
  });

  it('resolve 后进入 fields：分类 chip 出现、标题/日期/选中分类由解析结果预填', async () => {
    const d = deferred();
    renderDialog({ onParse: vi.fn(() => d.promise) });

    fireEvent.change(screen.getByLabelText('要记的事'), { target: { value: '交房租' } });
    fireEvent.click(screen.getByRole('button', { name: '确定' }));

    await act(async () => {
      d.resolve(PARSED);
    });

    // 骨架消失，字段区出现
    expect(screen.queryByLabelText('正在解析')).toBeNull();
    expect(screen.getByRole('radiogroup', { name: '分类' })).toBeTruthy();
    // 标题框 = 标题\n详情（与 ItemEditor 处理 initial 的方式一致）
    const titleInput = screen.getByLabelText('任务内容') as HTMLTextAreaElement;
    expect(titleInput.value).toBe('标题\n详情');
    // 日期与选中分类来自解析结果
    const dateInput = screen.getByLabelText('截止日期') as HTMLInputElement;
    expect(dateInput.value).toBe('2026-09-10');
    expect(screen.getByRole('radio', { name: '工作' })).toHaveAttribute('aria-checked', 'true');
    // 重要度控件可见，AI 解析出的档位（high →「重要」）被选中
    expect(screen.getByRole('radiogroup', { name: '重要度' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: '重要' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: '普通' })).toHaveAttribute('aria-checked', 'false');
  });

  it('fields 阶段点「保存」→ onSubmit 收到解析结果，importance/actionable 透传没丢', async () => {
    const d = deferred();
    const onSubmit = vi.fn<(fields: ItemFields) => void>();
    renderDialog({ onParse: vi.fn(() => d.promise), onSubmit });

    fireEvent.change(screen.getByLabelText('要记的事'), { target: { value: '交房租' } });
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    await act(async () => {
      d.resolve(PARSED);
    });

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      title: '标题',
      summary: '详情',
      category: '工作',
      due_date: '2026-09-10',
      importance: 'high',
      actionable: false,
    });
  });

  it('fields 阶段重要度可改：把 AI 判的 high 点成「普通」再保存，载荷 importance 为 normal', async () => {
    const d = deferred();
    const onSubmit = vi.fn<(fields: ItemFields) => void>();
    renderDialog({ onParse: vi.fn(() => d.promise), onSubmit });

    fireEvent.change(screen.getByLabelText('要记的事'), { target: { value: '交房租' } });
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    await act(async () => {
      d.resolve(PARSED);
    });

    // AI 判 high：默认选中「重要」；用户改点「普通」
    expect(screen.getByRole('radio', { name: '重要' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: '普通' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      title: '标题',
      summary: '详情',
      category: '工作',
      due_date: '2026-09-10',
      importance: 'normal',
      actionable: false,
    });
  });

  it('速记模式点「确定」→ 只调 onQuickSubmit(trim)，onParse 一次都没被调用', () => {
    const props = renderDialog({ quickMode: true });

    fireEvent.change(screen.getByLabelText('要记的事'), { target: { value: '  买牛奶  ' } });
    fireEvent.click(screen.getByRole('button', { name: '确定' }));

    expect(props.onQuickSubmit).toHaveBeenCalledTimes(1);
    expect(props.onQuickSubmit).toHaveBeenCalledWith('买牛奶');
    expect(props.onParse).not.toHaveBeenCalled();
  });

  it('onParse reject → 回 input、原文保留，出现「AI 解析失败」与「按原文添加」兜底', async () => {
    const d = deferred();
    const onSubmit = vi.fn<(fields: ItemFields) => void>();
    renderDialog({ onParse: vi.fn(() => d.promise), onSubmit });

    const input = screen.getByLabelText('要记的事') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '交房租' } });
    fireEvent.click(screen.getByRole('button', { name: '确定' }));

    await act(async () => {
      d.reject(new Error('解析服务不可用'));
    });

    // 回 input 阶段：原文还在，骨架消失
    expect((screen.getByLabelText('要记的事') as HTMLTextAreaElement).value).toBe('交房租');
    expect(screen.queryByLabelText('正在解析')).toBeNull();
    expect(screen.getByText(/AI 解析失败/)).toBeTruthy();

    // 按原文直接添加：标题=原文、分类兜底「其他」、无日期
    fireEvent.click(screen.getByRole('button', { name: '按原文添加' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      title: '交房租',
      summary: '',
      category: '其他',
      due_date: null,
    });
  });

  it('输入为空或只有空白时「确定」禁用', () => {
    renderDialog();

    const confirm = screen.getByRole('button', { name: '确定' });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByLabelText('要记的事'), { target: { value: '   ' } });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByLabelText('要记的事'), { target: { value: '买牛奶' } });
    expect(confirm).toBeEnabled();
  });

  it('parsing 阶段速记开关与主按钮都禁用（正在解析，不接受二次提交）', () => {
    const d = deferred();
    renderDialog({ onParse: vi.fn(() => d.promise) });

    fireEvent.change(screen.getByLabelText('要记的事'), { target: { value: '交房租' } });
    fireEvent.click(screen.getByRole('button', { name: '确定' }));

    expect(screen.getByRole('switch', { name: '速记模式' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '确定' })).toBeDisabled();
  });

  it('主按钮文案随阶段变化：input「确定」→ fields「保存」；fields 阶段速记开关隐藏', async () => {
    const d = deferred();
    renderDialog({ onParse: vi.fn(() => d.promise) });

    expect(screen.getByRole('button', { name: '确定' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull();

    fireEvent.change(screen.getByLabelText('要记的事'), { target: { value: '交房租' } });
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    await act(async () => {
      d.resolve(PARSED);
    });

    expect(screen.getByRole('button', { name: '保存' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '确定' })).toBeNull();
    // 已进预览，速记开关没意义：隐藏
    expect(screen.queryByRole('switch', { name: '速记模式' })).toBeNull();
  });
});
