// ItemEditor 测试：parseEditorText 纯函数拆分规则 + 编辑器行为
// （空文本禁用保存、标题/详情/分类/日期组装契约载荷、默认分类「个人」）。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ItemEditor, { parseEditorText } from '../src/components/ItemEditor';
import type { ItemFields } from '../src/types';

function renderEditor(opts: { submitting?: boolean; onSubmit?: (fields: ItemFields) => void } = {}) {
  return render(
    <ItemEditor
      heading="添加任务"
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
    expect(onSubmit).toHaveBeenCalledWith({
      title: '买牛奶',
      summary: '两盒',
      category: '账单',
      due_date: '2026-09-10',
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
    });
  });

  it('submitting 为 true 时保存按钮禁用', () => {
    renderEditor({ submitting: true });

    fireEvent.change(screen.getByLabelText('任务内容'), { target: { value: '买牛奶' } });
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  });
});
