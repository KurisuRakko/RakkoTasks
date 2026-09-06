// View Transitions 接线层：把「打方向标记 → 启动转场 → 清理标记」收敛成唯一入口。
// 浏览器不支持该 API、或用户偏好减少动效时退化为同步更新，调用方无需自己分支。

import { flushSync } from 'react-dom';

/**
 * 转场种类：写到 <html data-vt> 上，供样式层的 ::view-transition-* 规则选择。
 *
 * expand/collapse 与 expand-fab/collapse-fab 必须分开：一次 expand 里只有真正在形变的
 * 那个共享元素该做淡入淡出，其余同名元素（例如打开详情时原地不动的悬浮按钮）必须保持
 * 静止——CSS 无法从选择器上区分「这次形变的是谁」，只能靠 data-vt 的取值区分。
 */
export type VtKind =
  | 'route-forward'
  | 'route-back'
  /** 列表行 / 引用项 ↔ 对话框 */
  | 'expand'
  | 'collapse'
  /** 悬浮按钮 ↔ 编辑器 */
  | 'expand-fab'
  | 'collapse-fab';

/** 共享元素名。同一时刻同名元素只能有一个，出现两个会让整个转场被浏览器跳过 */
export const VT_NAMES = {
  sheet: 'rtk-sheet',
  fab: 'rtk-fab',
  appBar: 'rtk-app-bar',
  bottomNav: 'rtk-bottom-nav',
  navDrawer: 'rtk-nav-drawer',
  /** 内容玻璃板：fixed 定位的壳层元素，换页时必须与其它壳层一样保持静止 */
  contentGlass: 'rtk-content-glass',
} as const;

/**
 * 壳层（AppBar / 底栏 / 抽屉）与悬浮按钮的持名标记属性：元素上只写
 * data-vt-shell="<VT_NAMES 里的名字>"，不直接写 view-transition-name。
 *
 * 何时真正持名由样式层（motion-styles）按 <html data-vt> 的种类决定：
 * - 换页（route-*）：壳层与悬浮按钮全部持名，各自交叉淡化、保持静止；
 * - 打开 / 关闭详情（expand / collapse）：一律不持名——它们必须留在 root 快照里，
 *   才能被 Dialog 遮罩一起压暗；若单独成组就会浮在遮罩之上，直到转场结束瞬间才被
 *   压暗，看起来就是遮罩「闪一下」；
 * - 悬浮按钮另在 expand-fab / collapse-fab 时持名（它自己形变成编辑器）。
 */
export const VT_SHELL_ATTR = 'data-vt-shell';

/** 给壳层元素打标记用的 JSX 属性对象：{...shellAttr(VT_NAMES.appBar)} */
export function shellAttr(name: string): { [VT_SHELL_ATTR]: string } {
  return { [VT_SHELL_ATTR]: name };
}

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
  // 转场被跳过时（文档不可见、被后一次转场打断）ready 会 reject。DOM 更新照常完成，
  // 不是错误，但不接住就会变成控制台里的 Uncaught (in promise)。
  transition.ready.catch(() => undefined);
  return transition.finished
    .catch(() => undefined)
    .then(() => {
      if (latestToken === token) root.removeAttribute(VT_ATTR);
    });
}
