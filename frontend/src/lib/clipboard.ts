// 剪贴板写入工具：见 copyText 文档。

/** 把 getText 的结果写入系统剪贴板。Safari 只允许在用户手势的同一调用栈内发起写入，
 *  所以优先用 ClipboardItem 传 Promise，让网络请求在手势内“挂起”而不失效；
 *  不支持 ClipboardItem 的环境退回 writeText。 */
export async function copyText(getText: () => Promise<string>): Promise<void> {
  const clip = navigator.clipboard;
  if (!clip) throw new Error('clipboard_unavailable');
  if (typeof ClipboardItem !== 'undefined' && typeof clip.write === 'function') {
    await clip.write([
      new ClipboardItem({
        'text/plain': getText().then((t) => new Blob([t], { type: 'text/plain' })),
      }),
    ]);
  } else {
    await clip.writeText(await getText());
  }
}
