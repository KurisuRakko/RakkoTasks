// Rakko Design token 镜像常量——RakkoTasks MUI 主题层的数据源。
// 来源：~/GitHub/Rakko-Design/design-system/CHEATSHEET.md 与
//       ~/GitHub/Rakko-Design/design-system/references/tokens.md
//       （即 @rakko/design-system 包内 tokens.css 的文档化契约）。
// @rakko/design-system 不在 npm、Docker 构建装不到，故以常量镜像一份；
// 与 Rakko-Design tokens.css 手工同步，修改前先改上游。

/** 中性色浅色 1..10（暖纸感，R>G>B）；下标 = n 值 - 1 */
export const NEUTRAL_LIGHT: readonly [string, string, string, string, string, string, string, string, string, string] = [
  '#f9f8f5', // n1 页面背景
  '#f0efeb', // n2 卡片背景
  '#e3e1db', // n3 悬浮面/浅填充
  '#d0cec6', // n4 强填充（单色图标底）
  '#a8a69f', // n5 边框（不作文字色）
  '#787670', // n6 图标描边
  '#5c5a55', // n7 次要文字
  '#403f3a', // n8 正文次级
  '#24231f', // n9 默认正文
  '#141312', // n10 标题/最高强调
];

/** 中性色深色 1..10：不反转暖色，重置为纯灰（R=G=B）；下标 = n 值 - 1 */
export const NEUTRAL_DARK: readonly [string, string, string, string, string, string, string, string, string, string] = [
  '#141414', // n1 页面背景
  '#242424', // n2 卡片背景
  '#404040', // n3 悬浮面/浅填充
  '#5c5c5c', // n4 强填充
  '#787878', // n5 边框
  '#a8a8a8', // n6 图标描边
  '#d0d0d0', // n7 次要文字
  '#e3e3e3', // n8 正文次级
  '#f0f0f0', // n9 默认正文
  '#f8f8f8', // n10 标题/最高强调
];

/** accent（梅 ume）：浅色基础色 #c56473，深色提亮的 桃 近似 #e095a4 */
export const ACCENT = {
  light: '#c56473',
  dark: '#e095a4',
} as const;

/** 语义四色的完整 MUI 色阶：每档 { light, main, dark, contrastText } 都是显式 token，
 * 组件层不再拿到 MUI 用 grey/orange 兜出的默认值（深色 warning 曾漏成 MUI 深色色板的
 * orange[400]；对照物与「不许等于」的断言在 tests/theme-palette.test.ts）。
 * 依据：references/tokens.md:62-73 每个语义色只定义**一个**基础 hex，它是浅色主题的
 * main，也是另外两档的派生种子；`consumer app theme layer` 在深色把整个色阶上提约
 * 15%（tokens.md:71「lifts each one ~15% in dark mode」）。main 之外的两档契约没给，
 * 按同一条 ±15% 亮度档从 main 派生：light 提亮 15%、dark 压暗 15%（与真实 hex 的
 * 对应关系写在每个值后面）。深色主题自己的取值由 theme.ts 用 lighten(main, 0.15)
 * 求值（先例：theme.test.ts 的「深色语义色较浅色提亮」用例），那里只换 main 及其
 * 派生档的相对关系不变。
 * contrastText 取 pairings 的实测对比度（tokens.md:56-60 的「填充 + 白字」配对）：
 * 两个深色墨底给 #fff，两个中等亮度底给 #000（小字与常规字都过 WCAG AA）。
 * 四色同为状态色（tokens.md:73 不得当装饰色），不自造第五个语义色。 */
export const SEMANTIC = {
  info: {
    light: '#5a7ea5', // lighten(#3d6896, 15%)
    main: '#3d6896', // 縹 hanada（tokens.md:66）
    dark: '#33587f', // darken(#3d6896, 15%)
    contrastText: '#fff', // 6.90:1
  },
  success: {
    light: '#76ad91', // lighten(#5e9f7e, 15%)
    main: '#5e9f7e', // 若竹 wakatake（tokens.md:67）
    dark: '#4f876b', // darken(#5e9f7e, 15%)
    contrastText: '#000', // 7.16:1
  },
  warning: {
    light: '#b58d5a', // lighten(#a87a3d, 15%)
    main: '#a87a3d', // 朽葉 kuchiba（tokens.md:68）
    dark: '#8e6733', // darken(#a87a3d, 15%)
    contrastText: '#000', // 5.87:1
  },
  error: {
    light: '#b3646c', // lighten(#a64953, 15%)
    main: '#a64953', // 蘇芳 suoh（tokens.md:69）
    dark: '#8d3e46', // darken(#a64953, 15%)
    contrastText: '#fff', // 6.62:1
  },
} as const;

/** 默认边框：浅色 rgba(24,24,27,0.1)；深色用白色 12%。
 * 注意：tokens.css 未给深色边框值，深色一条为本项目取值。 */
export const BORDER = {
  light: 'rgba(24, 24, 27, 0.1)',
  dark: 'rgba(255, 255, 255, 0.12)',
} as const;

/** 无衬线栈：Inter 未随 @rakko/design-system 分发，不引入 webfont，直接系统栈 + CJK 兜底 */
export const FONT_SANS =
  "system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', 'Segoe UI', Roboto, Helvetica, 'Noto Sans SC', 'Hiragino Sans GB', sans-serif";

export interface TypeToken {
  size: number;
  lineHeight: number;
}

/** 字阶（role+px，仅消费端实际用到的八档）；基准 14px、letter-spacing 0.01em 由主题层下发 */
export const TYPE_SCALE: Record<
  'label-12' | 'copy-13' | 'copy-14' | 'copy-15' | 'copy-16' | 'title-20' | 'title-24' | 'title-28',
  TypeToken
> = {
  'label-12': { size: 12, lineHeight: 1.5 },
  'copy-13': { size: 13, lineHeight: 1.54 },
  'copy-14': { size: 14, lineHeight: 1.57 },
  'copy-15': { size: 15, lineHeight: 1.6 },
  'copy-16': { size: 16, lineHeight: 1.625 },
  'title-20': { size: 20, lineHeight: 1.4 },
  'title-24': { size: 24, lineHeight: 1.33 },
  'title-28': { size: 28, lineHeight: 1.29 },
};

/** 圆角（px）：chip 4、base 6、card 6、dialog 12。
 * card 这一档同时供列表行玻璃（lib/surface.ts）、右键菜单（RowContextMenu）与 MuiCard
 * 取用，三处是同一个视觉语汇，一起从 8 降到 6 是刻意的：浅色主题的玻璃边缘对比加强后，
 * 8px 的方角与玻璃的柔和质感冲突；6px（= RADIUS.base）更利落，与 Rakko Design 的
 * 克制圆角一致。 */
export const RADIUS = {
  chip: 4,
  base: 6,
  card: 6,
  dialog: 12,
} as const;

/** 动效时长（ms）与缓动：state/enter/exit/ripple + 标准曲线。
 * large / largeExit / fadeOut 是本项目按 MD2 Motion System 的扩展——Rakko Design 只
 * 定义了短内容入退场，没有覆盖容器变换与换页这类大面积转场；待上游 tokens.css 收录
 * 后改回镜像。fadeOut 是 fade-through 里出场内容的淡出占时（large 的前 30%）。 */
export const MOTION = {
  state: 160,
  enter: 240,
  exit: 180,
  ripple: 420,
  large: 300,
  largeExit: 250,
  fadeOut: 90,
  easeStandard: 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const;

/** 共享轴转场的横向位移（px）：MD2 Motion System 的 30dp */
export const SHARED_AXIS_OFFSET_PX = 30;

/** 状态层不透明度：hover 4% / focus 8% / pressed 12% */
export const STATE_OPACITY = {
  hover: 0.04,
  focus: 0.08,
  pressed: 0.12,
} as const;

/** 反相面（Tooltip / Snackbar）的墨底色与面上文字色。
 *  Tooltip 契约是「保持 n-10 实底（对比度优先、面积小、存活短）」
 *  （references/components.md:20），Snackbar 契约是「n-10 底、n-1 字」
 *  （rakko-glass.css 的 inverse 档定义）。
 *  这里取**浅色**中性档而不是当前主题的 n10/n1：深色主题的 n-1 是近黑、n-10 是近白，
 *  照当前主题直接取会得到一块近白的高亮气泡，既不是「墨色实底」也不是反向强调。
 *  浅色 n1 落在浅色 n10 上是 17.35:1，主题无关地恒成立。（PWA <meta name="theme-color">
 *  的深浅取值见 theme.ts / lib/theme-mode.tsx，是另一回事。） */
export const SEMANTIC_INVERSE_SURFACE = {
  bg: NEUTRAL_LIGHT[9], // 浅色 n10
  fg: NEUTRAL_LIGHT[0], // 浅色 n1
} as const;

/** 共享间距档（px）：与 Tailwind 默认档对齐（tokens.md:127-132 的四基准）
 *  4 / 8 / 12 / 16 / 24；组件主题层只消费这几档，不写裸数字。 */
export const SPACING = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

/** whisper 阴影：禁硬阴影（阴影只允许此档，其余用 1px 边框分层） */
export const WHISPER_SHADOW = '0 1px 2px rgba(20, 19, 18, 0.06)';

/** 玻璃材质数值（取自上游 tokens.css 的 --glass-*）。配方本身在 rakko-glass.css，
 * 是 design-system/src/glass.css 的**本地 Aero 定制版**（基于上游改过光泽与厚度边，
 * 偏离记录见该文件头部）；这里放它消费的值，由主题层下发到 :root。 */
export const GLASS = {
  blur: '3px',
  saturate: '193%',
  // chrome 是四档里最透的，压在它上面的是 12px/500 的底栏导航标签。实测（真实中文字形 +
  // 反相光晕，文字色 n9，取最差点）：浅色主题下 45% 时三张实测壁纸有两张够不到 AA 4.5，
  // 彩色天空只有 3.80；52% 是全部过线的最小值（4.62–5.45），且 45% 与 52% 的顶栏通透度
  // 截图对比无可见差别（与上游 Rakko Design 同步，原 45%）。
  surfaceOpacity: '52%',
  panelOpacity: '58%',
  scrimOpacity: '34%',
  // highlight 一条已删除：上游 CHEATSHEET.md:154 / tokens.md:160 的 --glass-highlight 是
  // 旧「左上透镜」配方的镜面高光，Aero 改版后整套玻璃（chrome / panel / inverse）都由
  // --glass-sheen-1..3 + --glass-rim / --glass-lip 出光泽，没有任何规则再读它——
  // 主题层继续下发就是个没人消费的键，测试却按「必须下发」锁着它。这里连同下发与
  // 断言一起删掉，将来要回旧配方时先改上游再补回来。
  // haze 纸色 55%（与上游 Rakko Design 同步，原 51%）：12px/600 的分组标题压在 haze 上，
  // 51% 时在三张实测壁纸中最低只有 3.96（彩色天空），够不到 WCAG AA 4.5；55% 是全部过线
  // 的最小值（4.53–4.98），且 51% 与 55% 的雾浓淡在真实版面上无可见差别。
  hazeOpacity: '55%',
  hazeBleed: '28px',
} as const;

/** Aero 玻璃的十一个新增 token（镜像上游 tokens.css 的 --glass-rim … --glass-text-glow）。
 * 键名 camelCase，与 CSS 变量一一对应：rim→--glass-rim、rimInner→--glass-rim-inner、
 * lip→--glass-lip、lipUnder→--glass-lip-under、side→--glass-side、bloom→--glass-bloom、
 * sheen1…sheen3→--glass-sheen-1…3、lift→--glass-lift、textGlow→--glass-text-glow。
 * 旧光泽的尾段键已删除（两个主题都删）：光泽改版后是上白下暗的三段（sheen-1 → sheen-2 45% →
 * sheen-3 100%），sheen-3 的语义是「底部的暗」——取代了旧版 46/47% 的陡变 + 四段尾键。
 * 浅色必须显式给暗：浅色是白纸底 + 白高光（rim/lip/side/bloom 全白）+ 白光泽（sheen-1/2），
 * 三层全白时通篇没有暗的一侧，卡片边界会溶进亮壁纸；所以 sheen-3 与 rim-inner 的暗段是浅色
 * 立体感的来源，写成白色就退回「无暗侧」的老问题。
 * 深色那套不是浅色的简单缩放，是重新定的档位；textGlow 的反相（深色用黑光晕）是硬约束：
 * 深底沿用白光晕会让亮色正文与光晕同色，对比度从 4.69 崩到 1.07（等于看不见）。 */
export const GLASS_AERO = {
  light: {
    rim: 'rgba(255, 255, 255, 0.58)',
    rimInner: 'rgba(0, 0, 0, 0.14)',
    lip: 'rgba(255, 255, 255, 0.6)',
    lipUnder: 'rgba(255, 255, 255, 0.22)',
    side: 'rgba(255, 255, 255, 0.26)',
    bloom: 'rgba(255, 255, 255, 0.15)',
    sheen1: 'rgba(255, 255, 255, 0.34)',
    sheen2: 'rgba(255, 255, 255, 0.1)',
    sheen3: 'rgba(0, 0, 0, 0.035)',
    lift: '0 1px 2px rgba(0, 0, 0, 0.07), 0 6px 18px rgba(0, 0, 0, 0.1)',
    textGlow: '0 0 2px rgba(255, 255, 255, 0.5), 0 0 6px rgba(255, 255, 255, 0.5)',
  },
  dark: {
    rim: 'rgba(255, 255, 255, 0.2)',
    rimInner: 'rgba(0, 0, 0, 0.22)',
    lip: 'rgba(255, 255, 255, 0.24)',
    lipUnder: 'rgba(255, 255, 255, 0.08)',
    side: 'rgba(255, 255, 255, 0.09)',
    bloom: 'rgba(255, 255, 255, 0.05)',
    sheen1: 'rgba(255, 255, 255, 0.13)',
    sheen2: 'rgba(255, 255, 255, 0.05)',
    sheen3: 'rgba(0, 0, 0, 0.05)',
    lift: '0 1px 2px rgba(0, 0, 0, 0.3), 0 6px 18px rgba(0, 0, 0, 0.34)',
    textGlow: '0 0 2px rgba(0, 0, 0, 0.5), 0 0 6px rgba(0, 0, 0, 0.5)',
  },
} as const;

/** 桌面常驻侧栏（AppShell 的 permanent Drawer，data-glass="chrome"）在**浅色主题**下
 *  的局部材质改写。**本项目扩展，不是上游 token**：上游只为 ~64px 高的顶栏定义了
 *  chrome，光泽的分界写成 `45%` 百分比；同一配方套到满屏高的侧栏上，那道分界落在屏幕
 *  中线，整个上半屏变成一层白纱——纸色 52% 叠 sheen-1 34% 后顶端白覆盖度 68.3%、底端
 *  52%，16 个点的落差让它读起来像一块白板而不是玻璃。
 *
 *  只削白，不动别的：纸色 alpha（52%）不降、不偏色；暗端 sheen-3（黑 3.5%）原样保留，
 *  浅色玻璃没有显式的暗端就会溶进亮壁纸。`--glass-rim` 不在此列——chrome 配方根本不消费
 *  它（只有 panel 消费），改它等于改每一行列表卡片。
 *
 *  取值：sheen-1 34% → 12%，顶端白覆盖度 68.3% → 57.8%，顶→中落差 11.5 点 → 3.4 点，
 *  白纱振幅削掉约七成而「上亮下暗」的方向仍在；sheen-2 10% → 5%，让中段只比纸色地板高
 *  2.4 点，接进 sheen-3 的暗端时是连续过渡、45% 那道止点不再看得出来。
 *  lip 60% → 22%：22% 是浅色 lipUnder 的现值，直接复用而不是再造一个白常数；侧栏顶边与
 *  顶栏顶边在屏幕上缘首尾相接，两条 60% 的白发丝线会连成一道通白线，弱化成 22% 后它回到
 *  「一道倒角」而不是「一条亮边」。
 *  深色主题不适用：深底本身自带一半的暗，那套 sheen（13%/5%）振幅已经够低。 */
export const GLASS_NAV_RAIL_LIGHT = {
  '--glass-sheen-1': 'rgba(255, 255, 255, 0.12)',
  '--glass-sheen-2': 'rgba(255, 255, 255, 0.05)',
  '--glass-lip': 'rgba(255, 255, 255, 0.22)',
} as const;

/** 玻璃面板的 whisper 阴影（上游 --shadow-whisper）；深色主题按契约加深一档。
 * 与上面的 WHISPER_SHADOW 是两回事：那一档是 MUI elevation 用的紧凑阴影，
 * 本项目早先镜像时取的值与上游 --shadow-whisper 不一致，此次不动它以免波及全部 elevation。 */
export const GLASS_SHADOW_WHISPER = {
  light: '0 4px 24px rgba(0, 0, 0, 0.05)',
  dark: '0 4px 24px rgba(0, 0, 0, 0.35)',
} as const;
