// runViewTransition 测试：jsdom 默认没有 document.startViewTransition，浏览器不支持时
// 必须退化为同步更新且不写 data-vt；stub 该 API 后验证标记（data-vt）的写入/清理、
// reduced 时不调用转场、竞态下旧转场不得抹掉后一次的方向标记、finished reject 不向上抛。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { runViewTransition, VT_ATTR } from '../src/lib/view-transition';

// jsdom 运行时不实现 startViewTransition（TS DOM lib 有类型、运行时没有），
// 用可选属性 cast 后直接赋值 / 删除来 stub 与还原
const vtDoc = () => document as unknown as { startViewTransition?: unknown };

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason?: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface InstalledStub {
  created: Deferred[];
  fn: ReturnType<typeof vi.fn>;
}

/**
 * stub document.startViewTransition：同步调用传入的回调，返回带
 * finished / ready / updateCallbackDone 三个 Promise 的对象（finished 由测试手动 resolve）。
 */
function installStartViewTransition(): InstalledStub {
  const created: Deferred[] = [];
  const fn = vi.fn((callback: () => void) => {
    const d = deferred();
    created.push(d);
    callback();
    return {
      finished: d.promise,
      ready: Promise.resolve(),
      updateCallbackDone: Promise.resolve(),
    };
  });
  vtDoc().startViewTransition = fn;
  return { created, fn };
}

afterEach(() => {
  delete vtDoc().startViewTransition;
  document.documentElement.removeAttribute(VT_ATTR);
});

describe('runViewTransition', () => {
  it('浏览器不支持（jsdom 默认无 startViewTransition）：同步执行 update、Promise resolve、不写 data-vt', async () => {
    expect(typeof document.startViewTransition).toBe('undefined');
    const update = vi.fn();
    const result = runViewTransition('route-forward', update);
    // update 在调用返回前就已同步执行
    expect(update).toHaveBeenCalledTimes(1);
    expect(document.documentElement.getAttribute(VT_ATTR)).toBeNull();
    await expect(result).resolves.toBeUndefined();
    expect(document.documentElement.getAttribute(VT_ATTR)).toBeNull();
  });

  it('reduced=true 时即使支持 View Transitions 也不调用它，直接执行 update', async () => {
    const { fn } = installStartViewTransition();
    const update = vi.fn();
    const result = runViewTransition('expand', update, true);
    expect(fn).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(document.documentElement.getAttribute(VT_ATTR)).toBeNull();
    await expect(result).resolves.toBeUndefined();
    expect(document.documentElement.getAttribute(VT_ATTR)).toBeNull();
  });

  it('支持时：update 在转场回调内执行、期间 data-vt 为传入 kind、finished 后清除', async () => {
    const { created } = installStartViewTransition();
    const update = vi.fn(() => {
      // update 执行（flushSync 提交）时标记必须已在 <html> 上
      expect(document.documentElement.getAttribute(VT_ATTR)).toBe('route-forward');
    });
    const result = runViewTransition('route-forward', update);
    expect(created).toHaveLength(1);
    expect(update).toHaveBeenCalledTimes(1);
    // 转场进行中（finished 未 resolve）：标记保持在 <html> 上
    expect(document.documentElement.getAttribute(VT_ATTR)).toBe('route-forward');
    created[0].resolve();
    await expect(result).resolves.toBeUndefined();
    expect(document.documentElement.getAttribute(VT_ATTR)).toBeNull();
  });

  it('竞态：先发起的转场结束时不会抹掉后一次转场的 data-vt', async () => {
    const { created } = installStartViewTransition();
    const update1 = vi.fn();
    const update2 = vi.fn();
    // 第一次转场进行中立即发起第二次
    const first = runViewTransition('route-forward', update1);
    const second = runViewTransition('route-back', update2);
    expect(created).toHaveLength(2);
    expect(document.documentElement.getAttribute(VT_ATTR)).toBe('route-back');
    // 第一次先结束：它的清理回调应认出自己已过期，不能删掉第二次写的标记
    created[0].resolve();
    await first;
    expect(document.documentElement.getAttribute(VT_ATTR)).toBe('route-back');
    created[1].resolve();
    await second;
    expect(document.documentElement.getAttribute(VT_ATTR)).toBeNull();
    expect(update1).toHaveBeenCalledTimes(1);
    expect(update2).toHaveBeenCalledTimes(1);
  });

  it('finished reject 时不抛出，Promise 照常 resolve 且标记被清除', async () => {
    const { created } = installStartViewTransition();
    const update = vi.fn();
    const result = runViewTransition('route-back', update);
    expect(document.documentElement.getAttribute(VT_ATTR)).toBe('route-back');
    created[0].reject(new Error('transition aborted'));
    await expect(result).resolves.toBeUndefined();
    expect(document.documentElement.getAttribute(VT_ATTR)).toBeNull();
  });
});
