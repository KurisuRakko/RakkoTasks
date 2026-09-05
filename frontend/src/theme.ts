// 主题：组件骨架仍为 MUI，视觉层整体换用 Rakko Design token（镜像常量见 ./rakko-tokens）。
// 深浅色跟随 ThemeModeProvider 的 resolved 值（system 时跟随系统偏好）。
// 纪律要点：正文用 n9、面用 n2、分割用 1px 边框；accent 只留给焦点元素与少量填充；
// 禁硬阴影（一律 whisper）；标题字重 500，全局不出现 700（CJK 禁伪粗）。

import { useMemo } from 'react';
import { alpha, createTheme, lighten } from '@mui/material/styles';
import type { Shadows, ThemeOptions } from '@mui/material/styles';
import { useThemeMode } from './lib/theme-mode';
import {
  ACCENT,
  BORDER,
  FONT_SANS,
  MOTION,
  NEUTRAL_DARK,
  NEUTRAL_LIGHT,
  RADIUS,
  SEMANTIC,
  STATE_OPACITY,
  TYPE_SCALE,
  WHISPER_SHADOW,
} from './rakko-tokens';

type Mode = 'light' | 'dark';

/** token 的 {size, lineHeight} → MUI 字阶样式 */
function typeStyle(scale: keyof typeof TYPE_SCALE): { fontSize: number; lineHeight: number } {
  const t = TYPE_SCALE[scale];
  return { fontSize: t.size, lineHeight: t.lineHeight };
}

function buildThemeOptions(mode: Mode): ThemeOptions {
  const n = mode === 'light' ? NEUTRAL_LIGHT : NEUTRAL_DARK;
  const [n1, n2, , , n5, , n7, , n9, n10] = n;
  const accent = mode === 'light' ? ACCENT.light : ACCENT.dark;
  // 语义色深色各提亮约 15%（tokens 约定），浅色直接用源色值
  const semantic =
    mode === 'dark'
      ? {
          info: lighten(SEMANTIC.info, 0.15),
          success: lighten(SEMANTIC.success, 0.15),
          warning: lighten(SEMANTIC.warning, 0.15),
          error: lighten(SEMANTIC.error, 0.15),
        }
      : SEMANTIC;

  return {
    palette: {
      mode,
      primary: {
        main: accent,
        contrastText: '#fff',
      },
      background: {
        default: n1,
        paper: n2,
      },
      text: {
        primary: n9,
        secondary: n7,
        disabled: n5,
      },
      divider: BORDER[mode],
      action: {
        // 状态层以控件前景（最高级中性墨色 n10）为底色，hover 4% / focus 8% / selected(pressed) 12%
        hover: alpha(n10, STATE_OPACITY.hover),
        focus: alpha(n10, STATE_OPACITY.focus),
        selected: alpha(n10, STATE_OPACITY.pressed),
      },
      info: { main: semantic.info },
      success: { main: semantic.success },
      warning: { main: semantic.warning },
      error: { main: semantic.error },
    },
    typography: {
      fontFamily: FONT_SANS,
      htmlFontSize: 14,
      fontSize: 14,
      // 关键：全局禁 700（CJK 禁伪粗），标题一律 500
      fontWeightBold: 500,
      body1: typeStyle('copy-14'),
      body2: typeStyle('copy-13'),
      caption: typeStyle('label-12'),
      overline: {
        ...typeStyle('label-12'),
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
      },
      subtitle1: { ...typeStyle('copy-15'), fontWeight: 500 },
      subtitle2: { ...typeStyle('copy-14'), fontWeight: 500 },
      h6: { ...typeStyle('title-20'), fontWeight: 500 },
      h5: { ...typeStyle('title-24'), fontWeight: 500 },
      h4: { ...typeStyle('title-28'), fontWeight: 500 },
      button: { ...typeStyle('copy-14'), fontWeight: 500, textTransform: 'none' },
    },
    shape: {
      borderRadius: RADIUS.base,
    },
    // 禁硬阴影：0 号位 none，1..24 全为 whisper 一档
    shadows: ['none', ...new Array<string>(24).fill(WHISPER_SHADOW)] as Shadows,
    transitions: {
      duration: {
        shortest: MOTION.state,
        shorter: MOTION.state,
        short: MOTION.state,
        standard: MOTION.enter,
        complex: MOTION.enter,
        enteringScreen: MOTION.enter,
        leavingScreen: MOTION.exit,
      },
      easing: {
        easeInOut: MOTION.easeStandard,
        easeOut: MOTION.easeStandard,
        easeIn: MOTION.easeStandard,
        sharp: MOTION.easeStandard,
      },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          html: { fontSize: 14 },
          body: { letterSpacing: '0.01em' },
        },
      },
      // AppBar 不再是 accent 大色块（accent 覆盖面 ≤5% 纪律）：paper 背景 + 下边框分层
      MuiAppBar: {
        defaultProps: { color: 'default' },
        styleOverrides: {
          root: ({ theme }) => ({
            backgroundColor: theme.palette.background.paper,
            color: theme.palette.text.primary,
            borderBottom: `1px solid ${theme.palette.divider}`,
            boxShadow: 'none',
          }),
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: { backgroundImage: 'none' },
        },
      },
      MuiCard: {
        styleOverrides: {
          root: { borderRadius: RADIUS.card },
        },
      },
      MuiDialog: {
        styleOverrides: {
          paper: { borderRadius: RADIUS.dialog },
        },
      },
      MuiChip: {
        styleOverrides: {
          root: { borderRadius: RADIUS.chip },
        },
      },
      MuiButton: {
        styleOverrides: {
          root: { borderRadius: RADIUS.base, textTransform: 'none' },
        },
      },
      // Fab 圆形是默认形状，不做圆角覆盖（圆保持默认）
      MuiListSubheader: {
        styleOverrides: {
          root: ({ theme }) => ({
            ...typeStyle('label-12'),
            backgroundColor: 'transparent',
            color: theme.palette.text.secondary,
            fontWeight: 500,
            letterSpacing: '0.04em',
          }),
        },
      },
      MuiButtonBase: {
        styleOverrides: {
          root: ({ theme }) => ({
            '&.Mui-focusVisible': {
              outline: `2px solid ${theme.palette.primary.main}`,
              outlineOffset: '2px',
            },
          }),
        },
      },
      MuiTouchRipple: {
        styleOverrides: {
          ripple: {
            '&.MuiTouchRipple-rippleVisible': { animationDuration: `${MOTION.ripple}ms` },
          },
        },
      },
      MuiBottomNavigation: {
        styleOverrides: {
          root: ({ theme }) => ({
            backgroundColor: theme.palette.background.paper,
            borderTop: `1px solid ${theme.palette.divider}`,
          }),
        },
      },
      MuiDrawer: {
        styleOverrides: {
          paper: ({ theme }) => ({
            borderRight: `1px solid ${theme.palette.divider}`,
          }),
        },
      },
    },
  };
}

export function useAppTheme() {
  const { resolved } = useThemeMode();
  return useMemo(() => createTheme(buildThemeOptions(resolved)), [resolved]);
}
