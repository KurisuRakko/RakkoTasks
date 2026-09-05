// View Transitions 样式层测试：结构断言（选择器键、时长 token 换算、打底规则、
// reduced-motion 总闸）+ 两条源码静态检查（禁 transition: all）。
// 纯函数断言，不渲染 DOM——viewTransitionStyles 只依赖 theme 的 breakpoints 字符串。

import { describe, expect, it } from 'vitest';
import { createTheme } from '@mui/material/styles';
import { MOTION, SHARED_AXIS_OFFSET_PX } from '../src/rakko-tokens';
import { VT_NAMES } from '../src/lib/view-transition';
import { viewTransitionStyles } from '../src/motion-styles';
// ?raw 由 vite 静态注入源码文本（tests 无 node 类型，读文件走 raw import）
import motionStylesSource from '../src/motion-styles.ts?raw';
import themeSource from '../src/theme.ts?raw';

type Styles = Record<string, unknown>;
type Rule = Record<string, unknown>;

function ruleValue(styles: Styles, key: string): Rule {
  const rule = styles[key];
  expect(rule).toBeDefined();
  return rule as Rule;
}

/** 顶层键里挑出包含全部 fragment 的那一条（选择器是动态拼的，不手抄整串） */
function findKey(styles: Styles, ...fragments: string[]): string {
  const key = Object.keys(styles).find((k) => fragments.every((f) => k.includes(f)));
  expect(key, `顶层键应包含 ${fragments.join(' 且 ')}`).toBeDefined();
  return key as string;
}

describe('viewTransitionStyles 结构', () => {
  const styles = viewTransitionStyles(createTheme()) as Styles;

  it('路由共享轴：route-forward / route-back 各有 old(root) 与 new(root) 动画', () => {
    const expected: Record<string, string> = {
      ':root[data-vt="route-forward"]::view-transition-old(root)': 'rtk-axis-out-back',
      ':root[data-vt="route-forward"]::view-transition-new(root)': 'rtk-axis-in-forward',
      ':root[data-vt="route-back"]::view-transition-old(root)': 'rtk-axis-out-forward',
      ':root[data-vt="route-back"]::view-transition-new(root)': 'rtk-axis-in-back',
    };
    for (const [selector, keyframe] of Object.entries(expected)) {
      const { animation } = ruleValue(styles, selector);
      expect(animation).toContain(keyframe);
      expect(animation).toContain(`${MOTION.large}ms`);
    }
  });

  it('容器变换时长：expand 用 large、collapse 用 largeExit（group 规则）', () => {
    const expand = ruleValue(
      styles,
      findKey(styles, 'expand', '::view-transition-group', VT_NAMES.sheet),
    );
    const collapse = ruleValue(
      styles,
      findKey(styles, 'collapse', '::view-transition-group', VT_NAMES.sheet),
    );
    expect(expand.animationDuration).toBe(`${MOTION.large}ms`);
    expect(collapse.animationDuration).toBe(`${MOTION.largeExit}ms`);
  });

  it('image-pair 打底：isolation auto、overflow clip（sheet 与 fab 一起）', () => {
    const key = findKey(styles, '::view-transition-image-pair', VT_NAMES.sheet, VT_NAMES.fab);
    const rule = ruleValue(styles, key);
    expect(rule.isolation).toBe('auto');
    expect(rule.overflow).toBe('clip');
  });

  it('reduced-motion 总闸存在且内层规则关掉动画', () => {
    const media = ruleValue(styles, '@media (prefers-reduced-motion: reduce)');
    const inner = Object.values(media)[0] as { animation?: string };
    expect(inner.animation).toContain('none');
  });

  it('路由 keyframes 的位移与共享轴 token 一致（±30px）', () => {
    const serialized = JSON.stringify(styles);
    expect(serialized).toContain(`translateX(-${SHARED_AXIS_OFFSET_PX}px)`);
    expect(serialized).toContain(`translateX(${SHARED_AXIS_OFFSET_PX}px)`);
  });
});

describe('源码静态检查', () => {
  it('motion-styles.ts 与 theme.ts 不使用 transition: all', () => {
    for (const source of [motionStylesSource, themeSource]) {
      expect(source).not.toContain('transition: all');
      expect(source).not.toContain("transition: 'all");
    }
  });
});
