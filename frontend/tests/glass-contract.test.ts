// 玻璃材质契约守卫（纯文本断言，不渲染任何组件）：
// rakko-glass.css 是上游 design-system/src/glass.css 的逐字镜像，全项目 backdrop-filter
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

    // 任务书 3a 的 :root 下发清单（原 14 键）+ Aero 化新增的 12 个（--glass-rim …
    // --glass-text-glow），共 26 键，逐字断言。css 实际消费的非 --rk- 变量为 23 个；
    // --glass-scrim-opacity（主题层 MuiBackdrop 消费）、--glass-highlight（新配方已不消费，
    // 主题层仍下发）与 --shadow-whisper（haze 等场景仍用）不在玻璃样式表里，
    // 故总下发数比 css 消费数多 3。
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
      '--glass-rim',
      '--glass-rim-inner',
      '--glass-lip',
      '--glass-lip-under',
      '--glass-side',
      '--glass-bloom',
      '--glass-sheen-1',
      '--glass-sheen-2',
      '--glass-sheen-3',
      '--glass-sheen-4',
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
    // 旧「左上透镜」radial 已被 sheen 光泽取代：不得残留为第二层，否则上半部过曝
    expect(panel).not.toContain('120% 90% at 18% 0%');
    expect(panel).not.toContain('--glass-highlight');
  });

  it('5b. chrome 配方保留 radial，但换成 Aero 弧光，并带文字光晕', async () => {
    const glassCss = (await loadFs()).readFileSync('src/rakko-glass.css', 'utf-8');
    const chrome = blockOf(glassCss, "[data-glass='chrome'] {");
    expect(chrome).toContain('ellipse 150% 200% at 14% -74%');
    expect(chrome).toContain('var(--glass-sheen-1)');
    expect(chrome).toContain('--glass-lip');
    expect(chrome).toContain('--glass-text-glow');
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

  it('5e. 退化块底色换成不透明 --color-paper / --color-neutral-10，border 与 box-shadow 仍完整', async () => {
    const glassCss = (await loadFs()).readFileSync('src/rakko-glass.css', 'utf-8');
    const { supports, reduce } = degradeRegions(glassCss);
    for (const [region, name] of [
      [supports, '@supports-not（无 backdrop-filter）'] as const,
      [reduce, '@media reduce'] as const,
    ]) {
      for (const selector of ["[data-glass='chrome'] {", "[data-glass='panel'] {"]) {
        expect(blockOf(region, selector), `${name} 的 ${selector} 应是不透明纸底`).toContain('var(--color-paper);');
      }
      expect(blockOf(region, "[data-glass='inverse'] {"), `${name} 的 inverse 应是不透明反色底`).toContain('var(--color-neutral-10);');
      // 厚度边与光泽仍在：border / box-shadow 全量声明（退化不丢识别特征）
      const panel = blockOf(region, "[data-glass='panel'] {");
      expect(panel).toContain('border: 1px solid var(--glass-rim);');
      expect(panel).toContain('inset 0 0 0 1px var(--glass-rim-inner),');
      expect(panel).toContain('var(--glass-lift);');
      expect(blockOf(region, "[data-glass='chrome'] {")).toContain('inset 0 1px 0 var(--glass-lip),');
      const inverse = blockOf(region, "[data-glass='inverse'] {");
      expect(inverse).toContain('border: 1px solid');
      expect(inverse).toContain('var(--glass-lift);');
    }
  });

  it('5f. reduced-transparency 退化块把文字光晕置 none；无 blur 支持的退化块保留光晕', async () => {
    const glassCss = (await loadFs()).readFileSync('src/rakko-glass.css', 'utf-8');
    const { supports, reduce } = degradeRegions(glassCss);
    for (const selector of ["[data-glass='chrome'] {", "[data-glass='panel'] {"]) {
      expect(blockOf(reduce, selector), `${selector} 在 reduce 块应关掉文字光晕`).toContain('text-shadow: none;');
      expect(blockOf(supports, selector), `${selector} 在无 blur 块应保留文字光晕`).toContain('text-shadow: var(--glass-text-glow);');
    }
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
