// ItemEditor 测试：parseEditorText 纯函数拆分规则 + 编辑器行为
// （空文本禁用保存、标题/详情/分类/日期组装契约载荷、默认分类「个人」）。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import ItemEditor, { parseEditorText } from '../src/components/ItemEditor';
import type { ItemFields } from '../src/types';

function renderEditor(opts: {
  submitting?: boolean;
  initial?: ItemFields;
  onSubmit?: (fields: ItemFields) => void;
} = {}) {
  return render(
    <ItemEditor
      heading="添加任务"
      initial={opts.initial}
      submitting={opts.submitting ?? false}
      onSubmit={opts.onSubmit ?? vi.fn<(fields: ItemFields) => void>()}
      onClose={vi.fn()}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe('parseEditorText', () => {
  it('单行文本：首行为标题，详情为空', () => {
    expect(parseEditorText('买牛奶')).toEqual({ title: '买牛奶', summary: '' });
  });

  it('多行文本：首行为标题，其余行 join 保留中间换行、首尾空白 strip', () => {
    expect(parseEditorText(' 买牛奶 \n两盒\n\n备注  ')).toEqual({
      title: '买牛奶',
      summary: '两盒\n\n备注',
    });
  });

  it('首行全空白时 title 为空串', () => {
    expect(parseEditorText('   \n两盒')).toEqual({ title: '', summary: '两盒' });
  });
});

describe('ItemEditor 渲染', () => {
  it('文本为空时保存按钮禁用，并提示「第一行不能为空」', () => {
    renderEditor();

    const save = screen.getByRole('button', { name: '保存' });
    expect(save).toBeDisabled();
    expect(screen.getByText('第一行不能为空')).toBeTruthy();

    // 首行只有空白时仍视为空标题
    fireEvent.change(screen.getByLabelText('任务内容'), { target: { value: '   \n两盒' } });
    expect(save).toBeDisabled();
  });

  it('标题超过 128 字时保存禁用并提示「标题最多 128 字」', () => {
    renderEditor();
    const save = screen.getByRole('button', { name: '保存' });

    fireEvent.change(screen.getByLabelText('任务内容'), {
      target: { value: '标'.repeat(129) },
    });
    expect(screen.getByText('标题最多 128 字')).toBeTruthy();
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText('任务内容'), {
      target: { value: '标'.repeat(128) },
    });
    expect(save).toBeEnabled();
  });

  it('标题 + 详情 + 选分类 + 设截止日期后保存，onSubmit 收到契约载荷', () => {
    const onSubmit = vi.fn<(fields: ItemFields) => void>();
    renderEditor({ onSubmit });

    const textarea = screen.getByLabelText('任务内容') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '买牛奶\n两盒' } });

    // 分类 chip（radiogroup 内单选）
    fireEvent.click(screen.getByText('账单'));

    // 截止日期（原生 date input）
    const dateInput = screen.getByLabelText('截止日期') as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: '2026-09-10' } });

    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    // 载荷契约（ItemEditor 接入提醒后）：恒带 reminders（空数组 = 明确不改动/清空，
    // 见 ItemEditor.handleSubmit 注释；「删光再保存」要能表达成 []，故从不省略）。
    // 接入重要度后同样恒带 importance（当前档位，新建默认 normal）。
    expect(onSubmit).toHaveBeenCalledWith({
      title: '买牛奶',
      summary: '两盒',
      category: '账单',
      due_date: '2026-09-10',
      reminders: [],
      importance: 'normal',
    });
  });

  it('不选分类时默认「个人」', () => {
    const onSubmit = vi.fn<(fields: ItemFields) => void>();
    renderEditor({ onSubmit });

    fireEvent.change(screen.getByLabelText('任务内容'), { target: { value: '买牛奶' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(onSubmit).toHaveBeenCalledWith({
      title: '买牛奶',
      summary: '',
      category: '个人',
      due_date: null,
      reminders: [],
      importance: 'normal',
    });
  });

  it('submitting 为 true 时保存按钮禁用', () => {
    renderEditor({ submitting: true });

    fireEvent.change(screen.getByLabelText('任务内容'), { target: { value: '买牛奶' } });
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  });

  it('编辑带 initial.importance=high 的条目：控件选中「重要」，原样保存不把 AI 判断洗掉', () => {
    const onSubmit = vi.fn<(fields: ItemFields) => void>();
    renderEditor({
      initial: { title: '买牛奶', summary: '', category: '个人', due_date: null, importance: 'high' },
      onSubmit,
    });

    // 控件显示的是条目当前档位（high → 「重要」），不是无条件停在「普通」
    expect(screen.getByRole('radio', { name: '重要' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: '普通' })).toHaveAttribute('aria-checked', 'false');

    // 什么都不改直接保存：载荷恒带 importance: 'high'（「没改就省略」会退回后端默认 normal）
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0].importance).toBe('high');
  });

  it('编辑时点「次要」再保存：载荷 importance 变 low（三档都能经 UI 表达）', () => {
    const onSubmit = vi.fn<(fields: ItemFields) => void>();
    renderEditor({
      initial: { title: '买牛奶', summary: '', category: '个人', due_date: null, importance: 'normal' },
      onSubmit,
    });

    fireEvent.click(screen.getByRole('radio', { name: '次要' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(onSubmit.mock.calls[0][0].importance).toBe('low');
  });
});

describe('ItemEditor 居中于主内容区的样式', () => {
  it('md 起容器让出抽屉宽度，paper 不封顶内容列宽（保持 sm）', () => {
    renderEditor();

    // 直接核对 style 文本：mainAreaDialogSx 只让 .MuiDialog-container 让出
    // 抽屉宽（240px），paper 不设内容列宽（840px）——编辑器保持 maxWidth="sm"
    const cssText = Array.from(document.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .join('\n');
    expect(cssText).toContain('padding-left:240px');
    expect(cssText).not.toContain('max-width:840px');
  });
});

describe('ItemEditor 字段区结构（抽成 ItemFieldsForm 后不变）', () => {
  it('标题多行输入、5 个分类 chip、重要度三档 chip（两个 radiogroup）、日期输入齐全', () => {
    renderEditor();

    expect(screen.getByLabelText('任务内容')).toBeTruthy();
    const categoryGroup = screen.getByRole('radiogroup', { name: '分类' });
    expect(within(categoryGroup).getAllByRole('radio')).toHaveLength(5);
    const importanceGroup = screen.getByRole('radiogroup', { name: '重要度' });
    expect(within(importanceGroup).getAllByRole('radio')).toHaveLength(3);
    // 新建（不传 initial）时重要度默认选中「普通」
    expect(screen.getByRole('radio', { name: '普通' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('截止日期')).toBeTruthy();
  });

  it('设置日期后出现「清除日期」按钮，点击即清空', () => {
    renderEditor();

    fireEvent.change(screen.getByLabelText('任务内容'), { target: { value: '买牛奶' } });
    fireEvent.change(screen.getByLabelText('截止日期'), { target: { value: '2026-09-10' } });

    const clear = screen.getByRole('button', { name: '清除日期' });
    expect(clear).toBeTruthy();
    fireEvent.click(clear);

    expect((screen.getByLabelText('截止日期') as HTMLInputElement).value).toBe('');
  });
});
