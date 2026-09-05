// 对话框过渡的单一出口：能用 View Transitions 时把入退场整个交给它（MUI 自身过渡设为
// 0ms 让位），否则退回向上滑入。集中一处，避免每个对话框各写一份 Slide 包装。

import { forwardRef } from 'react';
import Slide from '@mui/material/Slide';
import { supportsViewTransitions } from '../lib/view-transition';
import type { ReactElement } from 'react';
import type { DialogProps } from '@mui/material/Dialog';
import type { TransitionProps } from '@mui/material/transitions';

const SlideUp = forwardRef<HTMLDivElement, TransitionProps & { children: ReactElement }>(
  (props, ref) => <Slide direction="up" ref={ref} {...props} />,
);

/** 展开到 Dialog 上的过渡相关 props */
export function dialogTransitionProps(): Pick<
  DialogProps,
  'TransitionComponent' | 'transitionDuration'
> {
  return supportsViewTransitions() ? { transitionDuration: 0 } : { TransitionComponent: SlideUp };
}
