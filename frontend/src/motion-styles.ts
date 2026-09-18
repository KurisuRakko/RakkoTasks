// View Transitions 全局样式层：换页共享轴（场景 A）、列表行 ↔ 详情的容器变换（场景 B），
// 以及壳层与 FAB 的持名时机与交叉淡化节奏，外加 reduced-motion 总闸；
// 换页时壁纸层单独成组静止（段 (g)）。
// 右下角 FAB ↔ 速记面板**不走这里**：那条链路已改成纯 CSS transform + MUI Slide 的
// 对称编排（见 TasksPage 的 FAB sx 与 AiAddDialog 的 Dialog 过渡）。View Transitions
// 在 iOS Safari / PWA 上一旦被跳过就两个方向同时落空，而那是全站点击最频繁的动效。
// 全部规则经 MuiCssBaseline 的 styleOverrides 注入全局；转场方向标记 data-vt
// 由 lib/view-transition 的 runViewTransition 在转场期间写到 <html> 上。
// 时长、位移、元素名一律引用 token 与接线层常量，杜绝样式与运行时刻字面量分叉。

import type { Theme } from '@mui/material/styles';
import { MOTION, RADIUS, SHARED_AXIS_OFFSET_PX } from './rakko-tokens';
import { WALLPAPER_LAYER_ID } from './lib/glass';
import { VT_NAMES, VT_SHELL_ATTR } from './lib/view-transition';

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
  surfaceIn: 'rtk-surface-in',
  surfaceOut: 'rtk-surface-out',
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
  const wallpaper = VT_NAMES.wallpaper;

  // 容器变换（列表行 ↔ 详情）里 sheet 的旧/新快照基础样式（尺寸插值打底）。
  // 只有 sheet：FAB 不再形变，换页时它和其它壳层一样走 UA 默认交叉淡化。
  const snapshots = [`::view-transition-old(${sheet})`, `::view-transition-new(${sheet})`].join(', ');

  // 容器变换里正在形变的共享元素的旧/新快照选择器。其余同名元素因段 (b) 不持名，
  // 留在 root 快照里跟遮罩一起被压暗，不需要额外的「保持静止」规则。
  const dim = (kind: 'old' | 'new', dir: 'expand' | 'collapse', name: string) =>
    `:root[data-vt="${dir}"]${vtPseudo(kind, name)}`;

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

    // (b) 持名时机：壳层与 FAB 只在换页（route-*）时持有 view-transition-name，各自成组、
    // 按 fade-through 时序淡化（壳层见段 (d)、FAB 见段 (e)）；打开/关闭详情（expand / collapse）一律不持名、留在 root 快照里——单独成组
    // 会画在 root 之上，转场期间不被 Dialog 遮罩压暗，直到转场结束切回真实 DOM 的瞬间才被
    // 盖住，看起来就是遮罩「闪一下」。FAB 只在换页时持名，它不再有自己的容器变换。
    // view-transition-name 在 startViewTransition 拍旧快照前已生效：接线层先写 data-vt 方向
    // 标记、再启动转场，因此新旧两侧快照都能按这里的规则分组。
    [`:root[data-vt^="route-"] [${VT_SHELL_ATTR}="${appBar}"]`]: { viewTransitionName: appBar },
    [`:root[data-vt^="route-"] [${VT_SHELL_ATTR}="${bottomNav}"]`]: { viewTransitionName: bottomNav },
    [`:root[data-vt^="route-"] [${VT_SHELL_ATTR}="${navDrawer}"]`]: { viewTransitionName: navDrawer },
    [`:root[data-vt^="route-"] [${VT_SHELL_ATTR}="${fab}"]`]: { viewTransitionName: fab },

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

    // (d) 换页时壳层的 fade-through。玻璃化（data-glass="chrome"）之后壳层是半透明的，
    // 不能再保留 UA 默认的 plus-lighter 交叉淡化——那是加色混合，新旧两层半透明玻璃快照
    // 叠加时重叠像素相加变亮（实测中间帧卡片泛白发亮、文字重影发灰、顶栏两个标题糊在
    // 一起）。所以壳层与内容轴同型改走 fade-through：旧快照先 fadeOut 90ms 淡完、新快照
    // 等 90ms 后才 fadeIn 淡入，中途壳层全透明、整屏只剩壁纸——在有壁纸的产品里这正是
    // 刻意要的效果，不是缺陷。时序与内容轴一致：group 时长仍对齐内容轴移的 large；UA 的
    // plus-lighter 混合也必须显式关掉（mixBlendMode: normal），否则旧/新快照仍会加色
    // 合成，只改动画泛白还会在。
    [`:root[data-vt^="route-"]${vtPseudo('group', appBar)},
      :root[data-vt^="route-"]${vtPseudo('group', bottomNav)},
      :root[data-vt^="route-"]${vtPseudo('group', navDrawer)}`]:
      {
        animationDuration: `${MOTION.large}ms`,
        animationTimingFunction: ease,
        mixBlendMode: 'normal',
      },
    // 旧快照：与段 (e) 的 FAB 同型，90ms 淡出、无延迟
    [`:root[data-vt^="route-"]${vtPseudo('old', appBar)},
      :root[data-vt^="route-"]${vtPseudo('old', bottomNav)},
      :root[data-vt^="route-"]${vtPseudo('old', navDrawer)}`]:
      {
        animation: `${KF.fadeOut} ${MOTION.fadeOut}ms ${ease} both`,
      },
    // 新快照：延迟 fadeOut 后淡入（时长 = large - fadeOut），先让壁纸露 90ms
    [`:root[data-vt^="route-"]${vtPseudo('new', appBar)},
      :root[data-vt^="route-"]${vtPseudo('new', bottomNav)},
      :root[data-vt^="route-"]${vtPseudo('new', navDrawer)}`]:
      {
        animation: `${KF.fadeIn} ${MOTION.large - MOTION.fadeOut}ms ${ease} ${MOTION.fadeOut}ms both`,
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
    // 按方向对齐到容器时长（遮罩压在 root 快照上，壳层与 FAB 因段 (b) 不持名也在其中）。
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
    // 关闭详情时来源行已被删除：只剩 sheet 的旧快照，让它像 FAB 一样收小淡出
    [`:root[data-vt="collapse"]${vtPseudo('old', sheet)}:only-child`]: {
      animation: `${KF.fabOut} ${MOTION.largeExit}ms ${ease} both`,
    },

    // (g) 壁纸层：换页期间单独成组、完全静止。root 快照会随轴移淡到全透明，壁纸留在里面
    // 就跟着一起消失，中途露出的是浏览器 canvas 基色（浅色发白、深色发黑）而不是壁纸——
    // 段 (d) 注释里承诺的「中途整屏只剩壁纸」此前并未兑现。让 index.html 里的壁纸承载层
    // 在换页时持名，它就被排除在 root 快照之外（祖先快照跳过绘制已被捕获的后代），单独
    // 成组静止铺在最底下，内容与壳层在它之上转过去。
    // - 只在换页持名：expand / collapse 时 root 是等价交叉淡化，壁纸新旧两侧逐像素相同，
    //   本来就不闪，多一层快照没有收益，也不必重新论证遮罩压暗的观感；
    // - z-index: -1 决定层序，不能指望默认顺序：group 的文档顺序按捕获时的绘制顺序排，
    //   root 永远在绘制栈最底、排第一个（最下层），壁纸作为 body 的后代反而会排到 root
    //   之上、把内容整个盖住。::view-transition 自身是层叠上下文（视图转场层），各 group
    //   是它 position: absolute 的子级，负 z-index 稳定地排在全部兄弟 group 之下；
    // - 动画必须显式关死：group 默认会插值尺寸/位置，old/new 默认走 UA 交叉淡化且带
    //   mix-blend-mode: plus-lighter（加色混合，与段 (d) 记录的壳层泛白同一个坑）。
    //   两侧都不带动画时快照都停在 opacity 1、new 压在 old 上且逐像素相同，
    //   合成结果就是一张静止壁纸。
    [`:root[data-vt^="route-"] #${WALLPAPER_LAYER_ID}`]: { viewTransitionName: wallpaper },
    [`:root[data-vt^="route-"]${vtPseudo('group', wallpaper)}`]: {
      zIndex: -1,
      animation: 'none',
    },
    [`:root[data-vt^="route-"]${vtPseudo('old', wallpaper)},
      :root[data-vt^="route-"]${vtPseudo('new', wallpaper)}`]: {
      animation: 'none',
      mixBlendMode: 'normal',
    },

    // (h) reduced-motion 总闸：偏好减少动效时整个 View Transition 全部禁用动画
    '@media (prefers-reduced-motion: reduce)': {
      '::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*)': {
        animation: 'none !important',
      },
    },
  };
}
