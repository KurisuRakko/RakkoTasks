// dialogTransitionProps 测试：不支持 View Transitions 时退回 MUI SlideUp 过渡；
// 支持（stub document.startViewTransition）时把过渡让位给浏览器 VT（duration 0，不带组件）。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { dialogTransitionProps } from '../src/components/DialogTransition';

afterEach(() => {
  // 还原 stub：jsdom 默认本就没有 startViewTransition，直接删属性回到初始态
  delete (document as { startViewTransition?: unknown }).startViewTransition;
});

describe('dialogTransitionProps', () => {
  it('不支持 View Transitions 时返回带 TransitionComponent 的过渡，不带 transitionDuration: 0', () => {
    expect(typeof document.startViewTransition).toBe('undefined');
    const props = dialogTransitionProps();
    expect(props.TransitionComponent).toBeDefined();
    expect(props.transitionDuration).toBeUndefined();
  });

  it('支持 View Transitions 时返回 { transitionDuration: 0 }，不带 TransitionComponent', () => {
    (document as { startViewTransition?: unknown }).startViewTransition = vi.fn();
    const props = dialogTransitionProps();
    expect(props).toEqual({ transitionDuration: 0 });
    expect(props.TransitionComponent).toBeUndefined();
  });
});
