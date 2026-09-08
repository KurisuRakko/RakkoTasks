// 对话框过渡的单一出口。两条路，按对话框自己的定位选：
//
// - dialogTransitionProps()：详情对话框用。它由列表行经 View Transitions 容器变换
//   长出，能用 VT 时把入退场整个交给 VT（MUI 自身过渡设为 0ms 让位），否则退回向上滑入。
// - SlideUp：不参与容器变换的对话框直接拿它当 TransitionComponent，两个方向都由 MUI
//   自己跑。速记面板走这条——它必须在任何浏览器上都对称，不能押在 VT 是否被跳过上。
//
// 集中一处，避免每个对话框各写一份 Slide 包装。

import { forwardRef } from 'react';
import Slide from '@mui/material/Slide';
import { supportsViewTransitions } from '../lib/view-transition';
import type { ReactElement } from 'react';
import type { DialogProps } from '@mui/material/Dialog';
import type { TransitionProps } from '@mui/material/transitions';

/** 从下方滑入 / 滑出。整个应用只此一份，别再各处 new 一个 Slide 包装 */
export const SlideUp = forwardRef<HTMLDivElement, TransitionProps & { children: ReactElement }>(
  (props, ref) => <Slide direction="up" ref={ref} {...props} />,
);

/** 展开到 Dialog 上的过渡相关 props */
export function dialogTransitionProps(): Pick<
  DialogProps,
  'TransitionComponent' | 'transitionDuration'
> {
  return supportsViewTransitions() ? { transitionDuration: 0 } : { TransitionComponent: SlideUp };
}
