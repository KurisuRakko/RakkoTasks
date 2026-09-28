// @vitest-environment node
// 玻璃样式表过一遍真实压缩器（esbuild，Vite 构建默认的 CSS 压缩器）。
//
// 文本断言（glass-contract.test.ts）只读源码，挡不住「注释里意外拼出 */ 把紧随的规则吞掉」：
// 那种情况 esbuild 只报一条警告、构建照样成功，而被吞掉的恰好可能是整套玻璃的模糊来源。
// 所以这里断言压缩零警告，并确认关键声明在产物里仍然在位。
//
// 必须跑在 node 环境：jsdom 下 vitest 替换了全局对象，esbuild 的 TextEncoder / Uint8Array
// 跨 realm 自检会失败。esbuild 与 node:fs 都走 vi.importActual，理由同 glass-contract 文件头
// （tests 没有 node 类型声明，静态 import 会报类型错误）。

import { describe, expect, it, vi } from 'vitest';

type FsLike = { readFileSync: (path: string, encoding: 'utf-8') => string };
type EsbuildLike = {
  transformSync: (
    input: string,
    options: { loader: 'css'; minify: boolean },
  ) => { code: string; warnings: { text: string }[] };
};

async function minifiedGlassCss() {
  const fs = (await vi.importActual('node:fs')) as FsLike;
  const esbuild = (await vi.importActual('esbuild')) as EsbuildLike;
  const source = fs.readFileSync('src/rakko-glass.css', 'utf-8');
  return esbuild.transformSync(source, { loader: 'css', minify: true });
}

describe('rakko-glass.css 压缩产物', () => {
  it('压缩零警告（注释提前闭合、残缺选择器都会在这里报出来）', async () => {
    const { warnings } = await minifiedGlassCss();
    expect(warnings.map((w) => w.text)).toEqual([]);
  });

  it('关键声明在产物里仍然在位', async () => {
    const { code } = await minifiedGlassCss();
    // 整套玻璃的模糊来源
    expect(code).toContain('backdrop-filter:blur(var(--glass-blur)) saturate(var(--glass-saturate))');
    // 深色顶边受光：回退到 --glass-rim 的那一层没被吞掉，且仍排在 border 简写之后
    // （esbuild 保留 var() 回退值逗号后的空格）
    const shorthand = code.indexOf('border:1px solid var(--glass-rim);');
    const top = code.indexOf('border-top-color:var(--glass-rim-top, var(--glass-rim))');
    expect(shorthand).toBeGreaterThan(-1);
    expect(top).toBeGreaterThan(shorthand);
  });
});
