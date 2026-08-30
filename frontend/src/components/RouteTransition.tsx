// 路由转场：仅入场动画，方向性滑动（索引变大从右、变小从左、settings 组统一从右）。
// 只做入场不做离场（离场需 TransitionGroup，本任务禁止引入）；reduced-motion 时无动画。

import { useRef } from 'react';
import Box from '@mui/material/Box';
import { useLocation } from 'react-router-dom';
import { navIndexOf } from '../lib/nav';
import { usePrefersReducedMotion } from '../lib/motion';
import type { ReactNode } from 'react';

const FROM_RIGHT_KEYFRAMES = {
  '@keyframes rtk-route-right': {
    from: { opacity: 0, transform: 'translateX(24px)' },
    to: { opacity: 1, transform: 'translateX(0)' },
  },
};

const FROM_LEFT_KEYFRAMES = {
  '@keyframes rtk-route-left': {
    from: { opacity: 0, transform: 'translateX(-24px)' },
    to: { opacity: 1, transform: 'translateX(0)' },
  },
};

export default function RouteTransition({ children }: { children: ReactNode }) {
  const location = useLocation();
  const reduced = usePrefersReducedMotion();
  const prevIndex = useRef(navIndexOf(location.pathname));
  const index = navIndexOf(location.pathname);

  // /settings（-1）统一按「从右进入」；从 settings 返回（prev 为 -1）按「从左进入」
  const fromRight = index === -1 || (prevIndex.current !== -1 && index > prevIndex.current);
  const moving = index !== prevIndex.current;
  prevIndex.current = index;

  const sx = reduced || !moving ? {} : fromRight
    ? { ...FROM_RIGHT_KEYFRAMES, animation: 'rtk-route-right 240ms ease-out both' }
    : { ...FROM_LEFT_KEYFRAMES, animation: 'rtk-route-left 240ms ease-out both' };

  return (
    <Box key={location.pathname} sx={sx}>
      {children}
    </Box>
  );
}
