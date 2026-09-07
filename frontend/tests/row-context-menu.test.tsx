// RowContextMenu 测试：anchor 为 null 时不渲染；有值时经 Portal 弹到 body 且纸面
// 带 data-glass="panel"；点某项先关菜单再执行动作；材质必须来自 rakko-glass.css 的
// panel 配方——组件源码的 paper 配置里不允许出现 background/boxShadow/border 之类
// 的内联覆盖（写了会盖掉配方，同 MuiAppBar 让位的道理）。jsdom 不解析样式表，
// 内联材质断言一律落回源码原文（?raw），否则会写出永远为真的假断言。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import RowContextMenu from '../src/components/RowContextMenu';
import type { RowContextMenuAction } from '../src/components/RowContextMenu';
import source from '../src/components/RowContextMenu.tsx?raw';

function makeActions(): RowContextMenuAction[] {
  return [
    { key: 'edit', label: '编辑', onSelect: vi.fn() },
    { key: 'delete', label: '删除', danger: true, onSelect: vi.fn() },
  ];
}

afterEach(() => {
  cleanup();
});

describe('RowContextMenu', () => {
  it('anchor 为 null 时菜单不渲染（无 role=menu、无 data-glass 纸面）', () => {
    const { container } = render(
      <RowContextMenu anchor={null} actions={makeActions()} onClose={vi.fn()} />,
    );

    expect(container.querySelector('.MuiPaper-root')).toBeNull();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.querySelector('[data-glass="panel"]')).toBeNull();
  });

  it('anchor 有值时菜单弹出（portal 到 body），菜单纸面带 data-glass="panel"', () => {
    render(
      <RowContextMenu
        anchor={{ x: 120, y: 80 }}
        actions={makeActions()}
        onClose={vi.fn()}
      />,
    );

    const menu = screen.getByRole('menu');
    expect(menu).toBeTruthy();
    const paper = menu.closest('.MuiPaper-root');
    expect(paper).not.toBeNull();
    expect(paper!.getAttribute('data-glass')).toBe('panel');
    // Menu 经 Portal 挂到 body（浮层与列表行不是 DOM 后代，不构成嵌套玻璃）
    expect(document.body.contains(paper)).toBe(true);
  });

  it('点某项先调 onClose 再执行该项的 onSelect', () => {
    const onClose = vi.fn();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const actions: RowContextMenuAction[] = [
      { key: 'edit', label: '编辑', onSelect: onEdit },
      { key: 'delete', label: '删除', danger: true, onSelect: onDelete },
    ];

    render(
      <RowContextMenu
        anchor={{ x: 12, y: 34 }}
        actions={actions}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole('menuitem', { name: '编辑' }));
    // onClose 与该项 onSelect 都要被调用；onClose 先于 onSelect（先关菜单再动手，
    // 动作以菜单已关闭为预期前提）
    expect(onClose).toHaveBeenCalled();
    expect(onEdit).toHaveBeenCalled();
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(
      onEdit.mock.invocationCallOrder[0],
    );
  });

  it('菜单纸面的材质不做内联覆盖：paper 常量不含 backgroundColor / boxShadow / border', () => {
    // paper 材质 props 是模块级常量（同 AppShell 的 NAV_DRAWER_PAPER_PROPS 做法，
    // 常量赋值绕过 slotProps 的 excess property check）。切片到常量对象字面量，
    // 断言它只含 data-glass 与圆角：
    const constStart = source.indexOf('const MENU_PAPER_PROPS');
    expect(constStart).toBeGreaterThan(-1);
    const constEnd = source.indexOf('};', constStart);
    expect(constEnd).toBeGreaterThan(-1);
    const paperProps = source.slice(constStart, constEnd + 2);

    // 纸面走 data-glass="panel" 配方：只挂属性与圆角，不自己下发材质
    expect(paperProps).toContain("'data-glass': 'panel'");
    expect(paperProps).toContain('borderRadius');
    expect(paperProps).not.toContain('backgroundColor');
    expect(paperProps).not.toContain('boxShadow');
    // 'borderRadius' 是允许的（圆角归组件），其它任何 border 声明都不允许
    expect(paperProps.replaceAll('borderRadius', '')).not.toContain('border');
  });
});
