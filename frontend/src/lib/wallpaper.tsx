// 壁纸：用户上传的本地背景图，localStorage 持久化（本机独占，不传后端）。取景交互用
// react-easy-crop，解码与压缩仍是浏览器原生 <img> + canvas。
// 状态模型照 src/lib/list-cache.ts：模块级状态 + useSyncExternalStore 订阅。不做 React
// Context Provider——App.tsx 归壳层另一路，这里不能被 Provider 包裹。
//
// 图源以 CSS 变量（WALLPAPER_VAR）写到 <html>，body 背景由主题层消费：主题层在图上叠
// 驯化层纸色，图再被顶栏（chrome）与内容玻璃板（panel）各模糊一次——整页只允许这两次
// backdrop 读回。

import { useSyncExternalStore } from 'react';
import { WALLPAPER_ATTR, WALLPAPER_VAR } from './glass';

/** localStorage 存储键。index.html 的首帧内联脚本在模块系统之外只能手抄同一份
 *  （那边不能 import 常量），tests/wallpaper.test.tsx 会断言两处一致。 */
export const WALLPAPER_STORAGE_KEY = 'rakkotasks.wallpaper';

/** 压缩上限：裁剪区域的最长边 1920px，等比缩放、比 1920 小的不放大；JPEG 质量 0.75。
 *  可以压这么狠：壁纸身后还要被玻璃模糊一遍，清晰度不敏感；而 localStorage 只有
 *  5MB 上限，data URL 的 base64 还要再膨胀三分之一。 */
const MAX_EDGE = 1920;
const JPEG_QUALITY = 0.75;

/** data URL 形状校验。值的实际来源是 localStorage，不受控——用户能手改、同源的任何
 *  脚本也能写；含 " 或 ) 的值能逃出 url("...") 往 <html> 的 style 里注入别的 CSS 声明
 *  （危害有限，CSS 注入不执行 JS，但本项目对注入面敏感）。只放行 data:image 的
 *  base64 值；不匹配一律当作没有壁纸。 */
const SAFE_DATA_URL = /^data:image\/[a-z+.-]+;base64,[A-Za-z0-9+/=]+$/;

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

/** 把壁纸图源同步到 <html> 的 CSS 变量：形状不符的脏值按没有壁纸处理（置 'none'），
 *  不抛错——localStorage 里是脏数据不该让整个应用崩掉 */
function applyToRoot(dataUrl: string | null): void {
  const root = document.documentElement;
  const safe = dataUrl !== null && SAFE_DATA_URL.test(dataUrl);
  root.style.setProperty(WALLPAPER_VAR, safe ? `url("${dataUrl}")` : 'none');
  // 属性标记跟 safe 同一判定（脏值同样算没有壁纸），由主题层用
  // :root:not([data-wallpaper]) 消费：没有壁纸时玻璃身后没有图像可透，透镜渐变与
  // 内侧高光只剩无来由的光泽，应被禁用。
  root.toggleAttribute(WALLPAPER_ATTR, safe);
}

/** 同步读 localStorage 里的壁纸 data URL；读失败（隐私模式等）或形状不符返回 null */
export function readWallpaper(): string | null {
  try {
    const raw = localStorage.getItem(WALLPAPER_STORAGE_KEY);
    return raw !== null && SAFE_DATA_URL.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * 写壁纸：dataUrl 为 null 表示移除。先持久化，成功后才改内存态与 <html> 变量并通知
 * 订阅者。这里刻意不接异常：localStorage 写入超配额会抛 QuotaExceededError（隐私模式
 * 连 setItem 都直接抛），让它自然冒泡到调用方去提示用户——这与 theme-mode 的
 * 「写失败静默降级」不同：壁纸写不进去等于功能没生效，静默掉用户永远不知道。
 */
export function setWallpaper(dataUrl: string | null): void {
  if (dataUrl === null) localStorage.removeItem(WALLPAPER_STORAGE_KEY);
  else localStorage.setItem(WALLPAPER_STORAGE_KEY, dataUrl);
  current = dataUrl;
  applyToRoot(dataUrl);
  emit();
}

/** 裁剪区域，单位是原图像素（与 react-easy-crop 的 croppedAreaPixels 同形，但本模块不依赖它的类型） */
export interface WallpaperArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 选中的图片解码成功后的来源：url 是 object URL，调用方负责在不再需要时 revoke */
export interface WallpaperSource {
  url: string;
  image: HTMLImageElement;
}

/** 选中图片 → 可裁剪的来源。解码失败时把 object URL 一并撤掉（调用方拿不到它，只能在这里
 *  释放），错误照原样往外抛 */
export async function loadWallpaperSource(file: Blob): Promise<WallpaperSource> {
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  return { url, image };
}

/** 裁剪区域 → JPEG data URL（上限见 MAX_EDGE / JPEG_QUALITY）。
 *  画的是 HTMLImageElement 而不是另解一份位图：裁剪器用 <img> 显示，按
 *  naturalWidth/naturalHeight 算出 area；绘制走同一个 <img> 的解码结果，两边坐标系天然一致。 */
export function renderWallpaper(image: HTMLImageElement, area: WallpaperArea): string {
  // 只缩不放：裁剪区域最长边不超过 1920 的保持原尺寸
  const scale = Math.min(1, MAX_EDGE / Math.max(area.width, area.height));
  const width = Math.max(1, Math.round(area.width * scale));
  const height = Math.max(1, Math.round(area.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('canvas 2d 上下文不可用');
  // 源矩形越界交给 drawImage 按规范裁剪，这里不夹取
  ctx.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
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
