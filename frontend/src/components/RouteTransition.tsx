// 路由转场，按浏览器能力分两条路径：
// 1) 支持 View Transitions（supportsViewTransitions() 为真）：直接渲染 children——
//    不套盒子、不加动画、不留 transform。换页的方向转场由 lib/view-transition 的
//    data-vt 标记与样式层 ::view-transition-* 规则完成，壳层元素（AppBar/底栏/抽屉）
//    作为共享元素保持静止。这里的入场动画必须让位，因为 fill-mode: both 会让
//    transform: translateX(0) 长期残留——非 none 的 transform 会成为 fixed 后代的
//    包含块，任务页右下角悬浮按钮会因此跟着内容滚动。
// 2) 不支持时退回「外层裁剪盒 + 内层入场动画盒」：方向性滑动（索引变大从右、变小
//    从左、settings 组统一从右），参数对齐 design token；reduced-motion 时无动画。
//    回退路径只做入场（离场需视图在换页后仍留在 DOM，要 TransitionGroup 管理）。

import { useRef } from 'react';
import Box from '@mui/material/Box';
import { useLocation } from 'react-router-dom';
import { navIndexOf } from '../lib/nav';
import { supportsViewTransitions } from '../lib/view-transition';
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
  const prevIndex = useRef(navIndexOf(location.pathname));
  const index = navIndexOf(location.pathname);

  // 支持 View Transitions 时彻底让位：不加任何包裹与动画（见文件头注释）
  if (supportsViewTransitions()) return children;

  // 回退路径（无 View Transitions 的浏览器）：
  // /settings（-1）统一按「从右进入」；从 settings 返回（prev 为 -1）按「从左进入」
  const fromRight = index === -1 || (prevIndex.current !== -1 && index > prevIndex.current);
  const moving = index !== prevIndex.current;
  prevIndex.current = index;

  const sx = reduced || !moving ? {} : fromRight
    ? {
        ...FROM_RIGHT_KEYFRAMES,
        animation: `rtk-route-right ${MOTION.enter}ms ${MOTION.easeStandard} both`,
      }
    : {
        ...FROM_LEFT_KEYFRAMES,
        animation: `rtk-route-left ${MOTION.enter}ms ${MOTION.easeStandard} both`,
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
