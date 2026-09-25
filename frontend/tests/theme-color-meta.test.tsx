// A3 的验收：PWA 状态栏底色随解析后的深浅模式改写 <meta name="theme-color">。
// index.html 里这条 meta 是写死的浅色纸色（模块系统之外，本次不改它），深色用户会看到
// 状态栏与页面之间有一道浅色横条；本文件锁住 ThemeModeProvider 里的改写。
//
// 取值口径：改写用的常量（THEME_COLOR_BY_MODE）必须与该模式的 palette.background.default
// 一致——测试同时从 rakko-tokens 与 buildThemeOptions 两侧取值比对，任一侧漂移都报警。
// 两侧同源的那一支是 PAPER（= CssBaseline 下发的 --color-paper），不是中性色阶：
// 深色纸色与深色 n1 不是同一个值（见 rakko-tokens 的 PAPER 注释）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createTheme } from '@mui/material/styles';
import { ThemeModeProvider, useThemeMode } from '../src/lib/theme-mode';
import { NEUTRAL_LIGHT, PAPER } from '../src/rakko-tokens';
import { buildThemeOptions } from '../src/theme';
import { allStyleText } from './glass-text-contrast.test-utils';

const MODE_KEY = 'rakkotasks.theme-mode';
const META_SELECTOR = 'meta[name="theme-color"]';

/** index.html 里写死的那一条（模块系统之外，测试环境要自己建出来） */
function installMeta(content = NEUTRAL_LIGHT[0]): HTMLMetaElement {
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'theme-color');
  meta.setAttribute('content', content);
  document.head.appendChild(meta);
  return meta;
}

function Probe() {
  const { mode, resolved } = useThemeMode();
  return <span data-testid="state">{mode + ':' + resolved}</span>;
}

function renderProvider() {
  return render(
    <ThemeModeProvider>
      <Probe />
    </ThemeModeProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  for (const old of document.querySelectorAll(META_SELECTOR)) old.remove();
});

afterEach(() => {
  cleanup();
  for (const old of document.querySelectorAll(META_SELECTOR)) old.remove();
});

describe('A3 PWA 状态栏底色随模式改写', () => {
  it('浅色模式写 n1（与 index.html 的初值同值）', () => {
    localStorage.setItem(MODE_KEY, 'light');
    const meta = installMeta();
    renderProvider();
    expect(meta.getAttribute('content')).toBe(NEUTRAL_LIGHT[0]);
  });

  it('深色模式写深色纸色（状态栏与深色页面同底）', () => {
    localStorage.setItem(MODE_KEY, 'dark');
    const meta = installMeta();
    renderProvider();
    expect(screen.getByTestId('state').textContent).toBe('dark:dark');
    expect(meta.getAttribute('content')).toBe(PAPER.dark);
    expect(meta.getAttribute('content')).not.toBe(NEUTRAL_LIGHT[0]);
  });

  it('改写的值等于该模式 palette.background.default（两侧同源）', () => {
    for (const mode of ['light', 'dark'] as const) {
      cleanup();
      for (const old of document.querySelectorAll(META_SELECTOR)) old.remove();
      localStorage.setItem(MODE_KEY, mode);
      const meta = installMeta();
      renderProvider();
      const theme = createTheme(buildThemeOptions(mode));
      expect(meta.getAttribute('content'), mode).toBe(theme.palette.background.default);
    }
  });

  it('切换模式后 meta 跟着变（setMode 生效）', () => {
    localStorage.setItem(MODE_KEY, 'light');
    const meta = installMeta();
    renderProvider();
    expect(meta.getAttribute('content')).toBe(NEUTRAL_LIGHT[0]);
    // 直接改存储再重挂一次，等价于产品里的「设置页切到深色」
    cleanup();
    localStorage.setItem(MODE_KEY, 'dark');
    renderProvider();
    expect(meta.getAttribute('content')).toBe(PAPER.dark);
  });

  it('页面里没有这条 meta 时不抛异常（嵌入 / 测试场景）', () => {
    localStorage.setItem(MODE_KEY, 'dark');
    expect(document.querySelector(META_SELECTOR)).toBeNull();
    expect(() => renderProvider()).not.toThrow();
    expect(screen.getByTestId('state').textContent).toBe('dark:dark');
  });

  it('不改 index.html：源码里仍是写死的浅色纸色，没有注入脚本', async () => {
    // 本用例只读源码文本，防止有人「顺手」把改写搬回 index.html（那就绕过了模式状态）
    const fs = await loadFs();
    const html = fs.readFileSync('index.html', 'utf-8');
    expect(html).toContain('name="theme-color"');
    expect(html).toContain(NEUTRAL_LIGHT[0]);
    // 主题层不往全局样式里塞 meta 相关规则
    expect(allStyleText()).not.toContain('theme-color');
  });
});

/** tests 无 node 类型声明，读文件走 vi.importActual 的真实 fs（同 glass-contract.test.ts） */
async function loadFs(): Promise<{ readFileSync: (p: string, e: string) => string }> {
  const actual = await vi.importActual<{ default?: unknown }>('node:fs');
  return (actual.default ?? actual) as { readFileSync: (p: string, e: string) => string };
}

