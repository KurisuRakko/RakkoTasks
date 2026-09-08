// View Transitions 样式层测试：结构断言（选择器键、时长 token 换算、壳层持名时机、
// 表面色打底、reduced-motion 总闸）+ 两条源码静态检查（禁 transition: all）。
// FAB ↔ 速记面板已不走 View Transitions（纯 CSS transform + MUI Slide，断言在
// tasks-page.test.tsx），所以这里只剩「换页时 FAB 持名保持静止」这一项与它有关。
// 纯函数断言，不渲染 DOM——viewTransitionStyles 只依赖 theme 的 breakpoints 字符串。

import { describe, expect, it } from 'vitest';
import { createTheme } from '@mui/material/styles';
import { MOTION, SHARED_AXIS_OFFSET_PX } from '../src/rakko-tokens';
import { VT_NAMES, VT_SHELL_ATTR } from '../src/lib/view-transition';
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

  it('image-pair 打底：isolation auto、overflow clip（只有 sheet）', () => {
    const key = findKey(styles, '::view-transition-image-pair', VT_NAMES.sheet);
    const rule = ruleValue(styles, key);
    expect(rule.isolation).toBe('auto');
    expect(rule.overflow).toBe('clip');
    // FAB 不再有容器变换：它的快照不该再被 objectFit/mixBlendMode 打底，
    // 换页时和其它壳层一样走 UA 默认交叉淡化
    expect(key).not.toContain(VT_NAMES.fab);
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

describe('FAB 不再有自己的容器变换', () => {
  const styles = viewTransitionStyles(createTheme()) as Styles;

  it('样式表里不存在任何 expand-fab / collapse-fab 规则', () => {
    for (const key of Object.keys(styles)) {
      expect(key).not.toContain('expand-fab');
      expect(key).not.toContain('collapse-fab');
    }
  });

  it('圆角与底色 morph 的 keyframes 已删干净（FAB 不再形变成对话框）', () => {
    const serialized = JSON.stringify(styles);
    for (const name of ['rtk-radius-expand', 'rtk-radius-collapse', 'rtk-fab-surface-in', 'rtk-fab-surface-out']) {
      expect(serialized).not.toContain(name);
    }
  });

  it('详情的淡入淡出只落在 sheet 上，FAB 一条都不沾', () => {
    const fadeKeys = Object.keys(styles).filter((k) => {
      const rule = styles[k] as Rule;
      return typeof rule?.animation === 'string' && rule.animation.startsWith('rtk-vt-fade');
    });
    expect(fadeKeys.length).toBeGreaterThan(0);
    for (const key of fadeKeys) {
      expect(key).toContain(VT_NAMES.sheet);
      expect(key).not.toContain(`(${VT_NAMES.fab})`);
    }
  });
});

describe('壳层与 FAB 的持名时机', () => {
  const styles = viewTransitionStyles(createTheme()) as Styles;

  it('换页时四件套按 VT_SHELL_ATTR 持名；FAB 只在换页持名，没有别的持名时机', () => {
    const holding = (Object.entries(styles) as Array<[string, Rule]>).filter(
      ([, rule]) => typeof rule === 'object' && rule !== null && 'viewTransitionName' in rule,
    );
    for (const name of [VT_NAMES.appBar, VT_NAMES.bottomNav, VT_NAMES.navDrawer, VT_NAMES.fab]) {
      const hit = holding.find(
        ([key, rule]) =>
          key.includes(`data-vt^="route-"`) &&
          key.includes(`[${VT_SHELL_ATTR}="${name}"]`) &&
          rule.viewTransitionName === name,
      );
      expect(hit, `route-* 下 [${VT_SHELL_ATTR}="${name}"] 应持名`).toBeDefined();
    }
    // FAB 的持名规则有且仅有换页那一条
    const fabHolding = holding.filter(([, rule]) => rule.viewTransitionName === VT_NAMES.fab);
    expect(fabHolding).toHaveLength(1);
    expect(fabHolding[0][0]).toContain('data-vt^="route-"');
  });

  it('打开/关闭详情（expand / collapse）不持名：壳层与 FAB 留在 root 快照里随遮罩压暗', () => {
    const holding = (Object.entries(styles) as Array<[string, Rule]>).filter(
      ([, rule]) => typeof rule === 'object' && rule !== null && 'viewTransitionName' in rule,
    );
    for (const [key] of holding) {
      expect(key).not.toContain('data-vt="expand"]');
      expect(key).not.toContain('data-vt="collapse"]');
    }
  });
});

describe('壳层与遮罩的交叉淡化', () => {
  const styles = viewTransitionStyles(createTheme()) as Styles;

  it('换页壳层不再顺序淡化：rtk-vt-fade 动画的键都不含 route-', () => {
    const fadeKeys = Object.keys(styles).filter((k) => {
      const rule = styles[k] as Rule;
      return typeof rule?.animation === 'string' && rule.animation.startsWith('rtk-vt-fade');
    });
    // 淡化规则仍服务于容器变换（expand / collapse），只是不再落到换页壳层上
    expect(fadeKeys.length).toBeGreaterThan(0);
    for (const key of fadeKeys) {
      expect(key).not.toContain('route-');
    }
  });

  it('换页壳层的交叉淡化节奏对齐内容轴移：壳层三件套共用 group 规则，large + ease', () => {
    const key = findKey(
      styles,
      'route-',
      '::view-transition-group(',
      VT_NAMES.appBar,
      VT_NAMES.bottomNav,
      VT_NAMES.navDrawer,
    );
    const rule = ruleValue(styles, key);
    expect(rule.animationDuration).toBe(`${MOTION.large}ms`);
    expect(rule.animationTimingFunction).toBe(MOTION.easeStandard);
  });

  it('遮罩交叉淡化节奏：group(root) 时长 expand 用 large、collapse 用 largeExit', () => {
    const expandKey = findKey(styles, 'data-vt="expand"', '::view-transition-group(root)');
    expect(ruleValue(styles, expandKey).animationDuration).toBe(`${MOTION.large}ms`);
    const collapseKey = findKey(styles, 'data-vt="collapse"', '::view-transition-group(root)');
    expect(ruleValue(styles, collapseKey).animationDuration).toBe(`${MOTION.largeExit}ms`);
  });

  it('不再存在把 root 交叉淡化改成正常叠放的覆写（保留 UA 默认 plus-lighter）', () => {
    const keys = Object.keys(styles).filter((k) =>
      k.includes('::view-transition-old(root), ::view-transition-new(root)'),
    );
    expect(keys).toHaveLength(0);
  });
});

describe('容器变换的表面色打底与快照形态', () => {
  const styles = viewTransitionStyles(createTheme()) as Styles;

  it('快照 object-fit: none：容器长大而内容不缩放，左上锚定', () => {
    const key = findKey(styles, '::view-transition-old', '::view-transition-new', VT_NAMES.sheet);
    const rule = ruleValue(styles, key);
    expect(rule.objectFit).toBe('none');
    expect(rule.objectPosition).toBe('top left');
    expect(key).not.toContain(VT_NAMES.fab);
  });

  it('表面色打底跟随主题：sheet 的 image-pair 有进场/出场纸色动画', () => {
    const themed = viewTransitionStyles(
      createTheme({ palette: { background: { paper: '#123456' } } }),
    ) as Styles;
    expect(JSON.stringify(themed)).toContain('#123456');
    // sheet：expand 时纸色在 old 淡出的 90ms 内补上，collapse 时收尾 90ms 淡出
    const expandSheet = ruleValue(
      themed,
      findKey(themed, 'data-vt="expand"', 'image-pair', VT_NAMES.sheet),
    );
    expect(expandSheet.animation).toContain('rtk-surface-in');
    expect(expandSheet.animation).toContain(`${MOTION.fadeOut}ms`);
    const collapseSheet = ruleValue(
      themed,
      findKey(themed, 'data-vt="collapse"', 'image-pair', VT_NAMES.sheet),
    );
    expect(collapseSheet.animation).toContain('rtk-surface-out');
    expect(collapseSheet.animation).toContain(`${MOTION.largeExit - MOTION.fadeOut}ms`);
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
