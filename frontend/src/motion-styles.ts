// View Transitions 全局样式层：换页共享轴（场景 A）、容器变换（场景 B/C），
// 以及壳层与 FAB 的持名时机与交叉淡化节奏，外加 reduced-motion 总闸。
// 全部规则经 MuiCssBaseline 的 styleOverrides 注入全局；转场方向标记 data-vt
// 由 lib/view-transition 的 runViewTransition 在转场期间写到 <html> 上。
// 时长、位移、元素名一律引用 token 与接线层常量，杜绝样式与运行时刻字面量分叉。

import type { Theme } from '@mui/material/styles';
import { MOTION, RADIUS, SHARED_AXIS_OFFSET_PX } from './rakko-tokens';
import { VT_NAMES, VT_SHELL_ATTR } from './lib/view-transition';

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
  surfaceIn: 'rtk-surface-in',
  surfaceOut: 'rtk-surface-out',
  fabSurfaceIn: 'rtk-fab-surface-in',
  fabSurfaceOut: 'rtk-fab-surface-out',
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
  const appBar = VT_NAMES.appBar;
  const bottomNav = VT_NAMES.bottomNav;
  const navDrawer = VT_NAMES.navDrawer;
  const contentGlass = VT_NAMES.contentGlass;

  // 容器变换里 sheet/fab 各自的旧/新快照基础样式（圆角、尺寸插值打底）
  const pairNames = [sheet, fab]
    .map((n) => `::view-transition-image-pair(${n})`)
    .join(', ');
  const snapshots = [sheet, fab]
    .flatMap((n) => [`::view-transition-old(${n})`, `::view-transition-new(${n})`])
    .join(', ');

  // 容器变换里正在形变的那个共享元素的旧/新快照选择器。
  // dir 精确到具体元素（expand → sheet、expand-fab → fab），因为一次转场里只有形变的
  // 那个该淡入淡出；其余同名元素（例如详情开关下的 FAB）因段 (b) 不持名，留在 root 快照
  // 里跟遮罩一起被压暗，不需要额外的「保持静止」规则。
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
    // 容器变换期间 image-pair 的纸面色打底：快照不再缩放后盖不满长大的容器，
    // 露出的部分要有纸面色，否则会透出底下被遮罩压暗的页面。sheet 从透明淡入纸色
    // （跟随 old 淡出的 90ms）；FAB 从 primary.main 淡入纸色（跟随整段时长），关闭反向。
    [`@keyframes ${KF.surfaceIn}`]: {
      from: { backgroundColor: 'transparent' },
      to: { backgroundColor: theme.palette.background.paper },
    },
    [`@keyframes ${KF.surfaceOut}`]: {
      from: { backgroundColor: theme.palette.background.paper },
      to: { backgroundColor: 'transparent' },
    },
    [`@keyframes ${KF.fabSurfaceIn}`]: {
      from: { backgroundColor: theme.palette.primary.main },
      to: { backgroundColor: theme.palette.background.paper },
    },
    [`@keyframes ${KF.fabSurfaceOut}`]: {
      from: { backgroundColor: theme.palette.background.paper },
      to: { backgroundColor: theme.palette.primary.main },
    },

    // (b) 持名时机：壳层与 FAB 只在换页（route-*）时持有 view-transition-name，各自成组
    // 交叉淡化；打开/关闭详情（expand / collapse）一律不持名、留在 root 快照里——单独成组
    // 会画在 root 之上，转场期间不被 Dialog 遮罩压暗，直到转场结束切回真实 DOM 的瞬间才被
    // 盖住，看起来就是遮罩「闪一下」。FAB 另在 expand-fab / collapse-fab（自己形变）时持名。
    // view-transition-name 在 startViewTransition 拍旧快照前已生效：接线层先写 data-vt 方向
    // 标记、再启动转场，因此新旧两侧快照都能按这里的规则分组。
    [`:root[data-vt^="route-"] [${VT_SHELL_ATTR}="${appBar}"]`]: { viewTransitionName: appBar },
    [`:root[data-vt^="route-"] [${VT_SHELL_ATTR}="${bottomNav}"]`]: { viewTransitionName: bottomNav },
    [`:root[data-vt^="route-"] [${VT_SHELL_ATTR}="${navDrawer}"]`]: { viewTransitionName: navDrawer },
    // 内容玻璃板也是 fixed 壳层元素：换页时若不持名就会留在 root 快照里，跟着内容一起做
    // 共享轴位移——它必须像其它壳层一样保持静止
    [`:root[data-vt^="route-"] [${VT_SHELL_ATTR}="${contentGlass}"]`]: { viewTransitionName: contentGlass },
    [`:root[data-vt^="route-"] [${VT_SHELL_ATTR}="${fab}"]`]: { viewTransitionName: fab },
    [`:root[data-vt="expand-fab"] [${VT_SHELL_ATTR}="${fab}"],
      :root[data-vt="collapse-fab"] [${VT_SHELL_ATTR}="${fab}"]`]:
      {
        viewTransitionName: fab,
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

    // (d) 换页时壳层的交叉淡化：壳层前后两态几乎一样（只有标题文字 / 选中态在变），保留
    // UA 默认的 plus-lighter 交叉淡化——相同像素完全静止，变化像素平滑过渡，不该再安排
    // 「先 90ms 淡出、再淡入」的顺序淡化（那会让壳层中途全透明，整屏闪成底色）。这里只把
    // group 的时长从 UA 默认 250ms 对齐到内容轴移的 large，各壳层的旧/新快照动画时长随
    // 自己的 group 继承，交叉淡化的节奏与内容轴移一致。
    [`:root[data-vt^="route-"]${vtPseudo('group', appBar)},
      :root[data-vt^="route-"]${vtPseudo('group', bottomNav)},
      :root[data-vt^="route-"]${vtPseudo('group', navDrawer)},
      :root[data-vt^="route-"]${vtPseudo('group', contentGlass)}`]:
      {
        animationDuration: `${MOTION.large}ms`,
        animationTimingFunction: ease,
      },

    // (e) FAB 只存在于一侧时用 :only-child 命中，同样按 fade-through 时序
    [`:root[data-vt^="route-"]${vtPseudo('old', fab)}:only-child`]: {
      animation: `${KF.fabOut} ${MOTION.fadeOut}ms ${ease} both`,
    },
    [`:root[data-vt^="route-"]${vtPseudo('new', fab)}:only-child`]: {
      animation: `${KF.fabIn} ${MOTION.large - MOTION.fadeOut}ms ${ease} ${MOTION.fadeOut}ms both`,
    },

    // (f) 场景 B/C：容器变换。快照以 object-fit: none 保持原尺寸、左上锚定——容器变换的
    // 正确形态是「容器长大、内容不缩放」：若让快照填满容器，80px 高的行快照会被放大十余倍
    // 去铺满整个对话框，关闭时再看着它从巨大缩回原尺寸。快照超出容器部分由 image-pair 裁掉
    // （overflow: clip）；快照层改走 normal：image-pair 现在带不透明纸面色（surfaceIn /
    // fabSurfaceIn），plus-lighter 会把快照加在纸色上整体过曝；而 old 先 90ms 淡出、new 再
    // 淡入、互不重叠，改 normal 不损失交叉插值。
    [pairNames]: {
      isolation: 'auto',
      overflow: 'clip',
    },
    [snapshots]: {
      mixBlendMode: 'normal',
      display: 'block',
      height: '100%',
      objectFit: 'none',
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
    // 打开/关闭详情时 root 的交叉淡化默认 250ms，与容器变换的 300 / 250ms 不同步；
    // 遮罩的明暗节奏由此与对话框收放错开——old/new(root) 的时长从 group(root) 继承，这里
    // 按方向对齐到容器时长（遮罩压在 root 快照上，壳层与 FAB 因段 (b) 不持名也在其中）。
    [`:root[data-vt="expand"]${vtPseudo('group', 'root')}, :root[data-vt="expand-fab"]${vtPseudo('group', 'root')}`]:
      {
        animationDuration: `${MOTION.large}ms`,
      },
    [`:root[data-vt="collapse"]${vtPseudo('group', 'root')}, :root[data-vt="collapse-fab"]${vtPseudo('group', 'root')}`]:
      {
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
    // FAB 形变成编辑器：圆角 morph 与表面色都作用于 image-pair（快照合成层），两段动画
    // 逗号分隔同跑，跟随容器时长：底色从 primary.main 淡成纸色（关闭时反向，便于形变期间
    // 接住不缩放的快照露出部分）
    [`:root[data-vt="expand-fab"]::view-transition-image-pair(${fab})`]: {
      animation: `${KF.radiusExpand} ${MOTION.large}ms ${ease} both, ${KF.fabSurfaceIn} ${MOTION.large}ms ${ease} both`,
    },
    [`:root[data-vt="collapse-fab"]::view-transition-image-pair(${fab})`]: {
      animation: `${KF.radiusCollapse} ${MOTION.largeExit}ms ${ease} both, ${KF.fabSurfaceOut} ${MOTION.largeExit}ms ${ease} both`,
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
