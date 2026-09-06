// 主题：组件骨架仍为 MUI，视觉层整体换用 Rakko Design token（镜像常量见 ./rakko-tokens）。
// 深浅色跟随 ThemeModeProvider 的 resolved 值（system 时跟随系统偏好）。
// 纪律要点：正文用 n9、面用 n2、分割用 1px 边框；accent 只留给焦点元素与少量填充；
// 禁硬阴影（一律 whisper）；标题字重 500，全局不出现 700（CJK 禁伪粗）。

import { useMemo } from 'react';
import { alpha, createTheme, lighten } from '@mui/material/styles';
import type { Shadows, ThemeOptions } from '@mui/material/styles';
import { useThemeMode } from './lib/theme-mode';
import { viewTransitionStyles } from './motion-styles';
import {
  ACCENT,
  BORDER,
  FONT_SANS,
  GLASS,
  GLASS_SHADOW_WHISPER,
  MOTION,
  NEUTRAL_DARK,
  NEUTRAL_LIGHT,
  RADIUS,
  SEMANTIC,
  STATE_OPACITY,
  TYPE_SCALE,
  WHISPER_SHADOW,
} from './rakko-tokens';
import { WALLPAPER_TAME_OPACITY, WALLPAPER_VAR } from './lib/glass';

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
  // 驯化层：壁纸之上、玻璃之下的一层纸色叠加，把任意用户壁纸压进可控亮度区间
  // （玻璃档位按「身后是纸色系页面」调校，见 lib/glass.ts 的 WALLPAPER_TAME_OPACITY）
  const tame = `color-mix(in srgb, ${n1} ${WALLPAPER_TAME_OPACITY}, transparent)`;
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
        // 基线字号行高之外，View Transitions 的全局 keyframes 与 ::view-transition-* 规则
        // 也从这里注入：styleOverrides 的返回值会整段作为全局样式下发
        styleOverrides: (themeParam) => ({
          html: { fontSize: 14 },
          // rakko-glass.css 消费的全部 CSS 变量由主题层在这里下发到 :root——它自己不带任何
          // 默认值，是这套玻璃材质唯一的数据源；值来自 rakko-tokens 的镜像常量（GLASS /
          // GLASS_SHADOW_WHISPER），深浅主题各自求值。
          // --shadow-whisper 深色加深是契约要求：深底需要更强的阴影托起浮层。
          ':root': {
            '--color-paper': n1, // 页面纸色 = palette.background.default
            '--color-border': BORDER[mode],
            '--color-neutral-1': n[0],
            '--color-neutral-9': n[8],
            '--color-neutral-10': n[9],
            '--glass-blur': GLASS.blur,
            '--glass-saturate': GLASS.saturate,
            '--glass-surface-opacity': GLASS.surfaceOpacity,
            '--glass-panel-opacity': GLASS.panelOpacity,
            '--glass-scrim-opacity': GLASS.scrimOpacity,
            '--glass-highlight': GLASS.highlight,
            '--glass-haze-opacity': GLASS.hazeOpacity,
            '--glass-haze-bleed': GLASS.hazeBleed,
            '--shadow-whisper': GLASS_SHADOW_WHISPER[mode],
          },
          // body 两层背景：第一层是驯化层（把用户壁纸压进可控亮度区间，理由见 lib/glass 注释），
          // 第二层是壁纸本身，由 lib/wallpaper 写到 <html> 上；无壁纸时该变量为 none，
          // 退回纯纸色背景。backgroundAttachment: fixed 让壁纸不随滚动移动。
          body: {
            letterSpacing: '0.01em',
            backgroundImage: `linear-gradient(${tame}, ${tame}), var(${WALLPAPER_VAR}, none)`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            backgroundAttachment: 'fixed',
            backgroundRepeat: 'no-repeat',
          },
          ...viewTransitionStyles(themeParam),
        }),
      },
      // AppBar 不再是 accent 大色块（accent 覆盖面 ≤5% 纪律）：paper 背景 + 下边框分层。
      // 挂了 data-glass 的 AppBar（壳层顶栏）由 rakko-glass.css 的 chrome 配方接管，
      // 主题层一个 background / border 声明都不许下发——不能写成「data-glass 时设
      // transparent」：那是 (0,2,0) 的声明，会盖掉玻璃配方的 background，只剩模糊没有纸底。
      // 让位的唯一正确形式就是「什么都不写」。对话框内部的 AppBar（position="static"，
      // 不挂 data-glass）照旧走纸面色 + 下边框。
      MuiAppBar: {
        defaultProps: { color: 'default' },
        styleOverrides: {
          root: ({ theme }) => ({
            color: theme.palette.text.primary,
            boxShadow: 'none',
            '&:not([data-glass])': {
              backgroundColor: theme.palette.background.paper,
              borderBottom: `1px solid ${theme.palette.divider}`,
            },
          }),
        },
      },
      // 遮罩只压暗不模糊：全屏 backdrop-filter 要每帧读回整个视口，是整套材质里最贵的
      // 东西。用纯黑而不是 n-10，因为 n-10 在深色主题会翻成近白，遮罩会变成漂白层。
      // :not(.MuiBackdrop-invisible) 是不把 MUI 的隐形遮罩变体染黑。
      MuiBackdrop: {
        styleOverrides: {
          root: {
            '&:not(.MuiBackdrop-invisible)': {
              backgroundColor: 'rgb(0 0 0 / var(--glass-scrim-opacity))',
            },
          },
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
        // 水波终态停在 pressed 状态层 12%（MUI 默认 0.3 偏重），且进场淡入幅度
        // 收窄到 hover→pressed 之间，避免波峰闪白
        styleOverrides: {
          ripple: {
            '&.MuiTouchRipple-rippleVisible': {
              opacity: STATE_OPACITY.pressed,
              animationName: 'rtk-ripple-enter',
              animationDuration: `${MOTION.ripple}ms`,
              animationTimingFunction: MOTION.easeStandard,
            },
            '& .MuiTouchRipple-childLeaving': { animationDuration: `${MOTION.ripple}ms` },
            '@keyframes rtk-ripple-enter': {
              from: { transform: 'scale(0)', opacity: STATE_OPACITY.hover },
              to: { transform: 'scale(1)', opacity: STATE_OPACITY.pressed },
            },
          },
        },
      },
      MuiCheckbox: {
        // 勾选瞬间图标做一次小 pop，反馈选中动作；系统偏好减动效时去掉
        styleOverrides: {
          root: {
            '&.Mui-checked .MuiSvgIcon-root': {
              animation: `rtk-check-pop ${MOTION.state}ms ${MOTION.easeStandard}`,
            },
            '@keyframes rtk-check-pop': {
              from: { transform: 'scale(0.8)' },
              to: { transform: 'scale(1)' },
            },
            '@media (prefers-reduced-motion: reduce)': {
              '&.Mui-checked .MuiSvgIcon-root': { animation: 'none' },
            },
          },
        },
      },
      // 底栏底色与分割线改由 AppShell 的外层 Paper 提供（它叠在内容玻璃板之上），
      // 内层保持透明，否则会挡住外层的半透明纸底。
      MuiBottomNavigation: {
        styleOverrides: {
          root: { backgroundColor: 'transparent' },
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
