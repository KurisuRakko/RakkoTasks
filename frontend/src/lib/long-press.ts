// 长按手势 hook：给列表行提供移动端的「长按弹出上下文菜单」入口，与桌面右键
// （元素上的 onContextmenu）分开处理。
//
// 为什么用 touch 事件而不是 pointer 事件：本项目要同时支持桌面右键（contextmenu
// 事件）与移动端长按两种互斥的输入，它们本就各自走一条更专门的路径——桌面右键有
// 系统级的 contextmenu 语义（长按鼠标也由系统按需合成），移动端长按则需要自己计时、
// 自己判断位移。pointerdown 会同时覆盖两类输入，还得额外分辨 pointerType 才不致
// 与右键路径重复触发；分开处理后两条路径各自直白，不会互相干扰。
//
// 为什么要有 MOVE_TOLERANCE_PX：列表本身是滚动容器，手指按下后只要开始滚动列表，
// 触点位置必然移动（500ms 内随便滚一下就是几十 px）。不把位移排除掉，滚动的起始
// 触摸也会被当成长按，菜单会在用户只想滚动时误弹出。位移超过容差即视为滚动意图，
// 取消定时器；容差内的轻微抖动（按压时的自然漂移）不取消。
//
// 延迟与上游 motion.md 的 tooltip 提示同档（--motion-delay-tooltip 为 500ms）。
// 本项目 rakko-tokens 里没有镜像这个常量（那里只有 --motion-* 的时长/缓动档），
// 故在本文件直接定义 LONG_PRESS_MS = 500 并注明出处，不去改 rakko-tokens。

import { useEffect, useRef } from 'react';
import type { TouchEvent as ReactTouchEvent } from 'react';

/** 长按触发延迟（ms）。与上游 motion.md 的 tooltip 提示延迟同档
 * （--motion-delay-tooltip 为 500ms），本项目 rakko-tokens 未镜像该常量，故在此定义。 */
export const LONG_PRESS_MS = 500;

/** 判定为「滚动而不是长按」的位移容差（px）。列表滚动时手指必然移动，
 * 超出容差即取消定时器，避免误触发菜单。 */
export const MOVE_TOLERANCE_PX = 10;

/**
 * 长按手势 hook：按住 LONG_PRESS_MS 后调用 onLongPress，传入按下起点坐标
 * （菜单按坐标定位用）。位移超过 MOVE_TOLERANCE_PX（用户在滚列表）、提前抬起或
 * 取消、以及组件卸载时都会清掉定时器，卸载后不会再有迟到的触发。
 */
export function useLongPress(
  onLongPress: (point: { x: number; y: number }) => void,
): {
  onTouchStart: (e: ReactTouchEvent) => void;
  onTouchMove: (e: ReactTouchEvent) => void;
  onTouchEnd: () => void;
  onTouchCancel: () => void;
} {
  const start = useRef<{ x: number; y: number } | null>(null);
  const timer = useRef<number | null>(null);
  // 定时器触发时读最新的 onLongPress：行在按住期间若重渲染（如列表刷新换掉了
  // 回调闭包），触发时刻仍用当前回调，不会对着一份过期闭包操作
  const onLongPressRef = useRef(onLongPress);
  useEffect(() => {
    onLongPressRef.current = onLongPress;
  });

  const cancel = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const handleTouchStart = (e: ReactTouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    start.current = { x: touch.clientX, y: touch.clientY };
    cancel();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      const point = start.current;
      if (point) onLongPressRef.current(point);
    }, LONG_PRESS_MS);
  };

  const handleTouchMove = (e: ReactTouchEvent) => {
    const touch = e.touches[0];
    const origin = start.current;
    if (!touch || !origin) return;
    const dx = touch.clientX - origin.x;
    const dy = touch.clientY - origin.y;
    // 位移超容差 = 用户是在滚动列表，不是在长按：取消定时器
    if (Math.hypot(dx, dy) > MOVE_TOLERANCE_PX) cancel();
  };

  const handleTouchEnd = () => cancel();
  const handleTouchCancel = () => cancel();

  // 组件卸载时清掉未触发的定时器：否则卸载后触发会拿着过期回调 setState 到
  // 已卸载的组件（长按在行离场/页面切换的半途尤其常见）
  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  return {
    onTouchStart: handleTouchStart,
    onTouchMove: handleTouchMove,
    onTouchEnd: handleTouchEnd,
    onTouchCancel: handleTouchCancel,
  };
}
