// 玻璃材质契约守卫（纯文本断言，不渲染任何组件）：
// rakko-glass.css 是上游 design-system/src/glass.css 的逐字镜像，全项目 backdrop-filter
// 的唯一合法宿主。本文件守住：四档配方、两条退化路径、滚动渐显规则都在位；
// 「backdrop-filter 只允许出现在一个样式表里」；以及「css 消费的每个变量都已在
// theme.ts 下发」这两条接线契约。
//
// 读文件机制：tests 无 node 类型声明（tsconfig types 只有 vite/client），不能静态
// import 'node:fs'；同时 vitest 的 css:false 会把 .css 的任何静态导入（含 ?raw）剥成
// 空串。所以源码文本读取分两路——theme.ts 走 vite ?raw（与 motion-styles.test.ts 同），
// rakko-glass.css 与 src/ 目录遍历走 vi.importActual('node:fs') 的真实 fs（运行时可用，
// 编译期不经模块解析，故无类型报错）。

import { describe, expect, it, vi } from 'vitest';
import themeTs from '../src/theme.ts?raw';

interface DirentLike {
  name: string;
  isDirectory(): boolean;
}

interface FsLike {
  readFileSync(path: string, encoding: 'utf-8'): string;
  readdirSync(path: string, options: { withFileTypes: true }): DirentLike[];
}

function loadFs() {
  return vi.importActual('node:fs') as Promise<FsLike>;
}

/** 递归收集 src/ 下全部文件相对路径（含子目录，证明遍历不限于一层） */
async function walkSrc(): Promise<string[]> {
  const fs = await loadFs();
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) visit(full);
      else out.push(full);
    }
  };
  visit('src');
  return out;
}

describe('rakko-glass.css 镜像完整性', () => {
  it('4a. 四档材质配方选择器都在', async () => {
    const glassCss = (await loadFs()).readFileSync('src/rakko-glass.css', 'utf-8');
    for (const selector of [
      "[data-glass='chrome']",
      "[data-glass='panel']",
      "[data-glass='inverse']",
      "[data-glass='haze']",
    ]) {
      expect(glassCss, `缺少 ${selector}`).toContain(selector);
    }
  });

  it('4b. 两条退化路径都在（不支持 backdrop-filter / 降低透明度）', async () => {
    const glassCss = (await loadFs()).readFileSync('src/rakko-glass.css', 'utf-8');
    expect(glassCss).toContain('@supports not ((backdrop-filter');
    expect(glassCss).toContain('@media (prefers-reduced-transparency: reduce)');
  });

  it('4c. 滚动渐显规则在（data-reveal=scroll 选择器 + rk-glass-reveal keyframes）', async () => {
    const glassCss = (await loadFs()).readFileSync('src/rakko-glass.css', 'utf-8');
    expect(glassCss).toContain("[data-glass='chrome'][data-reveal='scroll']");
    expect(glassCss).toContain('@keyframes rk-glass-reveal');
  });
});

describe('backdrop-filter 唯一宿主守卫', () => {
  it('4d. src/ 递归遍历下，除 rakko-glass.css 外没有任何文件声明 backdrop-filter', async () => {
    const fs = await loadFs();
    const files = await walkSrc();
    // 递归真实发生：深层文件必须出现在遍历结果里
    for (const deep of ['src/components/AppShell.tsx', 'src/pages/TasksPage.tsx', 'src/lib/glass.ts']) {
      expect(files, `递归遍历应含 ${deep}`).toContain(deep);
    }

    // 守卫对象是「CSS 属性声明」形态（属性名 + 冒号，含 -webkit- 前缀与 camelCase
    // backdropFilter，注释/文档里提词不算实现——main.tsx、theme.ts、lib/glass.ts 的
    // 说明性注释按契约本就要写到这个属性名，字面扫词会把它们误报成第二宿主）。
    const declaration = /backdrop-?filter\s*:/i;
    const offenders = files
      .filter((path) => !path.endsWith('rakko-glass.css'))
      .filter((path) => declaration.test(fs.readFileSync(path, 'utf-8')));
    expect(offenders).toEqual([]);
  });
});

describe('变量下发守卫', () => {
  it('4e. rakko-glass.css 消费的每个 CSS 变量都能在 theme.ts 里找到下发', async () => {
    const glassCss = (await loadFs()).readFileSync('src/rakko-glass.css', 'utf-8');

    // 任务书 3a 的 :root 下发清单（共 14 个键；任务书行文称 15，按实际清单断言）。
    // css 实际消费的非 --rk- 变量为 13 个：--glass-scrim-opacity 由主题层 MuiBackdrop
    // 消费（不在玻璃样式表里），故总下发数比 css 消费数多 1，两条都逐字断言。
    const providedByTheme = [
      '--color-paper',
      '--color-border',
      '--color-neutral-1',
      '--color-neutral-9',
      '--color-neutral-10',
      '--glass-blur',
      '--glass-saturate',
      '--glass-surface-opacity',
      '--glass-panel-opacity',
      '--glass-scrim-opacity',
      '--glass-highlight',
      '--glass-haze-opacity',
      '--glass-haze-bleed',
      '--shadow-whisper',
    ];
    for (const v of providedByTheme) {
      // theme.ts 里以下发键的形态出现（'--xxx': 值）；断言带引号键名，
      // 避免注释里泛提变量名也能蒙混过关
      expect(themeTs, `${v} 应在 theme.ts 的 :root 块下发`).toContain(`'${v}'`);
    }

    // 动态守卫：镜像里出现的每个 var(--x)（剔除 --rk-glass-* 实现层调参钩子，
    // 它们自带默认值、不是主题层契约）都必须能在 theme.ts 找到下发——
    // 上游玻璃样式新增变量而主题层忘了补 = 此处红
    const consumed = new Set<string>();
    for (const match of glassCss.matchAll(/var\((--[a-z0-9-]+)/g)) {
      consumed.add(match[1]);
    }
    const contractVars = [...consumed].filter((v) => !v.startsWith('--rk-'));
    expect(contractVars.length).toBeGreaterThan(0);
    for (const v of contractVars) {
      expect(themeTs, `${v} 被玻璃样式消费，须在 theme.ts 有对应下发`).toContain(`'${v}'`);
    }
  });
});
