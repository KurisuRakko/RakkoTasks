// View Transitions 全局样式层：列表行 ↔ 详情的容器变换，外加 reduced-motion 总闸。
// 换页不走 View Transitions（见 components/RouteTransition 的文件头注释），
// 所以壳层（AppBar / 底栏 / 抽屉）与悬浮按钮在这里没有任何规则，也不持名。
// 右下角 FAB ↔ 速记面板**不走这里**：那条链路是纯 CSS transform + MUI Slide 的
// 对称编排（见 TasksPage 的 FAB sx 与 AiAddDialog 的 Dialog 过渡）。
// 全部规则经 MuiCssBaseline 的 styleOverrides 注入全局；转场种类标记 data-vt
// 由 lib/view-transition 的 runViewTransition 在转场期间写到 <html> 上。
// 时长、位移、元素名一律引用 token 与接线层常量，杜绝样式与运行时刻字面量分叉。

import type { Theme } from '@mui/material/styles';
import { MOTION, RADIUS } from './rakko-tokens';
import { VT_NAMES } from './lib/view-transition';

/** keyframes 名：只在此声明一次，动画引用处以同一常量拼接，避免两处手抄错位 */
const KF = {
  fadeOut: 'rtk-vt-fade-out',
  fadeIn: 'rtk-vt-fade-in',
  shrinkOut: 'rtk-sheet-shrink-out',
  surfaceIn: 'rtk-surface-in',
  surfaceOut: 'rtk-surface-out',
} as const;

const ease = MOTION.easeStandard;

/** ::view-transition-{old,new,group}(名字) 选择器；name 必须来自 VT_NAMES */
function vtPseudo(kind: 'old' | 'new' | 'group', name: string): string {
  return `::view-transition-${kind}(${name})`;
}

export function viewTransitionStyles(theme: Theme): Record<string, unknown> {
  const sheet = VT_NAMES.sheet;

  // 容器变换（列表行 ↔ 详情）里 sheet 的旧/新快照基础样式（尺寸插值打底）
  const snapshots = [`::view-transition-old(${sheet})`, `::view-transition-new(${sheet})`].join(', ');

  // 容器变换里正在形变的共享元素的旧/新快照选择器。壳层与悬浮按钮不持名，
  // 留在 root 快照里跟遮罩一起被压暗，不需要额外的「保持静止」规则。
  const dim = (kind: 'old' | 'new', dir: 'expand' | 'collapse', name: string) =>
    `:root[data-vt="${dir}"]${vtPseudo(kind, name)}`;

  return {
    // (a) 公共 keyframes——时长与位移全部来自 MOTION
    [`@keyframes ${KF.fadeOut}`]: {
      from: { opacity: 1 },
      to: { opacity: 0 },
    },
    [`@keyframes ${KF.fadeIn}`]: {
      from: { opacity: 0 },
      to: { opacity: 1 },
    },
    // 收小淡出：关闭详情时来源行已被删除，只剩 sheet 的旧快照，让它收着退场
    [`@keyframes ${KF.shrinkOut}`]: {
      from: { opacity: 1, transform: 'scale(1)' },
      to: { opacity: 0, transform: 'scale(0.9)' },
    },
    // 容器变换期间 image-pair 的纸面色打底：快照不再缩放后盖不满长大的容器，
    // 露出的部分要有纸面色，否则会透出底下被遮罩压暗的页面。sheet 从透明淡入纸色
    // （跟随 old 淡出的 90ms），关闭反向。
    [`@keyframes ${KF.surfaceIn}`]: {
      from: { backgroundColor: 'transparent' },
      to: { backgroundColor: theme.palette.background.paper },
    },
    [`@keyframes ${KF.surfaceOut}`]: {
      from: { backgroundColor: theme.palette.background.paper },
      to: { backgroundColor: 'transparent' },
    },

    // (b) 列表行 ↔ 详情的容器变换。快照以 object-fit: none 保持原尺寸、左上锚定——容器变换的
    // 正确形态是「容器长大、内容不缩放」：若让快照填满容器，80px 高的行快照会被放大十余倍
    // 去铺满整个对话框，关闭时再看着它从巨大缩回原尺寸。快照超出容器部分由 image-pair 裁掉
    // （overflow: clip）；快照层改走 normal：image-pair 现在带不透明纸面色（surfaceIn），
    // plus-lighter 会把快照加在纸色上整体过曝；而 old 先 90ms 淡出、new 再淡入、
    // 互不重叠，改 normal 不损失交叉插值。
    // sheet 的 image-pair 打底 + 圆角：必须写在同一条里。选择器相同的两条会因为
    // 对象字面量的重复键互相覆盖（后者整条赢），拆开写会静默丢掉先声明的那些属性。
    // 圆角：移动端全屏无圆角，md 起是带 Dialog 圆角的浮层。
    [`::view-transition-image-pair(${sheet})`]: {
      isolation: 'auto',
      overflow: 'clip',
      borderRadius: 0,
      [theme.breakpoints.up('md')]: { borderRadius: `${RADIUS.dialog}px` },
    },
    [snapshots]: {
      mixBlendMode: 'normal',
      display: 'block',
      height: '100%',
      objectFit: 'none',
      objectPosition: 'top left',
    },
    // group 的动画时长决定尺寸/位置插值节奏，expand 用 large、collapse 用 largeExit
    [`:root[data-vt="expand"]${vtPseudo('group', sheet)}`]: {
      animationDuration: `${MOTION.large}ms`,
      animationTimingFunction: ease,
    },
    [`:root[data-vt="collapse"]${vtPseudo('group', sheet)}`]: {
      animationDuration: `${MOTION.largeExit}ms`,
      animationTimingFunction: ease,
    },
    // 打开/关闭详情时 root 的交叉淡化默认 250ms，与容器变换的 300 / 250ms 不同步；
    // 遮罩的明暗节奏由此与对话框收放错开——old/new(root) 的时长从 group(root) 继承，这里
    // 按 expand / collapse 各自对齐到容器时长（遮罩压在 root 快照上，不持名的壳层与悬浮按钮也在其中）。
    [`:root[data-vt="expand"]${vtPseudo('group', 'root')}`]: {
      animationDuration: `${MOTION.large}ms`,
    },
    [`:root[data-vt="collapse"]${vtPseudo('group', 'root')}`]: {
      animationDuration: `${MOTION.largeExit}ms`,
    },
    // 快照不再缩放后盖不满长大的容器：image-pair 补纸面色动画，露出的部分不透出底下页面。
    // sheet 在 old 淡出的 90ms 内从透明补上纸色；关闭时在收尾 90ms 从纸色淡出、让位给真实 DOM
    [`:root[data-vt="expand"]::view-transition-image-pair(${sheet})`]: {
      animation: `${KF.surfaceIn} ${MOTION.fadeOut}ms ${ease} both`,
    },
    [`:root[data-vt="collapse"]::view-transition-image-pair(${sheet})`]: {
      animation: `${KF.surfaceOut} ${MOTION.fadeOut}ms ${ease} ${MOTION.largeExit - MOTION.fadeOut}ms both`,
    },
    [dim('old', 'expand', sheet)]: {
      animation: `${KF.fadeOut} ${MOTION.fadeOut}ms ${ease} both`,
    },
    [dim('new', 'expand', sheet)]: {
      animation: `${KF.fadeIn} ${MOTION.large - MOTION.fadeOut}ms ${ease} ${MOTION.fadeOut}ms both`,
    },
    [dim('old', 'collapse', sheet)]: {
      animation: `${KF.fadeOut} ${MOTION.fadeOut}ms ${ease} both`,
    },
    [dim('new', 'collapse', sheet)]: {
      animation: `${KF.fadeIn} ${MOTION.largeExit - MOTION.fadeOut}ms ${ease} ${MOTION.fadeOut}ms both`,
    },
    // 关闭详情时来源行已被删除：只剩 sheet 的旧快照，让它收小淡出
    [`:root[data-vt="collapse"]${vtPseudo('old', sheet)}:only-child`]: {
      animation: `${KF.shrinkOut} ${MOTION.largeExit}ms ${ease} both`,
    },

    // (c) reduced-motion 总闸：偏好减少动效时整个 View Transition 全部禁用动画
    '@media (prefers-reduced-motion: reduce)': {
      '::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*)': {
        animation: 'none !important',
      },
    },
  };
}
