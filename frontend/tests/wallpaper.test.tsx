// wallpaper 测试：
// - setWallpaper 双向：写 localStorage + <html> 的 WALLPAPER_VAR（url("...") / none）；
// - 失败路径：readWallpaper 在 getItem 抛异常时返回 null；setWallpaper 在 setItem 抛
//   QuotaExceededError 时错误向外抛——壁纸写不进去等于功能没生效，必须让调用方能提示
//   用户（与 theme-mode 的静默降级相反）；
// - useWallpaper 在 setWallpaper 之后重渲染拿到新值（模块级订阅模式）；
// - index.html 首帧内联脚本在模块系统之外只能手抄存储键与变量名，断言它与 lib 常量一致；
// - compressWallpaper：jsdom 跑不了真 canvas，只测错误路径 reject（stub createImageBitmap），
//   不给生产代码加测试专用分支。
// index.html 用 ?raw 读文本：tests 无 node 类型（同 motion-styles.test.ts 的做法），
// node:fs 在此环境 typecheck 过不了。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { WALLPAPER_VAR } from '../src/lib/glass';
import {
  compressWallpaper,
  readWallpaper,
  setWallpaper,
  useWallpaper,
  WALLPAPER_STORAGE_KEY,
} from '../src/lib/wallpaper';
import htmlSource from '../index.html?raw';

const FAKE = 'data:image/jpeg;base64,AAAA';

beforeEach(() => {
  localStorage.clear();
  // 模块内存态与 DOM 变量同步回「无壁纸」，防用例之间串扰
  setWallpaper(null);
});

afterEach(() => {
  cleanup();
  setWallpaper(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('setWallpaper / readWallpaper 持久化', () => {
  it('setWallpaper 写入 localStorage，并把 <html> 的 --rtk-wallpaper 设成 url("...")；传 null 时清掉 localStorage 且变量变成 none', () => {
    setWallpaper(FAKE);
    expect(localStorage.getItem(WALLPAPER_STORAGE_KEY)).toBe(FAKE);
    expect(document.documentElement.style.getPropertyValue(WALLPAPER_VAR)).toBe(`url("${FAKE}")`);

    setWallpaper(null);
    expect(localStorage.getItem(WALLPAPER_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.style.getPropertyValue(WALLPAPER_VAR)).toBe('none');
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
    expect(document.documentElement.style.getPropertyValue(WALLPAPER_VAR)).toBe('none');
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
});

describe('index.html 首帧脚本与 lib 常量一致', () => {
  it('内联脚本手抄的存储键与变量名与 src/lib/wallpaper.tsx 的常量一致', () => {
    // 内联脚本在模块系统之外无法 import 常量；两处不一致时首帧上屏会失效
    expect(htmlSource).toContain(WALLPAPER_STORAGE_KEY);
    expect(htmlSource).toContain(WALLPAPER_VAR);
  });
});

describe('compressWallpaper 错误路径', () => {
  it('createImageBitmap 失败时 reject（jsdom 跑不了真解码与画布输出）', async () => {
    const decode = vi.fn().mockRejectedValue(new Error('decode failed'));
    vi.stubGlobal('createImageBitmap', decode);
    const file = new File(['x'], 'photo.jpg', { type: 'image/jpeg' });
    await expect(compressWallpaper(file)).rejects.toThrow('decode failed');
    expect(decode).toHaveBeenCalledWith(file);
  });
});

describe('脏值形状校验（url() 逃逸防御）', () => {
  // 值的实际来源是 localStorage，不受控（用户手改 / 同源脚本可写）；含 " 与 ) 的假值
  // 能逃出 url("...")。校验挡掉后按没有壁纸处理，不抛错。
  const DIRTY = 'data:image/jpeg;base64,AA")AA';

  it('脏值不当作壁纸：readWallpaper 返回 null；模块兜底与 applyToRoot 都置 none；正常值照常写出', async () => {
    // 直接往 localStorage 塞脏值，模拟存储被外部写入
    localStorage.setItem(WALLPAPER_STORAGE_KEY, DIRTY);
    expect(readWallpaper()).toBeNull();

    // 模块加载兜底：重放「import 时 localStorage 已是脏值」——顶层
    // readWallpaper → applyToRoot 不把脏值写到 <html>（动态重载出新模块实例验证）
    vi.resetModules();
    const mod = await import('../src/lib/wallpaper');
    expect(mod.readWallpaper()).toBeNull();
    expect(document.documentElement.style.getPropertyValue(WALLPAPER_VAR)).toBe('none');

    // setWallpaper 走同一 applyToRoot：脏值按没有壁纸处理（置 none），不抛错
    setWallpaper(DIRTY);
    expect(document.documentElement.style.getPropertyValue(WALLPAPER_VAR)).toBe('none');

    // 正常的 data:image/jpeg;base64 仍然照常写出 url("...")
    setWallpaper(FAKE);
    expect(localStorage.getItem(WALLPAPER_STORAGE_KEY)).toBe(FAKE);
    expect(document.documentElement.style.getPropertyValue(WALLPAPER_VAR)).toBe(`url("${FAKE}")`);
  });
});
