// View Transitions 样式层测试：结构断言（选择器键、时长 token 换算、表面色打底、
// reduced-motion 总闸、除容器变换外不留任何转场规则）+ 一条源码静态检查（禁 transition: all）。
// 换页不走 View Transitions，这里关于「route-* / 壳层持名 / 壁纸持名」的断言已随之删除；
// FAB ↔ 速记面板也不走 View Transitions（纯 CSS transform + MUI Slide，断言在 tasks-page.test.tsx）。
// 纯函数断言，不渲染 DOM——viewTransitionStyles 只依赖 theme 的 breakpoints 字符串。

import { describe, expect, it } from 'vitest';
import { createTheme } from '@mui/material/styles';
import { MOTION } from '../src/rakko-tokens';
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

  it('image-pair 打底：isolation auto、overflow clip', () => {
    const key = findKey(styles, '::view-transition-image-pair', VT_NAMES.sheet);
    const rule = ruleValue(styles, key);
    expect(rule.isolation).toBe('auto');
    expect(rule.overflow).toBe('clip');
  });

  it('reduced-motion 总闸存在且内层规则关掉动画', () => {
    const media = ruleValue(styles, '@media (prefers-reduced-motion: reduce)');
    const inner = Object.values(media)[0] as { animation?: string };
    expect(inner.animation).toContain('none');
  });
});

describe('除容器变换外不再有任何转场规则', () => {
  const styles = viewTransitionStyles(createTheme()) as Styles;

  /** 选择器键 = 规则的顶层键里不是规则容器（@keyframes / @media）的那些，
   *  外加 @media 里嵌套的选择器键。@keyframes 名不是选择器，不计入。 */
  function selectorKeys(styles: Styles): string[] {
    const keys: string[] = [];
    for (const [key, rule] of Object.entries(styles)) {
      if (key.startsWith('@keyframes')) continue;
      keys.push(key);
      if (!key.startsWith('@media')) continue;
      keys.push(...Object.keys(rule as Rule));
    }
    return keys;
  }

  it('E：所有选择器键里不含 route-，也不含壁纸与壳层四件套的名字', () => {
    for (const key of selectorKeys(styles)) {
      expect(key).not.toContain('route-');
      for (const name of [
        'rtk-wallpaper',
        'rtk-app-bar',
        'rtk-bottom-nav',
        'rtk-nav-drawer',
        'rtk-fab',
      ]) {
        expect(key, `${key} 不应再出现壁纸 / 壳层的名字 ${name}`).not.toContain(name);
      }
    }
  });

  it('带 data-vt 的选择器只剩 expand / collapse 两种方向', () => {
    const withAttr = selectorKeys(styles).filter((key) => key.includes('data-vt='));
    expect(withAttr.length).toBeGreaterThan(0);
    for (const key of withAttr) {
      expect(/data-vt="(expand|collapse)"/.test(key)).toBe(true);
    }
  });

  it('换页专用的共享轴位移 keyframes 已删干净，留下的 keyframes 都只为容器变换服务', () => {
    const keyframes = Object.keys(styles).filter((k) => k.startsWith('@keyframes'));
    expect(keyframes.sort()).toEqual(
      [
        '@keyframes rtk-sheet-shrink-out',
        '@keyframes rtk-surface-in',
        '@keyframes rtk-surface-out',
        '@keyframes rtk-vt-fade-in',
        '@keyframes rtk-vt-fade-out',
      ].sort(),
    );
  });
});

describe('FAB 不参与任何转场', () => {
  const styles = viewTransitionStyles(createTheme()) as Styles;

  it('样式表里不存在任何 expand-fab / collapse-fab 规则', () => {
    for (const key of Object.keys(styles)) {
      expect(key).not.toContain('expand-fab');
      expect(key).not.toContain('collapse-fab');
    }
  });

  it('圆角与底色 morph 的 keyframes 已删干净（FAB 不形变成对话框）', () => {
    const serialized = JSON.stringify(styles);
    for (const name of ['rtk-radius-expand', 'rtk-radius-collapse', 'rtk-fab-surface-in', 'rtk-fab-surface-out']) {
      expect(serialized).not.toContain(name);
    }
  });

  it('详情的淡入淡出只落在 sheet 上', () => {
    const allFade = Object.keys(styles).filter((k) => {
      const rule = styles[k] as Rule;
      return typeof rule?.animation === 'string' && rule.animation.startsWith('rtk-vt-fade');
    });
    expect(allFade.length).toBeGreaterThan(0);
    for (const key of allFade) {
      expect(key).toContain(VT_NAMES.sheet);
    }
  });
});

describe('遮罩交叉淡化节奏', () => {
  const styles = viewTransitionStyles(createTheme()) as Styles;

  it('group(root) 时长 expand 用 large、collapse 用 largeExit', () => {
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
