// 布局常量与跨组件对话框定位的单一来源：
// - DRAWER_WIDTH：桌面常驻抽屉宽度（md = 900px 起，AppShell 的 Drawer 与之对齐）；
// - CONTENT_MAX_WIDTH：内容列最大宽度（AppShell 的路由出口盒子与从列表行长出来的
//   对话框共用，让对话框的横向几何与内容列完全一致，容器变换只剩纵向生长）；
// - PAGE_SX / PANEL_SX / DIALOG_BODY_SX / EMPTY_STATE_BOX_SX：页面外壳、分区玻璃面板、
//   对话框正文、空态居中块的 sx 字面量；
// - mainAreaDialogSx / columnDialogSx：md 起把 Dialog 的定位从「居中于整个视口」
//   改为「居中于主内容区」——给 .MuiDialog-container 左侧 padding 让出抽屉宽度，
//   遮罩仍由 Modal 根元素盖满全屏，抽屉照样被压暗。
// 注：sx 的容器/paper 后代选择器（如 `.css-x .MuiDialog-paper`）是两个类（0,2,0），
// 高于 MUI 自己的 .MuiDialog-paperWidthMd 等（0,1,0），不需要 !important。

import type { Theme } from '@mui/material/styles';
import type { SystemStyleObject } from '@mui/system';
import { RADIUS } from '../rakko-tokens';

/** 桌面常驻抽屉宽度（md 起） */
export const DRAWER_WIDTH = 240;
/** 内容列最大宽度：AppShell 的路由出口与从列表行长出来的对话框共用 */
export const CONTENT_MAX_WIDTH = 840;
/** 移动端固定底栏的让位高度：主内容区留白与吸底元素的偏移都以它为准 */
export const BOTTOM_NAV_HEIGHT_PX = 64;

/** 页面外壳：不给横向内边距（玻璃面板贴着内容区左右边，横向留白由面板自己的 px 提供），
 *  底部 padding 给固定底栏（AppShell，高 50–58px + env(safe-area-inset-bottom)）让出空间，
 *  72 = 底栏高 + 呼吸空间，不写死具体底栏高度。不给的话页面最下面的动作按钮会被底栏压住。 */
export const PAGE_SX = {
  pt: 2,
  pb: 'calc(72px + env(safe-area-inset-bottom))',
} as const;

/** 分区玻璃面板：材质（纸底 / 边框 / 高光 / 阴影）由 rakko-glass.css 的 data-glass="panel"
 *  配方提供——挂了 data-glass 的元素不能再下发 background/backgroundColor，主题层与局部
 *  sx 都不行，否则盖掉玻璃配方。这里只补配方不管的圆角（与列表行同一 RADIUS.card，而不是
 *  另写一个 6）与统一内边距。 */
export const PANEL_SX = {
  px: 2,
  py: 2,
  borderRadius: `${RADIUS.card}px`,
} as const;

/** 对话框正文：内边距（常规内边距之上再补一份底部安全区）+ 长串折行的兜底。
 *  内边距：对话框正文贴屏幕底边，底部控件坐在 home indicator 上会被遮住/误触。
 *  16px 是基准内边距，不随 env(safe-area-inset-bottom) 变；用 calc 相加而不是覆盖，
 *  安全区为 0 的机型上也保持对齐。
 *  overflowWrap：Dialog 的 paper 是 overflow-y: auto 的滚动容器，而一个轴不是
 *  visible 时另一轴的 visible 会按 CSS 规则计算成 auto——正文里任何比 paper 宽、
 *  又没有断点的长串（URL / 订单号 / 邮箱）都会让整张 paper 横向可滚，用户看到的
 *  就是整个弹窗左右晃。这里给正文补上断点，长串在正文宽度内折行。
 *  取 anywhere 而不是 break-word：两者都会在溢出时断开长串，但只有 anywhere 把
 *  这些断点计入 min-content——flex 行里的文字项按 min-content 收缩，才让得开宽度；
 *  break-word 下 flex 项的 min-width: auto 仍按整串宽度撑开，等于没修。 */
export const DIALOG_BODY_SX = {
  px: 2,
  py: 2,
  pb: 'calc(16px + env(safe-area-inset-bottom))',
  overflowWrap: 'anywhere',
} as const;

/** 空态 / 加载态居中块：一块只放 CircularProgress 或一句空态文案的横向居中容器。
 *  py 取 6（theme.spacing(6) = 48px）留出竖向呼吸，避免空态贴着上方标题或分区边框。 */
export const EMPTY_STATE_BOX_SX = {
  display: 'flex',
  justifyContent: 'center',
  py: 6,
} as const;

/** md 起 Dialog 居中于主内容区而非整个视口：容器左侧让出抽屉宽度；遮罩仍由 Modal 根元素盖全屏 */
export const mainAreaDialogSx: (theme: Theme) => SystemStyleObject<Theme> = (theme) => ({
  [theme.breakpoints.up('md')]: {
    // padding 数值会被 theme.spacing 放大（240 → 1920px），px 字符串原样进 CSS
    '& .MuiDialog-container': { paddingLeft: `${DRAWER_WIDTH}px` },
  },
});

/** md 起 Dialog 与内容列重合：在 mainAreaDialogSx 之上，paper 去横向边距、宽 100%、封顶内容列宽——
 *  列表行长成对话框时容器只在纵向生长 */
export const columnDialogSx: (theme: Theme) => SystemStyleObject<Theme> = (theme) => ({
  [theme.breakpoints.up('md')]: {
    '& .MuiDialog-container': { paddingLeft: `${DRAWER_WIDTH}px` },
    '& .MuiDialog-paper': {
      marginLeft: 0,
      marginRight: 0,
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
    },
  },
});
