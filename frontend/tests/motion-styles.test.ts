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
    const allFade = Object.keys(styles).filter((k) => {
      const rule = styles[k] as Rule;
      return typeof rule?.animation === 'string' && rule.animation.startsWith('rtk-vt-fade');
    });
    // 换页的 fade-through 也用同一组 rtk-vt-fade-* 关键帧（壳层四件套），那是另一条链路；
    // 这里只看详情容器变换的 expand / collapse
    const detailFade = allFade.filter((k) => /data-vt="(expand|collapse)"/.test(k));
    expect(detailFade.length).toBeGreaterThan(0);
    for (const key of detailFade) {
      expect(key).toContain(VT_NAMES.sheet);
    }
    // FAB 不许出现在任何淡入淡出规则里：换页时它走自己的 rtk-vt-fab-* 关键帧
    for (const key of allFade) {
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

describe('壳层换页 fade-through 与遮罩节奏', () => {
  const styles = viewTransitionStyles(createTheme()) as Styles;

  it('换页壳层走 fade-through：旧/新快照各自带 fadeOut / fadeIn 动画与正确延迟', () => {
    const oldKey = findKey(
      styles,
      'route-',
      '::view-transition-old(',
      VT_NAMES.appBar,
      VT_NAMES.bottomNav,
      VT_NAMES.navDrawer,
    );
    const oldRule = ruleValue(styles, oldKey);
    // 旧快照：fadeOut，时长 fadeOut（90ms），无延迟
    expect(oldRule.animation).toContain('rtk-vt-fade-out');
    expect(oldRule.animation).toContain(`${MOTION.fadeOut}ms`);
    const newKey = findKey(
      styles,
      'route-',
      '::view-transition-new(',
      VT_NAMES.appBar,
      VT_NAMES.bottomNav,
      VT_NAMES.navDrawer,
    );
    const newRule = ruleValue(styles, newKey);
    // 新快照：fadeIn，时长 large - fadeOut（210ms），延迟 fadeOut（90ms）后才进场
    expect(newRule.animation).toContain('rtk-vt-fade-in');
    expect(newRule.animation).toContain(`${MOTION.large - MOTION.fadeOut}ms`);
    expect(newRule.animation).toContain(`${MOTION.fadeOut}ms both`); // delay 后紧跟 both，与时长区分
  });

  it('壳层三件套共用 group 规则：时长对齐 large + ease，并关掉 UA 的 plus-lighter 混合', () => {
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
    // 玻璃化后壳层半透明，不关掉 plus-lighter 新旧快照会加色叠加泛白
    expect(rule.mixBlendMode).toBe('normal');
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

describe('壁纸层换页时单独成组且完全静止', () => {
  // root 快照随轴移淡到全透明，壁纸留在里面就跟着消失，中途露出 canvas 基色。让 index.html
  // 的壁纸承载层在换页时持名，它被排除在 root 快照之外，单独成组静止铺在最底下。
  const styles = viewTransitionStyles(createTheme()) as Styles;

  it('持名时机：只有换页时 #rtk-wallpaper 持名，且名字是 VT_NAMES.wallpaper', () => {
    const key = findKey(styles, 'data-vt^="route-"', `#${VT_NAMES.wallpaper}`);
    expect(ruleValue(styles, key).viewTransitionName).toBe(VT_NAMES.wallpaper);
  });

  it('层序：group 带 z-index -1（默认顺序会把壁纸排到 root 之上盖住内容）', () => {
    const rule = ruleValue(
      styles,
      findKey(styles, 'route-', '::view-transition-group(', VT_NAMES.wallpaper),
    );
    expect(rule.zIndex).toBe(-1);
  });

  it('group 动画关死：不插值尺寸与位置', () => {
    const rule = ruleValue(
      styles,
      findKey(styles, 'route-', '::view-transition-group(', VT_NAMES.wallpaper),
    );
    expect(rule.animation).toBe('none');
  });

  it('old/new 快照动画与加色混合都关死：两张快照停在 opacity 1，合成结果是静止壁纸', () => {
    const rule = ruleValue(
      styles,
      findKey(
        styles,
        'route-',
        '::view-transition-old(',
        '::view-transition-new(',
        VT_NAMES.wallpaper,
      ),
    );
    expect(rule.animation).toBe('none');
    // plus-lighter 是加色混合，与段 (d) 记录的壳层泛白同一个坑
    expect(rule.mixBlendMode).toBe('normal');
  });

  it('层序守卫：带 zIndex 的 group 规则有且仅有壁纸那一条，负值也只有它', () => {
    const entries = Object.entries(styles) as Array<[string, Rule]>;
    const groupWithZIndex = entries.filter(
      ([key, rule]) => key.includes('::view-transition-group(') && 'zIndex' in rule,
    );
    expect(groupWithZIndex).toHaveLength(1);
    expect(groupWithZIndex[0]![0]).toContain(VT_NAMES.wallpaper);

    const negative = entries.filter(([, rule]) => rule.zIndex === -1);
    expect(negative).toHaveLength(1);
    expect(negative[0]![0]).toContain(VT_NAMES.wallpaper);
  });

  it('不侵入对话框链路：壁纸层的规则都只在 route-* 下生效，不碰 expand / collapse', () => {
    const keys = Object.keys(styles).filter((k) => k.includes(VT_NAMES.wallpaper));
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).toContain('data-vt^="route-"');
      expect(key).not.toContain('data-vt="expand"');
      expect(key).not.toContain('data-vt="collapse"');
    }
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
