// View Transitions 接线层：把「打方向标记 → 启动转场 → 清理标记」收敛成唯一入口。
// 浏览器不支持该 API、或用户偏好减少动效时退化为同步更新，调用方无需自己分支。

import { flushSync } from 'react-dom';

/** 转场种类：写到 <html data-vt> 上，供样式层的 ::view-transition-* 规则选择 */
export type VtKind = 'route-forward' | 'route-back' | 'expand' | 'collapse';

/** 共享元素名。同一时刻同名元素只能有一个，出现两个会让整个转场被浏览器跳过 */
export const VT_NAMES = {
  sheet: 'rtk-sheet',
  fab: 'rtk-fab',
  appBar: 'rtk-app-bar',
  bottomNav: 'rtk-bottom-nav',
  navDrawer: 'rtk-nav-drawer',
} as const;

/** <html> 上的方向标记属性名 */
export const VT_ATTR = 'data-vt';

export function supportsViewTransitions(): boolean {
  return typeof document !== 'undefined' && typeof document.startViewTransition === 'function';
}

// 在途转场的序号：finished 回调只在自己仍是最新一次转场时才清理标记，
// 否则快速连点时先结束的转场会抹掉后一次转场的方向。
let latestToken = 0;

/**
 * 执行一次带 View Transition 的状态更新。
 *
 * update 必须是同步的 React 状态更新；它在转场回调内经 flushSync 提交，
 * 浏览器据此拍下新态快照。返回的 Promise 在转场结束（或被跳过）后 resolve，
 * 调用方可以在其后做清理，且永不 reject——转场被打断不是错误，DOM 已经更新。
 */
export function runViewTransition(
  kind: VtKind,
  update: () => void,
  reduced = false,
): Promise<void> {
  if (reduced || !supportsViewTransitions()) {
    update();
    return Promise.resolve();
  }
  const root = document.documentElement;
  const token = ++latestToken;
  root.setAttribute(VT_ATTR, kind);
  const transition = document.startViewTransition(() => {
    flushSync(update);
  });
  return transition.finished
    .catch(() => undefined)
    .then(() => {
      if (latestToken === token) root.removeAttribute(VT_ATTR);
    });
}
