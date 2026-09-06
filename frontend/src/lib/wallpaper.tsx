// 壁纸：用户上传的本地背景图，localStorage 持久化（本机独占，不传后端，也不引图像库——
// 压缩用浏览器原生 createImageBitmap + canvas）。
// 状态模型照 src/lib/list-cache.ts：模块级状态 + useSyncExternalStore 订阅。不做 React
// Context Provider——App.tsx 归壳层另一路，这里不能被 Provider 包裹。
//
// 图源以 CSS 变量（WALLPAPER_VAR）写到 <html>，body 背景由主题层消费：主题层在图上叠
// 驯化层纸色，图再被顶栏（chrome）与内容玻璃板（panel）各模糊一次——整页只允许这两次
// backdrop 读回。

import { useSyncExternalStore } from 'react';
import { WALLPAPER_VAR } from './glass';

/** localStorage 存储键。index.html 的首帧内联脚本在模块系统之外只能手抄同一份
 *  （那边不能 import 常量），tests/wallpaper.test.tsx 会断言两处一致。 */
export const WALLPAPER_STORAGE_KEY = 'rakkotasks.wallpaper';

/** 压缩上限：最长边 1920px，等比缩放、比 1920 小的不放大；JPEG 质量 0.75。
 *  可以压这么狠：壁纸身后还要被玻璃模糊一遍，清晰度不敏感；而 localStorage 只有
 *  5MB 上限，data URL 的 base64 还要再膨胀三分之一。 */
const MAX_EDGE = 1920;
const JPEG_QUALITY = 0.75;

// —— 模块级状态 + 订阅（模式同 src/lib/list-cache.ts）——
let current: string | null = null;
const listeners = new Set<() => void>();
/** 通知全部订阅者 */
const emit = (): void => listeners.forEach((listener) => listener());
/** useSyncExternalStore 的订阅接口；模块级函数引用稳定，不会反复重订阅 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 把壁纸图源同步到 <html> 的 CSS 变量（null 表示清除，变量置 'none'） */
function applyToRoot(dataUrl: string | null): void {
  const root = document.documentElement;
  root.style.setProperty(WALLPAPER_VAR, dataUrl === null ? 'none' : `url("${dataUrl}")`);
}

/** 同步读 localStorage 里的壁纸 data URL；读失败（隐私模式等）返回 null */
export function readWallpaper(): string | null {
  try {
    return localStorage.getItem(WALLPAPER_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * 写壁纸：dataUrl 为 null 表示移除。先持久化，成功后才改内存态与 <html> 变量并通知
 * 订阅者——localStorage 写入超配额会抛 QuotaExceededError（隐私模式连读都抛），必须
 * try/catch 并原样重抛，让调用方提示用户。这与 theme-mode 的「写失败静默降级」不同：
 * 壁纸写不进去等于功能没生效，静默掉用户永远不知道。
 */
export function setWallpaper(dataUrl: string | null): void {
  try {
    if (dataUrl === null) localStorage.removeItem(WALLPAPER_STORAGE_KEY);
    else localStorage.setItem(WALLPAPER_STORAGE_KEY, dataUrl);
  } catch (error) {
    throw error;
  }
  current = dataUrl;
  applyToRoot(dataUrl);
  emit();
}

/** 压缩壁纸为 JPEG data URL（上限见文件头的 MAX_EDGE / JPEG_QUALITY） */
export async function compressWallpaper(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    // 只缩不放：长边不超过 1920 的图保持原尺寸
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('canvas 2d 上下文不可用');
    ctx.drawImage(bitmap, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  } finally {
    bitmap.close();
  }
}

/** 订阅当前壁纸 data URL（无壁纸为 null）；写后所有订阅者随 setWallpaper 的 emit 更新 */
export function useWallpaper(): string | null {
  return useSyncExternalStore(subscribe, () => current);
}

// —— 模块加载兜底：把 localStorage 里已有的壁纸同步到 <html> ——
// 幂等：index.html 的内联脚本在 React 挂载前已经做过一次，这里是给热更新（模块被重新
// 执行）与测试环境（没跑内联脚本）补上，避免两处状态分叉。
current = readWallpaper();
applyToRoot(current);
