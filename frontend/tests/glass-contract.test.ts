// 玻璃材质契约守卫（纯文本断言，不渲染任何组件）：
// rakko-glass.css 是 design-system/src/glass.css 的**本地 Aero 定制版**（基线为上游 main，
// 光泽与厚度边在本地改过，偏离记录见该文件头），全项目 backdrop-filter
// 的唯一合法宿主。本文件守住：四档配方、两条退化路径、滚动渐显规则都在位；
// 「-webkit- 前缀写法不得与无前缀 backdrop-filter 声明并列在同一规则块，前缀兜底
// 独立在 @supports 块里」；「backdrop-filter 只允许出现在一个样式表里」；以及
// 「css 消费的每个变量都已在 theme.ts 下发」这几条接线契约。
//
// 读文件机制：tests 无 node 类型声明（tsconfig types 只有 vite/client），不能静态
// import 'node:fs'；同时 vitest 的 css:false 会把 .css 的任何静态导入（含 ?raw）剥成
// 空串。所以源码文本读取分两路——theme.ts 走 vite ?raw（与 motion-styles.test.ts 同），
// rakko-glass.css 与 src/ 目录遍历走 vi.importActual('node:fs') 的真实 fs（运行时可用，
// 编译期不经模块解析，故无类型报错）。

import { describe, expect, it, vi } from 'vitest';
import themeTs from '../src/theme.ts?raw';
import { GLASS, GLASS_AERO, GLASS_NAV_RAIL_LIGHT } from '../src/rakko-tokens';

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

/** 从 CSS 文本取出某个规则块的完整文本：起始行 trim 后须与 selector 整行相等（避免误中
 * 选择器更长的变体，如 chrome 的 data-reveal 规则），再按大括号配对取到对应结束 }。 */
function blockOf(css: string, selector: string): string {
  const lines = css.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== selector) continue;
    const out: string[] = [];
    let depth = 0;
    let opened = false;
    for (let j = i; j < lines.length; j++) {
      out.push(lines[j]);
      depth += (lines[j].match(/\{/g) ?? []).length;
      depth -= (lines[j].match(/\}/g) ?? []).length;
      if (depth > 0) opened = true;
      if (opened && depth <= 0) break;
    }
    return out.join('\n');
  }
  throw new Error(`规则块未找到：${selector}`);
}

/** 两条退化块的文本切片：@supports-not（无 backdrop-filter）与 prefers-reduced-transparency */
function degradeRegions(css: string): { supports: string; reduce: string } {
  const supportsStart = css.indexOf('@supports not ((backdrop-filter');
  const reduceStart = css.indexOf('@media (prefers-reduced-transparency: reduce)');
  expect(supportsStart).toBeGreaterThan(-1);
  expect(reduceStart).toBeGreaterThan(-1);
  return {
    supports: css.slice(supportsStart, reduceStart),
    reduce: css.slice(reduceStart),
  };
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

describe('backdrop-filter 前缀写法契约', () => {
  it('4f. 同一规则块内不得并列 backdrop-filter 与 -webkit-backdrop-filter 声明', async () => {
    const glassCss = (await loadFs()).readFileSync('src/rakko-glass.css', 'utf-8');
    // Lightning CSS（Tailwind v4 与 Vite 的 CSS 压缩器）会把同一规则块内的前缀/无前缀
    // 声明当同一属性去重、只留后写的一条——并列写法会让生产构建的玻璃失去模糊。
    // 判定：把 CSS 按 } 粗切成块，任何一块同时出现两种声明即违规。
    // @supports 的条件表达式本身也带「backdrop-filter: blur(1px)」这类文本（退化判定
    // 那条还同时含 -webkit- 形态），它们不是声明；先剥掉条件再切块，避免把合规的
    // @supports 包裹块（内部只有前缀声明）误判。
    const conditionless = glassCss.replace(/@supports\s+[^{]*\{/g, '@supports {');
    const prefixed = /-webkit-backdrop-filter\s*:/i;
    // 无前缀判定要求属性名前不是词字符/连字符：剥掉条件后，前缀声明内部的
    // backdrop-filter 子串前面恰是连字符，不会被当成第二条无前缀声明
    const unprefixed = /(?:^|[^-\w])backdrop-filter\s*:/i;
    const offenders = conditionless
      .split('}')
      .filter((block) => prefixed.test(block) && unprefixed.test(block))
      .map((block) => block.replace(/\s+/g, ' ').trim().slice(0, 120));
    expect(offenders).toEqual([]);
  });

  it('4g. 老 WebKit 前缀兜底块有 @supports not (backdrop-filter: blur(1px)) 守卫', async () => {
    const glassCss = (await loadFs()).readFileSync('src/rakko-glass.css', 'utf-8');
    expect(glassCss).toContain('@supports not (backdrop-filter: blur(1px))');
  });
});

describe('变量下发守卫', () => {
  it('4e. rakko-glass.css 消费的每个 CSS 变量都能在 theme.ts 里找到下发', async () => {
    const glassCss = (await loadFs()).readFileSync('src/rakko-glass.css', 'utf-8');

    // :root 的下发清单，逐字断言，共 24 键：--color-* 四键 + --glass-* 十八键 + --shadow-whisper。
    // 不含 --glass-highlight：镜面高光那一档由 sheen 承担，本文件没有任何规则读它，
    // 下发就是死键（下方动态守卫只看 css 里 var() 真正消费到的变量，本来也扫不到它）。
    // css 实际消费的非 --rk- 变量为 22 个：--glass-scrim-opacity（主题层 MuiBackdrop
    // 消费）与 --shadow-whisper（haze 等场景仍用）不在玻璃样式表里，
    // 故总下发数比 css 消费数多 2。
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
      '--glass-haze-opacity',
      '--glass-haze-bleed',
      '--glass-rim',
      '--glass-rim-inner',
      '--glass-lip',
      '--glass-lip-under',
      '--glass-side',
      '--glass-bloom',
      '--glass-sheen-1',
      '--glass-sheen-2',
      '--glass-sheen-3',
      '--glass-lift',
      '--glass-text-glow',
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

describe('Aero 玻璃配方契约（新材质接线）', () => {
  it('5a. panel 配方含 rim / lip / bloom / lift / text-glow', async () => {
    const glassCss = (await loadFs()).readFileSync('src/rakko-glass.css', 'utf-8');
    const panel = blockOf(glassCss, "[data-glass='panel'] {");
    for (const v of ['--glass-rim', '--glass-lip', '--glass-bloom', '--glass-lift', '--glass-text-glow']) {
      expect(panel, `panel 配方应含 ${v}`).toContain(v);
    }
    // 不得残留「左上透镜」radial 作第二层：它与 sheen 叠起来上半部会过曝
    expect(panel).not.toContain('120% 90% at 18% 0%');
    expect(panel).not.toContain('--glass-highlight');
  });

  it('5b. chrome 与 panel 共用同一线性光泽，chrome 不用 radial 弧光', async () => {
    const glassCss = (await loadFs()).readFileSync('src/rakko-glass.css', 'utf-8');
    const chrome = blockOf(glassCss, "[data-glass='chrome'] {");
    const panel = blockOf(glassCss, "[data-glass='panel'] {");
    // chrome 与 panel 共用同一份线性光泽（横贯整条顶栏），都消费 --glass-sheen-1/2/3：
    // 共用一份表达式，顶栏与浮层在壁纸上才是同一种材质
    for (const [name, block] of [
      ['chrome', chrome],
      ['panel', panel],
    ] as const) {
      expect(block, `${name} 应含线性光泽`).toContain('linear-gradient(');
      expect(block, `${name} 应消费 sheen-1`).toContain('var(--glass-sheen-1)');
      expect(block, `${name} 应消费 sheen-2`).toContain('var(--glass-sheen-2)');
      expect(block, `${name} 应消费 sheen-3`).toContain('var(--glass-sheen-3)');
    }
    expect(chrome, 'chrome 不应再含 radial-gradient（弧光已弃）').not.toContain('radial-gradient');
    expect(chrome).toContain('--glass-lip');
    expect(chrome).toContain('--glass-text-glow');
  });

  it('5b2. 光泽是上亮下暗的三段渐变，不得出现 46%/47% 陡变', async () => {
    const glassCss = (await loadFs()).readFileSync('src/rakko-glass.css', 'utf-8');
    // 依据：装饰性分界必须落在真实结构边界上。46%→47% 的陡变在 ~60px 卡片正中切出一道
    // 硬线，只是噪音；三段收尾（sheen-2 到 45% 收窄、sheen-3 在 100% 处压暗）把分界挪到
    // 卡片上下缘，反射分界消失。
    for (const selector of ["[data-glass='chrome'] {", "[data-glass='panel'] {"]) {
      const block = blockOf(glassCss, selector);
      expect(block, `${selector} 的 sheen-2 应在 45% 收窄`).toContain('var(--glass-sheen-2) 45%');
      expect(block, `${selector} 的 sheen-3 应在 100% 压暗收尾`).toContain('var(--glass-sheen-3) 100%');
      expect(block, `${selector} 不得含 46%/47% 陡变`).not.toMatch(/(?:46|47)%/);
    }
  });

  it('5c. inverse 配方不含 --glass-text-glow（不压在壁纸上，不设文字光晕）', async () => {
    const glassCss = (await loadFs()).readFileSync('src/rakko-glass.css', 'utf-8');
    const inverse = blockOf(glassCss, "[data-glass='inverse'] {");
    expect(inverse).not.toContain('--glass-text-glow');
    expect(inverse).not.toContain('text-shadow');
  });

  it('5d. 文字光晕关闭钩子：data-glass-text="off" 置 none，等宽元素自动免除', async () => {
    const glassCss = (await loadFs()).readFileSync('src/rakko-glass.css', 'utf-8');
    const hook = blockOf(glassCss, "[data-glass-text='off'],");
    expect(hook).toContain('text-shadow: none');
    expect(hook).toContain("[data-glass-text='off'] *");
    // 等宽字由材质自动免除光晕；:where() 特异性为 0，不与消费方自己的 text-shadow 打架
    expect(glassCss).toContain('[data-glass] :where(code, pre, kbd, samp)');
  });

  it('5e. 退化块只换不透明底色，不声明 border / box-shadow——识别特征靠层叠从主配方保留', async () => {
    const glassCss = (await loadFs()).readFileSync('src/rakko-glass.css', 'utf-8');
    const { supports, reduce } = degradeRegions(glassCss);
    for (const [region, name] of [
      [supports, '@supports-not（无 backdrop-filter）'] as const,
      [reduce, '@media reduce'] as const,
    ]) {
      // 底色换成不透明纸底（背景叠层最后一段以纯色收尾，与上游原文一致）
      for (const selector of ["[data-glass='chrome'] {", "[data-glass='panel'] {"]) {
        expect(blockOf(region, selector), `${name} 的 ${selector} 应是不透明纸底`).toContain('var(--color-paper);');
      }
      expect(blockOf(region, "[data-glass='inverse'] {"), `${name} 的 inverse 应是不透明反色底`).toContain('var(--color-neutral-10);');
      // haze 主体在退化里也有 85% 纸色兜底（雾底不随玻璃一起消失）
      expect(region, `${name} 应给 haze 主体不透明纸色兜底`).toContain('var(--color-paper) 85%, transparent);');
      // 退化块只允许覆盖 background：主配方在前面同特异性先声明，谁后写谁生效——
      // 退化块里一旦出现 border / box-shadow / text-shadow，就会盖掉主配方的厚度边与光泽
      const overrides = /(^|\n)\s*(?:-webkit-)?(?:border|box-shadow|text-shadow)\s*:/m;
      for (const selector of ["[data-glass='chrome'] {", "[data-glass='panel'] {", "[data-glass='inverse'] {"]) {
        expect(blockOf(region, selector), `${name} 的 ${selector} 不得覆盖 border / box-shadow / text-shadow`).not.toMatch(overrides);
      }
    }
    // 识别特征本身在主配方里完整在位（退化块靠层叠沿用它们）
    const panel = blockOf(glassCss, "[data-glass='panel'] {");
    expect(panel).toContain('border: 1px solid var(--glass-rim);');
    expect(panel).toContain('inset 0 0 0 1px var(--glass-rim-inner),');
    expect(panel).toContain('var(--glass-lift);');
    expect(blockOf(glassCss, "[data-glass='chrome'] {")).toContain('inset 0 1px 0 var(--glass-lip),');
    const inverse = blockOf(glassCss, "[data-glass='inverse'] {");
    expect(inverse).toContain('border: 1px solid');
    expect(inverse).toContain('var(--glass-lift);');
  });

  it('5f. 光晕策略随上游：无 blur 支持时保留（主配方层叠），reduce 时经合并规则统一关掉', async () => {
    const glassCss = (await loadFs()).readFileSync('src/rakko-glass.css', 'utf-8');
    const { supports, reduce } = degradeRegions(glassCss);
    // 无 blur 的浏览器：退化块不碰 text-shadow，主配方的光晕声明原样生效
    for (const selector of ["[data-glass='chrome'] {", "[data-glass='panel'] {"]) {
      expect(blockOf(glassCss, selector), `${selector} 主配方应带文字光晕`).toContain('text-shadow: var(--glass-text-glow);');
    }
    expect(supports, '无 blur 退化块不得声明 text-shadow（光晕由主配方层叠保留）').not.toMatch(/(^|\n)\s*text-shadow\s*:/m);
    // reduce：光晕经一条合并规则（panel / chrome / inverse 并列）统一关掉
    const glowOff = reduce.split('}').filter((block) => block.includes('text-shadow: none;'));
    expect(glowOff).toHaveLength(1);
    expect(glowOff[0]).toContain("[data-glass='panel'],");
    expect(glowOff[0]).toContain("[data-glass='chrome'],");
    expect(glowOff[0]).toContain("[data-glass='inverse'] {");
  });

  it('5g. haze 原样未动：九团云、噪声贴图、两种形态的规则都在', async () => {
    const glassCss = (await loadFs()).readFileSync('src/rakko-glass.css', 'utf-8');
    const haze = blockOf(glassCss, "[data-glass='haze'] {");
    // cloud 的九团：三团主体 + 六团外围凸起，全部收在盒内
    const blobs = haze.split('\n').filter((line) => line.includes('radial-gradient('));
    expect(blobs).toHaveLength(9);
    expect(haze).toContain('--rk-glass-haze-cloud-core, 33%');
    expect(glassCss).toContain('feTurbulence');
    for (const selector of [
      "[data-glass='haze']::before {",
      "[data-glass='haze']::after {",
      "[data-glass='haze'][data-haze='veil']::before {",
      "[data-glass='haze'][data-haze='veil']::after {",
    ]) {
      expect(() => blockOf(glassCss, selector), `缺少 ${selector}`).not.toThrow();
    }
    // 雾边 = 九团并集 ∩ 分形噪声
    expect(glassCss).toContain('mask-composite: intersect');
  });
});

/** rgba(...) 尾部的 alpha：'rgba(255, 255, 255, 0.12)' → 0.12；非法写法直接判失败。
 *  白层之间的强弱比较全部走它，不比较字符串（'0.1' 与 '0.12' 的字典序会给出反向结论）。 */
function alphaOf(color: string): number {
  const m = color.match(/[\d.]+(?=\)$)/);
  expect(m, `${color} 应是以 alpha 收尾的 rgba()`).not.toBeNull();
  return parseFloat(m![0]);
}

describe('玻璃可读性契约', () => {
  it('blur 恒为 3px：Aero 的通透是刻意的，不是待优化项', () => {
    // Aero 玻璃要能透过去看见背景轮廓，糊成一片是 iOS 毛玻璃的路子；
    // 改它要先重做可读性实测，别当成模糊不够的优化点去调大。
    expect(GLASS.blur).toBe('3px');
  });

  it('panel 纸底 opacity >= 58', () => {
    // 实测地板：降到 50% 时正文对比度掉到 4.01，跌出 WCAG AA 4.5。
    expect(parseFloat(GLASS.panelOpacity)).toBeGreaterThanOrEqual(58);
  });

  it('haze 纸色 opacity >= 55', () => {
    // 51% 时 12px/600 分组标题在彩色壁纸下只有 3.96（够不到 AA 4.5）；
    // 55% 是全部过线的最小值（4.53–4.98）。
    expect(parseFloat(GLASS.hazeOpacity)).toBeGreaterThanOrEqual(55);
  });

  it('surface（chrome 顶栏）纸底 opacity >= 52', () => {
    // chrome 是四档里最透的，压在它上面的是 12px/500 底栏导航标签：
    // 45% 时三张实测壁纸有两张够不到 AA 4.5，彩色天空只有 3.80；
    // 52% 是全部过线的最小值（4.62–5.45）。
    expect(parseFloat(GLASS.surfaceOpacity)).toBeGreaterThanOrEqual(52);
  });

  it('文字光晕必须与主题反相：浅色白光晕 / 深色黑光晕', () => {
    // 这是硬约束，不是审美选择：深色主题若沿用白光晕，亮色正文与光晕同色被淹没，
    // 对比度从 4.69 崩到 1.07，等于看不见。
    expect(GLASS_AERO.light.textGlow).toContain('255, 255, 255');
    expect(GLASS_AERO.dark.textGlow).toContain('rgba(0, 0, 0');
  });

  it('sheen3（光泽底部的暗段）两个主题都必须是黑色', () => {
    // 玻璃要有明暗两端才立体：光泽顶部是白（sheen-1/2），底部必须显式给暗收尾。
    // 浅色主题尤其如此——白纸底 + 白高光 + 白光泽三层全白时通篇没有暗的一侧，卡片
    // 边界会溶进亮壁纸；sheen3 若写成白色就退回「浅色无暗侧」的老问题。
    expect(GLASS_AERO.light.sheen3).toMatch(/rgba\(0, 0, 0/);
    expect(GLASS_AERO.dark.sheen3).toMatch(/rgba\(0, 0, 0/);
  });

  it('两个主题的 textGlow 不相等', () => {
    // 防复制粘贴时忘了改深色那份（上面一条是内容约束，这一条防笔误）。
    expect(GLASS_AERO.dark.textGlow).not.toBe(GLASS_AERO.light.textGlow);
  });

  it('GLASS_AERO 的 light / dark 键集完全一致', () => {
    // 十二个键一个不少：防止将来加 token 只加一边，两套配方错位。
    expect(Object.keys(GLASS_AERO.dark)).toEqual(Object.keys(GLASS_AERO.light));
  });

  it('深色的白层一律不超过浅色：深色只削白，不加白', () => {
    // 浅色好看的前提是白纸 + 白高光同向；把同样多的白光晕搬到半透明黑纸上，行卡会变成
    // 一层发灰的雾膜。方向由这条守：深色的每个白层都必须 ≤ 浅色同名的白层
    // （rim / lip / lip-under / side / sheen-1 / sheen-2），不是「差不多」而是不得反超。
    // 具体取值钉在 tests/theme-dark-glass.test.ts。
    const whites = ['rim', 'lip', 'lipUnder', 'side', 'sheen1', 'sheen2'] as const;
    for (const key of whites) {
      expect(alphaOf(GLASS_AERO.dark[key]), `dark ${key} 不该比浅色更白`).toBeLessThanOrEqual(
        alphaOf(GLASS_AERO.light[key]),
      );
    }
    // bloom 是内发光：它在黑纸上是唯一的纯雾源，深色必须归零而不是留一点
    expect(alphaOf(GLASS_AERO.dark.bloom)).toBe(0);
    // 白层清单之外，深色的 rim-inner（暗向）必须比浅色更深：厚度边的另一半靠它
    expect(alphaOf(GLASS_AERO.dark.rimInner)).toBeGreaterThan(alphaOf(GLASS_AERO.light.rimInner));
  });
});

// 桌面常驻侧栏（permanent Drawer，data-glass="chrome"）的浅色削白改写：上游只为 ~64px
// 高的顶栏定义了 chrome 档，光泽止点写成 45% 百分比；同一配方落在满屏高的侧栏上，那道
// 分界横穿屏幕中线，上半屏成一层白纱。改写集中在 GLASS_NAV_RAIL_LIGHT（落点是 AppShell
// 的 navRailGlassSx，作用范围由 app-shell.test.tsx 守卫）。本组钉的是「削了什么」与
// 「什么没被顺手削掉」——观感要由真机判定，文本只能钉住这几条不变量。
describe('桌面侧栏浅色削白契约', () => {
  it('改写恰好是三个白（sheen-1 / sheen-2 / lip），值逐字写死', () => {
    // 键集逐字相等而不是「包含」：多出一个键就说明动了本次范围外的层（暗端 / 纸色 / rim）。
    expect(Object.keys(GLASS_NAV_RAIL_LIGHT).sort()).toEqual([
      '--glass-lip',
      '--glass-sheen-1',
      '--glass-sheen-2',
    ]);
    expect(GLASS_NAV_RAIL_LIGHT['--glass-sheen-1']).toBe('rgba(255, 255, 255, 0.12)');
    expect(GLASS_NAV_RAIL_LIGHT['--glass-sheen-2']).toBe('rgba(255, 255, 255, 0.05)');
    expect(GLASS_NAV_RAIL_LIGHT['--glass-lip']).toBe('rgba(255, 255, 255, 0.22)');
  });

  it('改写不含暗端与纸色键：削白不许顺手改纸色地板或暗侧', () => {
    // --glass-rim 不在此列是因为 chrome 配方根本不消费它（只有 panel 消费），动它等于
    // 动每一行列表卡片；其余四个键都是「削白」这个动作的越界对象。
    const keys = Object.keys(GLASS_NAV_RAIL_LIGHT);
    for (const forbidden of [
      '--glass-sheen-3',
      '--glass-rim-inner',
      '--glass-panel-opacity',
      '--glass-surface-opacity',
      '--glass-haze-opacity',
    ]) {
      expect(keys, `${forbidden} 不在本次削白范围内`).not.toContain(forbidden);
    }
  });

  it('三个白值都严格小于浅色原值（防手滑写成更白）', () => {
    // 用 alpha 数值比较而不是字符串不等：写成更大的白会让侧栏比现状更白，正是这次要修的
    // 反方向；「严格小于」把方向也钉住。
    const pairs = [
      ['--glass-sheen-1', GLASS_AERO.light.sheen1],
      ['--glass-sheen-2', GLASS_AERO.light.sheen2],
      ['--glass-lip', GLASS_AERO.light.lip],
    ] as const;
    for (const [key, original] of pairs) {
      expect(
        alphaOf(GLASS_NAV_RAIL_LIGHT[key]),
        `${key} 应比 GLASS_AERO.light 的同名原值更弱`,
      ).toBeLessThan(alphaOf(original));
    }
  });

  it('纸色 alpha 三档不变：削白不动可读性地板', () => {
    // 58% / 52% / 55% 都是实测出来的 WCAG AA 地板（见上面几条 >= 用例的注释）；削白若
    // 顺手把纸色一起降下来，整块玻璃的正文对比度跟着掉。这三条是本次改动的范围守卫。
    expect(GLASS.panelOpacity).toBe('58%');
    expect(GLASS.surfaceOpacity).toBe('52%');
    expect(GLASS.hazeOpacity).toBe('55%');
  });

  it('暗端（sheen-3）与内暗边（rim-inner）不变', () => {
    // 浅色玻璃的立体感来自显式的暗端：白纸底 + 白高光 + 白光泽三层全白时通篇没有暗的
    // 一侧，会溶进亮壁纸。削白时把暗端一并削掉等于退回「浅色无暗侧」的老问题。
    expect(GLASS_AERO.light.sheen3).toBe('rgba(0, 0, 0, 0.035)');
    expect(GLASS_AERO.light.rimInner).toBe('rgba(0, 0, 0, 0.14)');
  });

  it('改写不落在 theme.ts：那会作用到将来任何 Drawer', () => {
    // 落点必须是 AppShell 那一块常驻侧栏的 paper。写进 theme.ts 的 MuiDrawer.styleOverrides.paper
    // 会连临时抽屉（以及将来任何 Drawer）一起改；这里只禁止把常量名带过去，不去扫
    // --glass-sheen-1——theme.ts 本来就负责把那个变量下发到 :root。
    expect(themeTs).not.toContain('GLASS_NAV_RAIL_LIGHT');
  });
});
