// View Transitions 全局样式层：换页共享轴（场景 A）、容器变换（场景 B/C）、
// 壳层与 FAB 的 fade-through，外加 reduced-motion 总闸。
// 全部规则经 MuiCssBaseline 的 styleOverrides 注入全局；转场方向标记 data-vt
// 由 lib/view-transition 的 runViewTransition 在转场期间写到 <html> 上。
// 时长、位移、元素名一律引用 token 与接线层常量，杜绝样式与运行时刻字面量分叉。

import type { Theme } from '@mui/material/styles';
import { MOTION, RADIUS, SHARED_AXIS_OFFSET_PX } from './rakko-tokens';
import { VT_NAMES } from './lib/view-transition';

/** FAB 直径 56px 的一半——FAB 是完全圆形，角半径即半径（Dialog 打开圆角 morph 的起点） */
const FAB_RADIUS_PX = 28;

/** keyframes 名：只在此声明一次，动画引用处以同一常量拼接，避免两处手抄错位 */
const KF = {
  fadeOut: 'rtk-vt-fade-out',
  fadeIn: 'rtk-vt-fade-in',
  axisOutBack: 'rtk-axis-out-back',
  axisInForward: 'rtk-axis-in-forward',
  axisOutForward: 'rtk-axis-out-forward',
  axisInBack: 'rtk-axis-in-back',
  fabOut: 'rtk-fab-out',
  fabIn: 'rtk-fab-in',
  radiusExpand: 'rtk-radius-expand',
  radiusCollapse: 'rtk-radius-collapse',
} as const;

/**
 * fade-through 里出场内容淡出占时（fadeOut）换算成 total（large）的百分比断点：
 * 90 / 300 = 30%。轴移动画里旧页在这之前淡完、新页在这之前保持隐形。
 */
const FADE_OUT_PCT = Math.round((MOTION.fadeOut / MOTION.large) * 100);

const ease = MOTION.easeStandard;

/** ::view-transition-{old,new,group}(名字) 选择器；name 必须来自 VT_NAMES */
function vtPseudo(kind: 'old' | 'new' | 'group', name: string): string {
  return `::view-transition-${kind}(${name})`;
}

export function viewTransitionStyles(theme: Theme): Record<string, unknown> {
  const sheet = VT_NAMES.sheet;
  const fab = VT_NAMES.fab;

  // 换页时壳层三件套：与路由内容同名的快照只出现在一侧，整体做淡出/淡入
  const shells = [VT_NAMES.appBar, VT_NAMES.bottomNav, VT_NAMES.navDrawer]
    .map((n) => `:root[data-vt^="route-"]${vtPseudo('old', n)}`)
    .join(', ');
  const shellsNew = [VT_NAMES.appBar, VT_NAMES.bottomNav, VT_NAMES.navDrawer]
    .map((n) => `:root[data-vt^="route-"]${vtPseudo('new', n)}`)
    .join(', ');

  // 容器变换里 sheet/fab 各自的旧/新快照基础样式（圆角、尺寸插值打底）
  const pairNames = [sheet, fab]
    .map((n) => `::view-transition-image-pair(${n})`)
    .join(', ');
  const snapshots = [sheet, fab]
    .flatMap((n) => [`::view-transition-old(${n})`, `::view-transition-new(${n})`])
    .join(', ');

  // 容器变换里正在形变的那个共享元素的旧/新快照选择器。
  // dir 精确到具体元素（expand → sheet、expand-fab → fab），因为一次转场里只有形变的
  // 那个该淡入淡出；同名但未变化的元素另有「保持静止」的规则兜住。
  const dim = (kind: 'old' | 'new', dir: 'expand' | 'collapse', name: string) =>
    `:root[data-vt="${dir}"]${vtPseudo(kind, name)}`;
  const dimFab = (kind: 'old' | 'new', dir: 'expand' | 'collapse') =>
    `:root[data-vt="${dir}-fab"]${vtPseudo(kind, fab)}`;

  return {
    // (a) 公共 keyframes——时长与位移全部来自 MOTION / SHARED_AXIS_OFFSET_PX
    [`@keyframes ${KF.fadeOut}`]: {
      from: { opacity: 1 },
      to: { opacity: 0 },
    },
    [`@keyframes ${KF.fadeIn}`]: {
      from: { opacity: 0 },
      to: { opacity: 1 },
    },
    // 前进路由：旧页向左退场（后 30% 隐形后再位移，避免位移带出残影）
    [`@keyframes ${KF.axisOutBack}`]: {
      '0%': { opacity: 1, transform: 'translateX(0)' },
      [`${FADE_OUT_PCT}%`]: { opacity: 0 },
      '100%': { opacity: 0, transform: `translateX(-${SHARED_AXIS_OFFSET_PX}px)` },
    },
    [`@keyframes ${KF.axisInForward}`]: {
      '0%': { opacity: 0, transform: `translateX(${SHARED_AXIS_OFFSET_PX}px)` },
      [`${FADE_OUT_PCT}%`]: { opacity: 0 },
      '100%': { opacity: 1, transform: 'translateX(0)' },
    },
    // 后退路由与前进互为镜像：旧页向正方向退场
    [`@keyframes ${KF.axisOutForward}`]: {
      '0%': { opacity: 1, transform: 'translateX(0)' },
      [`${FADE_OUT_PCT}%`]: { opacity: 0 },
      '100%': { opacity: 0, transform: `translateX(${SHARED_AXIS_OFFSET_PX}px)` },
    },
    [`@keyframes ${KF.axisInBack}`]: {
      '0%': { opacity: 0, transform: `translateX(-${SHARED_AXIS_OFFSET_PX}px)` },
      [`${FADE_OUT_PCT}%`]: { opacity: 0 },
      '100%': { opacity: 1, transform: 'translateX(0)' },
    },
    // FAB 只出现在单侧时的收放：old 收小淡出、new 由小放大淡入
    [`@keyframes ${KF.fabOut}`]: {
      from: { opacity: 1, transform: 'scale(1)' },
      to: { opacity: 0, transform: 'scale(0.9)' },
    },
    [`@keyframes ${KF.fabIn}`]: {
      from: { opacity: 0, transform: 'scale(0.92)' },
      to: { opacity: 1, transform: 'scale(1)' },
    },
    // FAB 圆 ↔ Dialog 圆角的形态 morph：由 FAB 半径过渡到 Dialog 圆角（反之亦然）
    [`@keyframes ${KF.radiusExpand}`]: {
      from: { borderRadius: `${FAB_RADIUS_PX}px` },
      to: { borderRadius: `${RADIUS.dialog}px` },
    },
    [`@keyframes ${KF.radiusCollapse}`]: {
      from: { borderRadius: `${RADIUS.dialog}px` },
      to: { borderRadius: `${FAB_RADIUS_PX}px` },
    },

    // (b) 根层交叉淡化默认 mix-blend-mode 会把两张不透明页面混出发灰，改回正常叠放
    '::view-transition-old(root), ::view-transition-new(root)': {
      mixBlendMode: 'normal',
    },

    // (c) 场景 A：路由共享轴。方向由 data-vt 区分，前进/后退各一组
    ':root[data-vt="route-forward"]::view-transition-old(root)': {
      animation: `${KF.axisOutBack} ${MOTION.large}ms ${ease} both`,
    },
    ':root[data-vt="route-forward"]::view-transition-new(root)': {
      animation: `${KF.axisInForward} ${MOTION.large}ms ${ease} both`,
    },
    ':root[data-vt="route-back"]::view-transition-old(root)': {
      animation: `${KF.axisOutForward} ${MOTION.large}ms ${ease} both`,
    },
    ':root[data-vt="route-back"]::view-transition-new(root)': {
      animation: `${KF.axisInBack} ${MOTION.large}ms ${ease} both`,
    },

    // (d) 壳层 fade-through：标题与选中态随快照淡出淡入，而不是硬切。
    // 新快照在旧快照淡出之后才进场，总时长仍是 large。
    [shells]: {
      animation: `${KF.fadeOut} ${MOTION.fadeOut}ms ${ease} both`,
    },
    [shellsNew]: {
      animation: `${KF.fadeIn} ${MOTION.large - MOTION.fadeOut}ms ${ease} ${MOTION.fadeOut}ms both`,
    },

    // (e) FAB 只存在于一侧时用 :only-child 命中，同样按 fade-through 时序
    [`:root[data-vt^="route-"]${vtPseudo('old', fab)}:only-child`]: {
      animation: `${KF.fabOut} ${MOTION.fadeOut}ms ${ease} both`,
    },
    [`:root[data-vt^="route-"]${vtPseudo('new', fab)}:only-child`]: {
      animation: `${KF.fabIn} ${MOTION.large - MOTION.fadeOut}ms ${ease} ${MOTION.fadeOut}ms both`,
    },

    // (f) 场景 B/C：容器变换。快照打底防止拉伸变形与半透明叠加发灰
    [pairNames]: {
      isolation: 'auto',
      overflow: 'clip',
    },
    [snapshots]: {
      mixBlendMode: 'normal',
      display: 'block',
      height: '100%',
      objectFit: 'cover',
      objectPosition: 'top left',
    },
    // group 的动画时长决定尺寸/位置插值节奏，expand 用 large、collapse 用 largeExit
    [`:root[data-vt="expand"]${vtPseudo('group', sheet)}, :root[data-vt="expand-fab"]${vtPseudo('group', fab)}`]:
      {
        animationDuration: `${MOTION.large}ms`,
        animationTimingFunction: ease,
      },
    [`:root[data-vt="collapse"]${vtPseudo('group', sheet)}, :root[data-vt="collapse-fab"]${vtPseudo('group', fab)}`]:
      {
        animationDuration: `${MOTION.largeExit}ms`,
        animationTimingFunction: ease,
      },
    // 打开/关闭详情时悬浮按钮原地不动：两侧快照都不加动画，叠放即原样，不闪
    [`:root[data-vt="expand"]${vtPseudo('old', fab)}, :root[data-vt="expand"]${vtPseudo('new', fab)},
      :root[data-vt="collapse"]${vtPseudo('old', fab)}, :root[data-vt="collapse"]${vtPseudo('new', fab)}`]:
      {
        animation: 'none',
      },
    [`${dim('old', 'expand', sheet)}, ${dimFab('old', 'expand')}`]: {
      animation: `${KF.fadeOut} ${MOTION.fadeOut}ms ${ease} both`,
    },
    [`${dim('new', 'expand', sheet)}, ${dimFab('new', 'expand')}`]: {
      animation: `${KF.fadeIn} ${MOTION.large - MOTION.fadeOut}ms ${ease} ${MOTION.fadeOut}ms both`,
    },
    [`${dim('old', 'collapse', sheet)}, ${dimFab('old', 'collapse')}`]: {
      animation: `${KF.fadeOut} ${MOTION.fadeOut}ms ${ease} both`,
    },
    [`${dim('new', 'collapse', sheet)}, ${dimFab('new', 'collapse')}`]: {
      animation: `${KF.fadeIn} ${MOTION.largeExit - MOTION.fadeOut}ms ${ease} ${MOTION.fadeOut}ms both`,
    },
    // 关闭详情时来源行已被删除：只剩 sheet 的旧快照，让它像 FAB 一样收小淡出
    [`:root[data-vt="collapse"]${vtPseudo('old', sheet)}:only-child`]: {
      animation: `${KF.fabOut} ${MOTION.largeExit}ms ${ease} both`,
    },
    // FAB 的圆角 morph 只作用于 image-pair（快照合成层），跟随容器时长
    [`:root[data-vt="expand-fab"]::view-transition-image-pair(${fab})`]: {
      animation: `${KF.radiusExpand} ${MOTION.large}ms ${ease} both`,
    },
    [`:root[data-vt="collapse-fab"]::view-transition-image-pair(${fab})`]: {
      animation: `${KF.radiusCollapse} ${MOTION.largeExit}ms ${ease} both`,
    },
    // sheet（Dialog）圆角：移动端全屏无圆角，md 起是带 Dialog 圆角的浮层
    [`::view-transition-image-pair(${sheet})`]: {
      borderRadius: 0,
      [theme.breakpoints.up('md')]: { borderRadius: `${RADIUS.dialog}px` },
    },

    // (g) reduced-motion 总闸：偏好减少动效时整个 View Transition 全部禁用动画
    '@media (prefers-reduced-motion: reduce)': {
      '::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*)': {
        animation: 'none !important',
      },
    },
  };
}
