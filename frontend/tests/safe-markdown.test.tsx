// SafeMarkdown 测试：LLM 产出的 Markdown 必须经它渲染——
// 图片是唯一零点击发起外部请求的元素，必须在渲染侧封死；
// 危险协议链接不得带出；正常链接保留并加 rel 防护；
// 版式上代码块的横向溢出由 <pre> 自己在框内吸收，不传给外层容器。

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import SafeMarkdown from '../src/components/SafeMarkdown';
import { allStyleText, ownRules } from './glass-text-contrast.test-utils';

afterEach(() => {
  cleanup();
});

describe('SafeMarkdown 渲染', () => {
  it('不渲染图片：![x](https://evil.com/a.png) 不会产生 img 元素', () => {
    const { container } = render(
      <SafeMarkdown>{'![x](https://evil.com/a.png)'}</SafeMarkdown>,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).not.toContain('evil.com');
  });

  it('javascript: 协议的链接不带出危险 href', () => {
    const { container } = render(
      <SafeMarkdown>{'[link](javascript:alert(1))'}</SafeMarkdown>,
    );
    const a = container.querySelector('a');
    expect(a).not.toBeNull();
    expect(a!.getAttribute('href')).not.toMatch(/^javascript:/i);
    expect(a!.getAttribute('href')).not.toContain('javascript');
  });

  it('正常链接 href 正确，且带 target="_blank" 与包含 noopener 的 rel', () => {
    const { container } = render(
      <SafeMarkdown>{'[GitHub](https://github.com)'}</SafeMarkdown>,
    );
    const a = container.querySelector('a');
    expect(a).not.toBeNull();
    expect(a!.getAttribute('href')).toBe('https://github.com');
    expect(a!.getAttribute('target')).toBe('_blank');
    expect(a!.getAttribute('rel')).toContain('noopener');
  });

  it('普通文本与加粗正常渲染', () => {
    const { container } = render(
      <SafeMarkdown>{'普通文本与 **加粗** 内容'}</SafeMarkdown>,
    );
    expect(container.textContent).toContain('普通文本与');
    expect(container.textContent).toContain('加粗');
    expect(container.querySelector('strong')).not.toBeNull();
  });

  it('breaks=true 时单个换行渲染为 <br>', () => {
    const { container } = render(<SafeMarkdown breaks>{'a\nb'}</SafeMarkdown>);
    expect(container.querySelector('br')).not.toBeNull();
    expect(container.textContent).toContain('a');
    expect(container.textContent).toContain('b');
  });

  it('默认（breaks 未开）单个换行不渲染 <br>', () => {
    const { container } = render(<SafeMarkdown>{'a\nb'}</SafeMarkdown>);
    expect(container.querySelector('br')).toBeNull();
  });
});

describe('SafeMarkdown 版式', () => {
  it('代码块自己横滑：<pre> 自带 overflow-x:auto', () => {
    // 200 字符无空格长行：<pre> 的 white-space: pre 不折行，正文的 overflow-wrap
    // 也管不到它，宽度只能由代码块自己吸收（在自身框内横滑）
    const { container } = render(
      <SafeMarkdown>{`\`\`\`\n${'x'.repeat(200)}\n\`\`\``}</SafeMarkdown>,
    );

    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();

    const rule = ownRules(allStyleText(), pre!);
    expect(rule, '<pre> 没读到自身的 css-* 规则，下面的断言会空转').not.toBe('');
    expect(rule, '代码块在自身框内横滑，不把宽度传给外层').toContain('overflow-x:auto');
  });
});

describe('react-markdown 使用范围', () => {
  it('src/ 下除 SafeMarkdown.tsx 外没有任何文件 import react-markdown', () => {
    // Vite ?raw glob：把 src 下全部 ts/tsx 源码读进来做断言检查
    const srcFiles = import.meta.glob('../src/**/*.{ts,tsx}', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    const hits = Object.entries(srcFiles)
      .filter(([, content]) => /from\s+['"]react-markdown['"]/.test(content))
      .map(([path]) => path);
    expect(hits).toEqual(['../src/components/SafeMarkdown.tsx']);
  });
});
