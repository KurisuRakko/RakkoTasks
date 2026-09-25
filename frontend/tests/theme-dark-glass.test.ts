// 深色模式重调的取值验收（D1–D4），外加浅色主题的逐项快照式断言（D-V2）。
//
// 口径：断言直接写出期望值，不用 toMatchSnapshot 文件——快照文件会随实现漂移而"自动通过"，
// 而这次的硬约束恰恰是「浅色一个值都不许变」，期望值必须能被人一眼读出、被 review 对比。
//
// 深浅两侧的读法都走真实下发路径，不抄一份：
//   主题层  buildThemeOptions(mode) → createTheme → palette / MuiCssBaseline 的 :root 块；
//   静态表  src/rakko-tokens.ts 的具名 token 常量。
// 深色落在这里的三条硬约束：
//   D1 纸色是暖的近黑（不是纯灰 n1）；D2 深色玻璃的白层一律收敛；
//   D3 深色三档纸底 opacity 只许上调；D4 深色壁纸才叠压暗层，浅色一个都不叠。

import { describe, expect, it } from 'vitest';
import { createTheme } from '@mui/material/styles';
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
  it('深色白层逐项钉死：rim .10 / lip .10 / lip-under .04 / side .04 / sheen-1 .06 / sheen-2 .02', () => {
    expect(GLASS_AERO.dark.rim).toBe('rgba(255, 255, 255, 0.1)');
    expect(GLASS_AERO.dark.lip).toBe('rgba(255, 255, 255, 0.1)');
    expect(GLASS_AERO.dark.lipUnder).toBe('rgba(255, 255, 255, 0.04)');
    expect(GLASS_AERO.dark.side).toBe('rgba(255, 255, 255, 0.04)');
    expect(GLASS_AERO.dark.sheen1).toBe('rgba(255, 255, 255, 0.06)');
    expect(GLASS_AERO.dark.sheen2).toBe('rgba(255, 255, 255, 0.02)');
  });

  it('深色 bloom 归零（透明写法而不是删键：配方的 box-shadow 层序不动）', () => {
    expect(alphaOf(GLASS_AERO.dark.bloom)).toBe(0);
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
  it('深色三档取值钉死：surface 58% / panel 72% / haze 66%', () => {
    expect(GLASS_DARK.surfaceOpacity).toBe('58%');
    expect(GLASS_DARK.panelOpacity).toBe('72%');
    expect(GLASS_DARK.hazeOpacity).toBe('66%');
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

  it('三档的相对关系保留：chrome 最透 < haze < panel 最实', () => {
    const surface = parseFloat(GLASS_DARK.surfaceOpacity);
    const haze = parseFloat(GLASS_DARK.hazeOpacity);
    const panel = parseFloat(GLASS_DARK.panelOpacity);
    expect(surface).toBeLessThan(haze);
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
  it('压暗层是 35% 纯黑', () => {
    expect(WALLPAPER_SHADE_DARK).toBe('rgba(0, 0, 0, 0.35)');
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

  it('深色解析出的压暗层是纯黑：不含任何亮色通道，也不是反相白', () => {
    // 压暗层的值必须是黑。用 n-10（深色主题下是近白）当压暗色会把壁纸漂白。
    const [r, g, b] = channels('#000000');
    expect([r, g, b]).toEqual([0, 0, 0]);
    expect(WALLPAPER_SHADE_DARK).toMatch(/^rgba\(0, 0, 0,/);
    expect(alphaOf(WALLPAPER_SHADE_DARK)).toBeCloseTo(0.35, 5);
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

describe('D5 深色文字光晕保持黑色、强度减半', () => {
  it('深色光晕是黑色且 alpha 恰为浅色的一半', () => {
    expect(GLASS_AERO.dark.textGlow).toMatch(/rgba\(0, 0, 0/);
    expect(GLASS_AERO.light.textGlow).toContain('255, 255, 255');
    // 两段（近距 + 远距）都要减半：只改一段会让光晕出现两个强度层
    const darkAlphas = [...GLASS_AERO.dark.textGlow.matchAll(/rgba\(0, 0, 0, ([\d.]+)\)/g)].map(
      (m) => parseFloat(m[1]),
    );
    const lightAlphas = [
      ...GLASS_AERO.light.textGlow.matchAll(/rgba\(255, 255, 255, ([\d.]+)\)/g),
    ].map((m) => parseFloat(m[1]));
    expect(darkAlphas).toHaveLength(2);
    expect(lightAlphas).toHaveLength(2);
    darkAlphas.forEach((a, i) => {
      // 逐段比：浅色两段都是 0.5 → 深色两段都必须是 0.25
      expect(a, `深色光晕第 ${i + 1} 段应是浅色对应段的一半`).toBeCloseTo(lightAlphas[i] / 2, 5);
    });
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
    expect(d.background.paper).toBe('#242424');
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
