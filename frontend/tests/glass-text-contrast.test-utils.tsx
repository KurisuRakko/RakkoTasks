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

/** 元素身上全部 css-* 局部类对应规则块的拼接。与 ruleTextOf 的区别：emotion 把
 *  styled 基类与 sx 类拆成两个 css-* 类，只取第一个会漏掉 sx 写的那半；同一个类的
 *  嵌套块（&::before 这类假元素规则）与 @media 里的改写也是独立的顶层规则块，所以
 *  按「以 .类名 开头的每条规则」收集，而不是只切第一个块。拼接结果为空串说明元素
 *  没挂局部类，断言容器会空转——先用 .not.toBe('') 钉住非空再查声明。 */
export function ownRules(css: string, el: Element): string {
  const classes = Array.from(el.classList).filter((c) => c.startsWith('css-'));
  const chunks: string[] = [];
  for (const cls of classes) {
    const head = `.${cls}`;
    let from = 0;
    for (;;) {
      const start = css.indexOf(head, from);
      if (start < 0) break;
      // 类名必须正好结束：css-abc 不该匹配 css-abcd。不匹配只是这一处不是要找的规则
      // （样式表里 .css-abcd 可能排在 .css-abc 前面），跳过它继续往后找，不能 break。
      const next = css[start + head.length];
      if (next !== '{' && next !== ':' && next !== '.' && next !== '[' && next !== ' ') {
        from = start + head.length;
        continue;
      }
      const open = css.indexOf('{', start);
      if (open < 0) break;
      let depth = 0;
      let end = -1;
      for (let i = open; i < css.length; i += 1) {
        if (css[i] === '{') depth += 1;
        else if (css[i] === '}') {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end < 0) break;
      chunks.push(css.slice(start, end + 1));
      from = end + 1;
    }
  }
  return chunks.join(' ');
}
