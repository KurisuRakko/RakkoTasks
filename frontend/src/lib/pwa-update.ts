// PWA 新版本检查。iOS 主屏 PWA 常驻后不会自行复查 Service Worker，也不会重载
// 页面，autoUpdate 因此形同虚设：这里主动周期性检查（含回到前台 / 恢复联网时），
// 发现新版本直接激活并重载页面（产品决定：不做更新提示条），唯一守住的是用户
// 正在输入的内容。

import { registerSW } from 'virtual:pwa-register';

/** 常驻时每 30 分钟检查一次新版 */
const CHECK_INTERVAL_MS = 30 * 60 * 1000;
/** 回到前台 / 恢复联网时，距上次检查至少 1 分钟才再查 */
const MIN_GAP_MS = 60 * 1000;

let started = false; // 模块级守卫：setupPwaUpdate 与 DOM 监听只生效一次
let reg: ServiceWorkerRegistration | null = null;
let updateSW: ((reloadPage?: boolean) => Promise<void>) | null = null;
let lastCheckAt = 0;
/** 发现新版但用户正在输入：挂起重载，等焦点离开或页面可见性变化后再执行 */
let pendingReload = false;

/** 真正发起一次检查并记录时间（所有入口共用，节流按它计算） */
function performCheck(): void {
  if (!reg) return;
  lastCheckAt = Date.now();
  void reg.update();
}

/** 节流后的检查：距上次检查 ≥ MIN_GAP_MS 才发起 */
function maybeCheck(): void {
  if (!reg || Date.now() - lastCheckAt < MIN_GAP_MS) return;
  performCheck();
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') maybeCheck();
}

function onOnline(): void {
  if (navigator.onLine) maybeCheck();
}

/**
 * 发现新版：直接重载是产品决定，唯一例外是用户正把焦点放在 INPUT / TEXTAREA
 * 上（正在输入）——挂起执行，等一次 focusout 或 visibilitychange 视为输入结束。
 */
function applyUpdate(): void {
  if (!updateSW || pendingReload) return;
  const active = document.activeElement;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
    pendingReload = true;
    const el = active as HTMLElement;
    const reloadLater = () => {
      pendingReload = false;
      el.removeEventListener('focusout', reloadLater);
      document.removeEventListener('visibilitychange', reloadLater);
      void updateSW?.(true);
    };
    el.addEventListener('focusout', reloadLater);
    document.addEventListener('visibilitychange', reloadLater);
  } else {
    void updateSW(true);
  }
}

/**
 * 注册 Service Worker 并启动周期 / 回前台 / 联网检查。入口调用一次即可；
 * 非浏览器或浏览器不支持 serviceWorker 时静默返回，重复调用无副作用。
 */
export function setupPwaUpdate(): void {
  if (started) return;
  if (
    typeof window === 'undefined' ||
    typeof navigator === 'undefined' ||
    !('serviceWorker' in navigator)
  ) {
    return;
  }
  started = true;
  updateSW = registerSW({
    immediate: true,
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      reg = registration;
      setInterval(performCheck, CHECK_INTERVAL_MS);
      document.addEventListener('visibilitychange', onVisibilityChange);
      window.addEventListener('online', onOnline);
    },
    onNeedRefresh() {
      applyUpdate();
    },
    onRegisterError(error) {
      // 注册失败不打断页面，只留日志
      console.warn('Service Worker 注册失败', error);
    },
  });
}

/**
 * 手动检查一次新版（设置页「检查更新」按钮用）。
 * @returns 是否真的发起了检查（SW 尚未注册时返回 false）
 */
export async function checkForUpdate(): Promise<boolean> {
  if (!reg) return false;
  performCheck();
  return true;
}
