// 布局常量与跨组件对话框定位的单一来源：
// - DRAWER_WIDTH：桌面常驻抽屉宽度（md = 900px 起，AppShell 的 Drawer 与之对齐）；
// - CONTENT_MAX_WIDTH：内容列最大宽度（AppShell 的路由出口盒子与从列表行长出来的
//   对话框共用，让对话框的横向几何与内容列完全一致，容器变换只剩纵向生长）；
// - mainAreaDialogSx / columnDialogSx：md 起把 Dialog 的定位从「居中于整个视口」
//   改为「居中于主内容区」——给 .MuiDialog-container 左侧 padding 让出抽屉宽度，
//   遮罩仍由 Modal 根元素盖满全屏，抽屉照样被压暗。
// 注：sx 的容器/paper 后代选择器（如 `.css-x .MuiDialog-paper`）是两个类（0,2,0），
// 高于 MUI 自己的 .MuiDialog-paperWidthMd 等（0,1,0），不需要 !important。

import type { Theme } from '@mui/material/styles';
import type { SystemStyleObject } from '@mui/system';

/** 桌面常驻抽屉宽度（md 起） */
export const DRAWER_WIDTH = 240;
/** 内容列最大宽度：AppShell 的路由出口与从列表行长出来的对话框共用 */
export const CONTENT_MAX_WIDTH = 840;

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
