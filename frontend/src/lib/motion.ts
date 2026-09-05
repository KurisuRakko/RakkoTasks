// 动效工具层：入场 stagger、勾选离场收起、带方向的路由跳转、容器变换对话框。
// 只用 CSS 与浏览器 View Transitions，不引第三方动画库。

import { useCallback, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useLocation, useNavigate } from 'react-router-dom';
import { MOTION } from '../rakko-tokens';
import { navIndexOf } from './nav';
import { runViewTransition, VT_NAMES } from './view-transition';
import type { SxProps } from '@mui/material';
import type { Theme } from '@mui/material/styles';

/** 是否偏好减少动态效果（系统级 prefers-reduced-motion） */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}

/** 入场 stagger 的单档延迟（ms）；封顶 8 档，长列表不会越排越久 */
const STAGGER_STEP_MS = 30;
const STAGGER_MAX_STEPS = 8;

const ENTER_UP_KEYFRAMES = {
  '@keyframes rtk-enter-up': {
    from: { opacity: 0, transform: 'translateY(8px)' },
    to: { opacity: 1, transform: 'translateY(0)' },
  },
};

function staggerDelay(index: number): string {
  return `${Math.min(index, STAGGER_MAX_STEPS) * STAGGER_STEP_MS}ms`;
}

/** 列表项入场动画 sx：淡入上移，index 从组内 0 起算；reduced 时返回空对象 */
export function enterSx(index: number, reduced: boolean): SxProps<Theme> {
  if (reduced) return {};
  return {
    ...ENTER_UP_KEYFRAMES,
    animation: `rtk-enter-up ${MOTION.enter}ms ${MOTION.easeStandard} both`,
    animationDelay: staggerDelay(index),
  };
}

/** 勾选离场时长：动画跑完再把条目移出列表 */
export const LEAVE_DURATION = MOTION.largeExit;

/**
 * 可勾选列表行的完整样式：入场 stagger + 勾选后行高收起。
 *
 * 行高用 grid-template-rows 1fr→0fr 过渡——height:auto 不可过渡，分数单位可以；
 * 子元素必须 min-height:0 才会真正被压缩。这样下方条目平滑上移，
 * 而不是在条目被移除的瞬间跳上来。
 * 过渡属性逐项列出，不用 transition: all（会连带动画布局与浏览器私有属性）。
 * enter 由调用方的 useCachedList.animateEnter 传入：入场 stagger 只在「这份列表
 * 首次拿到数据」时跑一次；命中缓存直接挂载的列表就该位，不重放一遍入场。
 */
export function rowSx(
  index: number,
  leaving: boolean,
  reduced: boolean,
  enter: boolean,
): SxProps<Theme> {
  const box = {
    display: 'grid',
    // MUI ListItem 根样式带 justify-content: flex-start，网格的隐式 auto 列会按
    // max-content 打包并贴左，行宽于是随内容长短变化——短标题的行只有半屏宽，
    // 右侧标签（重要 / 分类 / 日期）每行落在不同位置。显式铺一列 minmax(0, 1fr)
    // 让行占满容器；下限取 0 而非 auto，长文本才不会被 min-content 撑破列宽。
    gridTemplateColumns: 'minmax(0, 1fr)',
    gridTemplateRows: leaving ? '0fr' : '1fr',
    opacity: leaving ? 0 : 1,
    '& > *': { minHeight: 0, overflow: 'hidden' },
  };
  if (reduced) return box;
  // 入场动画只在「该列表首次拿到数据」且未离场时挂：两套动效同时作用于同一元素
  // 会互相覆盖 transform；命中缓存（enter=false）时列表已就位，不重放入场。
  const entering = enter && !leaving;
  return {
    ...(entering ? ENTER_UP_KEYFRAMES : {}),
    ...box,
    transform: leaving ? 'translateX(12px)' : 'none',
    transition: [
      `grid-template-rows ${MOTION.largeExit}ms ${MOTION.easeStandard}`,
      `opacity ${MOTION.exit}ms ${MOTION.easeStandard}`,
      `transform ${MOTION.exit}ms ${MOTION.easeStandard}`,
    ].join(', '),
    ...(entering
      ? {
          animation: `rtk-enter-up ${MOTION.enter}ms ${MOTION.easeStandard} both`,
          animationDelay: staggerDelay(index),
        }
      : {}),
  };
}

/**
 * 带方向的路由跳转：按导航索引判定前进/后退，交给 View Transitions 做共享轴转场。
 * 设置页（索引 -1）视为「更深一层」——进去算前进、出来算后退。
 * 目标与当前路径相同时不导航，避免原地触发一次无意义的转场。
 */
export function useTransitionNavigate(): (to: string) => void {
  const navigate = useNavigate();
  const location = useLocation();
  const reduced = usePrefersReducedMotion();
  return useCallback(
    (to: string) => {
      if (to === location.pathname) return;
      const from = navIndexOf(location.pathname);
      const next = navIndexOf(to);
      const forward = next === -1 || (from !== -1 && next > from);
      void runViewTransition(
        forward ? 'route-forward' : 'route-back',
        () => navigate(to),
        reduced,
      );
    },
    [location.pathname, navigate, reduced],
  );
}

export interface MorphDialog<T> {
  /** 当前打开的条目；null 表示对话框关闭 */
  current: T | null;
  open: (item: T) => void;
  close: () => void;
  /** 该 key 对应的来源元素此刻该用的 view-transition-name（不该持名时为 undefined） */
  sourceName: (key: number | string) => string | undefined;
}

/**
 * 容器变换对话框：打开时来源元素与对话框 paper 前后共用一个 view-transition-name，
 * 浏览器据此把来源「长成」对话框，关闭时缩回原处。
 *
 * 命名唯一性是硬约束：来源仅在「对话框关闭且它是上一次的来源」时持名。因此打开的
 * 转场里旧态由来源持名、新态由 paper 持名，关闭时正好反过来，任一时刻都只有一个。
 */
export function useMorphDialog<T>(keyOf: (item: T) => number | string): MorphDialog<T> {
  const [current, setCurrent] = useState<T | null>(null);
  const [sourceKey, setSourceKey] = useState<number | string | null>(null);
  const reduced = usePrefersReducedMotion();
  // 调用方常传内联箭头函数，用 ref 固定以免每次渲染都换掉 open 的引用
  const keyOfRef = useRef(keyOf);
  keyOfRef.current = keyOf;

  const open = useCallback(
    (item: T) => {
      // 先让来源元素带上名字并落到 DOM，转场才能捕获到它的起始位置
      flushSync(() => setSourceKey(keyOfRef.current(item)));
      void runViewTransition('expand', () => setCurrent(item), reduced);
    },
    [reduced],
  );

  const close = useCallback(() => {
    void runViewTransition('collapse', () => setCurrent(null), reduced).then(() =>
      setSourceKey(null),
    );
  }, [reduced]);

  const sourceName = useCallback(
    (key: number | string) =>
      current === null && sourceKey === key ? VT_NAMES.sheet : undefined,
    [current, sourceKey],
  );

  return { current, open, close, sourceName };
}
