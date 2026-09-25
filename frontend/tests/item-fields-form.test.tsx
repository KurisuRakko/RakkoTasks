// ItemFieldsForm 测试：字段区（标题多行框 + 分类 chip 单选 + 重要度 chip 单选 +
// 原生 date input + 清除）是受控组件——改文本/点 chip/改日期/清日期分别触发对应
// 回调，错误态文案按 props 展示。重要度三档（重要/普通/次要）与列表页口径一致，
// 位置在分类之后、截止日期之前；选中档由 props 决定、点击外发 onImportanceChange。
// DOM 结构、className、aria 语义与文案与抽组件前 ItemEditor 的字段区块一致
// （item-editor.test.tsx 的既有断言负责守住集成侧不变）。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import ItemFieldsForm from '../src/components/ItemFieldsForm';
import { CATEGORIES } from '../src/types';
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

describe('ItemFieldsForm 单选 chip 的选中/未选中口径', () => {
  /** 取某枚 radio chip 的 MuiChip 根元素 */
  function chipFor(name: string): HTMLElement {
    return screen.getByRole('radio', { name }).closest('.MuiChip-root') as HTMLElement;
  }

  it('分类：选中 = filled primary，未选中 = outlined 中性色（不再是 outlined primary）', () => {
    renderForm({ category: '个人' });

    const selected = chipFor('个人');
    expect(selected.className).toMatch(/MuiChip-filled/);
    expect(selected.className).toMatch(/MuiChip-colorPrimary/);

    // 未选中的那几枚不是「待点的主操作」：描 primary 边框会让整行看着像一排主按钮，
    // accent 覆盖面也远超 5% 的纪律上限。5 档分类里除当前档外都要逐个核过。
    for (const name of CATEGORIES.filter((c) => c !== '个人')) {
      const chip = chipFor(name);
      expect(chip.className, `${name} 未选中应为 outlined`).toMatch(/MuiChip-outlined/);
      expect(chip.className, `${name} 未选中不许带 primary 色`).not.toMatch(
        /MuiChip-colorPrimary/,
      );
      expect(chip.className, `${name} 未选中应是中性 default 色`).toMatch(/MuiChip-colorDefault/);
      // 选中态不靠颜色单独承担信息：aria-checked 必须同步
      expect(chip.getAttribute('aria-checked'), `${name} 的 aria-checked`).toBe('false');
    }
  });

  it('重要度：与分类同一口径——选中 filled primary，未选中 outlined 中性', () => {
    renderForm({ importance: 'high' });

    const selected = chipFor('重要');
    expect(selected.className).toMatch(/MuiChip-filled/);
    expect(selected.className).toMatch(/MuiChip-colorPrimary/);

    for (const name of ['普通', '次要']) {
      const chip = chipFor(name);
      expect(chip.className, `${name} 未选中应为 outlined`).toMatch(/MuiChip-outlined/);
      expect(chip.className, `${name} 未选中不许带 primary 色`).not.toMatch(
        /MuiChip-colorPrimary/,
      );
    }
  });
});

describe('ItemFieldsForm 输入框的统一度量', () => {
  it('截止日期与提醒时刻都是 outlined + size="small"（同一档，行高与标签位置才对得齐）', () => {
    renderForm({ date: '2026-09-10', reminders: ['2030-01-05T09:30'] });

    // 日期输入与提醒行输入：所有单行输入框只能有一种 variant 与一种 size
    const dateInput = screen.getByLabelText('截止日期');
    const dateRoot = dateInput.closest('.MuiFormControl-root') as HTMLElement;
    expect(dateRoot.className).toMatch(/MuiOutlinedInput-root|MuiTextField-root/);
    expect(dateInput.closest('.MuiInputBase-root')?.className).toMatch(/MuiOutlinedInput-root/);
    expect(dateInput.closest('.MuiInputBase-root')?.className).toMatch(
      /MuiInputBase-sizeSmall/,
    );

    const reminderInput = document.querySelector<HTMLInputElement>(
      'input[type="datetime-local"]',
    );
    expect(reminderInput).not.toBeNull();
    expect(reminderInput!.closest('.MuiInputBase-root')?.className).toMatch(
      /MuiOutlinedInput-root/,
    );
    expect(reminderInput!.closest('.MuiInputBase-root')?.className).toMatch(
      /MuiInputBase-sizeSmall/,
    );
  });

  it('同一行的删除按钮与清除按钮同尺寸（都是 size="small" 的 IconButton）', () => {
    renderForm({ date: '2026-09-10', reminders: ['2030-01-05T09:30'] });

    const clear = screen.getByRole('button', { name: '清除日期' });
    const remove = screen.getByRole('button', { name: '删除提醒 1' });
    for (const btn of [clear, remove]) {
      expect(btn.className).toMatch(/MuiIconButton-sizeSmall/);
    }
  });
});
