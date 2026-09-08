// 玻璃文字对比度守卫的共享工具（tasks/done/search/app-shell 的守卫用例共用）：
// - renderWithAppTheme：用应用真实主题渲染（ThemeModeProvider + useAppTheme），
//   matchMedia stub 恒不匹配 → system 回落浅色，palette 值即 Rakko token 原值
//   （text.primary = n9 / text.secondary = n7 / primary.main = accent）；
// - ownEmotionClass / ruleTextOf / allStyleText：jsdom 解析不了 emotion 的级联与
//   computed，但测试环境（非 speedy）emotion 把样式规则以文本节点插入 <style>，
//   规则文本可以逐字断言——这是守卫用例能断言「颜色值」的机制基础。
// 本文件不是测试套件（vitest 只收集 *.test.* / *.spec.*），仅被守卫用例引用。

import { createElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { ThemeModeProvider } from '../src/lib/theme-mode';
import { useAppTheme } from '../src/theme';

function Themed({ children }: { children: ReactNode }) {
  const theme = useAppTheme();
  return createElement(ThemeProvider, { theme }, children);
}

/** 应用真实主题外壳（浅色）：主题数据源与产品一致，断言的颜色值 = token 原值 */
export function AppThemeProvider({ children }: { children: ReactNode }) {
  return createElement(ThemeModeProvider, null, createElement(Themed, null, children));
}

/** 用应用真实主题渲染被测组件 */
export function renderWithAppTheme(ui: ReactElement): RenderResult {
  return render(createElement(AppThemeProvider, null, ui));
}

/** 拼接当前文档里全部 emotion 注入的样式规则文本 */
export function allStyleText(): string {
  return Array.from(document.querySelectorAll('style'))
    .map((s) => s.textContent ?? '')
    .join('\n');
}

/** 元素自身由 emotion 生成的 css-* 类名（可能为 null：元素没挂任何局部样式） */
export function ownEmotionClass(el: Element): string | null {
  return Array.from(el.classList).find((c) => c.startsWith('css-')) ?? null;
}

/** 元素自身 emotion 类对应规则块的文本；找不到返回空串 */
export function ruleTextOf(css: string, el: Element): string {
  const own = ownEmotionClass(el);
  if (!own) return '';
  const start = css.indexOf(`.${own}{`);
  if (start < 0) return '';
  const end = css.indexOf('}', start);
  return end < 0 ? '' : css.slice(start, end);
}
