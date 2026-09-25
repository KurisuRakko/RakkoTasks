// A2 的验收：MUI 默认值不再外漏到组件零件上。
// 断言口径分两层——能直接从 theme.components 读到的就断言结构；需要证明「真的生效」的
// 就渲染一次，用规则文本断言（jsdom 算不了级联，但测试环境非 speedy，emotion 把样式规则
// 以文本节点插入 <style>，可以逐条读；机制说明见 glass-text-contrast.test-utils.tsx）。
//
// 注意：本文件里的字符串处理只用 indexOf / substring / includes / endsWith。
// 这套测试运行时里 String.prototype.startsWith 与 slice 会给出错误结果
// （实测 'MuiButtonBase-root'.startsWith('Mui-') 为真、slice(0, 4) 得 'MuiB'），
// 用它们做判定会静默失灵。

import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import DialogActions from '@mui/material/DialogActions';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import type { Theme } from '@mui/material/styles';
import type { ThemeOptions } from '@mui/material/styles';
import { MOTION, RADIUS, SEMANTIC_INVERSE_SURFACE, SPACING, STATE_OPACITY } from '../src/rakko-tokens';
import { buildThemeOptions } from '../src/theme';
import { allStyleText } from './glass-text-contrast.test-utils';

const MODES = ['light', 'dark'] as const;
type Mode = (typeof MODES)[number];

const OPTIONS: Record<Mode, ThemeOptions> = {
  light: buildThemeOptions('light'),
  dark: buildThemeOptions('dark'),
};
const THEMES: Record<Mode, Theme> = {
  light: createTheme(OPTIONS.light),
  dark: createTheme(OPTIONS.dark),
};

/** 取某个组件的某个插槽（styleOverrides 可能是对象也可能是回调） */
function slot(theme: Theme, component: string, name: string): Record<string, unknown> {
  const entry = (theme.components as Record<string, { styleOverrides?: Record<string, unknown> }>)[
    component
  ];
  expect(entry, `${component} 应有 styleOverrides`).toBeDefined();
  const raw = entry.styleOverrides?.[name];
  expect(raw, `${component}.styleOverrides.${name} 应存在`).toBeDefined();
  return typeof raw === 'function'
    ? (raw as (p: { theme: Theme; ownerState: unknown }) => Record<string, unknown>)({
        theme,
        ownerState: {},
      })
    : (raw as Record<string, unknown>);
}

/** 取 OutlinedInput root 覆盖里「静止态描边」那一条的键名（排除 hover / focus 两条） */
function outlineKeyOf(root: Record<string, unknown>): string | undefined {
  return Object.keys(root).find(
    (k) =>
      k.indexOf('notchedOutline') >= 0 &&
      k.indexOf(':hover') < 0 &&
      k.indexOf('Mui-focused') < 0,
  );
}

afterEach(() => {
  cleanup();
});

describe('A2 按钮：四档层级一套度量，四档之外的差异只由 variant 表达', () => {
  it('defaultProps.disableElevation 为 true（禁硬阴影）', () => {
    for (const mode of MODES) {
      expect(OPTIONS[mode].components?.MuiButton?.defaultProps?.disableElevation, mode).toBe(true);
    }
  });

  it('root 给出统一高度 / 水平内边距 / 字重 / 圆角', () => {
    for (const mode of MODES) {
      const root = slot(THEMES[mode], 'MuiButton', 'root');
      expect(root.minHeight, mode).toBe(36);
      expect(root.padding, mode).toBe(`0 ${SPACING.lg}px`);
      expect(root.fontWeight, mode).toBe(600);
      expect(root.borderRadius, mode).toBe(RADIUS.base);
      expect(root.textTransform, mode).toBe('none');
    }
  });

  it('outlined 的描边用 BORDER token', () => {
    for (const mode of MODES) {
      const root = slot(THEMES[mode], 'MuiButton', 'root');
      const outlined = root['&.MuiButton-outlined'] as Record<string, unknown>;
      expect(outlined.borderColor, mode).toBe(THEMES[mode].palette.divider);
    }
  });

  it('color="inherit" 的三级按钮文字用 n9（不继承父级颜色）', () => {
    for (const mode of MODES) {
      const root = slot(THEMES[mode], 'MuiButton', 'root');
      const inheritText = root['&.MuiButton-text.MuiButton-colorInherit'] as Record<string, unknown>;
      expect(inheritText.color, mode).toBe(THEMES[mode].palette.text.primary);
    }
  });

  it('禁用态的填充与文字取 action token', () => {
    for (const mode of MODES) {
      const theme = THEMES[mode];
      const root = slot(theme, 'MuiButton', 'root');
      const disabled = root['&.Mui-disabled'] as Record<string, unknown>;
      expect(disabled.backgroundColor, mode).toBe(theme.palette.action.disabledBackground);
      expect(disabled.color, mode).toBe(theme.palette.action.disabled);
    }
  });

  it('三档 variant 渲染出的按钮都带同一份度量（36px 高）', () => {
    const theme = THEMES.light;
    for (const variant of ['contained', 'outlined', 'text'] as const) {
      cleanup();
      const { container } = render(
        createElement(
          ThemeProvider,
          { theme },
          createElement(Button, { variant }, '操作'),
        ),
      );
      const btn = container.querySelector('button');
      expect(btn, variant).not.toBeNull();
      expect(btn!.className, variant).toContain('MuiButton-disableElevation');
    }
    // 三档共用一条 root 覆盖声明：样式文本里只能有一处 minHeight:36px 的来源
    const css = allStyleText();
    expect(css).toContain('min-height:36px');
  });
});

describe('A2 芯片：12px/500 标签字、chip 圆角、中性档底色', () => {
  it('label 插槽统一 label-12 字号与 500 字重（压平 MUI 的 12/13/14 三档）', () => {
    for (const mode of MODES) {
      const label = slot(THEMES[mode], 'MuiChip', 'label');
      expect(label.fontSize, mode).toBe(12);
      expect(label.fontWeight, mode).toBe(500);
    }
  });

  it('root 用 chip 圆角与一档高度', () => {
    for (const mode of MODES) {
      const root = slot(THEMES[mode], 'MuiChip', 'root');
      expect(root.borderRadius, mode).toBe(RADIUS.chip);
      expect(root.height, mode).toBe(30);
    }
  });

  it('color="default" 的 filled / outlined 都改走中性 token', () => {
    for (const mode of MODES) {
      const theme = THEMES[mode];
      const root = slot(theme, 'MuiChip', 'root');
      const colorDefault = root['&.MuiChip-colorDefault'] as Record<string, Record<string, unknown>>;
      expect(colorDefault, mode).toBeDefined();
      expect(colorDefault['&.MuiChip-filled'].backgroundColor, mode).toBe(
        theme.palette.background.paper,
      );
      expect(colorDefault['&.MuiChip-filled'].color, mode).toBe(theme.palette.text.primary);
      expect(colorDefault['&.MuiChip-outlined'].borderColor, mode).toBe(theme.palette.divider);
      expect(colorDefault['&.MuiChip-outlined'].color, mode).toBe(theme.palette.text.primary);
    }
  });

  it('渲染出的 default Chip 字号是 12px（规则文本里没有 13px 的 label 声明）', () => {
    const { container } = render(
      createElement(ThemeProvider, { theme: THEMES.light }, createElement(Chip, { label: '标签' })),
    );
    expect(container.querySelector('.MuiChip-label')).not.toBeNull();
    const css = allStyleText();
    expect(css).toContain('font-size:12px');
    expect(css).not.toContain('MuiChip-fontSize');
  });
});

describe('A2 输入框：静止 / hover / focus 三态描边', () => {
  it('静止描边是 BORDER token，focus 是 primary 且 2px', () => {
    for (const mode of MODES) {
      const theme = THEMES[mode];
      const root = slot(theme, 'MuiOutlinedInput', 'root');
      const keys = Object.keys(root);
      const outlineKey = outlineKeyOf(root);
      const hoverKey = keys.find(
        (k) => k.indexOf('notchedOutline') >= 0 && k.indexOf(':hover') >= 0,
      );
      const focusKey = keys.find(
        (k) => k.indexOf('notchedOutline') >= 0 && k.indexOf('Mui-focused') >= 0,
      );
      expect(outlineKey, `${mode} 静止描边键`).toBeDefined();
      expect(hoverKey, `${mode} hover 描边键`).toBeDefined();
      expect(focusKey, `${mode} focus 描边键`).toBeDefined();
      expect((root[outlineKey!] as Record<string, unknown>).borderColor, mode).toBe(
        theme.palette.divider,
      );
      expect((root[focusKey!] as Record<string, unknown>).borderColor, mode).toBe(
        theme.palette.primary.main,
      );
      expect((root[focusKey!] as Record<string, unknown>).borderWidth, mode).toBe(2);
    }
  });

  it('描边过渡只给 border-color，时长与缓动取状态档', () => {
    for (const mode of MODES) {
      const root = slot(THEMES[mode], 'MuiOutlinedInput', 'root');
      const outlineKey = outlineKeyOf(root);
      expect(outlineKey, mode).toBeDefined();
      const transition = (root[outlineKey!] as Record<string, unknown>).transition as string;
      expect(transition, mode).toContain('border-color');
      expect(transition, mode).not.toContain('all');
      // transitions.create 默认吃 theme.transitions.duration.standard（= MOTION.enter 240），
      // 所以这里锁的是「时长来自主题动效 token、缓动是标准曲线」，不是某个写死的数字
      expect(transition, mode).toContain(`${MOTION.enter}ms`);
      expect(transition, mode).toContain(MOTION.easeStandard);
    }
  });

  it('hover 描边不是静止那一条（真的加深了一档）', () => {
    for (const mode of MODES) {
      const root = slot(THEMES[mode], 'MuiOutlinedInput', 'root');
      const keys = Object.keys(root);
      const hoverKey = keys.find((k) => k.indexOf('notchedOutline') >= 0 && k.indexOf(':hover') >= 0);
      const hoverColor = (root[hoverKey!] as Record<string, unknown>).borderColor;
      expect(hoverColor, mode).not.toBe(THEMES[mode].palette.divider);
      expect(typeof hoverColor, mode).toBe('string');
    }
  });

  it('TextField 渲染出的 notchedOutline 规则里带着 BORDER 描边', () => {
    const theme = THEMES.light;
    const { container } = render(
      createElement(
        ThemeProvider,
        { theme },
        createElement(TextField, { label: '标题' }),
      ),
    );
    expect(container.querySelector('.MuiOutlinedInput-notchedOutline')).not.toBeNull();
    expect(allStyleText()).toContain(theme.palette.divider);
  });
});

describe('A2 其余零件：图标按钮 / Snackbar / Tooltip / Switch / 对话框操作区 / 分割线', () => {
  it('IconButton 两档尺寸统一，hover 与按下走状态层', () => {
    for (const mode of MODES) {
      const theme = THEMES[mode];
      const root = slot(theme, 'MuiIconButton', 'root');
      const small = slot(theme, 'MuiIconButton', 'sizeSmall');
      expect(root.width, mode).toBe(36);
      expect(root.height, mode).toBe(36);
      expect(small.width, mode).toBe(30);
      expect(small.height, mode).toBe(30);
      expect((root['&:hover'] as Record<string, unknown>).backgroundColor, mode).toBe(
        theme.palette.action.hover,
      );
      expect((root['&:active'] as Record<string, unknown>).backgroundColor, mode).toBe(
        theme.palette.action.selected,
      );
      expect(theme.palette.action.hoverOpacity, mode).toBe(STATE_OPACITY.hover);
    }
    // 渲染一次确认真落到样式表（主题数据对 + 规则文本对）
    const { container } = render(
      createElement(ThemeProvider, { theme: THEMES.light }, createElement(IconButton, { 'aria-label': '更多' })),
    );
    expect(container.querySelector('.MuiIconButton-root')).not.toBeNull();
    expect(allStyleText()).toContain('width:36px');
  });

  it('Avatar 用中性档填充 + n9 文字（不是 accent 底）', () => {
    for (const mode of MODES) {
      const theme = THEMES[mode];
      const root = slot(theme, 'MuiAvatar', 'root');
      expect(root.backgroundColor, mode).toBe(theme.palette.grey[300]);
      expect(root.color, mode).toBe(theme.palette.text.primary);
      expect(root.backgroundColor, mode).not.toBe(theme.palette.primary.main);
    }
  });

  it('Snackbar 的 autoHideDuration 由主题统一给 4000', () => {
    for (const mode of MODES) {
      expect(OPTIONS[mode].components?.MuiSnackbar?.defaultProps?.autoHideDuration, mode).toBe(4000);
    }
  });

  it('SnackbarContent 是墨底浅字的反相面，action 用 primary 浅色档', () => {
    for (const mode of MODES) {
      const theme = THEMES[mode];
      const root = slot(theme, 'MuiSnackbarContent', 'root');
      const action = slot(theme, 'MuiSnackbarContent', 'action');
      expect(root.backgroundColor, mode).toBe(SEMANTIC_INVERSE_SURFACE.bg);
      expect(root.color, mode).toBe(SEMANTIC_INVERSE_SURFACE.fg);
      expect(root.borderRadius, mode).toBe(RADIUS.base);
      expect(root.backgroundImage, mode).toBe('none');
      expect(action.color, mode).toBe(theme.palette.primary.light);
    }
  });

  it('Tooltip 是 n-10 实底 + n-1 字', () => {
    for (const mode of MODES) {
      const tooltip = slot(THEMES[mode], 'MuiTooltip', 'tooltip');
      expect(tooltip.backgroundColor, mode).toBe(SEMANTIC_INVERSE_SURFACE.bg);
      expect(tooltip.color, mode).toBe(SEMANTIC_INVERSE_SURFACE.fg);
      expect(tooltip.borderRadius, mode).toBe(RADIUS.base);
    }
  });

  it('Divider 用 BORDER token，Switch 的两态颜色都来自 token', () => {
    for (const mode of MODES) {
      const theme = THEMES[mode];
      const divider = slot(theme, 'MuiDivider', 'root');
      expect(divider.borderColor, mode).toBe(theme.palette.divider);
      const track = slot(theme, 'MuiSwitch', 'track');
      const thumb = slot(theme, 'MuiSwitch', 'thumb');
      const colorPrimary = slot(theme, 'MuiSwitch', 'colorPrimary');
      expect(track.backgroundColor, mode).toBe(theme.palette.grey[400]);
      expect(thumb.backgroundColor, mode).toBe(theme.palette.background.paper);
      const checkedTrack = colorPrimary['&.Mui-checked + .MuiSwitch-track'] as Record<string, unknown>;
      expect(checkedTrack.backgroundColor, mode).toBe(theme.palette.primary.main);
    }
  });

  it('DialogActions 右对齐、统一间距与内边距，取消在左确认在右', () => {
    for (const mode of MODES) {
      const root = slot(THEMES[mode], 'MuiDialogActions', 'root');
      expect(root.justifyContent, mode).toBe('flex-end');
      expect(root.gap, mode).toBe(SPACING.sm);
      expect(root.padding, mode).toBe(`${SPACING.md}px ${SPACING.xl}px`);
    }
    // DOM 顺序即视觉顺序：取消 / 确认两个按钮在同一个右对齐行里，取消在前
    const { container } = render(
      createElement(
        ThemeProvider,
        { theme: THEMES.light },
        createElement(
          DialogActions,
          null,
          createElement(Button, { variant: 'text', color: 'inherit' }, '取消'),
          createElement(Button, { variant: 'contained' }, '确认'),
        ),
      ),
    );
    const actions = container.querySelector('.MuiDialogActions-root');
    expect(actions).not.toBeNull();
    const labels: string[] = [];
    for (const btn of actions!.querySelectorAll('button')) {
      labels.push(btn.textContent ?? '');
    }
    expect(labels).toEqual(['取消', '确认']);
  });
});
