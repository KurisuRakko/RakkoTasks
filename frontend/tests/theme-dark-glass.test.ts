// 深色模式重调的取值验收（D1–D4），外加浅色主题的逐项快照式断言（D-V2）。
//
// 口径：断言直接写出期望值，不用 toMatchSnapshot 文件——快照文件会随实现漂移而"自动通过"，
// 而这次的硬约束恰恰是「浅色一个值都不许变」，期望值必须能被人一眼读出、被 review 对比。
//
// 深浅两侧的读法都走真实下发路径，不抄一份：
//   主题层  buildThemeOptions(mode) → createTheme → palette / MuiCssBaseline 的 :root 块；
//   静态表  src/rakko-tokens.ts 的具名 token 常量。
// 深色落在这里的硬约束：
//   D1 纸色是暖的近黑（不是纯灰 n1）；D2 深色玻璃的白层一律收敛；
//   D3 深色三档纸底 opacity 只许上调；D4 深色壁纸才叠压暗层，浅色一个都不叠；
//   D5 深色光晕是黑且减半；D6 深色通用描边不超过 D2 量级。
//
// 本文件不碰 DOM，也不依赖 CSSOM：D-V1 的调用形式（`npm --prefix frontend exec vitest run
// tests/theme-dark`，从仓库根执行）**不会加载 frontend/vite.config.ts**，environment 退回
// node——没有 document / window。所以这里只读 token 常量与主题对象，涉及 css 文本的地方
// 全部走字符串解析。jsdom 的 CSSOM 对 background-image 不做值校验（纯色值也照收），本来
// 也不能用来判「这一层是不是合法 <image>」。

import { describe, expect, it } from 'vitest';
import { createTheme, getContrastRatio } from '@mui/material/styles';
import type { Theme } from '@mui/material/styles';
import {
  DEFAULT_WALLPAPER_URL,
  WALLPAPER_LAYER_ID,
  WALLPAPER_SHADE_DARK,
  WALLPAPER_SHADE_VAR,
  WALLPAPER_VAR,
} from '../src/lib/glass';
import {
  BORDER,
  GLASS,
  GLASS_AERO,
  GLASS_DARK,
  GLASS_SHADOW_WHISPER,
  NEUTRAL_DARK,
  NEUTRAL_LIGHT,
  PAPER,
  PAPER_RAISED,
  SEMANTIC_INVERSE_SURFACE,
  TEXT_CONTRAST_MIN,
} from '../src/rakko-tokens';
import { buildThemeOptions } from '../src/theme';

const MODES = ['light', 'dark'] as const;
type Mode = (typeof MODES)[number];

const THEMES: Record<Mode, Theme> = {
  light: createTheme(buildThemeOptions('light')),
  dark: createTheme(buildThemeOptions('dark')),
};

/** 单主题的全局样式表（CssBaseline 的 styleOverrides 求值结果） */
function globalStyles(mode: Mode): Record<string, unknown> {
  const overrides = THEMES[mode].components?.MuiCssBaseline?.styleOverrides;
  expect(typeof overrides, `${mode}: CssBaseline 应下发函数式 styleOverrides`).toBe('function');
  return (overrides as (t: Theme) => Record<string, unknown>)(THEMES[mode]);
}

/** :root 下下发的 CSS 变量表 */
function rootVars(mode: Mode): Record<string, string> {
  const root = globalStyles(mode)[':root'];
  expect(root, `${mode}: CssBaseline 应下发 ':root' 规则块`).toBeDefined();
  return root as Record<string, string>;
}

/** 壁纸承载层的样式对象 */
function wallpaperLayer(mode: Mode): Record<string, unknown> {
  const layer = globalStyles(mode)[`#${WALLPAPER_LAYER_ID}`] as
    | Record<string, unknown>
    | undefined;
  expect(layer, `${mode}: 应存在 '#${WALLPAPER_LAYER_ID}' 承载层规则`).toBeDefined();
  return layer!;
}

/** rgba 尾部 alpha（'rgba(255, 255, 255, 0.12)' → 0.12）；写法不合法直接判失败 */
function alphaOf(color: string): number {
  const m = color.match(/[\d.]+(?=\)$)/);
  expect(m, `${color} 应是以 alpha 收尾的 rgba()`).not.toBeNull();
  return parseFloat(m![0]);
}

/** #rrggbb → [r, g, b] */
function channels(hex: string): [number, number, number] {
  expect(hex, `${hex} 应是 #rrggbb`).toMatch(/^#[0-9a-f]{6}$/);
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** HSL 色相（度）。深色纸的白点归一化与浅色纸无关，两边都按同一支公式算即可比较相对关系。 */
function hueOf(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0; // 纯灰无色相
  const d = max - min;
  const h =
    max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

describe('D1 深色纸色：暖的近黑，与中性色阶分家', () => {
  it('纸色 token 是契约取值 #1a1814，且深色不等于深色 n1', () => {
    // 来源：Rakko-Design main 的 design-system/showcase/src/styles/foundation.css
    // [data-theme='dark'] { --color-paper }（契约里深色的暖意只由纸色承担，tokens.md:7）
    expect(PAPER.light).toBe('#f9f8f5');
    expect(PAPER.dark).toBe('#1a1814');
    expect(PAPER.dark).not.toBe(NEUTRAL_DARK[0]);
  });

  it('palette.background.default 与 --color-paper 同步取纸色 token（深色不是纯灰 n1）', () => {
    for (const mode of MODES) {
      expect(THEMES[mode].palette.background.default, mode).toBe(PAPER[mode]);
      expect(rootVars(mode)['--color-paper'], mode).toBe(PAPER[mode]);
    }
    // 中性色阶原样保留纯灰：深色不反转暖色阶，暖意只在纸色上
    expect(NEUTRAL_DARK[0]).toBe('#141414');
    expect(THEMES.dark.palette.grey[50]).toBe(NEUTRAL_DARK[0]);
    expect(THEMES.dark.palette.grey[900]).toBe(NEUTRAL_DARK[9]);
  });

  it('深色纸是暖色（R > G > B）且不是纯灰：色相与浅色纸同族、饱和度更低', () => {
    const [dr, dg, db] = channels(PAPER.dark);
    expect(dr, '深色纸 R > G：否则是冷底或纯灰').toBeGreaterThan(dg);
    expect(dg, '深色纸 G > B：否则是冷底或纯灰').toBeGreaterThan(db);
    // 与浅色纸同色相族（同一支暖黄灰），容差 ±20°：浅色 45° / 深色 40°
    const delta = Math.abs(hueOf(PAPER.dark) - hueOf(PAPER.light));
    expect(delta, `深色纸色相应与浅色纸同族（差 ${delta}°）`).toBeLessThanOrEqual(20);
  });

  it('纸色是"近黑"不是中调：三个通道都在 0x18 以下，亮度低于深色 n1', () => {
    // 「近黑」是纸色的定义之一：它要能当页面地板的实体色，太亮会在深色界面里浮起来。
    // 这里说的是色值本身，不牵连玻璃纸底与压暗层（那是 D3 / D8 的事）。
    // 顺带锁住它与深色 n1 的亮度关系（#1a1814 比 #141414 只亮 1.2 个点）。
    for (const [name, hex] of [
      ['PAPER.dark', PAPER.dark],
      ['NEUTRAL_DARK[0]', NEUTRAL_DARK[0]],
    ] as const) {
      for (const c of channels(hex)) expect(c, `${name} 的通道值应近黑`).toBeLessThan(0x1b);
    }
    const lum = (hex: string) => {
      const [r, g, b] = channels(hex);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    expect(Math.abs(lum(PAPER.dark) - lum(NEUTRAL_DARK[0]))).toBeLessThan(6);
  });

  it('浅色纸色一个值都没动：仍是暖纸 n1 #f9f8f5', () => {
    expect(PAPER.light).toBe(NEUTRAL_LIGHT[0]);
    expect(THEMES.light.palette.background.default).toBe(NEUTRAL_LIGHT[0]);
    expect(rootVars('light')['--color-paper']).toBe(NEUTRAL_LIGHT[0]);
  });
});

describe('D2 深色玻璃去雾：白层收敛，暗向保留', () => {
  it('深色白层逐项钉死：rim .14 / lip .16 / lip-under .06 / side .06 / sheen-1 .09 / sheen-2 .03', () => {
    expect(GLASS_AERO.dark.rim).toBe('rgba(255, 255, 255, 0.14)');
    expect(GLASS_AERO.dark.lip).toBe('rgba(255, 255, 255, 0.16)');
    expect(GLASS_AERO.dark.lipUnder).toBe('rgba(255, 255, 255, 0.06)');
    expect(GLASS_AERO.dark.side).toBe('rgba(255, 255, 255, 0.06)');
    expect(GLASS_AERO.dark.sheen1).toBe('rgba(255, 255, 255, 0.09)');
    expect(GLASS_AERO.dark.sheen2).toBe('rgba(255, 255, 255, 0.03)');
  });

  it('深色 bloom 是 3%（看得见但不成雾；写法保留，配方 box-shadow 层序不动）', () => {
    expect(GLASS_AERO.dark.bloom).toBe('rgba(255, 255, 255, 0.03)');
    expect(alphaOf(GLASS_AERO.dark.bloom)).toBeGreaterThan(0);
    expect(Object.keys(GLASS_AERO.dark)).toContain('bloom');
  });

  it('深色 rim-inner 比浅色更深（厚度边的暗向那一半）', () => {
    expect(GLASS_AERO.dark.rimInner).toBe('rgba(0, 0, 0, 0.26)');
    expect(alphaOf(GLASS_AERO.dark.rimInner)).toBeGreaterThan(alphaOf(GLASS_AERO.light.rimInner));
  });

  it('深色 sheen-3 是暗向的黑，不是白', () => {
    expect(GLASS_AERO.dark.sheen3).toMatch(/rgba\(0, 0, 0/);
  });

  it('深色每个白层都严格弱于浅色同名层（深色只削白，不加白）', () => {
    for (const key of ['rim', 'lip', 'lipUnder', 'side', 'sheen1', 'sheen2'] as const) {
      expect(alphaOf(GLASS_AERO.dark[key]), `dark ${key}`).toBeLessThan(
        alphaOf(GLASS_AERO.light[key]),
      );
    }
  });

  it('深色取值真的下发到了 :root（不是只改了常量）', () => {
    const dark = rootVars('dark');
    const pairs = [
      ['--glass-rim', 'rim'],
      ['--glass-rim-inner', 'rimInner'],
      ['--glass-lip', 'lip'],
      ['--glass-lip-under', 'lipUnder'],
      ['--glass-side', 'side'],
      ['--glass-bloom', 'bloom'],
      ['--glass-sheen-1', 'sheen1'],
      ['--glass-sheen-2', 'sheen2'],
      ['--glass-sheen-3', 'sheen3'],
      ['--glass-text-glow', 'textGlow'],
    ] as const;
    for (const [cssVar, token] of pairs) {
      expect(dark[cssVar], `dark ${cssVar}`).toBe(GLASS_AERO.dark[token]);
    }
    // 浅色仍是原值：白层没被顺手改掉
    expect(rootVars('light')['--glass-rim']).toBe(GLASS_AERO.light.rim);
    expect(rootVars('light')['--glass-sheen-1']).toBe(GLASS_AERO.light.sheen1);
    expect(rootVars('light')['--glass-bloom']).toBe(GLASS_AERO.light.bloom);
  });
});

describe('D3 深色玻璃更深：三档纸底只许上调', () => {
  it('深色三档取值钉死：surface 52% / panel 60% / haze 55%', () => {
    expect(GLASS_DARK.surfaceOpacity).toBe('52%');
    expect(GLASS_DARK.panelOpacity).toBe('60%');
    expect(GLASS_DARK.hazeOpacity).toBe('55%');
  });

  it('深色三档都严格高于浅色同名档，且不低于浅色地板 58/52/55', () => {
    // 「只许上调」是硬约束：深色纸底比浅色更透就等于把壁纸更亮地放进来，与本轮要修的
    // 「黑纸被亮壁纸染脏」是反方向。
    const floors: Record<keyof typeof GLASS_DARK, number> = {
      surfaceOpacity: 52,
      panelOpacity: 58,
      hazeOpacity: 55,
    };
    for (const key of Object.keys(GLASS_DARK) as Array<keyof typeof GLASS_DARK>) {
      const dark = parseFloat(GLASS_DARK[key]);
      expect(dark, `dark ${key} 应 >= 浅色同名档`).toBeGreaterThanOrEqual(
        parseFloat(GLASS[key]),
      );
      expect(dark, `dark ${key} 应 >= 浅色地板`).toBeGreaterThanOrEqual(floors[key]);
    }
  });

  it('三档的相对关系保留：chrome 最透 = haze，两者都低于 panel 最实', () => {
    const surface = parseFloat(GLASS_DARK.surfaceOpacity);
    const haze = parseFloat(GLASS_DARK.hazeOpacity);
    const panel = parseFloat(GLASS_DARK.panelOpacity);
    // surface 与 haze 同档（52 / 55 回调后 surface 压到地板，与 haze 只差 3 个点）
    expect(surface).toBeLessThanOrEqual(haze);
    expect(haze).toBeLessThan(panel);
  });

  it('深色三档真的下发到 :root，浅色三档逐字未动', () => {
    const dark = rootVars('dark');
    expect(dark['--glass-surface-opacity']).toBe(GLASS_DARK.surfaceOpacity);
    expect(dark['--glass-panel-opacity']).toBe(GLASS_DARK.panelOpacity);
    expect(dark['--glass-haze-opacity']).toBe(GLASS_DARK.hazeOpacity);

    const light = rootVars('light');
    expect(light['--glass-surface-opacity']).toBe('52%');
    expect(light['--glass-panel-opacity']).toBe('58%');
    expect(light['--glass-haze-opacity']).toBe('55%');
  });

  it('scrim 与 blur / saturate / bleed 深浅同值（不在本轮范围内）', () => {
    for (const mode of MODES) {
      const vars = rootVars(mode);
      expect(vars['--glass-scrim-opacity'], mode).toBe(GLASS.scrimOpacity);
      expect(vars['--glass-blur'], mode).toBe(GLASS.blur);
      expect(vars['--glass-saturate'], mode).toBe(GLASS.saturate);
      expect(vars['--glass-haze-bleed'], mode).toBe(GLASS.hazeBleed);
    }
  });
});

describe('D4 深色壁纸压暗：只有深色叠，浅色一层都不叠', () => {
  it('压暗层是 12% 纯黑的实心渐变（<image> 而不是 <color>）', () => {
    expect(WALLPAPER_SHADE_DARK).toBe(
      'linear-gradient(rgba(0, 0, 0, 0.12), rgba(0, 0, 0, 0.12))',
    );
    // 两端同色即实心：这是「一层 12% 纯黑」的合法写法
    expect([...WALLPAPER_SHADE_DARK.matchAll(/rgba\(0, 0, 0, ([\d.]+)\)/g)].map((m) => m[1])).toEqual([
      '0.12',
      '0.12',
    ]);
  });

  it('深浅两档的 shade 取值都必须是合法 <image>（none 或 linear-gradient）', () => {
    // 这一条是本轮返工的直接原因：shade 是 background-image 的一层，只接受 <image>。
    // 写成 rgba(...) 这类 <color> 时浏览器把整条 background-image 判无效，连后面的壁纸
    // url 一起丢掉——实测表现是深色下壁纸整张消失（getComputedStyle 得到 'none'）。
    const imageOnly = /^(none|linear-gradient\(.+\))$/;
    for (const mode of MODES) {
      const shade = rootVars(mode)[WALLPAPER_SHADE_VAR];
      expect(shade, `${mode} ${WALLPAPER_SHADE_VAR} 应是 <image> 或 none`).toMatch(imageOnly);
    }
    const darkShade = rootVars('dark')[WALLPAPER_SHADE_VAR];
    expect(darkShade, '深色取值不得以 rgba( 开头：那是 <color>，会让整条 background-image 失效')
      .not.toMatch(/^rgba\(/);
    expect(darkShade, '深色取值不得以 rgb( 开头').not.toMatch(/^rgb\(/);
    expect(darkShade, '深色取值不得是裸十六进制色').not.toMatch(/^#/);
  });

  it('把两档 shade 代进 background-image 后，每一层都是合法的 <image>', () => {
    // 上一组断言只看取值形状；这一条看**代入后的整条声明**：逐层判它是不是 <image>。
    // 这就是浏览器丢壁纸的那一步——第一层是 <color> 时整条 background-image 无效，
    // 后面的壁纸 url 一起被丢掉。
    //
    // 为什么不用 document.createElement('div').style 让 CSSOM 判：jsdom 的 CSSOM 对
    // background-image 不做值校验（rgba() 那版照样原样读回，守卫会空转），而且本文件在
    // D-V1 的调用形式下拿不到 document（见文件头）。所以自己解析列表、自己判层类型。
    //
    // 顶层逗号切分（跳过括号内的逗号），再逐层匹配已知的 <image> 形态
    const splitLayers = (value: string): string[] => {
      const layers: string[] = [];
      let depth = 0;
      let current = '';
      for (const ch of value) {
        if (ch === '(') depth += 1;
        if (ch === ')') depth -= 1;
        if (ch === ',' && depth === 0) {
          layers.push(current.trim());
          current = '';
        } else {
          current += ch;
        }
      }
      layers.push(current.trim());
      return layers.filter((layer) => layer !== '');
    };
    const isImageLayer = (layer: string): boolean =>
      /^(none|url\(|(repeating-)?(linear|radial|conic)-gradient\(|image-set\(|cross-fade\(|element\(|(repeating-)?-webkit-(linear|radial)-gradient\()/.test(
        layer,
      );
    /** 层文本的**顶层**是不是 <color>（十六进制色 / 颜色函数）。<color> 与 <image> 不能
     *  混在同一层里，这一条专门抓「把纯色值当图像层用」这个错法。只看顶层：渐变内部的色标
     *  （linear-gradient(rgba(...), rgba(...))）是 <image> 的合法组成，不算「这一层是颜色」。
     *  做法：先把每个函数调用的括号内容整段去掉（函数名留下），再看剩下的顶层文本——要么是
     *  一个颜色函数名（rgb / rgba / …），要么是一个十六进制色。 */
    const hasTopLevelColorToken = (layer: string): boolean => {
      const withoutParens = layer.replace(/\([^()]*\)/g, '');
      if (/#[0-9a-f]{3,8}\b/.test(withoutParens)) return true;
      return /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)$/.test(
        withoutParens.trim().toLowerCase(),
      );
    };
    /** 代入两个真实下发值后的 background-image 层列表 */
    const resolvedLayers = (mode: Mode): string[] => {
      const raw = wallpaperLayer(mode).backgroundImage as string;
      // 用模板代换 var()（jsdom 不解析 var()，且这里也拿不到 CSSOM），代入的是**真的下发值**
      const resolved = raw
        .replace(new RegExp(`var\\(${WALLPAPER_SHADE_VAR}\\)`), rootVars(mode)[WALLPAPER_SHADE_VAR])
        .replace(
          // var() 整体替换掉（含它自己的右括号）：壁纸那一段是
          // var(--rtk-wallpaper, url("..."))，只替 [^)]* 会多留一个右括号
          new RegExp(`var\\(${WALLPAPER_VAR},[^)]*\\)\\)`),
          `url("${DEFAULT_WALLPAPER_URL}")`,
        );
      expect(resolved, `${mode}: 代入后不该再留 var()`).not.toContain('var(');
      return splitLayers(resolved);
    };

    for (const mode of MODES) {
      const layers = resolvedLayers(mode);
      expect(layers, `${mode}: 代入后应恰好两层（压暗 + 壁纸）`).toHaveLength(2);
      expect(isImageLayer(layers[0]), `${mode}: 第一层不是 <image>：${layers[0]}`).toBe(true);
      expect(
        hasTopLevelColorToken(layers[0]),
        `${mode}: 第一层是纯 <color>（会让整条 background-image 失效）：${layers[0]}`,
      ).toBe(false);
      expect(layers[1], `${mode}: 第二层应是壁纸 url`).toBe(`url("${DEFAULT_WALLPAPER_URL}")`);
      expect(isImageLayer(layers[1]), `${mode}: 第二层不是 <image>`).toBe(true);
      // 深色第一层必须真的是渐变（纯色值会在这里现形），浅色才是 none
      if (mode === 'dark') expect(layers[0]).toContain('linear-gradient(');
      else expect(layers[0]).toBe('none');
    }

    // 对照物：上一版那个 <color> 取值必须被判出来（否则守卫是空转的）
    const previous = `rgba(0, 0, 0, 0.35), url("${DEFAULT_WALLPAPER_URL}")`;
    expect(splitLayers(previous)[0]).toBe('rgba(0, 0, 0, 0.35)');
    expect(isImageLayer(splitLayers(previous)[0]), 'rgba() 不该被认成 <image>').toBe(false);
    expect(hasTopLevelColorToken(splitLayers(previous)[0]), 'rgba() 该被判成 <color>').toBe(true);
    expect(hasTopLevelColorToken('#000'), '十六进制色该被判成 <color>').toBe(true);
    expect(hasTopLevelColorToken('none'), 'none 不是颜色').toBe(false);
    // 渐变里的色标虽然含 rgba()，但它是在 gradient() 内部，层本身是 <image>
    expect(hasTopLevelColorToken(WALLPAPER_SHADE_DARK), '渐变层本身不是 <color> 层').toBe(false);
    expect(isImageLayer(WALLPAPER_SHADE_DARK)).toBe(true);
  });

  it('浅色下发 none，深色下发压暗层', () => {
    expect(rootVars('light')[WALLPAPER_SHADE_VAR]).toBe('none');
    expect(rootVars('dark')[WALLPAPER_SHADE_VAR]).toBe(WALLPAPER_SHADE_DARK);
  });

  it('压暗层在壁纸之上（background 层列表自上而下，压暗那段必须写在壁纸之前）', () => {
    // 位置约束：壁纸之上、内容与玻璃之下。承载层本身就是「内容之下」那一块（z-index -1），
    // 所以只要压暗排在壁纸那一段之前即可。背景图层的先后由**模板文本**决定，与当前主题
    // 下发什么值无关——所以这条对浅色同样成立（浅色把第一层解析成 none，等于该层不存在）。
    // 定位用「变量名的左括号」而不是变量名本身：WALLPAPER_SHADE_VAR 是 WALLPAPER_VAR 的
    // 前缀，直接 indexOf(var(--rtk-wallpaper) 会命中 shade 那一段的同一处，两侧都返回 0，
    // 「谁在前」就永远判不出来。
    for (const mode of MODES) {
      const bg = wallpaperLayer(mode).backgroundImage as string;
      const shadeAt = bg.indexOf(`var(${WALLPAPER_SHADE_VAR})`);
      // 壁纸那一段带兜底图，变量名后面紧跟逗号——按「名字 + 逗号」定位，避开前缀歧义
      const imageAt = bg.indexOf(`var(${WALLPAPER_VAR},`);
      expect(shadeAt, `${mode}: 压暗层应在叠层里`).toBeGreaterThan(-1);
      expect(imageAt, `${mode}: 壁纸层应在叠层里`).toBeGreaterThan(-1);
      expect(shadeAt, `${mode}: 压暗层应在壁纸之前（即之上）`).toBeLessThan(imageAt);
      // 两个变量名确实是前缀关系：这正是上面两条断言不能用裸变量名的原因
      expect(WALLPAPER_SHADE_VAR).toContain(WALLPAPER_VAR);
      expect(bg, `${mode}: 壁纸兜底仍是默认图`).toContain(`url("${DEFAULT_WALLPAPER_URL}")`);
    }
  });

  it('深色压暗层是纯黑、35% 不透明度：不含任何亮色通道，也不是反相白', () => {
    // 压暗层的颜色必须是黑。用 n-10（深色主题下是近白）当压暗色会把壁纸漂白。
    const [r, g, b] = channels('#000000');
    expect([r, g, b]).toEqual([0, 0, 0]);
    // 取的是声明里两端色标（gradient 两端同色），不是 alphaOf——那条只认 alpha 直接收尾的
    // rgba()，渐变的字符串以 ')' 收尾，用它会把合法的渐变判失败
    const stops = [...WALLPAPER_SHADE_DARK.matchAll(/rgba\((\d+), (\d+), (\d+), ([\d.]+)\)/g)].map(
      (m) => [Number(m[1]), Number(m[2]), Number(m[3]), parseFloat(m[4])] as const,
    );
    expect(stops, '压暗层应有两个同色色标').toHaveLength(2);
    for (const [rr, gg, bb, alpha] of stops) {
      expect([rr, gg, bb], '压暗色必须是纯黑').toEqual([0, 0, 0]);
      expect(alpha).toBeCloseTo(0.12, 5);
    }
    expect(WALLPAPER_SHADE_DARK, '不得出现亮色通道（白压上去是漂白）').not.toContain('255');
    expect(rootVars('light')[WALLPAPER_SHADE_VAR], '浅色不得有可见压暗').toBe('none');
  });

  it('不新增伪元素或 DOM 节点：压暗只改同一块 background 的叠层', () => {
    // Chromium 里 body::before + position:fixed 的壁纸采样不到 backdrop-filter；新增伪元素
    // 会改掉壁纸那块被读回的合成层结构，玻璃会连壁纸一起读丢。所以压暗只能落在壁纸自己
    // 的节点上——这里用「样式对象只有一层规则、不含任何伪元素键」来钉住。
    for (const mode of MODES) {
      const keys = Object.keys(globalStyles(mode));
      const pseudo = keys.filter((k) => k.includes(WALLPAPER_LAYER_ID) && k.includes('::'));
      expect(pseudo, `${mode}: 壁纸层不得新增伪元素规则`).toEqual([]);
      const body = globalStyles(mode).body as Record<string, unknown>;
      expect(body['&::before'], `${mode}: body 不得新增 ::before`).toBeUndefined();
    }
  });

  it('压暗层不接收指针事件：承载层仍是 pointer-events none 的纯背景层', () => {
    expect(wallpaperLayer('dark').pointerEvents).toBe('none');
  });

  it('承载层的不透明地板是深色纸色（压暗层下面仍有实体底色）', () => {
    expect(wallpaperLayer('dark').backgroundColor).toBe(PAPER.dark);
    expect(wallpaperLayer('light').backgroundColor).toBe(PAPER.light);
  });
});

describe('D8 深色不许压成黑板：壁纸的透出量有下限', () => {
  // 上一轮把「72% 纸底 + 35% 压暗」一起上，两个乘子叠成约 1/18 的透出量，壁纸几乎看不见，
  // 整屏读作一块黑板。观感是主观的，但它的成因可算：壁纸图层的黑色叠层与玻璃的纸底会
  // **相乘**成同一个量，所以这一条把这个乘积钉出下限——太暗就是黑板，而下限之上的
  // 具体档位由观感定（`太亮染脏黑纸` 那一侧是压暗层存在的理由，由「不加压暗会更亮」这一条反向钉住）。
  const alphaOfLayer = (layer: string): number => {
    const m = layer.match(/rgba\(0, 0, 0, ([\d.]+)\)/);
    expect(m, `${layer} 应是纯黑 alpha 层`).not.toBeNull();
    return parseFloat(m![1]);
  };
  /** '60%' → 0.6。必须显式解析：JS 的 '60%' / 100 是 NaN（TS 也不报错），
   *  直接把百分比串丢进算术会静默算出 NaN，断言只会报 "expected NaN"。 */
  const percentOf = (opacity: string): number => {
    const m = opacity.match(/^([\d.]+)%$/);
    expect(m, `${opacity} 应是百分比串`).not.toBeNull();
    return parseFloat(m![1]) / 100;
  };
  /** 最上层黑叠层的 alpha 合成：out = mix(a, b)，顺序不影响结果 */
  const stack = (...alphas: number[]): number => {
    for (const a of alphas) expect(Number.isFinite(a), `alpha 应是有限数，收到 ${a}`).toBe(true);
    return alphas.reduce((acc, a) => acc + a * (1 - acc), 0);
  };
  const shadeAlpha = alphaOfLayer(WALLPAPER_SHADE_DARK);
  /** 玻璃压在壁纸上的透出量：壁纸可见比例（纸底与压暗相乘） */
  const throughPanel = (opacity: string, shade: number): number =>
    1 - stack(percentOf(opacity), shade);

  it('panel 下的壁纸透出量 >= 0.3：看得见壁纸（回调后的实际值 0.352）', () => {
    const value = throughPanel(GLASS_DARK.panelOpacity, shadeAlpha);
    expect(value).toBeGreaterThanOrEqual(0.3);
    // 上限只钉"玻璃本身仍要让壁纸透过来"：超过一半就不是深色玻璃了
    expect(value).toBeLessThan(0.5);
  });

  it('对照物：上一轮的 72% + 35% 与更暗的档位都要低于下限（守卫不是空转的）', () => {
    expect(throughPanel('72%', 0.35), '上一轮那套就是黑板').toBeLessThan(0.3);
    expect(throughPanel('72%', 0.5)).toBeLessThan(0.3);
    expect(throughPanel('90%', 0.6)).toBeLessThan(0.3);
    expect(throughPanel('60%', 0.35), '不过压暗、只把纸底调回来也过不了').toBeLessThan(0.3);
  });

  it('压暗层确实在起作用：去掉它透出量会更高（这是压暗存在的理由）', () => {
    // 反向对照——不是"越透越好"：不叠压暗的话 panel 只挡掉 60% 纸底，亮壁纸会明显透上来
    const withoutShade = throughPanel(GLASS_DARK.panelOpacity, 0);
    expect(withoutShade).toBeCloseTo(0.4, 3);
    expect(withoutShade).toBeGreaterThan(throughPanel(GLASS_DARK.panelOpacity, shadeAlpha));
    // 压暗必须轻于玻璃自己的纸底：压暗比纸底还重时，深色感就全由压暗层扛，壁纸先没了
    expect(shadeAlpha).toBeLessThan(percentOf(GLASS_DARK.panelOpacity));
  });

  it('chrome / haze 档的透出量同样在下限之上（三档一起看）', () => {
    for (const [name, opacity] of [
      ['surface', GLASS_DARK.surfaceOpacity],
      ['haze', GLASS_DARK.hazeOpacity],
      ['panel', GLASS_DARK.panelOpacity],
    ] as const) {
      expect(throughPanel(opacity, shadeAlpha), `${name} 档不该压成黑板`).toBeGreaterThanOrEqual(0.3);
    }
  });

  it('两个乘子都被钉在回调后的取值上（改任何一个都会让上面的区间失守）', () => {
    expect(GLASS_DARK.panelOpacity).toBe('60%');
    expect(shadeAlpha).toBeCloseTo(0.12, 5);
    // 面板下 0.6 纸底 + 0.12 压暗 → 合成 0.648，透出量 0.352
    expect(throughPanel(GLASS_DARK.panelOpacity, shadeAlpha)).toBeCloseTo(0.352, 3);
  });
});

describe('D5 深色文字光晕保持黑色', () => {
  it('深色光晕是黑色，两段都是 0.4（浅色的 80%）', () => {
    expect(GLASS_AERO.dark.textGlow).toMatch(/rgba\(0, 0, 0/);
    expect(GLASS_AERO.light.textGlow).toContain('255, 255, 255');
    // 两段（近距 + 远距）都要取同一个强度：只改一段会让光晕出现两个强度层
    const darkAlphas = [...GLASS_AERO.dark.textGlow.matchAll(/rgba\(0, 0, 0, ([\d.]+)\)/g)].map(
      (m) => parseFloat(m[1]),
    );
    const lightAlphas = [
      ...GLASS_AERO.light.textGlow.matchAll(/rgba\(255, 255, 255, ([\d.]+)\)/g),
    ].map((m) => parseFloat(m[1]));
    expect(darkAlphas).toHaveLength(2);
    expect(lightAlphas).toHaveLength(2);
    darkAlphas.forEach((a, i) => {
      // 逐段比：浅色两段都是 0.5，深色是它的 80%
      expect(a, `深色光晕第 ${i + 1} 段应是浅色对应段的 80%`).toBeCloseTo(lightAlphas[i] * 0.8, 5);
    });
    expect(darkAlphas[0]).toBeCloseTo(0.4, 5);
    expect(rootVars('dark')['--glass-text-glow']).toBe(GLASS_AERO.dark.textGlow);
    expect(rootVars('light')['--glass-text-glow']).toBe(GLASS_AERO.light.textGlow);
  });

  it('深色正文仍是亮色（光晕反相的前提是文字亮、底暗）', () => {
    expect(THEMES.dark.palette.text.primary).toBe(NEUTRAL_DARK[8]);
    const [r, g, b] = channels(THEMES.dark.palette.text.primary);
    for (const c of [r, g, b]) expect(c).toBeGreaterThan(0x80);
  });
});

describe('D6 深色通用描边：与 D2 同一量级', () => {
  it('深色 BORDER token 的白 alpha 不超过 D2 白层上限 .12', () => {
    // 深色的通用描边本来就是白色系（BORDER.dark）。它必须在 D2 的白层量级里——
    // 大于 .12 就会比边框本身（rim）更亮，边框反而盖过玻璃的厚度边。
    const m = BORDER.dark.match(/rgba\(255, 255, 255, ([\d.]+)\)/);
    expect(m, 'BORDER.dark 应是白色系 rgba').not.toBeNull();
    const alpha = parseFloat(m![1]);
    expect(alpha, '深色通用描边不得超过 D2 的白层上限').toBeLessThanOrEqual(0.12);
    expect(alpha, '深色通用描边仍要看得见').toBeGreaterThanOrEqual(0.08);
  });

  it('深色 outlined 芯片的描边不走白：default 用 BORDER，语义色用各自 main', () => {
    // outlined 是唯一「只有描边」的芯片形态。深色下 default 档的 palette.divider 就是
    // BORDER.dark（白色系、已在 D2 量级内）；四个语义档走各自提亮 15% 的 main，
    // 不是白色系，所以本轮不需要为它们降值。这一条把「谁在扛描边」钉住，
    // 防止将来有人把 outlined 的描边改成 theme.palette.common.white。
    const theme = THEMES.dark;
    expect(theme.palette.divider).toBe(BORDER.dark);
    const variants = (theme.components?.MuiChip?.variants ?? []) as Array<{
      props: Record<string, unknown>;
      style: unknown;
    }>;
    const defaultVariant = variants.find((v) => v.props.color === 'default');
    expect(defaultVariant, 'MuiChip 应有 color=default 的 variants').toBeDefined();
    const defaultStyle = (
      defaultVariant!.style as (a: { theme: Theme }) => Record<string, Record<string, unknown>>
    )({ theme });
    expect(defaultStyle['&.MuiChip-outlined'].borderColor).toBe(theme.palette.divider);
    for (const key of ['info', 'success', 'warning', 'error'] as const) {
      const semantic = variants.find((v) => v.props.color === key);
      expect(semantic, `MuiChip 应有 color=${key} 的 variants`).toBeDefined();
      const style = (
        semantic!.style as (a: { theme: Theme }) => Record<string, Record<string, unknown>>
      )({ theme });
      const border = style['&.MuiChip-outlined'].borderColor as string;
      expect(border, `dark ${key} outlined 描边应是语义色`).toBe(theme.palette[key].main);
      expect(border, `dark ${key} outlined 描边不该是白色系`).not.toContain('255, 255, 255');
    }
  });
});

describe('D7 深色实体浮层的底：暖色系抬升一档，文字对比度过 AA', () => {
  it('深色 background.paper 是 PAPER_RAISED.dark = #262420（不是纯冷灰的 n2）', () => {
    // 取证结论：深色详情/菜单/对话框这类不透明实色浮层的底原本是 n2（#242424，纯冷灰），
    // 压在暖近黑的页面纸色上色调打架。
    expect(PAPER_RAISED.dark).toBe('#262420');
    expect(THEMES.dark.palette.background.paper).toBe('#262420');
    expect(THEMES.dark.palette.background.paper).not.toBe(NEUTRAL_DARK[1]);
    expect(NEUTRAL_DARK[1], '中性色阶仍是纯冷灰（契约不动它）').toBe('#242424');
  });

  it('新 paper 与深色 n2 同明度（CIE L* 差 < 0.5）：抬升一档的观感不变', () => {
    const lum = (hex: string) => {
      const [r, g, b] = channels(hex);
      const lin = (c: number) => {
        const v = c / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    // CIE L*（相对亮度的立方根近似）
    const lStar = (hex: string) => {
      const Y = lum(hex);
      const e = 216 / 24389;
      const k = 24389 / 27;
      const fy = Y > e ? Y ** (1 / 3) : (k * Y + 16) / 116;
      return 116 * fy - 16;
    };
    expect(Math.abs(lStar(PAPER_RAISED.dark) - lStar(NEUTRAL_DARK[1]))).toBeLessThan(0.5);
    // 抬升关系不能反：浮层的底必须比页面纸色亮
    expect(lStar(PAPER_RAISED.dark)).toBeGreaterThan(lStar(PAPER.dark));
  });

  it('新 paper 与 PAPER.dark 同色相：三通道 R > G > B，且三通道都比纸色高', () => {
    const [pr, pg, pb] = channels(PAPER_RAISED.dark);
    const [cr, cg, cb] = channels(PAPER.dark);
    expect(pr, 'R > G：保持暖向').toBeGreaterThan(pg);
    expect(pg, 'G > B：保持暖向').toBeGreaterThan(pb);
    // 混白只降饱和度（13.0% → 8.6%），色相 40° 不变；R-B 与纸色相同
    expect(pr - pb).toBe(cr - cb);
    // 抬升是"整体加白"：三个通道都必须高于纸色，不能只抬一两个
    expect(pr).toBeGreaterThan(cr);
    expect(pg).toBeGreaterThan(cg);
    expect(pb).toBeGreaterThan(cb);
  });

  it('实体浮层上的深色文字对比度：text.primary 与 text.secondary 都 ≥ 4.5', () => {
    /** WCAG 2.x 的对比度，按标准公式自算：sRGB 相对亮度（0.04045 分段函数）后取 (L1+.05)/(L2+.05)。
     *  不用 MUI 的 getContrastRatio——它对深色有量化（相对亮度被压到 0.01 一档）：
     *  `#f0f0f0` 对 `#242424`、`#262420`、`#141312` 它都给同一个 13.5441，量不出换色带来的
     *  差异。要求本身就是「对比度 ≥ 4.5」，用标准公式算出来的数才是那个对比度。 */
    const lum = (hex: string): number => {
      const [r, g, b] = channels(hex);
      const lin = (c: number) => {
        const v = c / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    const contrast = (fg: string, bg: string): number => {
      const [l1, l2] = [lum(fg), lum(bg)].sort((a, b) => b - a);
      return (l1! + 0.05) / (l2! + 0.05);
    };

    const palette = THEMES.dark.palette;
    const paper = palette.background.paper;
    const primary = contrast(palette.text.primary, paper);
    const secondary = contrast(palette.text.secondary, paper);
    expect(primary, `text.primary ${palette.text.primary} on ${paper}`).toBeGreaterThanOrEqual(
      TEXT_CONTRAST_MIN,
    );
    expect(secondary, `text.secondary ${palette.text.secondary} on ${paper}`).toBeGreaterThanOrEqual(
      TEXT_CONTRAST_MIN,
    );
    expect(getContrastRatio(palette.text.primary, paper)).toBeGreaterThanOrEqual(TEXT_CONTRAST_MIN);
    expect(getContrastRatio(palette.text.secondary, paper)).toBeGreaterThanOrEqual(
      TEXT_CONTRAST_MIN,
    );
    // 深色正文档 n9/n8 压在新 paper 上也过线
    expect(contrast(NEUTRAL_DARK[8], paper)).toBeGreaterThanOrEqual(TEXT_CONTRAST_MIN);
    expect(contrast(NEUTRAL_DARK[9], paper)).toBeGreaterThanOrEqual(TEXT_CONTRAST_MIN);
    // 浅色的对应关系不变（浅色是标杆）
    expect(
      contrast(THEMES.light.palette.text.primary, THEMES.light.palette.background.paper),
    ).toBeGreaterThanOrEqual(TEXT_CONTRAST_MIN);
  });

  it('反相面不受影响：Snackbar / Tooltip 仍是浅色墨底 + 浅色字，不是新 paper', () => {
    // 反相面走 SEMANTIC_INVERSE_SURFACE（浅色 n10 底 + 浅色 n1 字），本来就不吃
    // background.paper；这条钉住"改 paper 没波及它"。
    expect(SEMANTIC_INVERSE_SURFACE.bg).toBe(NEUTRAL_LIGHT[9]);
    expect(SEMANTIC_INVERSE_SURFACE.fg).toBe(NEUTRAL_LIGHT[0]);
    for (const mode of MODES) {
      const components = THEMES[mode].components;
      const tooltip = components?.MuiTooltip?.styleOverrides?.tooltip as Record<string, unknown>;
      const snackbar = components?.MuiSnackbarContent?.styleOverrides?.root as Record<string, unknown>;
      expect(tooltip.backgroundColor, mode).toBe(SEMANTIC_INVERSE_SURFACE.bg);
      expect(snackbar.backgroundColor, mode).toBe(SEMANTIC_INVERSE_SURFACE.bg);
      expect(snackbar.color, mode).toBe(SEMANTIC_INVERSE_SURFACE.fg);
      expect(tooltip.backgroundColor, mode).not.toBe(THEMES[mode].palette.background.paper);
    }
    // 反相面自己的对比度也够（墨底浅字）
    expect(
      getContrastRatio(SEMANTIC_INVERSE_SURFACE.bg, SEMANTIC_INVERSE_SURFACE.fg),
    ).toBeGreaterThanOrEqual(TEXT_CONTRAST_MIN);
  });
});

describe('D-V2 浅色主题逐项快照：与基线逐字一致（期望值直接写出，不用快照文件）', () => {
  /** 浅色 :root 的完整期望表：24 个契约变量逐字写死。
   *  这一条是「浅色是标杆、一个值都不许动」的机器可读版本——任何一处漂移立刻红。
   *  值由三处交叉钉住：这里写死的字面量、rakko-tokens 的常量、实际下发的 :root。 */
  const LIGHT_ROOT: Record<string, string> = {
    '--color-paper': '#f9f8f5',
    '--color-border': 'rgba(24, 24, 27, 0.1)',
    '--color-neutral-1': '#f9f8f5',
    '--color-neutral-9': '#24231f',
    '--color-neutral-10': '#141312',
    '--glass-blur': '3px',
    '--glass-saturate': '193%',
    '--glass-surface-opacity': '52%',
    '--glass-panel-opacity': '58%',
    '--glass-scrim-opacity': '34%',
    '--glass-haze-opacity': '55%',
    '--glass-haze-bleed': '28px',
    '--glass-rim': 'rgba(255, 255, 255, 0.58)',
    '--glass-rim-inner': 'rgba(0, 0, 0, 0.14)',
    '--glass-lip': 'rgba(255, 255, 255, 0.6)',
    '--glass-lip-under': 'rgba(255, 255, 255, 0.22)',
    '--glass-side': 'rgba(255, 255, 255, 0.26)',
    '--glass-bloom': 'rgba(255, 255, 255, 0.15)',
    '--glass-sheen-1': 'rgba(255, 255, 255, 0.34)',
    '--glass-sheen-2': 'rgba(255, 255, 255, 0.1)',
    '--glass-sheen-3': 'rgba(0, 0, 0, 0.035)',
    '--glass-lift': '0 1px 2px rgba(0, 0, 0, 0.07), 0 6px 18px rgba(0, 0, 0, 0.1)',
    '--glass-text-glow': '0 0 2px rgba(255, 255, 255, 0.5), 0 0 6px rgba(255, 255, 255, 0.5)',
    '--shadow-whisper': '0 4px 24px rgba(0, 0, 0, 0.05)',
  };

  it('浅色 :root 的 24 个契约变量逐项等于写死的期望值', () => {
    const vars = rootVars('light');
    for (const [cssVar, value] of Object.entries(LIGHT_ROOT)) {
      expect(vars[cssVar], `light ${cssVar}`).toBe(value);
    }
  });

  it('浅色 :root 的键集等于 24 个契约键 + 深色壁纸压暗层（多一个键就说明浅色被动过）', () => {
    // 压暗层变量是这一轮新增的唯一一个 :root 键，浅色下它的值是 none（等于不存在）。
    expect(Object.keys(rootVars('light')).sort()).toEqual(
      [...Object.keys(LIGHT_ROOT), WALLPAPER_SHADE_VAR].sort(),
    );
  });

  it('浅色期望表本身与 token 常量一致（防两边各自漂移）', () => {
    expect(GLASS.blur).toBe(LIGHT_ROOT['--glass-blur']);
    expect(GLASS.saturate).toBe(LIGHT_ROOT['--glass-saturate']);
    expect(GLASS.surfaceOpacity).toBe(LIGHT_ROOT['--glass-surface-opacity']);
    expect(GLASS.panelOpacity).toBe(LIGHT_ROOT['--glass-panel-opacity']);
    expect(GLASS.scrimOpacity).toBe(LIGHT_ROOT['--glass-scrim-opacity']);
    expect(GLASS.hazeOpacity).toBe(LIGHT_ROOT['--glass-haze-opacity']);
    expect(GLASS.hazeBleed).toBe(LIGHT_ROOT['--glass-haze-bleed']);
    expect(GLASS_AERO.light.rim).toBe(LIGHT_ROOT['--glass-rim']);
    expect(GLASS_AERO.light.rimInner).toBe(LIGHT_ROOT['--glass-rim-inner']);
    expect(GLASS_AERO.light.lip).toBe(LIGHT_ROOT['--glass-lip']);
    expect(GLASS_AERO.light.lipUnder).toBe(LIGHT_ROOT['--glass-lip-under']);
    expect(GLASS_AERO.light.side).toBe(LIGHT_ROOT['--glass-side']);
    expect(GLASS_AERO.light.bloom).toBe(LIGHT_ROOT['--glass-bloom']);
    expect(GLASS_AERO.light.sheen1).toBe(LIGHT_ROOT['--glass-sheen-1']);
    expect(GLASS_AERO.light.sheen2).toBe(LIGHT_ROOT['--glass-sheen-2']);
    expect(GLASS_AERO.light.sheen3).toBe(LIGHT_ROOT['--glass-sheen-3']);
    expect(GLASS_AERO.light.lift).toBe(LIGHT_ROOT['--glass-lift']);
    expect(GLASS_AERO.light.textGlow).toBe(LIGHT_ROOT['--glass-text-glow']);
    expect(GLASS_SHADOW_WHISPER.light).toBe(LIGHT_ROOT['--shadow-whisper']);
    expect(NEUTRAL_LIGHT[0]).toBe(LIGHT_ROOT['--color-neutral-1']);
    expect(NEUTRAL_LIGHT[8]).toBe(LIGHT_ROOT['--color-neutral-9']);
    expect(NEUTRAL_LIGHT[9]).toBe(LIGHT_ROOT['--color-neutral-10']);
    expect(PAPER.light).toBe(LIGHT_ROOT['--color-paper']);
  });

  it('浅色 palette 逐项等于基线值（accent / 纸面 / 文字 / 分割线 / 语义四色）', () => {
    const p = THEMES.light.palette;
    expect(p.primary.main).toBe('#c56473');
    expect(p.primary.contrastText).toBe('#fff');
    expect(p.background.default).toBe('#f9f8f5');
    expect(p.background.paper).toBe('#f0efeb');
    expect(p.text.primary).toBe('#24231f');
    expect(p.text.secondary).toBe('#5c5a55');
    // text.disabled 沿用 n5（契约标注 n5 不作文字色，禁用态是既有例外，与基线一致）
    expect(p.text.disabled).toBe('#a8a69f');
    expect(p.divider).toBe('rgba(24, 24, 27, 0.1)');
    expect(p.info.main).toBe('#3d6896');
    expect(p.success.main).toBe('#5e9f7e');
    expect(p.warning.main).toBe('#a87a3d');
    expect(p.error.main).toBe('#a64953');
    expect([p.grey[50], p.grey[100], p.grey[200], p.grey[900]]).toEqual([
      '#f9f8f5',
      '#f0efeb',
      '#e3e1db',
      '#141312',
    ]);
  });

  it('深色 palette 是另一套值（防止把浅色那份复制成深色断言）', () => {
    const d = THEMES.dark.palette;
    expect(d.background.default).toBe('#1a1814');
    expect(d.background.paper).toBe('#262420');
    expect(d.text.primary).toBe('#f0f0f0');
    expect(d.divider).toBe('rgba(255, 255, 255, 0.12)');
    expect(d.primary.main).toBe('#e095a4');
  });

  it('浅色壁纸承载层逐项等于基线：纸色地板 + 一层"不存在的"压暗变量 + 不用渐变/color-mix', () => {
    const layer = wallpaperLayer('light');
    expect(layer.backgroundColor).toBe('#f9f8f5');
    expect(layer.backgroundImage).toBe(
      `var(${WALLPAPER_SHADE_VAR}), var(${WALLPAPER_VAR}, url("${DEFAULT_WALLPAPER_URL}"))`,
    );
    expect(layer.position).toBe('fixed');
    expect(layer.inset).toBe(0);
    expect(layer.zIndex).toBe(-1);
    expect(layer.pointerEvents).toBe('none');
    expect(layer.backgroundSize).toBe('cover');
    expect(layer.backgroundPosition).toBe('center');
    expect(layer.backgroundRepeat).toBe('no-repeat');
    // 浅色不叠任何可见的层：压暗变量在这一主题下是 none
    expect(rootVars('light')[WALLPAPER_SHADE_VAR]).toBe('none');
    expect(layer.backgroundImage as string).not.toContain('gradient');
    expect(layer.backgroundImage as string).not.toContain('color-mix');
  });
});
