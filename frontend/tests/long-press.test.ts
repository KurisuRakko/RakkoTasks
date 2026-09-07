// useLongPress 测试：长按满 LONG_PRESS_MS 触发一次并带起点坐标；提前抬起、
// touchmove 位移超容差、组件卸载都不得触发；容差内的小位移不取消。
// 直接调用 hook 返回的处理器（fireEvent.touchStart 依赖 jsdom 的 TouchEvent 构造，
// 这里用最小事件形状的直调更稳），配合 vi.useFakeTimers 推进定时器。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { LONG_PRESS_MS, MOVE_TOLERANCE_PX, useLongPress } from '../src/lib/long-press';

type Handlers = ReturnType<typeof useLongPress>;
type TouchEventArg = Parameters<Handlers['onTouchStart']>[0];

function touchStartEvent(clientX: number, clientY: number): TouchEventArg {
  return { touches: [{ clientX, clientY }] } as unknown as TouchEventArg;
}

function touchMoveEvent(clientX: number, clientY: number): TouchEventArg {
  return { touches: [{ clientX, clientY }] } as unknown as TouchEventArg;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('useLongPress', () => {
  it('touchstart 后推进 500ms：onLongPress 被调用一次，且收到起点坐标', () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    act(() => result.current.onTouchStart(touchStartEvent(120, 60)));
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));

    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLongPress).toHaveBeenCalledWith({ x: 120, y: 60 });
  });

  it('touchstart 后 400ms 就 touchend：推进满 500ms 也不触发', () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    act(() => result.current.onTouchStart(touchStartEvent(10, 10)));
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS - 100));
    act(() => result.current.onTouchEnd());
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('touchmove 位移超过 10px（用户是在滚列表）：推进满 500ms 也不触发', () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    act(() => result.current.onTouchStart(touchStartEvent(0, 0)));
    act(() =>
      result.current.onTouchMove(
        touchMoveEvent(MOVE_TOLERANCE_PX + 1, 0),
      ),
    );
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('touchmove 位移在容差内（5px 的按压漂移）：不取消，满 500ms 仍触发且坐标是起点', () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    act(() => result.current.onTouchStart(touchStartEvent(100, 200)));
    act(() => result.current.onTouchMove(touchMoveEvent(105, 200)));
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));

    expect(onLongPress).toHaveBeenCalledTimes(1);
    // 定位用的是按下起点，不是漂移后的触点
    expect(onLongPress).toHaveBeenCalledWith({ x: 100, y: 200 });
  });

  it('卸载后推进满 500ms 不触发（卸载清理函数清掉了定时器）', () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const { result, unmount } = renderHook(() => useLongPress(onLongPress));

    act(() => result.current.onTouchStart(touchStartEvent(30, 40)));
    unmount();
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('touchcancel 与 touchend 一样清定时器：touchstart 后 cancel 不触发', () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    act(() => result.current.onTouchStart(touchStartEvent(5, 5)));
    act(() => result.current.onTouchCancel());
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));

    expect(onLongPress).not.toHaveBeenCalled();
  });
});
