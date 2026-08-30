// 动画工具：入场 stagger 与 reduced-motion 适配。仅 CSS 动画，不引第三方动画库。

import useMediaQuery from '@mui/material/useMediaQuery';
import type { SxProps } from '@mui/material';
import type { Theme } from '@mui/material/styles';

/** 是否偏好减少动态效果（系统级 prefers-reduced-motion） */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}

const ENTER_UP_KEYFRAMES = {
  '@keyframes rtk-enter-up': {
    from: { opacity: 0, transform: 'translateY(8px)' },
    to: { opacity: 1, transform: 'translateY(0)' },
  },
};

/**
 * 列表项入场动画 sx：淡入上移 220ms，index 从组内 0 起算，
 * 延迟封顶 8 档（Math.min(index, 8) * 40ms），reduced 时返回空对象。
 */
export function enterSx(index: number, reduced: boolean): SxProps<Theme> {
  if (reduced) return {};
  return {
    ...ENTER_UP_KEYFRAMES,
    animation: 'rtk-enter-up 220ms ease-out both',
    animationDelay: `${Math.min(index, 8) * 40}ms`,
  };
}

/** 勾选离场叠加样式：删除线 + 半透明 + 右移，配合 260ms 过渡 */
export const LEAVE_SX = {
  textDecoration: 'line-through',
  opacity: 0.4,
  transform: 'translateX(12px)',
  transition: 'all 260ms',
} as const;
