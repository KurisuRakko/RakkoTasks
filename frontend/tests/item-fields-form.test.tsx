// ItemFieldsForm 测试：字段区（标题多行框 + 分类 chip 单选 + 重要度 chip 单选 +
// 原生 date input + 清除）是受控组件——改文本/点 chip/改日期/清日期分别触发对应
// 回调，错误态文案按 props 展示。重要度三档（重要/普通/次要）与列表页口径一致，
// 位置在分类之后、截止日期之前；选中档由 props 决定、点击外发 onImportanceChange。
// DOM 结构、className、aria 语义与文案与抽组件前 ItemEditor 的字段区块一致
// （item-editor.test.tsx 的既有断言负责守住集成侧不变）。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import ItemFieldsForm from '../src/components/ItemFieldsForm';
import type { Category, Importance } from '../src/types';

interface RenderFormOpts {
  text?: string;
  category?: Category;
  importance?: Importance;
  date?: string;
  invalid?: boolean;
  helper?: string;
  onTextChange?: (next: string) => void;
  onCategoryChange?: (next: Category) => void;
  onImportanceChange?: (next: Importance) => void;
  onDateChange?: (next: string) => void;
  reminders?: string[];
  onRemindersChange?: (next: string[]) => void;
}

function renderForm(opts: RenderFormOpts = {}) {
  const props = {
    text: opts.text ?? '买牛奶',
    category: opts.category ?? ('个人' as Category),
    importance: opts.importance ?? ('normal' as Importance),
    date: opts.date ?? '',
    invalid: opts.invalid ?? false,
    helper: opts.helper ?? '',
    onTextChange: opts.onTextChange ?? vi.fn<(next: string) => void>(),
    onCategoryChange: opts.onCategoryChange ?? vi.fn<(next: Category) => void>(),
    onImportanceChange: opts.onImportanceChange ?? vi.fn<(next: Importance) => void>(),
    onDateChange: opts.onDateChange ?? vi.fn<(next: string) => void>(),
    reminders: opts.reminders ?? [],
    onRemindersChange: opts.onRemindersChange ?? vi.fn<(next: string[]) => void>(),
  };
  render(<ItemFieldsForm {...props} />);
  return { props };
}

afterEach(() => {
  cleanup();
});

describe('ItemFieldsForm 渲染', () => {
  it('标题输入框、5 个分类 chip、重要度三档 chip（两个 radiogroup）、日期输入框齐全', () => {
    renderForm();

    expect(screen.getByLabelText('任务内容')).toBeTruthy();
    // 分类与重要度是两个独立 radiogroup，5 + 3 档 chip 都在
    const categoryGroup = screen.getByRole('radiogroup', { name: '分类' });
    expect(within(categoryGroup).getAllByRole('radio')).toHaveLength(5);
    const importanceGroup = screen.getByRole('radiogroup', { name: '重要度' });
    expect(within(importanceGroup).getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByLabelText('截止日期')).toBeTruthy();
  });

  it('重要度三档文案为「重要」「普通」「次要」，选中档由 props 决定', () => {
    renderForm({ importance: 'high' });

    expect(screen.getByRole('radio', { name: '重要' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: '普通' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('radio', { name: '次要' })).toHaveAttribute('aria-checked', 'false');
  });

  it('low 档能选中（三档缺一不可：AI 会产出 low，只留两档会把 low 静默洗成 normal）', () => {
    renderForm({ importance: 'low' });

    expect(screen.getByRole('radio', { name: '重要' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('radio', { name: '普通' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('radio', { name: '次要' })).toHaveAttribute('aria-checked', 'true');
  });

  it('点重要度 chip 触发 onImportanceChange；受控：未收到新 props 前选中态不变', () => {
    const { props } = renderForm({ importance: 'normal' });

    fireEvent.click(screen.getByRole('radio', { name: '重要' }));
    expect(props.onImportanceChange).toHaveBeenCalledTimes(1);
    expect(props.onImportanceChange).toHaveBeenCalledWith('high');
    // 受控组件不自己改选中态，等 props 回填（仍是 normal）
    expect(screen.getByRole('radio', { name: '普通' })).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByRole('radio', { name: '次要' }));
    expect(props.onImportanceChange).toHaveBeenCalledWith('low');
  });

  it('改文本触发 onTextChange', () => {
    const { props } = renderForm();

    fireEvent.change(screen.getByLabelText('任务内容'), { target: { value: '交房租' } });
    expect(props.onTextChange).toHaveBeenCalledTimes(1);
    expect(props.onTextChange).toHaveBeenCalledWith('交房租');
  });

  it('点分类 chip 触发 onCategoryChange，选中态随 props 更新', () => {
    const { props } = renderForm({ category: '个人' });

    fireEvent.click(screen.getByRole('radio', { name: '账单' }));
    expect(props.onCategoryChange).toHaveBeenCalledWith('账单');

    expect(screen.getByRole('radio', { name: '个人' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: '账单' })).toHaveAttribute('aria-checked', 'false');
  });

  it('改日期触发 onDateChange', () => {
    const { props } = renderForm();

    fireEvent.change(screen.getByLabelText('截止日期'), { target: { value: '2026-09-10' } });
    expect(props.onDateChange).toHaveBeenCalledTimes(1);
    expect(props.onDateChange).toHaveBeenCalledWith('2026-09-10');
  });

  it('无日期时不渲染「清除日期」按钮；有日期时点击触发 onDateChange("")', () => {
    renderForm();
    expect(screen.queryByRole('button', { name: '清除日期' })).toBeNull();

    const { props } = renderForm({ date: '2026-09-10' });
    expect(screen.getByRole('button', { name: '清除日期' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '清除日期' }));
    expect(props.onDateChange).toHaveBeenCalledWith('');
  });

  it('invalid=true 且给了 helper 时错误文案可见', () => {
    renderForm({ invalid: true, helper: '第一行不能为空' });

    expect(screen.getByText('第一行不能为空')).toBeTruthy();
  });
});
