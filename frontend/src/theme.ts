// 主题：组件骨架仍为 MUI，视觉层整体换用 Rakko Design token（镜像常量见 ./rakko-tokens）。
// 深浅色跟随 ThemeModeProvider 的 resolved 值（system 时跟随系统偏好）。
// 纪律要点：正文用 n9、面用 n2、分割用 1px 边框；accent 只留给焦点元素与少量填充；
// 禁硬阴影（一律 whisper）；标题字重 500，全局不出现 700（CJK 禁伪粗）。
//
// 组件层（components）的两条总则：
// 1. 同一个角色只有一种样式——按钮四档层级（contained 主 / outlined 次 / text 三级 /
//    error 危险）、芯片一种字号与圆角、输入框一种描边与焦点。差异只由 variant 表达，
//    调用点不再各自覆写尺寸。
// 2. 颜色只能来自 theme.palette 或 rakko-tokens 的 token：这里不出现新的 #hex 字面量，
//    连"加深一档"也写成 token 之间的 alpha 混合，避免 Material 默认值顺 MUI 内部
//    grey/orange 漏进界面。

import { useMemo } from 'react';
import { alpha, createTheme, darken, getContrastRatio, lighten } from '@mui/material/styles';
import type { PaletteColorOptions, Shadows, Theme, ThemeOptions } from '@mui/material/styles';
import { useThemeMode } from './lib/theme-mode';
import { viewTransitionStyles } from './motion-styles';
import {
  ACCENT,
  BORDER,
  FONT_SANS,
  GLASS,
  GLASS_AERO,
  GLASS_SHADOW_WHISPER,
  MOTION,
  NEUTRAL_DARK,
  NEUTRAL_LIGHT,
  RADIUS,
  SEMANTIC,
  SEMANTIC_INVERSE_SURFACE,
  SEMANTIC_TINT_ALPHA,
  SPACING,
  STATE_OPACITY,
  TEXT_CONTRAST_MIN,
  TYPE_SCALE,
  WHISPER_SHADOW,
} from './rakko-tokens';
import { DEFAULT_WALLPAPER_URL, SCRIM_COLOR, WALLPAPER_LAYER_ID, WALLPAPER_VAR } from './lib/glass';

type Mode = 'light' | 'dark';

/** 按钮两档度量（px）：medium 36 高 / 水平 16，small 30 高 / 水平 12。
 *  contract 的 components.md 未给按钮规格，取 Apple HIG 的 44pt 触摸目标在桌面端
 *  收敛后的常用值；同一行里的按钮高度一致，不参差。 */
const BUTTON_METRICS = {
  medium: { minHeight: 36, paddingInline: SPACING.lg },
  small: { minHeight: 30, paddingInline: SPACING.md },
} as const;

/** 中性浅填充的不透明度（芯片默认填充 / 按钮禁用填充共用一套口径）：
 *  纸底上叠一层中性墨色，浅色 8% 读起来是"纸上一档灰"、深色 12% 才分得出边界。
 *  不用 background.paper 这类不透明纸色：芯片压在玻璃行上会变成一颗实心药丸，
 *  浅色主题下又和卡片同色、只剩文字。 */
const NEUTRAL_TINT_ALPHA = { light: 0.08, dark: 0.12 } as const;

/** 语义色 filled 芯片的底色：main 档与 contrastText 够不到 TEXT_CONTRAST_MIN 时降到
 *  dark 档。深色主题下 info / error 的 main 是提亮值，配白字只有 4.23——12px 的芯片
 *  标签按正文档要求不合格，换成它们的 dark 档（5.10 / 5.15）。 */
function semanticFill(theme: Theme, key: 'info' | 'success' | 'warning' | 'error'): string {
  const slot = theme.palette[key];
  return getContrastRatio(slot.contrastText, slot.main) >= TEXT_CONTRAST_MIN ? slot.main : slot.dark;
}

/** 四个语义色的 MUI 名（palette 键 → class 后缀），芯片与其它语义色零件共用 */
const SEMANTIC_KEYS = ['info', 'success', 'warning', 'error'] as const;

/** MUI 的"加深/变浅一档"用前景墨色 alpha 表达，不引入新的 hex：
 *  hover 描边 = 边框 token 再叠 20% 墨色，浅色变深、深色变亮，方向都正确
 *  （深色主题 BORDER 是白 12%，叠白墨就是提亮）。 */
const BORDER_STRONG_ALPHA = 0.2;

/** token 的 {size, lineHeight} → MUI 字阶样式 */
function typeStyle(scale: keyof typeof TYPE_SCALE): { fontSize: number; lineHeight: number } {
  const t = TYPE_SCALE[scale];
  return { fontSize: t.size, lineHeight: t.lineHeight };
}

/** 单主题的 ThemeOptions（未过 createTheme）。导出给测试用：断言组件最终生效值时
 *  要读「主题真的下发了什么」，而不是在测试里手抄一份颜色。 */
export function buildThemeOptions(mode: Mode): ThemeOptions {
  const n = mode === 'light' ? NEUTRAL_LIGHT : NEUTRAL_DARK;
  const [n1, n2, , , n5, n6, n7, , n9, n10] = n;
  const accent = mode === 'light' ? ACCENT.light : ACCENT.dark;
  // accent 的 light/dark 是从 main 派生的两档（契约 ACCENT 只给了一个基础色）：浅色主题
  // 向亮侧、暗侧各 15%；深色主题的 accent 本身已是提亮值（#e095a4），dark 档直接沿用
  // main 而不压暗——再压一档会掉进背景的暗区。
  const accentLight = lighten(accent, 0.15);
  const accentDark = mode === 'light' ? darken(accent, 0.15) : accent;
  // 语义四色的每个档都是显式 token（SEMANTIC 的注释说明派生规则）；深色主题按契约
  // （tokens.md:71）把整个色阶上提 15%——只换 main，light/dark 的相对关系不变。
  // 四个语义色都必须是完整色阶：缺哪一档，MUI 就会用自己的默认色板补上
  // （深色 warning 会变成 MUI 深色色板的 orange[400]）。对照断言见
  // theme-palette.test.ts。
  const lift = (c: string) => lighten(c, 0.15);
  const semanticOf = (s: (typeof SEMANTIC)[keyof typeof SEMANTIC]): PaletteColorOptions =>
    mode === 'dark'
      ? { light: lift(s.light), main: lift(s.main), dark: lift(s.dark), contrastText: s.contrastText }
      : { ...s };
  const border = BORDER[mode];
  // 描边深一档：边框 token 上再叠一层墨色（见 BORDER_STRONG_ALPHA 的说明）
  const borderStrong = alpha(n9, BORDER_STRONG_ALPHA);

  return {
    palette: {
      mode,
      primary: {
        main: accent,
        light: accentLight,
        dark: accentDark,
        contrastText: '#fff',
      },
      background: {
        default: n1,
        paper: n2,
      },
      text: {
        primary: n9,
        secondary: n7,
        // 禁用文字沿用 n5（契约里 n5 标注「never text」，但禁用态本就该几乎读不见，
        // 这里保持既有取值不动以免改变页面上已定稿的禁用观感）；按钮的禁用填充与文字
        // 走下面 action.disabled / disabledBackground 一对（见 alert-glass 的守卫用例）。
        disabled: n5,
      },
      divider: border,
      action: {
        // 状态层以控件前景（最高级中性墨色 n10）为底色，hover 4% / focus 8% /
        // selected(pressed) 12%（motion.md:15-17）
        hover: alpha(n10, STATE_OPACITY.hover),
        focus: alpha(n10, STATE_OPACITY.focus),
        selected: alpha(n10, STATE_OPACITY.pressed),
        // 禁用态文字：n6（小号标签档）压到 70%，约 2.9:1——禁用本就该弱，但至少读得出
        // 「这里有字」；不用 MUI 默认那支 Material 黑 alpha（深浅主题同一支，深色主题下
        // 会几乎看不见）。
        disabled: alpha(n6, 0.7),
        // 禁用填充与芯片默认填充同一档（见 NEUTRAL_TINT_ALPHA）
        disabledBackground: alpha(n9, NEUTRAL_TINT_ALPHA[mode]),
        // 对应 *Opacity：MUI 用它们去 alpha(action.*) 派生状态层，这里直接对齐状态层 token
        hoverOpacity: STATE_OPACITY.hover,
        selectedOpacity: STATE_OPACITY.pressed,
        focusOpacity: STATE_OPACITY.focus,
        disabledOpacity: 0.6,
      },
      // 灰阶整体换成 Rakko 中性色阶（n1..n9 按亮度就近一一对应），MUI 内部按 grey[300] /
      // grey[700] / grey.A100 取色的地方（Avatar 兜底、Chip 图标色、inherit 按钮 hover、
      // outlined 按钮的描边……）都落在 Rakko 的中性色上，不出现 Material 灰。
      // A100/A200/A400/A700 必须显式给：MUI 的 createTheme 只会用 grey 的 50..900 递归
      // deepmerge，A* 四条会原样保留 Material 默认值（Material 的 A400 是中灰，
      // 与本项目的中性色阶对不上；对照物写在 theme-palette.test.ts 里）。
      grey: {
        50: n[0],
        100: n[1],
        200: n[2],
        300: n[3],
        400: n[4],
        500: n[5],
        600: n[6],
        700: n[7],
        800: n[8],
        900: n[9],
        A100: n[1],
        A200: n[2],
        A400: n[3],
        A700: n[5],
      },
      info: semanticOf(SEMANTIC.info),
      success: semanticOf(SEMANTIC.success),
      warning: semanticOf(SEMANTIC.warning),
      error: semanticOf(SEMANTIC.error),
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
            '--glass-haze-opacity': GLASS.hazeOpacity,
            '--glass-haze-bleed': GLASS.hazeBleed,
            // Aero 化新增的十二个材质 token（rakko-glass.css 的厚度边/光泽/文字光晕消费，
            // 变量名 rim→--glass-rim、rimInner→--glass-rim-inner … textGlow→--glass-text-glow）。
            // 深浅各自求值：深色是重新定的档位，不是浅色的简单缩放；textGlow 反相是硬约束。
            '--glass-rim': GLASS_AERO[mode].rim,
            '--glass-rim-inner': GLASS_AERO[mode].rimInner,
            '--glass-lip': GLASS_AERO[mode].lip,
            '--glass-lip-under': GLASS_AERO[mode].lipUnder,
            '--glass-side': GLASS_AERO[mode].side,
            '--glass-bloom': GLASS_AERO[mode].bloom,
            '--glass-sheen-1': GLASS_AERO[mode].sheen1,
            '--glass-sheen-2': GLASS_AERO[mode].sheen2,
            '--glass-sheen-3': GLASS_AERO[mode].sheen3,
            '--glass-lift': GLASS_AERO[mode].lift,
            '--glass-text-glow': GLASS_AERO[mode].textGlow,
            '--shadow-whisper': GLASS_SHADOW_WHISPER[mode],
          },
          // 不下发 --glass-highlight：chrome / panel / inverse 三档的光泽全部由
          // --glass-sheen-1..3 与 --glass-rim / --glass-lip 承担，没有任何规则读它
          // （上游 tokens.css 仍列着这个契约 token，本地不消费就不下发）。
          // body 只留排版属性：地板整体在下面的壁纸承载层里。
          body: {
            letterSpacing: '0.01em',
          },
          // 壁纸承载层：整页地板（纸色 + 用户壁纸原图）都在这一层，是 index.html 里的
          // 真实 DOM 节点。
          // - 不用 background-attachment: fixed——iOS Safari 从未正确实现它，一律退化成
          //   跟着内容滚；position: fixed 在 iOS 上工作正常。用户是 PWA standalone，
          //   没有伸缩地址栏，视口高度恒定，inset: 0 即可，无需 100lvh 等动态视口单位；
          // - z-index: -1：定位后代排在「根元素背景之后、块级非定位后代之前」，既盖不住
          //   页面内容，又仍位于玻璃元素身后——backdrop-filter 照样读得到壁纸；
          // - pointerEvents: none：纯背景层，不能吃掉任何点击；
          // - backgroundColor 垫纸色：这一层必须是一块不透明的地板——壁纸尚未解码、
          //   或壁纸带 alpha 时，透过去就是 canvas。今天 canvas 的基色是 CssBaseline 给
          //   body 设的 background.default 传播上去的，与这里的 n1 同色，垫上去当前观感
          //   等价；它的价值是不依赖 body → canvas 这条传播链，body 背景一旦改透明，
          //   这一层就是唯一的不透明地板。这一层今天恒有图：用户壁纸或默认壁纸，
          //   纸色只是图尚未解码时的底。
          // 壁纸图源由 lib/wallpaper 写到 <html> 的 CSS 变量上，不叠驯化层纸色（驯化层已
          // 移除，壁纸显示用户原图）；变量的兜底值是默认壁纸而不是 none——lib/wallpaper
          // 尚未执行时也不该空成纯纸色。
          [`#${WALLPAPER_LAYER_ID}`]: {
            position: 'fixed',
            inset: 0,
            zIndex: -1,
            pointerEvents: 'none',
            backgroundColor: n1,
            backgroundImage: `var(${WALLPAPER_VAR}, url("${DEFAULT_WALLPAPER_URL}"))`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
          },
          ...viewTransitionStyles(themeParam),
        }),
      },
      // Alert 走「语义色描边的纸色内嵌盒」：底色与 panel 档玻璃纸色同一个 color-mix
      // 表达式（逐字一致，58% 不写死），在玻璃卡片上是更实一点的内嵌盒，裸页面背景上
      // 落在实测安全的纸色阅读条件；文字强制 n9——玻璃上次级文字 n7 只有 2.36–2.64，
      // 只有 n9 全场过 AA，MUI 默认的压暗语义色文字是 Material 做法，一律不用。
      // 不挂 data-glass：Alert 常出现在 data-glass="panel" 卡片内部，挂上就破坏
      // 「data-glass 不嵌套」既有不变量（search-page.test.tsx 在断言它），所以只要纸色
      // 底，不要模糊、不要厚度边、不要光泽。severity 底色是 MUI 内部 variants，注入先于
      // styleOverrides.root：emotion 片段拼接不按键合并，两套声明会同时留在规则文本里，
      // 靠「覆盖声明追加在 variants 之后、同级级联后者生效」盖住它；若哪天顺序回归导致
      // 盖不住，需补 standardSuccess / standardInfo / standardWarning / standardError
      // 四个插槽显式清底（alert-glass.test.tsx 的生效值断言会先失败报警）。
      MuiAlert: {
        styleOverrides: {
          root: ({ theme, ownerState }) => {
            const severityMain = theme.palette[ownerState.severity ?? 'success'].main;
            return {
              borderRadius: RADIUS.base,
              backgroundColor:
                'color-mix(in srgb, var(--color-paper) var(--glass-panel-opacity), transparent)',
              backgroundImage: 'none', // 压掉 MUI 深色 Paper 的 overlay 渐变
              boxShadow: 'none',
              border: `1px solid ${alpha(severityMain, mode === 'light' ? 0.34 : 0.42)}`,
              color: theme.palette.text.primary,
            };
          },
          icon: ({ theme, ownerState }) => ({
            color: theme.palette[ownerState.severity ?? 'success'].main,
          }),
        },
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
              backgroundColor: SCRIM_COLOR,
            },
          },
        },
      },
      // backgroundImage: 'none' 是为了压掉 MUI 深色模式的 overlay 渐变。收进
      // &:not([data-glass])：挂了 data-glass 的 Paper 由 rakko-glass.css 提供背景
      // （panel 档本身就带透镜渐变），主题层不能把它抹掉。
      MuiPaper: {
        styleOverrides: {
          root: { '&:not([data-glass])': { backgroundImage: 'none' } },
        },
      },
      // Avatar 是身份标记，不是状态：中性色填充 + n9 文字。交给 MUI 默认会顺
      // palette.primary 出一块 accent 底，头像成排时顶破 accent 覆盖面 ≤5% 的纪律。
      MuiAvatar: {
        styleOverrides: {
          root: ({ theme }) => ({
            backgroundColor: theme.palette.grey[300],
            color: theme.palette.text.primary,
          }),
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
      // 芯片只有一种零件：12px/500 的标签字（label-12）与 RADIUS.chip 的克制圆角。
      // 字号收在 label 插槽而不是 root，是为了压平 MUI 给 small(12) / medium(13) /
      // large(14) 三档不同字号带来的「同一个芯片在不同页面大小不一」。
      // 高度不给：交回 MUI 的 size 体系（medium 32 / small 24），调用点的 size="small"
      // 状态芯片要保持自己的小尺寸，统一高度会把它们撑胖。
      //
      // 语义色的芯片有一条硬约束：**文字一律 text.primary**。
      // 芯片标签是 12px 正文，MUI 默认把语义色 main 当文字色，压在纸底上 success 只有
      // 2.93、warning 3.58（压在 58% 玻璃上更低），够不到 TEXT_CONTRAST_MIN。所以
      // outlined 的语义由「同色描边 + 同色淡填充」传达，文字与图标分家：
      //   文字 text.primary（13.6:1），描边 palette[c].main，底色 alpha(main, 14%/20%)。
      // filled 语义芯片保留 main 底 + contrastText（语义靠整块底色，文字必须是最强的
      // 那一档），底色用 semanticFill——main 配 contrastText 够不到地板时降 dark 档。
      //
      // color="default" 是中性档：filled 走纸上一档中性浅填充（与禁用按钮同一口径，
      // 而不是不透明纸色——压在玻璃行上会变成一颗实心药丸），outlined 走 BORDER 描边。
      MuiChip: {
        // 芯片的 color 由 MUI 自己的 variants 写死（colorDefault 的填充、语义色的
        // main 文字），styleOverrides 的键名命中不到它，必须同样用 variants 覆盖；
        // 排在自己的 styleOverrides 之前，故最终生效。
        variants: [
          {
            props: { color: 'default' },
            style: ({ theme }: { theme: Theme }) => ({
              '&.MuiChip-filled': {
                backgroundColor: theme.palette.action.disabledBackground,
                color: theme.palette.text.primary,
              },
              '&.MuiChip-outlined': {
                borderColor: theme.palette.divider,
                color: theme.palette.text.primary,
              },
            }),
          },
          ...SEMANTIC_KEYS.map((key) => ({
            props: { color: key },
            style: ({ theme }: { theme: Theme }) => ({
              '&.MuiChip-filled': {
                backgroundColor: semanticFill(theme, key),
                color: theme.palette[key].contrastText,
              },
              '&.MuiChip-outlined': {
                borderColor: theme.palette[key].main,
                backgroundColor: alpha(
                  theme.palette[key].main,
                  SEMANTIC_TINT_ALPHA[theme.palette.mode],
                ),
                color: theme.palette.text.primary,
              },
              '&.MuiChip-outlined .MuiChip-icon': {
                color: theme.palette[key].main,
              },
            }),
          })),
        ],
        styleOverrides: {
          root: { borderRadius: RADIUS.chip },
          label: { ...typeStyle('label-12'), fontWeight: 500 },
        },
      },
      // 按钮只有四档层级（contained 主 / outlined 次 / text 三级 / error 危险）；
      // 同一档之内所有 variant 共用一套度量与圆角，差异只由 variant 表达。
      // disableElevation 默认开：禁硬阴影纪律下 elevation 只会带来 Material 的浮起感。
      // 尺寸分两档（见 BUTTON_METRICS），写进 size × variant 的组合选择器而不是只写
      // sizeXxx：MUI 对每个 variant 另有一条 `padding: <variant>Size<Size>` 规则，
      // 与 sizeXxx 同特异性、写在后面，只写 sizeXxx 的话它会把内边距盖回去。
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: ({ theme }) => ({
            borderRadius: RADIUS.base,
            textTransform: 'none',
            fontWeight: 600,
            [`&.MuiButton-sizeMedium.MuiButton-contained,
             &.MuiButton-sizeMedium.MuiButton-outlined,
             &.MuiButton-sizeMedium.MuiButton-text`]: {
              minHeight: BUTTON_METRICS.medium.minHeight,
              padding: `0 ${BUTTON_METRICS.medium.paddingInline}px`,
            },
            [`&.MuiButton-sizeSmall.MuiButton-contained,
             &.MuiButton-sizeSmall.MuiButton-outlined,
             &.MuiButton-sizeSmall.MuiButton-text`]: {
              minHeight: BUTTON_METRICS.small.minHeight,
              padding: `0 ${BUTTON_METRICS.small.paddingInline}px`,
            },
            // 禁用态换 Rakko 中性色：MUI 默认的填充与文字是 Material 硬编码的黑 alpha
            // （深浅主题都一样），对不上 Rakko 的中性色阶。填充取
            // action.disabledBackground，文字取 action.disabled（都由 token 派生，
            // 见 palette.action）。
            '&.Mui-disabled': {
              backgroundColor: theme.palette.action.disabledBackground,
              color: theme.palette.action.disabled,
            },
            // outlined 的描边用 BORDER token；文字色交回各 variant/color 自己的声明
            '&.MuiButton-outlined': {
              borderColor: theme.palette.divider,
            },
            // color="inherit" 的三级按钮要走正文墨色：inherit 会连父级颜色一起继承，
            // 压在玻璃卡片上时深浅不可控；n9 在纸底与玻璃上都过 AA。
            '&.MuiButton-text.MuiButton-colorInherit': {
              color: theme.palette.text.primary,
            },
            // outlined / text 本来没有禁用填充，压掉上面那条中性填充，只留描边与文字色
            '&.MuiButton-outlined.Mui-disabled, &.MuiButton-text.Mui-disabled': {
              backgroundColor: 'transparent',
              borderColor: theme.palette.action.disabledBackground,
            },
          }),
        },
      },
      // 对话框操作区：取消在左、确认在右，两者都靠右对齐，间距由这里统一给；
      // 上边缘 16px 起，避免按钮贴住最后一行内容。
      MuiDialogActions: {
        styleOverrides: {
          root: {
            justifyContent: 'flex-end',
            gap: SPACING.sm,
            padding: `${SPACING.md}px ${SPACING.xl}px`,
          },
        },
      },
      MuiDivider: {
        styleOverrides: {
          root: ({ theme }) => ({
            borderColor: theme.palette.divider,
          }),
        },
      },
      // IconButton 收在两档尺寸里（默认 36 / small 30）。
      // hover / pressed 的中性状态层只给 default 与 inherit 两种 color：带语义色的
      // IconButton（如 color="error" 的删除按钮）由 MUI 按 palette 算出的同色淡底，
      // 那是它自己的语义，不该被中性色盖掉。
      MuiIconButton: {
        styleOverrides: {
          root: ({ theme }) => ({
            width: BUTTON_METRICS.medium.minHeight,
            height: BUTTON_METRICS.medium.minHeight,
            borderRadius: RADIUS.base,
            transition: theme.transitions.create('background-color'),
            '&.MuiIconButton-colorDefault, &.MuiIconButton-colorInherit': {
              '&:hover': { backgroundColor: theme.palette.action.hover },
              '&:active': { backgroundColor: theme.palette.action.selected },
            },
          }),
          sizeSmall: {
            width: BUTTON_METRICS.small.minHeight,
            height: BUTTON_METRICS.small.minHeight,
          },
        },
      },
      // 输入框的描边只有三态：静止 BORDER token、hover 加深一档、focus primary 2px。
      // 三处都落在 notchedOutline 上——MUI 的休息态描边来自 NotchedOutline 根声明、
      // hover/focus 是 OutlinedInput 根上的后代规则，所以覆盖也必须在根上用同样的
      // 后代选择器写（实测：root 的后代选择器带一个额外类，特异性 (0,3,0) 压得住
      // MUI 的 (0,2,0) + 一个类的组合；写进 notchedOutline 插槽反而是 (0,1,0)，只能
      // 靠"后者生效"改成同特异性的一条，hover 那条就压不住）。
      // 过渡只给 border-color，时长与缓动取主题动效 token（transitions.create 默认吃
      // duration.standard = MOTION.enter 240ms 与标准曲线，见 theme.test.ts 的动效用例）；
      // 不能用 transition 的全属性简写（motion.md:225 明令）。
      MuiOutlinedInput: {
        styleOverrides: {
          root: ({ theme }) => ({
            '& .MuiOutlinedInput-notchedOutline': {
              borderColor: theme.palette.divider,
              transition: theme.transitions.create('border-color'),
            },
            '&:hover .MuiOutlinedInput-notchedOutline': {
              borderColor: borderStrong,
            },
            '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
              borderColor: theme.palette.primary.main,
              borderWidth: 2,
            },
          }),
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
      // 短提示的时长由主题统一给：Rakko 契约是「4 秒自动关闭，hover / focus 时暂停」
      // （motion.md:83）。调用点不得再各自传自己的时长。
      MuiSnackbar: {
        defaultProps: { autoHideDuration: 4000 },
      },
      // 反相面：n-10 墨底 + n-1 字（rakko-glass.css 的 inverse 档同一套语义）。
      // 底与字都取**浅色**中性档（SEMANTIC_INVERSE_SURFACE），所以深浅主题下都保持
      // "墨底浅字"的反向强调，不会在深色主题翻成一块近白气泡。
      // action 用 primary 的浅色档：墨底上 main 档对比度不足，浅色档才读得清。
      MuiSnackbarContent: {
        styleOverrides: {
          root: {
            backgroundColor: SEMANTIC_INVERSE_SURFACE.bg,
            backgroundImage: 'none', // 压掉 MUI 深色 Paper 的 overlay 渐变
            color: SEMANTIC_INVERSE_SURFACE.fg,
            borderRadius: RADIUS.base,
          },
          action: ({ theme }) => ({
            color: theme.palette.primary.light,
          }),
        },
      },
      // 开关的颜色全部走 token：关态轨道是纸面上一档中性填充，开态与滑块用 primary。
      MuiSwitch: {
        styleOverrides: {
          track: ({ theme }) => ({
            backgroundColor: theme.palette.grey[400],
            opacity: 1,
          }),
          thumb: ({ theme }) => ({
            backgroundColor: theme.palette.background.paper,
          }),
          colorPrimary: ({ theme }) => ({
            '&.Mui-checked + .MuiSwitch-track': {
              backgroundColor: theme.palette.primary.main,
              opacity: 1,
            },
          }),
        },
      },
      // Tooltip 保持 n-10 实底（契约 components.md:20：对比度优先、面积小、存活短）；
      // 字色取同族的 n-1，圆角与按钮对齐。不用 paper 半透底——它是短提示，不需要玻璃。
      MuiTooltip: {
        styleOverrides: {
          tooltip: {
            backgroundColor: SEMANTIC_INVERSE_SURFACE.bg,
            color: SEMANTIC_INVERSE_SURFACE.fg,
            borderRadius: RADIUS.base,
          },
        },
      },
      // 底栏玻璃底色改由外层 Paper 的 data-glass="chrome" 提供（本地 Aero 版的 chrome 配方
      // 自带纸底与发丝线），内层必须保持透明，
      // 否则会挡住玻璃。
      MuiBottomNavigation: {
        styleOverrides: {
          root: { backgroundColor: 'transparent' },
        },
      },
      // 底栏项的度量按上游 BottomNav 契约（bottom-nav.css 的 .rk-bottom-nav__item）：
      // gap 3px / padding 8px 4px 10px / 12px 500 行高 1.6，图标 20×20。
      // 图标那一条是自有偏离的落点：上游显式给图与字定位，MUI 会按 showLabels 给
      // icon 加 margin-bottom（默认 4px、选中态 1px）——它在 flex 列里与 gap 叠加成
      // 两段间距，选中前后条目高度还会跳一下，所以清零、只留 gap。
      // label 字号必须压平：MUI 默认给 .MuiBottomNavigationAction-label 自带字号，
      // 且选中态再抬一档（契约里选中只换颜色、不换字号），不压平两态字号就不一致。
      MuiBottomNavigationAction: {
        styleOverrides: {
          root: {
            gap: 3,
            padding: '8px 4px 10px',
            fontSize: 12,
            fontWeight: 500,
            lineHeight: 1.6,
            '& .MuiBottomNavigationAction-label': { fontSize: 12, lineHeight: 1.6 },
            '&.Mui-selected .MuiBottomNavigationAction-label': { fontSize: 12 },
            '& .MuiSvgIcon-root': { width: 20, height: 20, fontSize: 20, marginBottom: 0 },
            '&.Mui-selected .MuiSvgIcon-root': { marginBottom: 0 },
          },
        },
      },
      // Drawer 纸底由另一路给侧边栏挂 data-glass（chrome 配方）；这里的 borderRight
      // 保留——chrome 档的发丝线画在下缘（box-shadow: 0 1px 0），方向对不上侧边栏，
      // 右侧分割线仍由主题层给。
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
