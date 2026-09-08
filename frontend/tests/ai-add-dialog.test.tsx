// AiAddDialog 测试：三阶段状态机（input → parsing → fields）+ 速记模式分流 +
// 解析失败兜底。onParse/onSubmit/onQuickSubmit 由调用方注入（组件自身不打 fetch），
// 测试用 vi.fn() 桩 + 手工 resolve/reject 的 Promise 驱动阶段切换。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AiAddDialog from '../src/components/AiAddDialog';
import type { ItemFields, ParsedTask } from '../src/types';
import { MOTION } from '../src/rakko-tokens';

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
  let resolve!: (parsed: ParsedTask[]) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<ParsedTask[]>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface RenderDialogOpts {
  quickMode?: boolean;
  open?: boolean;
  onParse?: (text: string) => Promise<ParsedTask[]>;
  onSubmit?: (fieldsList: ItemFields[]) => void;
  onQuickSubmit?: (text: string) => void;
}

function renderDialog(opts: RenderDialogOpts = {}) {
  const props = {
    open: opts.open ?? true,
    quickMode: opts.quickMode ?? false,
    onQuickModeChange: vi.fn<(next: boolean) => void>(),
    onParse: opts.onParse ?? vi.fn(async () => [PARSED]),
    onSubmit: opts.onSubmit ?? vi.fn<(fieldsList: ItemFields[]) => void>(),
    onQuickSubmit: opts.onQuickSubmit ?? vi.fn<(text: string) => void>(),
    submitting: false,
    onClose: vi.fn<() => void>(),
  };
  const view = render(<AiAddDialog {...props} />);
  return { ...props, view };
}

afterEach(() => {
  cleanup();
});

describe('AiAddDialog 三阶段界面', () => {
  it('初始 input 阶段：只有「待办内容」输入框，无分类 chip、无日期输入', () => {
    renderDialog();

    expect(screen.getByLabelText('待办内容')).toBeTruthy();
    // 还没解析：字段区不出现
    expect(screen.queryByLabelText('分类')).toBeNull();
    expect(screen.queryByLabelText('截止日期')).toBeNull();
    expect(document.querySelector('input[type="date"]')).toBeNull();
    // 非速记模式提示文案
    expect(screen.getByText('提交后可先确认识别结果再保存')).toBeTruthy();
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
    expect(screen.getByText('速记模式已开启，提交后直接保存')).toBeTruthy();
  });

  it('非速记点「解析」→ onParse 收到 trim 后原文；resolve 前骨架可见', async () => {
    const d = deferred();
    const props = renderDialog({ onParse: vi.fn(() => d.promise) });

    fireEvent.change(screen.getByLabelText('待办内容'), { target: { value: '  交房租  ' } });
    fireEvent.click(screen.getByRole('button', { name: '解析' }));

    expect(props.onParse).toHaveBeenCalledTimes(1);
    expect(props.onParse).toHaveBeenCalledWith('交房租');
    // 解析进行中：骨架卡可见
    expect(screen.getByLabelText('正在识别')).toHaveAttribute('aria-busy', 'true');
  });

  it('resolve 后进入 fields：分类 chip 出现、标题/日期/选中分类由解析结果预填', async () => {
    const d = deferred();
    renderDialog({ onParse: vi.fn(() => d.promise) });

    fireEvent.change(screen.getByLabelText('待办内容'), { target: { value: '交房租' } });
    fireEvent.click(screen.getByRole('button', { name: '解析' }));

    await act(async () => {
      d.resolve([PARSED]);
    });

    // 骨架消失，字段区出现
    expect(screen.queryByLabelText('正在识别')).toBeNull();
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
    const onSubmit = vi.fn<(fieldsList: ItemFields[]) => void>();
    renderDialog({ onParse: vi.fn(() => d.promise), onSubmit });

    fireEvent.change(screen.getByLabelText('待办内容'), { target: { value: '交房租' } });
    fireEvent.click(screen.getByRole('button', { name: '解析' }));
    await act(async () => {
      d.resolve([PARSED]);
    });

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith([
      {
        title: '标题',
        summary: '详情',
        category: '工作',
        due_date: '2026-09-10',
        importance: 'high',
        actionable: false,
      },
    ]);
  });

  it('fields 阶段重要度可改：把 AI 判的 high 点成「普通」再保存，载荷 importance 为 normal', async () => {
    const d = deferred();
    const onSubmit = vi.fn<(fieldsList: ItemFields[]) => void>();
    renderDialog({ onParse: vi.fn(() => d.promise), onSubmit });

    fireEvent.change(screen.getByLabelText('待办内容'), { target: { value: '交房租' } });
    fireEvent.click(screen.getByRole('button', { name: '解析' }));
    await act(async () => {
      d.resolve([PARSED]);
    });

    // AI 判 high：默认选中「重要」；用户改点「普通」
    expect(screen.getByRole('radio', { name: '重要' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: '普通' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith([
      {
        title: '标题',
        summary: '详情',
        category: '工作',
        due_date: '2026-09-10',
        importance: 'normal',
        actionable: false,
      },
    ]);
  });

  it('速记模式点「解析」→ 只调 onQuickSubmit(trim)，onParse 一次都没被调用', () => {
    const props = renderDialog({ quickMode: true });

    fireEvent.change(screen.getByLabelText('待办内容'), { target: { value: '  买牛奶  ' } });
    fireEvent.click(screen.getByRole('button', { name: '解析' }));

    expect(props.onQuickSubmit).toHaveBeenCalledTimes(1);
    expect(props.onQuickSubmit).toHaveBeenCalledWith('买牛奶');
    expect(props.onParse).not.toHaveBeenCalled();
  });

  it('onParse reject → 回 input、原文保留，出现「未能识别内容」与「按原文保存」兜底', async () => {
    const d = deferred();
    const onSubmit = vi.fn<(fieldsList: ItemFields[]) => void>();
    renderDialog({ onParse: vi.fn(() => d.promise), onSubmit });

    const input = screen.getByLabelText('待办内容') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '交房租' } });
    fireEvent.click(screen.getByRole('button', { name: '解析' }));

    await act(async () => {
      d.reject(new Error('解析服务不可用'));
    });

    // 回 input 阶段：原文还在，骨架消失
    expect((screen.getByLabelText('待办内容') as HTMLTextAreaElement).value).toBe('交房租');
    expect(screen.queryByLabelText('正在识别')).toBeNull();
    expect(screen.getByText(/未能识别内容/)).toBeTruthy();

    // 按原文直接添加：标题=原文、分类兜底「其他」、无日期
    fireEvent.click(screen.getByRole('button', { name: '按原文保存' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith([
      { title: '交房租', summary: '', category: '其他', due_date: null },
    ]);
  });

  it('输入为空或只有空白时「解析」禁用', () => {
    renderDialog();

    const confirm = screen.getByRole('button', { name: '解析' });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByLabelText('待办内容'), { target: { value: '   ' } });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByLabelText('待办内容'), { target: { value: '买牛奶' } });
    expect(confirm).toBeEnabled();
  });

  it('parsing 阶段速记开关与主按钮都禁用（正在解析，不接受二次提交）', () => {
    const d = deferred();
    renderDialog({ onParse: vi.fn(() => d.promise) });

    fireEvent.change(screen.getByLabelText('待办内容'), { target: { value: '交房租' } });
    fireEvent.click(screen.getByRole('button', { name: '解析' }));

    expect(screen.getByRole('switch', { name: '速记模式' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '解析' })).toBeDisabled();
  });

  it('主按钮文案随阶段变化：input「解析」→ fields「保存」；fields 阶段速记开关隐藏', async () => {
    const d = deferred();
    renderDialog({ onParse: vi.fn(() => d.promise) });

    expect(screen.getByRole('button', { name: '解析' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull();

    fireEvent.change(screen.getByLabelText('待办内容'), { target: { value: '交房租' } });
    fireEvent.click(screen.getByRole('button', { name: '解析' }));
    await act(async () => {
      d.resolve([PARSED]);
    });

    expect(screen.getByRole('button', { name: '保存' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '解析' })).toBeNull();
    // 已进预览，速记开关没意义：隐藏
    expect(screen.queryByRole('switch', { name: '速记模式' })).toBeNull();
  });
});


// ── 一段话多条：列表预览 ───────────────────────────────────────

/** 三条解析结果，标题各不同，用来断言顺序、删除与逐条编辑 */
const THREE: ParsedTask[] = [
  { ...PARSED, title: '买奶茶', summary: '', due_date: null },
  { ...PARSED, title: '接斯卡蒂', summary: '', due_date: null },
  { ...PARSED, title: '卖 TQQQ', summary: '', due_date: null },
];

async function renderWithTasks(tasks: ParsedTask[], onSubmit = vi.fn<(f: ItemFields[]) => void>()) {
  const d = deferred();
  const props = renderDialog({ onParse: vi.fn(() => d.promise), onSubmit });
  fireEvent.change(screen.getByLabelText('待办内容'), { target: { value: '一段话' } });
  fireEvent.click(screen.getByRole('button', { name: '解析' }));
  await act(async () => {
    d.resolve(tasks);
  });
  return props;
}

describe('AiAddDialog 多条解析结果', () => {
  it('三条 → 列成三行，默认全部收起（不铺三整套表单）', async () => {
    await renderWithTasks(THREE);

    expect(screen.getByText('识别出 3 条，点开可修改')).toBeTruthy();
    const list = screen.getByRole('list', { name: '识别结果' });
    expect(within(list).getAllByRole('button', { name: /^第 \d 条：/ })).toHaveLength(3);
    expect(screen.getByRole('button', { name: '第 1 条：买奶茶' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '第 3 条：卖 TQQQ' })).toBeTruthy();
    // 全部收起：字段区一个都没铺开
    expect(screen.queryByLabelText('任务内容')).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: '分类' })).toBeNull();
  });

  it('点开某一行才出现该条的字段区，再点收起', async () => {
    await renderWithTasks(THREE);

    fireEvent.click(screen.getByRole('button', { name: '第 2 条：接斯卡蒂' }));
    const textarea = screen.getByLabelText('任务内容') as HTMLTextAreaElement;
    expect(textarea.value).toBe('接斯卡蒂');
    expect(screen.getByRole('radiogroup', { name: '分类' })).toBeTruthy();

    const row = screen.getByRole('button', { name: '第 2 条：接斯卡蒂' });
    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'false');
    // Collapse 是 unmountOnExit：收起动画跑完才真的移出 DOM
    await waitFor(() => expect(screen.queryByLabelText('任务内容')).toBeNull());
  });

  it('「保存」一次交出全部三条，顺序与解析结果一致', async () => {
    const onSubmit = vi.fn<(f: ItemFields[]) => void>();
    await renderWithTasks(THREE, onSubmit);

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0].map((f) => f.title)).toEqual([
      '买奶茶',
      '接斯卡蒂',
      '卖 TQQQ',
    ]);
  });

  it('删掉解析错的那条：行数减一，保存载荷里也没有它', async () => {
    const onSubmit = vi.fn<(f: ItemFields[]) => void>();
    await renderWithTasks(THREE, onSubmit);

    fireEvent.click(screen.getByRole('button', { name: '删除第 2 条' }));
    expect(screen.getByText('识别出 2 条，点开可修改')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /接斯卡蒂/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSubmit.mock.calls[0][0].map((f) => f.title)).toEqual(['买奶茶', '卖 TQQQ']);
  });

  it('删到只剩一条时退回单条表单（不再套列表壳）', async () => {
    await renderWithTasks(THREE);

    fireEvent.click(screen.getByRole('button', { name: '删除第 3 条' }));
    fireEvent.click(screen.getByRole('button', { name: '删除第 2 条' }));

    expect(screen.queryByRole('list', { name: '识别结果' })).toBeNull();
    expect((screen.getByLabelText('任务内容') as HTMLTextAreaElement).value).toBe('买奶茶');
  });

  it('改某一行的标题后保存：只有那条变了，其余原样', async () => {
    const onSubmit = vi.fn<(f: ItemFields[]) => void>();
    await renderWithTasks(THREE, onSubmit);

    fireEvent.click(screen.getByRole('button', { name: '第 1 条：买奶茶' }));
    fireEvent.change(screen.getByLabelText('任务内容'), { target: { value: '买两杯奶茶' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(onSubmit.mock.calls[0][0].map((f) => f.title)).toEqual([
      '买两杯奶茶',
      '接斯卡蒂',
      '卖 TQQQ',
    ]);
  });

  it('任一行非法则「保存」禁用，且该行在收起态就标出错误', async () => {
    await renderWithTasks(THREE);

    fireEvent.click(screen.getByRole('button', { name: '第 2 条：接斯卡蒂' }));
    fireEvent.change(screen.getByLabelText('任务内容'), { target: { value: '   ' } });

    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    // 行首那条摘要直接换成错误文案：「保存」灰着时用户看得出该点开哪一条
    const row = screen.getByRole('button', { name: /^第 2 条：/ });
    expect(within(row).getByText('第一行不能为空')).toBeTruthy();
    // 另外两行没被误标
    expect(within(screen.getByRole('button', { name: /^第 1 条：/ })).getByText('买奶茶')).toBeTruthy();
  });
});

// ── 入退场对称 ─────────────────────────────────────────────────

describe('AiAddDialog 入退场对称', () => {
  it('open=false 时不渲染内容；转 true 后出现', () => {
    const { view, ...props } = renderDialog({ open: false });
    expect(screen.queryByLabelText('待办内容')).toBeNull();

    view.rerender(<AiAddDialog {...props} open />);
    expect(screen.getByLabelText('待办内容')).toBeTruthy();
  });

  it('关闭后内容不立刻消失——退场过渡跑完才卸载（这正是改版前缺的那一半）', async () => {
    vi.useFakeTimers();
    try {
      const { view, ...props } = renderDialog();
      expect(screen.getByLabelText('待办内容')).toBeTruthy();

      view.rerender(<AiAddDialog {...props} open={false} />);
      // 退场刚开始：内容还在，用户看得到它往下滑
      expect(screen.queryByLabelText('待办内容')).not.toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(MOTION.largeExit + 50);
      });
      expect(screen.queryByLabelText('待办内容')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('退场跑完后状态复位：再次打开是空白的 input 阶段，不是上次的解析结果', async () => {
    vi.useFakeTimers();
    try {
      const d = deferred();
      const { view, ...props } = renderDialog({ onParse: vi.fn(() => d.promise) });
      fireEvent.change(screen.getByLabelText('待办内容'), { target: { value: '一段话' } });
      fireEvent.click(screen.getByRole('button', { name: '解析' }));
      await act(async () => {
        d.resolve(THREE);
      });
      expect(screen.getByText('识别出 3 条，点开可修改')).toBeTruthy();

      view.rerender(<AiAddDialog {...props} open={false} />);
      await act(async () => {
        vi.advanceTimersByTime(MOTION.largeExit + 50);
      });
      view.rerender(<AiAddDialog {...props} open />);

      expect(screen.queryByText('识别出 3 条，点开可修改')).toBeNull();
      expect((screen.getByLabelText('待办内容') as HTMLTextAreaElement).value).toBe('');
      expect(screen.getByRole('button', { name: '解析' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('退场途中又打开：内容不被复位（onExited 没跑，状态该留着）', async () => {
    vi.useFakeTimers();
    try {
      const { view, ...props } = renderDialog();
      fireEvent.change(screen.getByLabelText('待办内容'), { target: { value: '还没打完' } });

      view.rerender(<AiAddDialog {...props} open={false} />);
      await act(async () => {
        vi.advanceTimersByTime(Math.floor(MOTION.largeExit / 2));
      });
      view.rerender(<AiAddDialog {...props} open />);
      await act(async () => {
        vi.advanceTimersByTime(MOTION.large + 50);
      });

      expect((screen.getByLabelText('待办内容') as HTMLTextAreaElement).value).toBe('还没打完');
    } finally {
      vi.useRealTimers();
    }
  });
});
