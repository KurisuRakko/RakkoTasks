// A1 的验收：浅/深两套 palette 全部显式取自 Rakko token，MUI 的默认值不许漏出来。
// 覆盖对象是 buildThemeOptions（单主题 ThemeOptions），再经 createTheme 求值——断言读的是
// 「主题真的下发了什么」，不是测试里手抄的颜色。
//
// 三条最重要的锁：
//  1. 深色 warning.main 不许等于 MUI 深色色板的 orange[400]（缺档时 MUI 会兜到它）；
//  2. 灰阶不许等于 Material 的 grey[400] / grey[600]（对照物见下面的 MUI_GREY_DEFAULTS）；
//  3. 语义四色必须是完整色阶（main/light/dark/contrastText 四项齐全），
//     缺一项 MUI 就会用 grey/自身算法兜底。

import { describe, expect, it } from 'vitest';
import { grey, orange } from '@mui/material/colors';
import { createTheme, lighten } from '@mui/material/styles';
import type { Theme } from '@mui/material/styles';
import {
  ACCENT,
  BORDER,
  NEUTRAL_DARK,
  NEUTRAL_LIGHT,
  PAPER,
  PAPER_RAISED,
  SEMANTIC,
  STATE_OPACITY,
} from '../src/rakko-tokens';
import { buildThemeOptions } from '../src/theme';

const MODES = ['light', 'dark'] as const;
type Mode = (typeof MODES)[number];

/** 两套主题各求值一次 */
const THEMES: Record<Mode, Theme> = {
  light: createTheme(buildThemeOptions('light')),
  dark: createTheme(buildThemeOptions('dark')),
};

/** MUI 灰阶里被本项目点名替换掉的几档：直接读 MUI 自己的色板当对照物，
 *  这样「漏值」的定义不靠手抄的十六进制（MUI 升级换值也不会让断言失效） */
const MUI_GREY_DEFAULTS = [grey[100], grey[200], grey[300], grey[400], grey[600]];

describe('A1 语义色：四档齐全，深浅两套都不来自 MUI 默认', () => {
  it('warning.main 不是 MUI 深色色板的 orange[400]', () => {
    // 对照物是 MUI 自己的 orange 色板：深色漏值时 warning.main 会等于 orange[400]
    for (const mode of MODES) {
      expect(THEMES[mode].palette.warning.main, mode).not.toBe(orange[400]);
      expect(THEMES[mode].palette.warning.main, mode).not.toBe(orange[800]);
    }
  });

  it('浅色四个语义色 main 逐项等于 token 原值', () => {
    const palette = THEMES.light.palette;
    expect(palette.info.main).toBe(SEMANTIC.info.main);
    expect(palette.success.main).toBe(SEMANTIC.success.main);
    expect(palette.warning.main).toBe(SEMANTIC.warning.main);
    expect(palette.error.main).toBe(SEMANTIC.error.main);
  });

  it('深色四个语义色 main 是 token main 提亮 15%（契约 tokens.md:71）', () => {
    const palette = THEMES.dark.palette;
    expect(palette.info.main).toBe(lighten(SEMANTIC.info.main, 0.15));
    expect(palette.success.main).toBe(lighten(SEMANTIC.success.main, 0.15));
    expect(palette.warning.main).toBe(lighten(SEMANTIC.warning.main, 0.15));
    expect(palette.error.main).toBe(lighten(SEMANTIC.error.main, 0.15));
  });

  it('四个语义色在深浅两套下都有 light / dark / contrastText 三项（缺项就会被 MUI 兜底）', () => {
    for (const mode of MODES) {
      for (const key of ['info', 'success', 'warning', 'error'] as const) {
        const slot = THEMES[mode].palette[key];
        expect(slot.light, `${mode} ${key}.light`).toBeTruthy();
        expect(slot.dark, `${mode} ${key}.dark`).toBeTruthy();
        expect(slot.contrastText, `${mode} ${key}.contrastText`).toBeTruthy();
      }
    }
  });

  it('深色的 light/dark 档不是 MUI 从 main 自动兜的值（等于 token 档同样提亮 15%）', () => {
    for (const key of ['info', 'success', 'warning', 'error'] as const) {
      const slot = THEMES.dark.palette[key];
      expect(slot.light, `dark ${key}.light`).toBe(lighten(SEMANTIC[key].light, 0.15));
      expect(slot.dark, `dark ${key}.dark`).toBe(lighten(SEMANTIC[key].dark, 0.15));
    }
  });

  it('contrastText 深浅一致（切换主题不改语义填充上的字色）', () => {
    for (const key of ['info', 'success', 'warning', 'error'] as const) {
      expect(THEMES.dark.palette[key].contrastText).toBe(THEMES.light.palette[key].contrastText);
    }
  });
});

describe('A1 灰阶：n1..n9 一一映射，不露 Material 灰', () => {
  it('grey[400] / grey[600] 不是 MUI 灰阶的对应档', () => {
    for (const mode of MODES) {
      expect(THEMES[mode].palette.grey[400], mode).not.toBe(grey[400]);
      expect(THEMES[mode].palette.grey[600], mode).not.toBe(grey[600]);
    }
  });

  it('grey 50..900 逐项等于该模式的 n1..n9', () => {
    const steps = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900] as const;
    for (const mode of MODES) {
      const neutral = mode === 'light' ? NEUTRAL_LIGHT : NEUTRAL_DARK;
      steps.forEach((step, index) => {
        expect(THEMES[mode].palette.grey[step], `${mode} grey[${step}]`).toBe(neutral[index]);
      });
    }
  });

  it('A100 / A200 / A400 / A700 也是 Rakko 中性档（MUI 只 merge 50..900，A* 会留 Material 值）', () => {
    for (const mode of MODES) {
      const grey = THEMES[mode].palette.grey;
      expect(MUI_GREY_DEFAULTS).not.toContain(grey.A100);
      expect(MUI_GREY_DEFAULTS).not.toContain(grey.A200);
      expect(MUI_GREY_DEFAULTS).not.toContain(grey.A400);
      expect(MUI_GREY_DEFAULTS).not.toContain(grey.A700);
      const neutral = mode === 'light' ? NEUTRAL_LIGHT : NEUTRAL_DARK;
      expect([neutral[1], neutral[2], neutral[3], neutral[5]]).toContain(grey.A100);
      expect([neutral[1], neutral[2], neutral[3], neutral[5]]).toContain(grey.A700);
    }
  });
});

describe('A1 基础面：accent / 纸色 / 分割线 / 状态层', () => {
  it('primary 用该模式的 accent token，深浅都带 light / dark / contrastText', () => {
    expect(THEMES.light.palette.primary.main).toBe(ACCENT.light);
    expect(THEMES.dark.palette.primary.main).toBe(ACCENT.dark);
    for (const mode of MODES) {
      const primary = THEMES[mode].palette.primary;
      expect(primary.light, `${mode} primary.light`).toBeTruthy();
      expect(primary.dark, `${mode} primary.dark`).toBeTruthy();
      expect(primary.contrastText, `${mode} primary.contrastText`).toBe('#fff');
    }
  });

  it('background.default 是纸色，paper 是抬升一档的实体面（两者都不取中性色阶）', () => {
    // 纸色与中性色阶分家是契约口径（tokens.md:7：深色不反转暖色阶，暖意只由 --color-paper
    // 承担）：浅色纸就是 n1，深色纸是另一支（见 PAPER 的注释），所以深色这里不能拿
    // NEUTRAL_DARK[0] 当期望值。实体浮层的底同理走 PAPER_RAISED——深色的 n2 是纯冷灰，
    // 压在暖纸上色调打架（见 PAPER_RAISED 的注释）。
    for (const mode of MODES) {
      expect(THEMES[mode].palette.background.default, mode).toBe(PAPER[mode]);
      expect(THEMES[mode].palette.background.paper, mode).toBe(PAPER_RAISED[mode]);
    }
    // 浅色两支仍等于浅色中性档（浅色是标杆，n1 / n2 一个值都没动）
    expect(THEMES.light.palette.background.default).toBe(NEUTRAL_LIGHT[0]);
    expect(THEMES.light.palette.background.paper).toBe(NEUTRAL_LIGHT[1]);
  });

  it('divider 用 BORDER token（不是 MUI 的 rgba(0,0,0,0.12)）', () => {
    for (const mode of MODES) {
      expect(THEMES[mode].palette.divider, mode).toBe(BORDER[mode]);
      expect(THEMES[mode].palette.divider, mode).not.toBe('rgba(0, 0, 0, 0.12)');
    }
  });

  it('action.hover / focus / selected 用状态层 token 的 4% / 8% / 12%', () => {
    for (const mode of MODES) {
      const action = THEMES[mode].palette.action;
      expect(action.hoverOpacity, mode).toBe(STATE_OPACITY.hover);
      expect(action.focusOpacity, mode).toBe(STATE_OPACITY.focus);
      expect(action.selectedOpacity, mode).toBe(STATE_OPACITY.pressed);
      expect(action.hover, mode).toContain(', 0.04)');
      expect(action.focus, mode).toContain(', 0.08)');
      expect(action.selected, mode).toContain(', 0.12)');
    }
  });

  it('禁用态的填充与文字都由 token 派生，不是 Material 的黑 alpha', () => {
    for (const mode of MODES) {
      const action = THEMES[mode].palette.action;
      expect(action.disabled, mode).not.toBe('rgba(0, 0, 0, 0.26)');
      expect(action.disabledBackground, mode).not.toBe('rgba(0, 0, 0, 0.12)');
      expect(action.disabledOpacity, mode).toBeGreaterThan(0);
    }
  });

  it('text.primary / secondary 是 n9 / n7', () => {
    for (const mode of MODES) {
      const neutral = mode === 'light' ? NEUTRAL_LIGHT : NEUTRAL_DARK;
      expect(THEMES[mode].palette.text.primary, mode).toBe(neutral[8]);
      expect(THEMES[mode].palette.text.secondary, mode).toBe(neutral[6]);
    }
  });
});
