// wallpaper 测试：
// - setWallpaper 双向：写 localStorage + <html> 的 WALLPAPER_VAR（url("用户图") / 默认图 url）；
// - 失败路径：readWallpaper 在 getItem 抛异常时返回 null；setWallpaper 在 setItem 抛
//   QuotaExceededError 时错误向外抛——壁纸写不进去等于功能没生效，必须让调用方能提示
//   用户（与 theme-mode 的静默降级相反）；
// - useWallpaper 在 setWallpaper 之后重渲染拿到新值（模块级订阅模式）；
// - 「没有壁纸」不是一种状态：null / 脏值都落到 DEFAULT_WALLPAPER_URL；
// - index.html 首帧内联脚本在模块系统之外只能手抄存储键、变量名与默认图地址，断言它与
//   lib 常量一致；
// - loadWallpaperSource / renderWallpaper：jsdom 既没有 HTMLImageElement.prototype.decode，
//   也没有 2d 画布实现，解码与绘制全靠 stub 驱动（stub object URL + mock decode + 假
//   canvas 上下文），不给生产代码加测试专用分支。
// index.html 用 ?raw 读文本：tests 无 node 类型（同 motion-styles.test.ts 的做法），
// node:fs 在此环境 typecheck 过不了。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import {
  DEFAULT_WALLPAPER_URL,
  WALLPAPER_LAYER_ID,
  WALLPAPER_VAR,
} from '../src/lib/glass';
import {
  loadWallpaperSource,
  readWallpaper,
  renderWallpaper,
  setWallpaper,
  useWallpaper,
  WALLPAPER_STORAGE_KEY,
} from '../src/lib/wallpaper';
import htmlSource from '../index.html?raw';

const FAKE = 'data:image/jpeg;base64,AAAA';

/** 默认壁纸写在 <html> 变量里的形状；用户没设过壁纸时变量就是这个值 */
const DEFAULT_URL_VALUE = `url("${DEFAULT_WALLPAPER_URL}")`;

/** 值的实际来源是 localStorage，不受控（用户手改 / 同源脚本可写）；含 " 与 ) 的假值
 *  能逃出 url("...")。校验挡掉后按「用户没设过壁纸」处理，回默认图，不抛错。 */
const DIRTY = 'data:image/jpeg;base64,AA")AA';

beforeEach(() => {
  localStorage.clear();
  // 模块内存态与 DOM 变量同步回「用户没设过壁纸」，防用例之间串扰
  setWallpaper(null);
});

afterEach(() => {
  cleanup();
  setWallpaper(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('setWallpaper / readWallpaper 持久化', () => {
  it('setWallpaper 写入 localStorage，并把 <html> 的 --rtk-wallpaper 设成 url("...")；传 null 时清掉 localStorage 且变量回默认壁纸', () => {
    setWallpaper(FAKE);
    expect(localStorage.getItem(WALLPAPER_STORAGE_KEY)).toBe(FAKE);
    expect(document.documentElement.style.getPropertyValue(WALLPAPER_VAR)).toBe(`url("${FAKE}")`);

    setWallpaper(null);
    expect(localStorage.getItem(WALLPAPER_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.style.getPropertyValue(WALLPAPER_VAR)).toBe(DEFAULT_URL_VALUE);
  });

  it('readWallpaper 读回刚写入的 data URL', () => {
    setWallpaper(FAKE);
    expect(readWallpaper()).toBe(FAKE);
  });

  it('readWallpaper 在 localStorage 抛异常时返回 null', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage denied');
    });
    expect(readWallpaper()).toBeNull();
  });

  it('setWallpaper 在 localStorage.setItem 抛 QuotaExceededError 时错误往外抛，且状态不变', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    expect(() => setWallpaper(FAKE)).toThrow('quota exceeded');
    // 写失败不得半途改内存态 / DOM 变量：调用方看到的是「没生效」
    vi.restoreAllMocks();
    expect(readWallpaper()).toBeNull();
    expect(document.documentElement.style.getPropertyValue(WALLPAPER_VAR)).toBe(DEFAULT_URL_VALUE);
  });
});

describe('useWallpaper 订阅', () => {
  it('setWallpaper 之后重渲染拿到新值，传 null 后回到 null', () => {
    const { result, rerender } = renderHook(() => useWallpaper());
    expect(result.current).toBeNull();

    act(() => setWallpaper(FAKE));
    rerender();
    expect(result.current).toBe(FAKE);

    act(() => setWallpaper(null));
    rerender();
    expect(result.current).toBeNull();
  });

  it('未设壁纸时返回值是 null 而不是默认图地址：默认图不进用户壁纸状态', () => {
    // 默认图由 applyToRoot 直接写到 <html>；若混进 useWallpaper，「恢复默认壁纸」
    // 在状态层就没有可表达的空值，调用方也无法区分用户图与默认图
    const { result } = renderHook(() => useWallpaper());
    expect(result.current).toBeNull();
    expect(document.documentElement.style.getPropertyValue(WALLPAPER_VAR)).toBe(DEFAULT_URL_VALUE);
  });
});

describe('index.html 首帧脚本与 lib 常量一致', () => {
  it('内联脚本手抄的存储键与变量名与 src/lib/wallpaper.tsx 的常量一致', () => {
    // 内联脚本在模块系统之外无法 import 常量；两处不一致时首帧上屏会失效
    expect(htmlSource).toContain(WALLPAPER_STORAGE_KEY);
    expect(htmlSource).toContain(WALLPAPER_VAR);
  });

  it('内联脚本手抄的默认壁纸地址与 DEFAULT_WALLPAPER_URL 一致', () => {
    // 没有用户壁纸时首帧就写默认图；地址两边不一致会变成 404 背景
    expect(htmlSource).toContain(DEFAULT_WALLPAPER_URL);
  });

  it('壁纸承载节点是 body 的第一个子节点（在 #root 之前），且全局只有一个', () => {
    // 承载层的 id 在 HTML 里只能手抄（常量 WALLPAPER_LAYER_ID，本文件在模块系统之外）；
    // 主题层按同一 id 下发地板样式，换页时的持名规则也按它命中
    expect(htmlSource).toContain(`id="${WALLPAPER_LAYER_ID}"`);
    const layerAt = htmlSource.indexOf(`id="${WALLPAPER_LAYER_ID}"`);
    const rootAt = htmlSource.indexOf('id="root"');
    expect(rootAt).toBeGreaterThan(-1);
    // 地板先于应用根存在：React 挂载与路由 churn 都不影响它
    expect(layerAt).toBeLessThan(rootAt);
    // 同一时刻同名元素只能有一个：出现两个会让整个 View Transition 被浏览器跳过
    expect(htmlSource.split(`id="${WALLPAPER_LAYER_ID}"`)).toHaveLength(2);
  });
});

describe('loadWallpaperSource', () => {
  const FILE = new File(['x'], 'photo.jpg', { type: 'image/jpeg' });
  const OBJECT_URL = 'blob:wallpaper-source';

  /** jsdom 没实现 HTMLImageElement.prototype.decode，没有可 spy 的原方法，只能补一个；
   *  本组 afterEach 把它删掉，不留痕。 */
  function stubDecode(impl: () => Promise<void>) {
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true,
      writable: true,
      value: vi.fn(impl),
    });
  }

  afterEach(() => {
    Reflect.deleteProperty(HTMLImageElement.prototype, 'decode');
  });

  it('解码失败：reject 原错误，并 revoke 同一个 object URL（不吞错、不泄漏 URL）', async () => {
    stubDecode(() => Promise.reject(new Error('decode failed')));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue(OBJECT_URL);
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    await expect(loadWallpaperSource(FILE)).rejects.toThrow('decode failed');
    expect(revoke).toHaveBeenCalledWith(OBJECT_URL);
  });

  it('解码成功：返回 object URL 与 src 指向它的 image，且不 revoke', async () => {
    stubDecode(() => Promise.resolve());
    vi.spyOn(URL, 'createObjectURL').mockReturnValue(OBJECT_URL);
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    const source = await loadWallpaperSource(FILE);
    expect(source.url).toBe(OBJECT_URL);
    expect(source.image.src).toBe(OBJECT_URL);
    expect(revoke).not.toHaveBeenCalled();
  });
});

describe('renderWallpaper', () => {
  /** 假的 2d 上下文：只记录 drawImage 的实参（jsdom 的 getContext('2d') 恒为 null） */
  function stubCanvas(): ReturnType<typeof vi.fn> {
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(FAKE);
    return drawImage;
  }

  it('裁剪区域 3000×1500：等比缩到最长边 1920，drawImage 的目标矩形是 0,0,1920,960', () => {
    const drawImage = stubCanvas();
    const image = document.createElement('img');

    expect(renderWallpaper(image, { x: 0, y: 0, width: 3000, height: 1500 })).toBe(FAKE);
    expect(drawImage.mock.calls[0].slice(-4)).toEqual([0, 0, 1920, 960]);
  });

  it('裁剪区域 800×600：只缩不放，目标矩形保持 0,0,800,600；源矩形按 area 原样传', () => {
    const drawImage = stubCanvas();
    const image = document.createElement('img');

    expect(renderWallpaper(image, { x: 40, y: 25, width: 800, height: 600 })).toBe(FAKE);
    expect(drawImage.mock.calls[0].slice(0, 5)).toEqual([image, 40, 25, 800, 600]);
    expect(drawImage.mock.calls[0].slice(-4)).toEqual([0, 0, 800, 600]);
  });

  it('getContext 返回 null 时抛错，不做无声输出', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const image = document.createElement('img');

    expect(() => renderWallpaper(image, { x: 0, y: 0, width: 800, height: 600 })).toThrow(
      'canvas 2d 上下文不可用',
    );
  });
});

describe('脏值形状校验（url() 逃逸防御）', () => {
  it('脏值不当作壁纸：readWallpaper 返回 null；模块兜底与 applyToRoot 都回默认壁纸；正常值照常写出', async () => {
    // 直接往 localStorage 塞脏值，模拟存储被外部写入
    localStorage.setItem(WALLPAPER_STORAGE_KEY, DIRTY);
    expect(readWallpaper()).toBeNull();

    // 模块加载兜底：重放「import 时 localStorage 已是脏值」——顶层
    // readWallpaper → applyToRoot 不把脏值写到 <html>（动态重载出新模块实例验证）
    vi.resetModules();
    const mod = await import('../src/lib/wallpaper');
    expect(mod.readWallpaper()).toBeNull();
    expect(document.documentElement.style.getPropertyValue(WALLPAPER_VAR)).toBe(DEFAULT_URL_VALUE);

    // setWallpaper 走同一 applyToRoot：脏值按「用户没设过壁纸」处理（回默认图），不抛错
    setWallpaper(DIRTY);
    expect(document.documentElement.style.getPropertyValue(WALLPAPER_VAR)).toBe(DEFAULT_URL_VALUE);

    // 正常的 data:image/jpeg;base64 仍然照常写出 url("...")
    setWallpaper(FAKE);
    expect(localStorage.getItem(WALLPAPER_STORAGE_KEY)).toBe(FAKE);
    expect(document.documentElement.style.getPropertyValue(WALLPAPER_VAR)).toBe(`url("${FAKE}")`);
  });
});
