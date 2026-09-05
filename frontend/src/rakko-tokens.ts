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

/** 语义色（和色体系）；深色主题下各提亮约 15%（MUI lighten(c, 0.15)） */
export const SEMANTIC = {
  info: '#3d6896', // 縹 hanada
  success: '#5e9f7e', // 若竹 wakatake
  warning: '#a87a3d', // 朽葉 kuchiba
  error: '#a64953', // 蘇芳 suoh
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

/** 圆角（px）：chip 4、默认 6、卡片 8、对话框 12 */
export const RADIUS = {
  chip: 4,
  base: 6,
  card: 8,
  dialog: 12,
} as const;

/** 动效时长（ms）与缓动：state/enter/exit/ripple + 标准曲线 */
export const MOTION = {
  state: 160,
  enter: 240,
  exit: 180,
  ripple: 420,
  easeStandard: 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const;

/** 状态层不透明度：hover 4% / focus 8% / pressed 12% */
export const STATE_OPACITY = {
  hover: 0.04,
  focus: 0.08,
  pressed: 0.12,
} as const;

/** whisper 阴影：禁硬阴影（阴影只允许此档，其余用 1px 边框分层） */
export const WHISPER_SHADOW = '0 1px 2px rgba(20, 19, 18, 0.06)';
