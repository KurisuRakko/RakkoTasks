// Rakko Design token 主题测试：深浅两套 palette、字阶、whisper 阴影、动效时长
// 与 AppBar color="default"（defaultProps 生效）与深色语义色提亮。
// useAppTheme 依赖 ThemeModeProvider 的 resolved 值：先写 localStorage 再 renderHook。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, renderHook } from '@testing-library/react';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import AppBar from '@mui/material/AppBar';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { ThemeModeProvider } from '../src/lib/theme-mode';
import { DEFAULT_WALLPAPER_URL, WALLPAPER_LAYER_ID, WALLPAPER_VAR } from '../src/lib/glass';
import {
  ACCENT,
  GLASS,
  GLASS_SHADOW_WHISPER,
  MOTION,
  NEUTRAL_DARK,
  NEUTRAL_LIGHT,
  STATE_OPACITY,
  TYPE_SCALE,
  WHISPER_SHADOW,
} from '../src/rakko-tokens';
import { useAppTheme } from '../src/theme';
import { allStyleText, renderWithAppTheme } from './glass-text-contrast.test-utils';

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
    // body 只留排版属性：壁纸层是顶层键 '#rtk-wallpaper' 那一块规则
    // （断言见「玻璃材质变量下发与让位」的 5d/5j 用例），这里只验证 letterSpacing 保留
    expect(styles.body).toMatchObject({ letterSpacing: '0.01em' });
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

/** MuiCssBaseline styleOverrides 函数跑出全局样式表（:root / body / 伪元素选择器） */
function globalStyles(mode: 'light' | 'dark') {
  const theme = themeOf(mode);
  const cssBaseline = theme.components?.MuiCssBaseline;
  expect(cssBaseline).toBeDefined();
  const overrides = cssBaseline!.styleOverrides;
  expect(typeof overrides).toBe('function');
  return (overrides as (t: typeof theme) => Record<string, unknown>)(theme);
}

/** :root 下下发的 CSS 变量表（键即变量名） */
function rootVars(mode: 'light' | 'dark'): Record<string, string> {
  const styles = globalStyles(mode);
  const root = styles[':root'];
  expect(root, "CssBaseline 应下发 ':root' 规则块").toBeDefined();
  return root as Record<string, string>;
}

describe('玻璃材质变量下发与让位', () => {
  it('5a. :root 的 --glass-* 值与 GLASS 常量逐项一致（浅/深两套）', () => {
    const expected: Record<string, string> = {
      '--glass-blur': GLASS.blur,
      '--glass-saturate': GLASS.saturate,
      '--glass-surface-opacity': GLASS.surfaceOpacity,
      '--glass-panel-opacity': GLASS.panelOpacity,
      '--glass-scrim-opacity': GLASS.scrimOpacity,
      '--glass-haze-opacity': GLASS.hazeOpacity,
      '--glass-haze-bleed': GLASS.hazeBleed,
    };
    for (const mode of ['light', 'dark'] as const) {
      const vars = rootVars(mode);
      for (const [cssVar, tokenValue] of Object.entries(expected)) {
        expect(vars[cssVar], `${mode} ${cssVar}`).toBe(tokenValue);
      }
    }
  });

  it('5a2. --glass-highlight 已删除：GLASS 里没有这一条，:root 也不再下发', () => {
    // 旧「左上透镜」配方的镜面高光；Aero 改版后三档光泽都由 --glass-sheen-1..3 与
    // --glass-rim / --glass-lip 出，没有任何规则再读它。留着只会让测试替一个死键护航。
    expect(Object.keys(GLASS)).not.toContain('highlight');
    for (const mode of ['light', 'dark'] as const) {
      expect(rootVars(mode), `${mode} 不该再下发 --glass-highlight`).not.toHaveProperty(
        '--glass-highlight',
      );
    }
  });

  it('5b. --shadow-whisper 浅色=GLASS_SHADOW_WHISPER.light，深色=.dark', () => {
    expect(rootVars('light')['--shadow-whisper']).toBe(GLASS_SHADOW_WHISPER.light);
    expect(rootVars('dark')['--shadow-whisper']).toBe(GLASS_SHADOW_WHISPER.dark);
  });

  it('5c. --color-paper 等于该主题 palette.background.default', () => {
    for (const mode of ['light', 'dark'] as const) {
      const theme = themeOf(mode);
      expect(rootVars(mode)['--color-paper']).toBe(theme.palette.background.default);
      expect(rootVars(mode)['--color-paper']).toBe(
        mode === 'light' ? NEUTRAL_LIGHT[0] : NEUTRAL_DARK[0],
      );
    }
  });

  it('5d. 壁纸原图单层背景位于顶层键 #rtk-wallpaper 承载层（var(--rtk-wallpaper)，驯化层已移除不含 color-mix）', () => {
    for (const mode of ['light', 'dark'] as const) {
      const styles = globalStyles(mode);
      const layer = styles[`#${WALLPAPER_LAYER_ID}`] as Record<string, unknown> | undefined;
      expect(layer, `${mode}: 壁纸层应是顶层键 '#${WALLPAPER_LAYER_ID}'`).toBeDefined();
      const bg = layer!.backgroundImage;
      expect(typeof bg).toBe('string');
      expect(bg as string).toContain('var(--rtk-wallpaper');
      // 驯化层已移除：不再有纸色 color-mix 叠加层，壁纸显示用户原图
      expect(bg as string).not.toContain('color-mix');
    }
  });

  it('5d2. 图源变量的兜底是默认壁纸而不是 none：lib/wallpaper 未执行时也不该空成纯纸色', () => {
    for (const mode of ['light', 'dark'] as const) {
      const styles = globalStyles(mode);
      const layer = styles[`#${WALLPAPER_LAYER_ID}`] as Record<string, unknown> | undefined;
      const bg = layer!.backgroundImage as string;
      expect(bg).not.toContain('none');
      expect(bg).toContain(`url("${DEFAULT_WALLPAPER_URL}")`);
    }
  });

  it('5e. AppBar 顶层无 backgroundColor，纸色只落在 &:not([data-glass])', () => {
    const theme = themeOf('light');
    const appBar = theme.components?.MuiAppBar;
    expect(appBar).toBeDefined();
    const rootOverride = appBar!.styleOverrides?.root as unknown as (p: {
      theme: typeof theme;
    }) => Record<string, unknown>;
    const rootStyles = rootOverride({ theme });
    expect(rootStyles.backgroundColor).toBeUndefined();
    expect(rootStyles.borderBottom).toBeUndefined();
    const plain = rootStyles['&:not([data-glass])'] as Record<string, unknown>;
    expect(plain.backgroundColor).toBe(theme.palette.background.paper);
    expect(plain.borderBottom).toBe(`1px solid ${theme.palette.divider}`);
  });

  it('5f. MuiBackdrop 压暗层引用 --glass-scrim-opacity', () => {
    const theme = themeOf('light');
    const backdrop = theme.components?.MuiBackdrop;
    expect(backdrop).toBeDefined();
    expect(JSON.stringify(backdrop!.styleOverrides)).toContain('var(--glass-scrim-opacity)');
  });

  it('5g. MuiPaper 顶层不下发 backgroundImage，只落在 &:not([data-glass])', () => {
    const theme = themeOf('light');
    const paper = theme.components?.MuiPaper;
    expect(paper).toBeDefined();
    const rootOverride = paper!.styleOverrides?.root as
      | Record<string, unknown>
      | ((p: { theme: typeof theme }) => Record<string, unknown>);
    const rootStyles =
      typeof rootOverride === 'function' ? rootOverride({ theme }) : (rootOverride ?? {});
    // 顶层 backgroundImage 会把挂 data-glass 的 Paper 背景抹掉（panel 档的透镜渐变
    // 来自镜像配方的背景声明）；backgroundImage: none 只用来压 MUI 深色模式的
    // overlay 渐变，故收敛到 ':not([data-glass])'
    expect(rootStyles.backgroundImage).toBeUndefined();
    const plain = rootStyles['&:not([data-glass])'] as Record<string, unknown> | undefined;
    expect(plain, "MuiPaper 的 backgroundImage: none 应收敛到 '&:not([data-glass])'").toBeDefined();
    expect(plain!.backgroundImage).toBe('none');
  });

  it('5h. MuiDrawer paper 保留右侧分割线（chrome 发丝线在下缘，方向对不上侧边栏）', () => {
    const theme = themeOf('light');
    const drawer = theme.components?.MuiDrawer;
    expect(drawer).toBeDefined();
    const paperOverride = drawer!.styleOverrides?.paper as unknown as (p: {
      theme: typeof theme;
    }) => Record<string, unknown>;
    const paperStyles = paperOverride({ theme });
    expect(paperStyles.borderRight).toBe(`1px solid ${theme.palette.divider}`);
  });

  it('5i. MuiBottomNavigation root 保持透明（玻璃底色来自外层 Paper 的 data-glass）', () => {
    const theme = themeOf('light');
    const bottomNav = theme.components?.MuiBottomNavigation;
    expect(bottomNav).toBeDefined();
    const rootOverride = bottomNav!.styleOverrides?.root as
      | Record<string, unknown>
      | ((p: { theme: typeof theme }) => Record<string, unknown>);
    const rootStyles =
      typeof rootOverride === 'function' ? rootOverride({ theme }) : (rootOverride ?? {});
    expect(rootStyles.backgroundColor).toBe('transparent');
  });

  it('5j. 壁纸层由 #rtk-wallpaper 真实 DOM 节点承载：body 不再带背景，承载层 fixed / inset 0 / z-index -1 / pointer-events none，且无 backgroundAttachment', () => {
    for (const mode of ['light', 'dark'] as const) {
      const styles = globalStyles(mode);
      const body = styles.body as Record<string, unknown>;
      // 背景已挪进真实 DOM 承载层，body 只剩排版属性；backgroundAttachment: fixed 整条删除——
      // 固定由 position: fixed 提供，留着是死代码
      expect(body['&::before']).toBeUndefined();
      expect(body.backgroundImage).toBeUndefined();
      expect(body.backgroundAttachment).toBeUndefined();
      const layer = styles[`#${WALLPAPER_LAYER_ID}`] as Record<string, unknown> | undefined;
      expect(layer, `${mode}: 应存在 '#${WALLPAPER_LAYER_ID}' 承载层规则`).toBeDefined();
      expect(layer!.position).toBe('fixed');
      expect(layer!.inset).toBe(0);
      expect(layer!.zIndex).toBe(-1);
      expect(layer!.pointerEvents).toBe('none');
      expect(layer!.backgroundAttachment).toBeUndefined();
    }
  });

  it('5k. 壁纸层自带不透明纸色地板：backgroundColor 等于该主题的 palette.background.default', () => {
    for (const mode of ['light', 'dark'] as const) {
      const theme = themeOf(mode);
      const styles = globalStyles(mode);
      const layer = styles[`#${WALLPAPER_LAYER_ID}`] as Record<string, unknown> | undefined;
      expect(layer, `${mode}: 应存在 '#${WALLPAPER_LAYER_ID}' 承载层规则`).toBeDefined();
      // 承载层被单独快照后与 canvas 背景分家，自己必须是一块不透明地板：
      // 壁纸尚未解码、或壁纸带 alpha 时，透过去看到的就是 canvas
      expect(layer!.backgroundColor).toBe(theme.palette.background.default);
      expect(layer!.backgroundColor).not.toBe('transparent');
    }
  });

  it('5l. 承载层规则真的落到样式表：规则块含 position:fixed / z-index:-1 / pointer-events:none', () => {
    // 5d/5j/5k 只验证样式对象；这一条验证 emotion 真的把 '#rtk-wallpaper' 作为顶层选择器
    // 写进了样式表（测试环境非 speedy，规则以文本节点注入 <style>，机制同 alert-glass）
    renderWithAppTheme(createElement(CssBaseline));
    const css = allStyleText().replace(/\s+/g, '');
    const start = css.indexOf(`#${WALLPAPER_LAYER_ID}{`);
    expect(start, `样式表里应出现 '#${WALLPAPER_LAYER_ID}{' 规则块`).toBeGreaterThanOrEqual(0);
    const end = css.indexOf('}', start);
    expect(end).toBeGreaterThan(start);
    const rule = css.slice(start, end);
    expect(rule).toContain('position:fixed');
    expect(rule).toContain('z-index:-1');
    expect(rule).toContain('pointer-events:none');
  });
});

describe('玻璃高光已不再下发（Aero 光泽取代旧镜面高光）', () => {
  // 「没有壁纸」已不是一种状态：用户没设时背景是默认壁纸，玻璃身后永远有图像可透。
  // 旧配方按图源分流 --glass-highlight 的选择器早已不存在，Aero 改版后连这条变量
  // 本身（连同 GLASS.highlight 与 :root 下发）都已删除，见 5a2。
  it('6a. 两个模式都不存在按图源分流的高光改写块', () => {
    for (const mode of ['light', 'dark'] as const) {
      const keys = Object.keys(globalStyles(mode));
      expect(
        keys.filter((key) => key.includes(WALLPAPER_VAR)),
        `${mode}: 不该再有按 ${WALLPAPER_VAR} 分流的选择器`,
      ).toEqual([]);
    }
  });

  it('6b. 两个模式的 :root 都不含 --glass-highlight', () => {
    expect(rootVars('light')).not.toHaveProperty('--glass-highlight');
    expect(rootVars('dark')).not.toHaveProperty('--glass-highlight');
  });
});
