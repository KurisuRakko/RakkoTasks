// clipboard 工具测试：ClipboardItem 主路径 / writeText 回退 / 剪贴板不可用时 reject。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from '../src/lib/clipboard';

// 记录模块加载时环境里是否有 ClipboardItem 与 navigator.clipboard，用例结束后恢复原状
const hadClipboardItem = 'ClipboardItem' in globalThis;
const originalClipboardItem = (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
const originalClipboardDesc = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

/** 可被 new 构造的 ClipboardItem 替身：record 构造函数参数，供断言数据通路 */
class MockClipboardItem {
  constructor(
    public readonly data: Record<string, Promise<Blob>>,
    public readonly types: string[] = Object.keys(data),
  ) {}
}

function stubClipboard(clipboard: unknown): void {
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
}

function restoreClipboard(): void {
  if (originalClipboardDesc) {
    Object.defineProperty(navigator, 'clipboard', originalClipboardDesc);
  } else {
    delete (navigator as { clipboard?: unknown }).clipboard;
  }
  if (hadClipboardItem && originalClipboardItem !== undefined) {
    Object.defineProperty(globalThis, 'ClipboardItem', {
      value: originalClipboardItem,
      configurable: true,
      writable: true,
    });
  } else {
    delete (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  restoreClipboard();
});

// jsdom 的 Blob 没有 .text()/arrayBuffer()，用 FileReader 读出内容（两种实现都兼容）
function blobToText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsText(blob);
  });
}

describe('copyText', () => {
  it('有 ClipboardItem 且 clip.write 可用时：write 一次、不调 writeText，Blob 内容为 getText 结果', async () => {
    vi.stubGlobal('ClipboardItem', MockClipboardItem);
    const write = vi.fn(async (_items: unknown[]) => undefined);
    const writeText = vi.fn(async () => undefined);
    stubClipboard({ write, writeText });

    await copyText(async () => 'hello');

    expect(write).toHaveBeenCalledTimes(1);
    expect(writeText).not.toHaveBeenCalled();
    const items = write.mock.calls[0][0] as unknown as MockClipboardItem[];
    expect(items).toHaveLength(1);
    expect(items[0]).toBeInstanceOf(MockClipboardItem);
    const blob = await items[0].data['text/plain'];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('text/plain');
    expect(await blobToText(blob)).toBe('hello');
  });

  it('没有 ClipboardItem 时回退 clip.writeText，收到 getText 的字符串', async () => {
    delete (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
    const writeText = vi.fn(async () => undefined);
    stubClipboard({ writeText });

    await copyText(async () => 'plain text');

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('plain text');
  });

  it('navigator.clipboard 不可用时 reject', async () => {
    stubClipboard(undefined);

    await expect(copyText(async () => 'x')).rejects.toThrow('clipboard_unavailable');
  });
});
