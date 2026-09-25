// 桌面对话框纸面的玻璃面板接线。移动端的同内容页面坐在 <Box data-glass="panel"> 上，
// 桌面端如果不是同一档材质，同一个「账户详情」在两种断点下就是两种质感。
//
// 写法与 AppShell 的底栏发丝线同一条规矩：App.tsx 用 injectFirst 把 MUI 的 emotion
// 样式插到 <head> 最前，rakko-glass.css 的 [data-glass='panel'] 在其后，特异性同为
// (0,1,0) 时后者赢。局部要覆盖配方就必须把选择器抬到 (0,2,0)——这里写成
// `&[data-glass='panel']`（容器类 + 属性选择器）而不是裸的 `&`。
//
// 盖掉的是背景，不是全部：配方给的是「线性光泽 + 纸色 58%」两层 background，而
// MuiDialog-paper 的 background-color 在同特异性下会打不过配方（injectFirst），
// 结果是深色主题下 transparent 变成近黑、浅色主题下只剩纸色层。所以显式把背景重写成
// 「配方那两层的透明度 + 对话框自己的纸色」，圆角与阴影（--glass-lift）沿用配方。
//
// 内唇用 inset 0 1px 0 var(--glass-lip)：box-shadow 是整条替换，只写脸面不做补偿会把
// 配方那圈内边一起抹掉（同 AppShell 底栏的注释）。

import type { Theme } from '@mui/material/styles';
import type { SystemStyleObject } from '@mui/system';

/** 挂在 Dialog 的 sx 上：作用对象是它内部的 .MuiDialog-paper */
export const dialogPanelGlassSx = (theme: Theme): SystemStyleObject<Theme> => ({
  '& .MuiDialog-paper': {
    '&[data-glass="panel"]': {
      background: [
        'linear-gradient(to bottom, var(--glass-sheen-1) 0, var(--glass-sheen-2) 45%, var(--glass-sheen-3) 100%)',
        `color-mix(in srgb, ${theme.palette.background.paper} var(--glass-panel-opacity), transparent)`,
      ].join(', '),
      boxShadow: 'inset 0 0 0 1px var(--glass-rim-inner), inset 0 1px 0 var(--glass-lip), var(--glass-lift)',
      // 纸面上的文字不再吃玻璃的文字光晕：对话框里是 13–15px 的正文，光晕按玻璃面板
      // 那套（0 0 6px）打上来会糊成双层字。配方本身的光晕留给页面级玻璃分区。
      textShadow: 'none',
    },
  },
});
