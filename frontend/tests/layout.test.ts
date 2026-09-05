// lib/layout 测试：两个布局常量（抽屉宽 / 内容列宽）与两个 Dialog 定位 sx 的结构。
// sx 是纯函数（theme → 样式树），直接调用断言 md 媒体查询内的规则；
// 媒体查询串用 theme.breakpoints.up('md') 现拼、不手抄。

import { describe, expect, it } from 'vitest';
import { createTheme } from '@mui/material/styles';
import type { Theme } from '@mui/material/styles';
import {
  columnDialogSx,
  CONTENT_MAX_WIDTH,
  DRAWER_WIDTH,
  mainAreaDialogSx,
} from '../src/lib/layout';

/** 样式树逐层都是键值对象；断言侧以 unknown 展开，不依赖 MUI 的深层 CSS 类型 */
type StyleTree = { [key: string]: unknown };

function sxTree(build: (theme: Theme) => unknown, theme: Theme): StyleTree {
  return build(theme) as StyleTree;
}

describe('lib/layout 布局常量', () => {
  it('桌面常驻抽屉宽 240、内容列最大宽 840', () => {
    expect(DRAWER_WIDTH).toBe(240);
    expect(CONTENT_MAX_WIDTH).toBe(840);
  });
});

describe('lib/layout 对话框 sx', () => {
  const theme = createTheme();
  const md = theme.breakpoints.up('md');

  it('columnDialogSx：md 起容器让出抽屉宽度、paper 与内容列重合', () => {
    const tree = sxTree(columnDialogSx, theme);
    expect(Object.keys(tree)).toEqual([md]);
    const rules = tree[md] as StyleTree;
    const container = rules['& .MuiDialog-container'] as StyleTree;
    const paper = rules['& .MuiDialog-paper'] as StyleTree;
    // 容器 padding 是 px 字符串：数值会被 theme.spacing 放大（240 → 1920px），
    // 字符串原样进 CSS 才是抽屉宽度 240px
    expect(container.paddingLeft).toBe(`${DRAWER_WIDTH}px`);
    expect(paper.maxWidth).toBe(CONTENT_MAX_WIDTH);
    expect(paper.marginLeft).toBe(0);
    expect(paper.marginRight).toBe(0);
    expect(paper.width).toBe('100%');
  });

  it('mainAreaDialogSx：只有容器让出抽屉的规则、没有 paper 规则', () => {
    const tree = sxTree(mainAreaDialogSx, theme);
    expect(Object.keys(tree)).toEqual([md]);
    const rules = tree[md] as StyleTree;
    expect(Object.keys(rules)).toEqual(['& .MuiDialog-container']);
    expect(rules['& .MuiDialog-paper']).toBeUndefined();
    const container = rules['& .MuiDialog-container'] as StyleTree;
    expect(container.paddingLeft).toBe(`${DRAWER_WIDTH}px`);
  });
});
