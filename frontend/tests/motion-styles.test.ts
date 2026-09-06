// View Transitions 样式层测试：结构断言（选择器键、时长 token 换算、壳层持名时机、
// 表面色打底、reduced-motion 总闸）+ 两条源码静态检查（禁 transition: all）。
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

describe('悬浮按钮与对话框的转场互不干扰', () => {
  const styles = viewTransitionStyles(createTheme()) as Styles;

  it('FAB 形变挂在 expand-fab / collapse-fab 上，不蹭详情的 expand', () => {
    // 圆角 morph 只在 FAB 自己的 kind 下跑
    const expandRadius = findKey(styles, 'data-vt="expand-fab"', 'image-pair', VT_NAMES.fab);
    expect(ruleValue(styles, expandRadius).animation).toContain(`${MOTION.large}ms`);
    const collapseRadius = findKey(styles, 'data-vt="collapse-fab"', 'image-pair', VT_NAMES.fab);
    expect(ruleValue(styles, collapseRadius).animation).toContain(`${MOTION.largeExit}ms`);
  });

  it('详情的淡入淡出只落在 sheet 与 FAB 自己的 kind 上，不落在 expand 下的 fab', () => {
    const fadeKeys = Object.keys(styles).filter((k) => {
      const rule = styles[k] as Rule;
      return typeof rule?.animation === 'string' && rule.animation.startsWith('rtk-vt-fade');
    });
    const expandFabFaded = fadeKeys.some((k) =>
      k.includes(`data-vt="expand"]::view-transition-old(${VT_NAMES.fab})`),
    );
    expect(expandFabFaded).toBe(false);
    // sheet 与 expand-fab 各自都有淡化规则
    expect(fadeKeys.some((k) => k.includes(`data-vt="expand"]::view-transition-old(${VT_NAMES.sheet})`))).toBe(true);
    expect(fadeKeys.some((k) => k.includes(`data-vt="expand-fab"]`))).toBe(true);
  });
});

describe('壳层与 FAB 的持名时机', () => {
  const styles = viewTransitionStyles(createTheme()) as Styles;

  it('换页时四件套按 VT_SHELL_ATTR 持名，FAB 另在 expand-fab / collapse-fab 持名', () => {
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
    const fabSelf = holding.find(
      ([key, rule]) =>
        key.includes(`data-vt="expand-fab"`) &&
        key.includes(`data-vt="collapse-fab"`) &&
        rule.viewTransitionName === VT_NAMES.fab,
    );
    expect(fabSelf, 'fab 在 expand-fab / collapse-fab 时应持名').toBeDefined();
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
    const key = findKey(
      styles,
      '::view-transition-old',
      '::view-transition-new',
      VT_NAMES.sheet,
      VT_NAMES.fab,
    );
    const rule = ruleValue(styles, key);
    expect(rule.objectFit).toBe('none');
    expect(rule.objectPosition).toBe('top left');
  });

  it('表面色打底跟随主题：sheet 与 fab 的 image-pair 各有进场/出场纸色动画', () => {
    const themed = viewTransitionStyles(
      createTheme({
        palette: { background: { paper: '#123456' }, primary: { main: '#abcdef' } },
      }),
    ) as Styles;
    const serialized = JSON.stringify(themed);
    expect(serialized).toContain('#123456');
    expect(serialized).toContain('#abcdef');
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
    // fab：形变时长内圆角 morph 与 primary.main→纸色两段动画同跑
    const expandFab = ruleValue(
      themed,
      findKey(themed, 'data-vt="expand-fab"', 'image-pair', VT_NAMES.fab),
    );
    expect(expandFab.animation).toContain('rtk-radius-expand');
    expect(expandFab.animation).toContain('rtk-fab-surface-in');
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
