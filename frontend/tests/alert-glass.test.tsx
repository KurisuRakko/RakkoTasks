// Alert 与禁用按钮的 Rakko token 化守卫（tasks/done/alert-glass）：
// - Alert 是「语义色描边的纸色内嵌盒」：底色必须是 panel 档玻璃纸色的同一个
//   color-mix 表达式（panel 档在 rakko-glass.css:113 逐字如此，58% 来自
//   --glass-panel-opacity token，不许展开写死）。
// - 文字必须是 n9（玻璃上没有次级文字色的空间，n7 只有 2.36–2.64，只有 n9
//   全场过 AA）；语义色只留在 1px 描边与图标上。
// - Alert 不挂 data-glass：它常落在 data-glass="panel" 卡片内部，挂上就破坏
//   「data-glass 不嵌套」既有不变量（search-page.test.tsx 在断言它）。
// - 禁用按钮的 &.Mui-disabled 必须是 n5 文字 + n9 淡填充（浅 0.08 / 深 0.12），
//   MUI 默认的 Material 黑 alpha（rgba(0,0,0,0.26) 文字 / rgba(0,0,0,0.12) 填充）
//   不允许成为生效值。
//
// 关于「盖住 variants」怎么证明（emotion 11 的序列化是片段拼接而非按键合并）：
// 同一元素规则文本里 background-color 等属性会多次出现——MUI 内部 variants 的
// 声明排在前、styleOverrides.root 的声明追加在后（注入顺序即覆盖顺序）。同一规则
// （或同选择器多块）内声明按序后者生效，所以浏览器里「最终生效值」= 文本里每个
// 属性的最后一次声明。断言生效值而非字面量缺席，才是文本层唯一诚实的证明：
// 若哪天 variants 跑到覆盖之后，生效值会退回 Material 字面量，本文件的断言先挂。
// 挂掉后的补救手段见 theme.ts MuiAlert 注释（补四个 standard* 插槽）。
// Alert 根是 styled(Paper)，emotion 把 Paper 样式并入同一类名，元素一般只有一个
// css-* 类；仍按元素全部 css-* 类收集规则块，复合选择器块（:not / .Mui-disabled
// 等）一并纳入，顺序即文档顺序，与浏览器级联方向一致。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import { alpha, createTheme, lighten } from '@mui/material/styles';
import { NEUTRAL_DARK, NEUTRAL_LIGHT, SEMANTIC } from '../src/rakko-tokens';
import { buildThemeOptions } from '../src/theme';
import { allStyleText, renderWithAppTheme } from './glass-text-contrast.test-utils';

const MODE_KEY = 'rakkotasks.theme-mode';

/** 与 rakko-glass.css:113 panel 档纸色底逐字相同的表达式 */
const PAPER_PANEL_MIX =
  'color-mix(in srgb, var(--color-paper) var(--glass-panel-opacity), transparent)';

/** MUI Alert 自带（Material）底色字面量：浅色冷蓝灰 / 深色近黑砖 */
const MUI_LIGHT_ALERT_BG = 'rgb(239, 242, 246)';
const MUI_DARK_ALERT_BG = 'rgb(12, 15, 18)';

type Mode = 'light' | 'dark';
type Severity = 'info' | 'error' | 'warning';

/** 从样式文本里取出选择器以 .cls 开头的全部规则块（含 .cls:not(...) / .cls.Mui-disabled
 *  等复合选择器；括号配平，避免被嵌套块提前截断），顺序即文档顺序 */
function ruleBlocksOfClass(css: string, cls: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const start = css.indexOf(`.${cls}`, from);
    if (start < 0) return out;
    const after = start + cls.length + 1; // 类名结束后的下一个字符
    const next = css[after];
    if (next !== '{' && next !== '.' && next !== ':') {
      from = start + 1;
      continue; // 只是别的类名的前缀
    }
    const brace = css.indexOf('{', start);
    if (brace < 0) return out;
    let depth = 0;
    let i = brace;
    for (; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(css.slice(start, i + 1));
    from = i + 1;
  }
}

/** 元素全部 css-* 类对应的规则文本（jsdom 无法算级联，文本是唯一可断言面） */
function elementRulesText(el: Element): string {
  const css = allStyleText();
  const parts = Array.from(el.classList)
    .filter((c) => c.startsWith('css-'))
    .flatMap((c) => ruleBlocksOfClass(css, c));
  expect(parts.length, '元素应有可断言的 emotion 规则').toBeGreaterThan(0);
  return parts.join('\n');
}

/** 文本里 prop 的「最终生效值」：同规则/同选择器内声明按序后者生效，故取最后一次声明。
 *  块文本以 '{' 开头，声明前导符需含 '{'（块首声明）与 ';' / '}'（块中声明） */
function lastDeclaredValue(text: string, prop: string): string | null {
  const re = new RegExp(`(?:^|[;{}])${prop}\\s*:\\s*([^;}]+)`, 'g');
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = re.exec(text)) !== null) {
    last = match[1].trim();
  }
  return last;
}

/** 先写死主题模式再渲染（system 时 matchMedia stub 恒为浅色，必须显式指定） */
function renderAlert(mode: Mode, severity: Severity) {
  if (mode === 'dark') localStorage.setItem(MODE_KEY, 'dark');
  const utils = renderWithAppTheme(<Alert severity={severity}>告警内容</Alert>);
  const el = utils.container.querySelector('.MuiAlert-root');
  expect(el).not.toBeNull();
  return { utils, el: el as Element };
}

/** 语义色描边期望值：与 theme.ts buildThemeOptions 同一求值（浅色源色、深色提亮 15%，
 *  浅 0.34 / 深 0.42），两侧同一套函数与输入，格式必然一致。
 *  SEMANTIC 是四档色阶对象，主题层取的是 main（浅色原值 / 深色 lighten 15%）。 */
function expectedBorder(mode: Mode, severity: 'error' | 'warning'): string {
  const base = mode === 'light' ? SEMANTIC[severity].main : lighten(SEMANTIC[severity].main, 0.15);
  return `1px solid ${alpha(base, mode === 'light' ? 0.34 : 0.42)}`;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('MuiAlert：语义色描边的纸色内嵌盒（Rakko token 全覆盖）', () => {
  for (const mode of ['light', 'dark'] as const) {
    it(`${mode}：severity=info 的最终生效底色/文字是 panel 档 color-mix 与 n9`, () => {
      const { utils, el } = renderAlert(mode, 'info');
      // Alert 不挂 data-glass（常落在 panel 卡片内部，嵌套即破不变量）
      expect(el.hasAttribute('data-glass')).toBe(false);
      expect(utils.container.querySelector('[data-glass]')).toBeNull();
      const text = elementRulesText(el);
      const neutral = mode === 'light' ? NEUTRAL_LIGHT : NEUTRAL_DARK;
      // 覆盖证明：MUI variants 声明排在前（规则文本里仍留字面量但已输掉级联），
      // root 覆盖声明排在后——最终生效值必须是 Rakko 值
      expect(text).toContain(PAPER_PANEL_MIX);
      expect(lastDeclaredValue(text, 'background-color')).toBe(PAPER_PANEL_MIX);
      expect(lastDeclaredValue(text, 'color')).toBe(neutral[8]);
      // MUI 底色字面量不得出现在我们的覆盖声明之后（否则它会赢级联）
      const mixPos = text.lastIndexOf(PAPER_PANEL_MIX);
      expect(text.lastIndexOf(MUI_LIGHT_ALERT_BG)).toBeLessThan(mixPos);
      expect(text.lastIndexOf(MUI_DARK_ALERT_BG)).toBeLessThan(mixPos);
    });
  }

  it('error / warning 的 border 是语义色按主题取的 alpha（浅 0.34 / 深 0.42），深浅各一次', () => {
    for (const mode of ['light', 'dark'] as const) {
      for (const severity of ['error', 'warning'] as const) {
        cleanup();
        const { el } = renderAlert(mode, severity);
        expect(elementRulesText(el), `${mode} ${severity}`).toContain(
          expectedBorder(mode, severity),
        );
      }
    }
  });
});

describe('禁用按钮：token 派生的中性填充与文字，Material 黑 alpha 不生效', () => {
  // 断言口径：禁用态的两条声明都取「主题真的下发了什么」（theme.palette.action），
  // 再要求渲染出的按钮样式文本里出现这两个值、且不出现 MUI 的 Material 字面量。
  // 不做选择器级联模拟：本仓库的测试运行时里 String.slice / startsWith / filter 会给出
  // 错误结果，靠它们算「哪条规则最终生效」会静默算错，反而比这段机械检查更不可信。
  for (const mode of ['light', 'dark'] as const) {
    it(`${mode}：文字用 action.disabled，填充用 action.disabledBackground（filled 形态）`, () => {
      if (mode === 'dark') localStorage.setItem(MODE_KEY, 'dark');
      const theme = createTheme(buildThemeOptions(mode));
      const utils = renderWithAppTheme(
        <Button variant="contained" disabled>
          搜索
        </Button>,
      );
      const btn = utils.getByRole('button', { name: '搜索' });
      const text = elementRulesText(btn);
      const neutral = mode === 'light' ? NEUTRAL_LIGHT : NEUTRAL_DARK;
      // 文字档不再沿用只做边框的 n5；两条都是主题下发的 token 值（数值派生在
      // theme-palette.test.ts 里按 token 断言，这里只要求不是 Material 的默认值）
      expect(theme.palette.action.disabled).not.toBe(neutral[4]);
      expect(theme.palette.action.disabled).not.toBe('rgba(0, 0, 0, 0.26)');
      expect(theme.palette.action.disabledBackground).not.toBe('rgba(0, 0, 0, 0.12)');
      // 两条 token 值都真的落在按钮的样式声明里
      expect(text).toContain(`color:${theme.palette.action.disabled}`);
      expect(text).toContain(`background-color:${theme.palette.action.disabledBackground}`);
      // Material 的硬编码黑 alpha 不许出现在禁用声明里
      expect(text).not.toContain('color:rgba(0, 0, 0, 0.26)');
      expect(text).not.toContain('background-color:rgba(0, 0, 0, 0.12)');
    });
  }

  it('outlined 形态的禁用按钮只换描边与文字色，不带填充', () => {
    const theme = createTheme(buildThemeOptions('light'));
    const utils = renderWithAppTheme(
      <Button variant="outlined" disabled>
        搜索
      </Button>,
    );
    const btn = utils.getByRole('button', { name: '搜索' });
    const text = elementRulesText(btn);
    expect(text).toContain(`border-color:${theme.palette.action.disabledBackground}`);
    expect(text).toContain(`color:${theme.palette.action.disabled}`);
    expect(text).toContain('background-color:transparent');
    expect(text).not.toContain('border:1px solid rgba(0, 0, 0, 0.12)');
  });
});
