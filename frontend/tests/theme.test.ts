// Rakko Design token 主题测试：深浅两套 palette、字阶、whisper 阴影、动效时长
// 与 AppBar color="default"（defaultProps 生效）与深色语义色提亮。
// useAppTheme 依赖 ThemeModeProvider 的 resolved 值：先写 localStorage 再 renderHook。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, renderHook } from '@testing-library/react';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import AppBar from '@mui/material/AppBar';
import { ThemeProvider } from '@mui/material/styles';
import { ThemeModeProvider } from '../src/lib/theme-mode';
import {
  ACCENT,
  MOTION,
  NEUTRAL_DARK,
  NEUTRAL_LIGHT,
  STATE_OPACITY,
  TYPE_SCALE,
  WHISPER_SHADOW,
} from '../src/rakko-tokens';
import { useAppTheme } from '../src/theme';

const MODE_KEY = 'rakkotasks.theme-mode';

function wrapper(props: { children?: ReactNode }) {
  return createElement(ThemeModeProvider, null, props.children);
}

/** 先写死主题模式再取主题：system 时 matchMedia stub 恒为浅色，所以必须显式指定 */
function themeOf(mode: 'light' | 'dark') {
  localStorage.setItem(MODE_KEY, mode);
  const { result } = renderHook(() => useAppTheme(), { wrapper });
  return result.current;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('Rakko Design token 主题', () => {
  it('palette 对齐 accent 与中性色（浅色）', () => {
    const theme = themeOf('light');
    expect(theme.palette.primary.main).toBe(ACCENT.light);
    expect(theme.palette.primary.contrastText).toBe('#fff');
    expect(theme.palette.background.default).toBe(NEUTRAL_LIGHT[0]);
    expect(theme.palette.background.paper).toBe(NEUTRAL_LIGHT[1]);
    expect(theme.palette.text.primary).toBe(NEUTRAL_LIGHT[8]);
    expect(theme.palette.text.secondary).toBe(NEUTRAL_LIGHT[6]);
    expect(theme.palette.text.disabled).toBe(NEUTRAL_LIGHT[4]);
  });

  it('palette 对齐 accent 与中性色（深色）', () => {
    const theme = themeOf('dark');
    expect(theme.palette.primary.main).toBe(ACCENT.dark);
    expect(theme.palette.background.default).toBe(NEUTRAL_DARK[0]);
    expect(theme.palette.background.paper).toBe(NEUTRAL_DARK[1]);
    expect(theme.palette.text.primary).toBe(NEUTRAL_DARK[8]);
    expect(theme.palette.text.secondary).toBe(NEUTRAL_DARK[6]);
    expect(theme.palette.text.disabled).toBe(NEUTRAL_DARK[4]);
  });

  it('字阶与字重：button 无大写、全局禁 700、h6/body1 对齐 token', () => {
    const theme = themeOf('light');
    expect(theme.typography.fontWeightBold).toBe(500);
    expect(theme.typography.button.textTransform).toBe('none');
    expect(theme.typography.button.fontSize).toBe(TYPE_SCALE['copy-14'].size);
    expect(theme.typography.h6.fontSize).toBe(TYPE_SCALE['title-20'].size);
    expect(theme.typography.h6.lineHeight).toBe(TYPE_SCALE['title-20'].lineHeight);
    expect(theme.typography.h6.fontWeight).toBe(500);
    expect(theme.typography.body1.fontSize).toBe(TYPE_SCALE['copy-14'].size);
    expect(theme.typography.body1.lineHeight).toBe(TYPE_SCALE['copy-14'].lineHeight);
    expect(theme.typography.body2.fontSize).toBe(TYPE_SCALE['copy-13'].size);
  });

  it('禁硬阴影：全部索引都是 whisper；shape 圆角 6', () => {
    const theme = themeOf('light');
    expect(theme.shadows[0]).toBe('none');
    expect(theme.shadows[1]).toBe(WHISPER_SHADOW);
    expect(theme.shadows[8]).toBe(WHISPER_SHADOW);
    expect(theme.shadows[24]).toBe(WHISPER_SHADOW);
    expect(theme.shape.borderRadius).toBe(6);
  });

  it('动效：enter 240 / exit 180，缓动统一标准曲线', () => {
    const theme = themeOf('light');
    expect(theme.transitions.duration.standard).toBe(240);
    expect(theme.transitions.duration.leavingScreen).toBe(180);
    expect(theme.transitions.duration.shortest).toBe(160);
    expect(theme.transitions.easing.easeInOut).toBe(MOTION.easeStandard);
  });

  it('MOTION 大转场契约：large 300 / largeExit 250 / fadeOut 90', () => {
    expect(MOTION.large).toBe(300);
    expect(MOTION.largeExit).toBe(250);
    expect(MOTION.fadeOut).toBe(90);
  });

  it('MuiCssBaseline styleOverrides 是函数，且同时下发 html 与 View Transitions 全局规则', () => {
    const theme = themeOf('light');
    const cssBaseline = theme.components?.MuiCssBaseline;
    expect(cssBaseline).toBeDefined();
    const overrides = cssBaseline!.styleOverrides;
    expect(typeof overrides).toBe('function');
    const styles = (overrides as (t: typeof theme) => Record<string, unknown>)(theme);
    expect(styles.html).toEqual({ fontSize: 14 });
    expect(styles.body).toEqual({ letterSpacing: '0.01em' });
    expect(Object.keys(styles).some((k) => k.startsWith('::view-transition'))).toBe(true);
  });

  it('水波 ripple 可见态终态透明度对齐 pressed 状态层', () => {
    const theme = themeOf('light');
    const ripple = theme.components?.MuiTouchRipple?.styleOverrides?.ripple as
      | Record<string, unknown>
      | undefined;
    expect(ripple).toBeDefined();
    const visible = ripple!['&.MuiTouchRipple-rippleVisible'] as { opacity?: number };
    expect(visible.opacity).toBe(STATE_OPACITY.pressed);
  });

  it('MuiCheckbox 有勾选 pop 动画覆盖（含 rtk-check-pop）', () => {
    const theme = themeOf('light');
    const checkbox = theme.components?.MuiCheckbox;
    expect(checkbox).toBeDefined();
    expect(JSON.stringify(checkbox!.styleOverrides)).toContain('rtk-check-pop');
  });

  it('AppBar defaultProps color=default 生效（MuiAppBar-colorDefault 类存在）', () => {
    const theme = themeOf('light');
    const { container } = render(
      createElement(ThemeProvider, { theme }, createElement(AppBar, { position: 'static' })),
    );
    const bar = container.querySelector('.MuiAppBar-root');
    expect(bar).not.toBeNull();
    expect(bar!.className).toContain('MuiAppBar-colorDefault');
  });

  it('深色语义色较浅色提亮（error.main 不等且来自 lighten）', () => {
    const light = themeOf('light');
    const dark = themeOf('dark');
    expect(dark.palette.error.main).not.toBe(light.palette.error.main);
    expect(dark.palette.info.main).not.toBe(light.palette.info.main);
    expect(dark.palette.success.main).not.toBe(light.palette.success.main);
    expect(dark.palette.warning.main).not.toBe(light.palette.warning.main);
  });
});
