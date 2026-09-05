// pwa-update 测试：mock virtual:pwa-register，用假 registration 验证
// 注册选项 / 回前台节流 / 30 分钟定时检查 / 输入保护 / 手动检查 / 重复调用守卫。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PwaUpdateModule = typeof import('../src/lib/pwa-update');
/** registerSW 被捕获的选项（onNeedRefresh 等回调在测试里手动触发） */
type CapturedOptions = {
  immediate?: boolean;
  onRegisteredSW?: (url: string, registration: unknown) => void;
  onNeedRefresh?: () => void;
  onRegisterError?: (error: unknown) => void;
};
type UpdateSwFn = (reloadPage?: boolean) => Promise<void>;

// vi.mock 提升到 import 之前执行：registerSW 捕获选项并返回 updateSW spy
const { registerSWMock, updateSWMock } = vi.hoisted(() => {
  const updateSWMock = vi.fn<UpdateSwFn>();
  const registerSWMock = vi.fn<(options: CapturedOptions) => UpdateSwFn>(() => updateSWMock);
  return { registerSWMock, updateSWMock };
});

vi.mock('virtual:pwa-register', () => ({ registerSW: registerSWMock }));

let mod: PwaUpdateModule;
let options: CapturedOptions;

function fakeRegistration() {
  return { update: vi.fn() };
}

/** 调 setupPwaUpdate、取出捕获的选项并触发 onRegisteredSW，返回假 registration */
function setupRegistered(): { update: ReturnType<typeof vi.fn> } {
  mod.setupPwaUpdate();
  options = registerSWMock.mock.calls[0][0];
  const registration = fakeRegistration();
  options.onRegisteredSW?.('sw.js', registration);
  return registration;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  // 每次 import 全新模块实例，清掉上一测的 reg/interval/DOM 监听状态
  vi.resetModules();
  registerSWMock.mockImplementation(() => updateSWMock);
  // jsdom 无 serviceWorker：补一个属性让环境守卫放行（registerSW 已被 mock，用不到它）
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {} });
  // jsdom 默认可见性状态不确定，显式固定为可见
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  mod = await import('../src/lib/pwa-update');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('setupPwaUpdate', () => {
  it('以 immediate:true 调用 registerSW 并挂上各回调', () => {
    mod.setupPwaUpdate();
    expect(registerSWMock).toHaveBeenCalledTimes(1);
    const opts = registerSWMock.mock.calls[0][0];
    expect(opts.immediate).toBe(true);
    expect(typeof opts.onRegisteredSW).toBe('function');
    expect(typeof opts.onNeedRefresh).toBe('function');
    expect(typeof opts.onRegisterError).toBe('function');
  });

  it('回到前台触发检查，1 分钟内的再次触发被节流', () => {
    const registration = setupRegistered();

    document.dispatchEvent(new Event('visibilitychange'));
    expect(registration.update).toHaveBeenCalledTimes(1);

    // 同一分钟内再次回前台：不再发起
    document.dispatchEvent(new Event('visibilitychange'));
    expect(registration.update).toHaveBeenCalledTimes(1);

    // 超过 MIN_GAP（1 分钟）后再回前台：重新发起
    vi.advanceTimersByTime(60 * 1000 + 1);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(registration.update).toHaveBeenCalledTimes(2);
  });

  it('30 分钟定时器到点触发检查', () => {
    const registration = setupRegistered();
    expect(registration.update).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(registration.update).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(registration.update).toHaveBeenCalledTimes(2);
  });

  it('onNeedRefresh 且无输入焦点时立即 updateSW(true)', () => {
    setupRegistered();
    options.onNeedRefresh?.();
    expect(updateSWMock).toHaveBeenCalledTimes(1);
    expect(updateSWMock).toHaveBeenCalledWith(true);
  });

  it('onNeedRefresh 时 TEXTAREA 处于焦点则延后，focusout 后只执行一次', () => {
    setupRegistered();
    const textarea = document.createElement('textarea');
    const activeSpy = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(textarea);

    options.onNeedRefresh?.();
    expect(updateSWMock).not.toHaveBeenCalled();

    textarea.dispatchEvent(new Event('focusout'));
    expect(updateSWMock).toHaveBeenCalledTimes(1);
    expect(updateSWMock).toHaveBeenCalledWith(true);

    // 再触发一次 focusout：一次性监听已移除，不重复重载
    textarea.dispatchEvent(new Event('focusout'));
    expect(updateSWMock).toHaveBeenCalledTimes(1);
    activeSpy.mockRestore();
  });

  it('重复调用 setupPwaUpdate 只注册一次 registerSW', () => {
    mod.setupPwaUpdate();
    mod.setupPwaUpdate();
    expect(registerSWMock).toHaveBeenCalledTimes(1);
  });
});

describe('checkForUpdate', () => {
  it('SW 未注册时返回 false，注册后返回 true 并触发 registration.update', async () => {
    await expect(mod.checkForUpdate()).resolves.toBe(false);

    const registration = setupRegistered();
    await expect(mod.checkForUpdate()).resolves.toBe(true);
    expect(registration.update).toHaveBeenCalledTimes(1);
  });
});
