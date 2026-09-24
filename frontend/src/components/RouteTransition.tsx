// 路由转场：换页只让内容列播一段入场动画——外层裁剪盒 + 以 pathname 为 key 的内层
// 动画盒，方向由 routeDirection 判定（导航索引变大从右、变小从左；设置组内按路径深度）。
// 壁纸层、壳层（AppBar / 底栏 / 桌面抽屉）与悬浮按钮都留在真实 DOM 里不动，换页不影响它们。
//
// 换页刻意不走 View Transitions：那条链路要先拍整页旧快照、同步渲染整页新状态、再合成
// 多张全屏快照，而列表每行一块 backdrop-filter 玻璃、行的入场 stagger 最长 540ms，全都得
// 每帧重栅格化进快照，这是换页卡顿的主要来源；并且 root 快照带着 CssBaseline 传播到
// canvas 的纸色背景，z-index -1 的壁纸层即使静止也会被整块盖住，换页期间看不到壁纸。
// 列表行 / 引用项 ↔ 详情对话框的容器变换（expand / collapse）仍走 View Transitions，
// 与本组件无关。
//
// 入场动画的 fill-mode 必须是 backwards：动画跑完不得残留 transform / opacity，否则残留的
// translateX(0) 会让这个盒子成为 fixed 后代的包含块与层叠上下文。悬浮按钮已 portal 到
// body（TasksPage），因此不受影响；以后新增的 fixed 元素要么同样 portal，要么别放进动画盒。
// 只做入场：离场要求视图在换页后仍留在 DOM 里，得靠 TransitionGroup 才管得起来。
// 首次挂载（路径未变）与 reduced-motion 下不加动画，裁剪盒照常生效。

import { useRef } from 'react';
import Box from '@mui/material/Box';
import { useLocation } from 'react-router-dom';
import { routeDirection } from '../lib/nav';
import { usePrefersReducedMotion } from '../lib/motion';
import { MOTION, SHARED_AXIS_OFFSET_PX } from '../rakko-tokens';
import type { ReactNode } from 'react';

const FROM_RIGHT_KEYFRAMES = {
  '@keyframes rtk-route-right': {
    from: { opacity: 0, transform: `translateX(${SHARED_AXIS_OFFSET_PX}px)` },
    to: { opacity: 1, transform: 'translateX(0)' },
  },
};

const FROM_LEFT_KEYFRAMES = {
  '@keyframes rtk-route-left': {
    from: { opacity: 0, transform: `translateX(-${SHARED_AXIS_OFFSET_PX}px)` },
    to: { opacity: 1, transform: 'translateX(0)' },
  },
};

export default function RouteTransition({ children }: { children: ReactNode }) {
  const location = useLocation();
  const reduced = usePrefersReducedMotion();
  // 记上一段路径而非索引：方向按 routeDirection 判（设置组内按路径深度）
  const prevPath = useRef(location.pathname);
  const path = location.pathname;

  const fromRight = routeDirection(prevPath.current, path) === 'forward';
  const moving = path !== prevPath.current;
  prevPath.current = path;

  const sx = reduced || !moving ? {} : fromRight
    ? {
        ...FROM_RIGHT_KEYFRAMES,
        animation: `rtk-route-right ${MOTION.enter}ms ${MOTION.easeStandard} backwards`,
      }
    : {
        ...FROM_LEFT_KEYFRAMES,
        animation: `rtk-route-left ${MOTION.enter}ms ${MOTION.easeStandard} backwards`,
      };

  return (
    // 外层裁剪盒：overflow 只裁后代不裁自身，而 transform 作用在内层动画盒上，
    // 故裁剪必须放在外层（否则 translateX 溢出仍会撑出横向滚动区）。
    // clip 不创建滚动容器、不改变 overflow-y 计算值，hidden 作老浏览器兜底；
    // 无条件生效（reduced-motion 下同样裁剪），AppBar/底栏在此元素之外不受影响。
    <Box
      sx={{
        overflowX: 'hidden',
        '@supports (overflow: clip)': { overflowX: 'clip' },
      }}
    >
      <Box key={location.pathname} sx={sx}>
        {children}
      </Box>
    </Box>
  );
}
