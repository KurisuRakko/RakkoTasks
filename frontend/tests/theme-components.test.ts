// A2 的验收：MUI 默认值不外漏到组件零件上。
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
import { ThemeProvider, alpha, createTheme, getContrastRatio, rgbToHex } from '@mui/material/styles';
import type { Theme } from '@mui/material/styles';
import type { ThemeOptions } from '@mui/material/styles';
import {
  MOTION,
  RADIUS,
  SEMANTIC_INVERSE_SURFACE,
  SEMANTIC_TINT_ALPHA,
  SPACING,
  STATE_OPACITY,
} from '../src/rakko-tokens';
import { buildThemeOptions } from '../src/theme';
import { allStyleText } from './glass-text-contrast.test-utils';

const MODES = ['light', 'dark'] as const;
type Mode = (typeof MODES)[number];

/** 四个语义色（palette 键），芯片守卫逐色跑 */
const SEMANTIC_KEYS = ['info', 'success', 'warning', 'error'] as const;

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

/** 主题里某组件 variants 中 props 命中 color 的那一条的 style（由 theme 求值） */
function variantStyle(
  theme: Theme,
  component: string,
  color: string,
): Record<string, unknown> {
  const entry = (theme.components as Record<string, { variants?: unknown[] }>)[component];
  expect(entry, `${component} 应有 variants`).toBeDefined();
  const variants = (entry.variants ?? []) as Array<{
    props: Record<string, unknown>;
    style: unknown;
  }>;
  for (const v of variants) {
    if (v.props?.color === color) {
      const raw = v.style;
      return typeof raw === 'function'
        ? (raw as (a: { theme: Theme }) => Record<string, unknown>)({ theme })
        : (raw as Record<string, unknown>);
    }
  }
  throw new Error(`${component} 的 variants 里没有 color=${color}`);
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

/** `#rrggbb` / `rgb(r, g, b)` + 不透明度 → MUI 序列化的 `rgba(r, g, b, a)` */
function rgbaOf(color: string, opacity: number): string {
  const hex = color.charAt(0) === '#';
  let r: number;
  let g: number;
  let b: number;
  if (hex) {
    const value = parseInt(color.substring(1), 16);
    r = (value >> 16) & 255;
    g = (value >> 8) & 255;
    b = value & 255;
  } else {
    const nums = color.replace(/[^0-9.,]/g, '').split(',');
    r = Number(nums[0]);
    g = Number(nums[1]);
    b = Number(nums[2]);
  }
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
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

  it('root 给字重与圆角，不给统一尺寸', () => {
    for (const mode of MODES) {
      const root = slot(THEMES[mode], 'MuiButton', 'root');
      expect(root.fontWeight, mode).toBe(600);
      expect(root.borderRadius, mode).toBe(RADIUS.base);
      expect(root.textTransform, mode).toBe('none');
      // 统一尺寸会让 size="small" 的按钮被撑到 medium 的高度
      expect(root.minHeight, mode).toBeUndefined();
      expect(root.padding, mode).toBeUndefined();
    }
  });

  it('small 与 medium 渲染出不同高度（不许出现统一高度把 small 撑胖）', () => {
    cleanup();
    const { container } = render(
      createElement(
        ThemeProvider,
        { theme: THEMES.light },
        createElement(Button, { variant: 'contained', size: 'medium' }, '中等'),
        createElement(Button, { variant: 'contained', size: 'small' }, '小'),
      ),
    );
    const buttons = container.querySelectorAll('button');
    expect(buttons).toHaveLength(2);
    const medium = getComputedStyle(buttons[0] as HTMLElement).minHeight;
    const small = getComputedStyle(buttons[1] as HTMLElement).minHeight;
    expect(medium).toBe('36px');
    expect(small).toBe('30px');
    expect(small, 'small 必须比 medium 矮，否则就是被统一高度撑胖了').not.toBe(medium);
  });

  it('两档尺寸：medium 36 高 / 水平 16，small 30 高 / 水平 12（三档 variant 都是）', () => {
    const expected = {
      medium: { minHeight: 36, padding: '0 16px' },
      small: { minHeight: 30, padding: '0 12px' },
    } as const;
    for (const mode of MODES) {
      const root = slot(THEMES[mode], 'MuiButton', 'root');
      for (const size of ['medium', 'small'] as const) {
        const keys = Object.keys(root).filter(
          (k) =>
            k.indexOf(`MuiButton-size${size === 'medium' ? 'Medium' : 'Small'}`) >= 0 &&
            k.indexOf('MuiButton-contained') >= 0,
        );
        expect(keys.length, `${mode} size=${size} 组合选择器`).toBeGreaterThan(0);
        for (const key of keys) {
          expect((root[key] as Record<string, unknown>).minHeight, `${mode} ${key}`).toBe(
            expected[size].minHeight,
          );
          expect((root[key] as Record<string, unknown>).padding, `${mode} ${key}`).toBe(
            expected[size].padding,
          );
        }
      }
    }
    // 生效值：六种 size × variant 组合各渲染一次
    for (const size of ['medium', 'small'] as const) {
      for (const variant of ['contained', 'outlined', 'text'] as const) {
        cleanup();
        const { container } = render(
          createElement(
            ThemeProvider,
            { theme: THEMES.light },
            createElement(Button, { variant, size }, '操作'),
          ),
        );
        const btn = container.querySelector('button') as HTMLElement;
        const cs = getComputedStyle(btn);
        expect(cs.minHeight, `${variant} ${size}`).toBe(`${expected[size].minHeight}px`);
        expect(cs.paddingLeft, `${variant} ${size} 水平内边距`).toBe(
          `${size === 'medium' ? 16 : 12}px`,
        );
        expect(cs.paddingTop, `${variant} ${size} 竖向内边距`).toBe('0px');
      }
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
    expect(allStyleText()).toContain('min-height:36px');
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

  it('root 只给 chip 圆角，不给统一高度（高度交回 MUI 的 size 体系）', () => {
    for (const mode of MODES) {
      const root = slot(THEMES[mode], 'MuiChip', 'root');
      expect(root.borderRadius, mode).toBe(RADIUS.chip);
      // root 上一旦写死高度，size="small" 的 24px 状态芯片会被一律撑胖
      expect(root.height, mode).toBeUndefined();
      expect(root.minHeight, mode).toBeUndefined();
    }
  });

  it('两档尺寸各自保留 MUI 的高度：medium 32 / small 24', () => {
    for (const [size, expected] of [['medium', 32], ['small', 24]] as const) {
      cleanup();
      const { container } = render(
        createElement(
          ThemeProvider,
          { theme: THEMES.light },
          createElement(Chip, { label: '标签', size }),
        ),
      );
      const chip = container.querySelector('.MuiChip-root') as HTMLElement;
      expect(chip, size).not.toBeNull();
      expect(getComputedStyle(chip).height, size).toBe(`${expected}px`);
    }
  });

  it('color="default" 的 filled 背景是中性浅填充，不是不透明纸色', () => {
    for (const mode of MODES) {
      const theme = THEMES[mode];
      const colorDefault = variantStyle(theme, 'MuiChip', 'default') as Record<
        string,
        Record<string, unknown>
      >;
      expect(colorDefault, mode).toBeDefined();
      expect(colorDefault['&.MuiChip-filled'].backgroundColor, mode).toBe(
        theme.palette.action.disabledBackground,
      );
      expect(colorDefault['&.MuiChip-filled'].backgroundColor, mode).not.toBe(
        theme.palette.background.paper,
      );
      expect(colorDefault['&.MuiChip-filled'].color, mode).toBe(theme.palette.text.primary);
      expect(colorDefault['&.MuiChip-outlined'].borderColor, mode).toBe(theme.palette.divider);
      expect(colorDefault['&.MuiChip-outlined'].color, mode).toBe(theme.palette.text.primary);
    }
    // 渲染一次读生效值：压在玻璃行上的 chip 是一层可透的淡填充，不是实心纸色
    const { container } = render(
      createElement(ThemeProvider, { theme: THEMES.light }, createElement(Chip, { label: '标签' })),
    );
    const chip = container.querySelector('.MuiChip-root') as HTMLElement;
    const bg = getComputedStyle(chip).backgroundColor;
    expect(bg).toBe(THEMES.light.palette.action.disabledBackground);
    expect(bg).not.toBe(THEMES.light.palette.background.paper);
  });

  it('语义色 outlined：文字是 text.primary，不是 palette[c].main', () => {
    for (const mode of MODES) {
      const theme = THEMES[mode];
      for (const key of SEMANTIC_KEYS) {
        const style = variantStyle(theme, 'MuiChip', key) as Record<
          string,
          Record<string, unknown>
        >;
        const outlined = style['&.MuiChip-outlined'] as Record<string, unknown>;
        expect(outlined, `${mode} ${key}`).toBeDefined();
        expect(outlined.color, `${mode} ${key} 文字色`).toBe(theme.palette.text.primary);
        expect(outlined.color, `${mode} ${key} 不许用语义色当文字`).not.toBe(
          theme.palette[key].main,
        );
        expect(outlined.borderColor, `${mode} ${key} 描边`).toBe(theme.palette[key].main);
        expect(outlined.backgroundColor, `${mode} ${key} 底色`).toBe(
          alpha(theme.palette[key].main, SEMANTIC_TINT_ALPHA[mode]),
        );
        const icon = style['&.MuiChip-outlined .MuiChip-icon'] as Record<string, unknown>;
        expect(icon?.color, `${mode} ${key} 图标`).toBe(theme.palette[key].main);
      }
    }
    // 生效值：四色 × 两模式的文字都是 n9，且对纯纸色够 4.5
    for (const mode of MODES) {
      const theme = THEMES[mode];
      for (const key of SEMANTIC_KEYS) {
        cleanup();
        const { container } = render(
          createElement(
            ThemeProvider,
            { theme },
            createElement(Chip, { label: '正常', color: key, variant: 'outlined' }),
          ),
        );
        const chip = container.querySelector('.MuiChip-root') as HTMLElement;
        const cs = getComputedStyle(chip);
        // jsdom 把 hex 渲染成 rgb(...)，用 rgbToHex 归一后再比
        expect(rgbToHex(cs.color), `${mode} ${key} 渲染文字色`).toBe(
          theme.palette.text.primary,
        );
        expect(
          getContrastRatio(theme.palette.text.primary, theme.palette.background.default),
          `${mode} ${key} 文字对纯纸色`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('语义色 filled：底色配 contrastText 的对比度 ≥ 4.5（不够时降 dark 档）', () => {
    for (const mode of MODES) {
      const theme = THEMES[mode];
      for (const key of SEMANTIC_KEYS) {
        const slot = theme.palette[key];
        const filled = (variantStyle(theme, 'MuiChip', key) as Record<string, Record<string, unknown>>)[
          '&.MuiChip-filled'
        ];
        expect(filled.color, `${mode} ${key} filled 文字`).toBe(slot.contrastText);
        // 底色要么是 main（够线），要么是 dark（main 不够线时的降档）
        expect([slot.main, slot.dark], `${mode} ${key} filled 底色`).toContain(
          filled.backgroundColor as string,
        );
        expect(
          getContrastRatio(filled.color as string, filled.backgroundColor as string),
          `${mode} ${key} filled 对比度`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
    // 生效值：渲染出来的比值同样要够线
    for (const mode of MODES) {
      for (const key of SEMANTIC_KEYS) {
        cleanup();
        const { container } = render(
          createElement(
            ThemeProvider,
            { theme: THEMES[mode] },
            createElement(Chip, { label: '逾期', color: key }),
          ),
        );
        const chip = container.querySelector('.MuiChip-root') as HTMLElement;
        const cs = getComputedStyle(chip);
        expect(
          getContrastRatio(cs.color, cs.backgroundColor),
          `${mode} ${key} 渲染 filled 对比度`,
        ).toBeGreaterThanOrEqual(4.5);
      }
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
  it('两档尺寸统一（默认 36 / small 30）', () => {
    for (const mode of MODES) {
      const root = slot(THEMES[mode], 'MuiIconButton', 'root');
      const small = slot(THEMES[mode], 'MuiIconButton', 'sizeSmall');
      expect(root.width, mode).toBe(36);
      expect(root.height, mode).toBe(36);
      expect(small.width, mode).toBe(30);
      expect(small.height, mode).toBe(30);
    }
    const { container } = render(
      createElement(ThemeProvider, { theme: THEMES.light }, createElement(IconButton, { 'aria-label': '更多' })),
    );
    expect(container.querySelector('.MuiIconButton-root')).not.toBeNull();
    expect(allStyleText()).toContain('width:36px');
  });

  it('中性状态层只给 default / inherit，带色 IconButton 保留 palette 自己的淡底', () => {
    for (const mode of MODES) {
      const theme = THEMES[mode];
      const root = slot(theme, 'MuiIconButton', 'root');
      // 根上不许有裸的 &:hover / &:active 背景覆盖——那会盖掉 MUI 按 color 算出的
      // 同色淡底（color="error" 的删除图标 hover 会从 error 淡色变成中性色）
      expect(root['&:hover'], mode).toBeUndefined();
      expect(root['&:active'], mode).toBeUndefined();
      const neutral = root['&.MuiIconButton-colorDefault, &.MuiIconButton-colorInherit'] as Record<
        string,
        Record<string, unknown>
      >;
      expect(neutral, mode).toBeDefined();
      expect(neutral['&:hover'].backgroundColor, mode).toBe(theme.palette.action.hover);
      expect(neutral['&:active'].backgroundColor, mode).toBe(theme.palette.action.selected);
      expect(theme.palette.action.hoverOpacity, mode).toBe(STATE_OPACITY.hover);
    }
    // 生效值：中性色按钮走状态层，语义色按钮走 MUI 按 palette 算出的同色淡底
    const expectedByColor: Record<string, string> = {
      error: rgbaOf(THEMES.light.palette.error.main, STATE_OPACITY.hover),
      primary: rgbaOf(THEMES.light.palette.primary.main, STATE_OPACITY.hover),
    };
    for (const color of ['error', 'primary'] as const) {
      cleanup();
      const { container } = render(
        createElement(
          ThemeProvider,
          { theme: THEMES.light },
          createElement(IconButton, { color, 'aria-label': '删除' }),
        ),
      );
      const btn = container.querySelector('.MuiIconButton-root') as HTMLElement;
      const hoverBg = getComputedStyle(btn).getPropertyValue('--IconButton-hoverBg').trim();
      expect(hoverBg, color).toBe(expectedByColor[color]);
      expect(hoverBg, `${color} 不该被中性状态层盖掉`).not.toBe(
        rgbaOf(THEMES.light.palette.action.hover, 1),
      );
    }
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
