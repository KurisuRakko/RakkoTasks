// SettingsPage 测试：已停用账户的变暗必须由 filter 实现，不能靠 opacity——
// 入场动画 animation-fill-mode: both 会把关键帧终态 opacity: 1 保持在元素上
// （动画值优先级高于普通声明），静态 opacity 声明会被压掉、变暗失效。
// 账户分区逻辑迁去 AccountsSection 后仍在同一页面上渲染，这些断言继续适用；
// AccountsSection 内部会调用带方向导航的 hook，渲染需要 Router 上下文。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SettingsPage from '../src/pages/SettingsPage';
import { ThemeModeProvider } from '../src/lib/theme-mode';
import { readWallpaper, setWallpaper } from '../src/lib/wallpaper';
import type { WallpaperArea } from '../src/lib/wallpaper';
import { MOTION, RADIUS } from '../src/rakko-tokens';
import { ROW_MIN_HEIGHT_PX } from '../src/components/accounts/SettingsRow';
import { AppThemeProvider, allStyleText, ownRules } from './glass-text-contrast.test-utils';
import type { StatusResponse } from '../src/types';
import settingsPageSource from '../src/pages/SettingsPage.tsx?raw';

// SettingsPage 依赖 pwa-update（其注册逻辑只在浏览器生效），这里替换 checkForUpdate
const { checkForUpdateMock } = vi.hoisted(() => ({ checkForUpdateMock: vi.fn() }));
const { loadWallpaperSourceMock, renderWallpaperMock } = vi.hoisted(() => ({
  loadWallpaperSourceMock: vi.fn(),
  renderWallpaperMock: vi.fn(),
}));

vi.mock('../src/lib/pwa-update', () => ({ checkForUpdate: checkForUpdateMock }));

// 壁纸用例要驱动「选图→裁剪→写入」整条链路；jsdom 既不能真解码图片、也没有 2d 画布，
// mock 掉解码与渲染两个模块导出（其余导出保持原样——写入/订阅仍走真实现，
// setWallpaper 的配额异常与提示分流是真实验证对象）
vi.mock('../src/lib/wallpaper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/wallpaper')>();
  return {
    ...actual,
    loadWallpaperSource: loadWallpaperSourceMock,
    renderWallpaper: renderWallpaperMock,
  };
});

// react-easy-crop 在 jsdom 里量不出容器尺寸、也不会自己上报裁剪像素。替身把受控的
// image / aspect / zoom 摊到 data-* 上供断言，并在挂载后上报一次裁剪像素。
vi.mock('react-easy-crop', async () => {
  const { useEffect } = await import('react');
  return {
    default: function FakeCropper(props: {
      image?: string;
      aspect?: number;
      zoom?: number;
      onCropComplete?: (croppedArea: WallpaperArea, pixels: WallpaperArea) => void;
    }) {
      // 只要求「挂载后调一次」：真组件是图加载完才上报，这里的 deps 数组保持空
      useEffect(() => {
        props.onCropComplete?.(
          { x: 0, y: 0, width: 100, height: 100 },
          { x: 10, y: 20, width: 300, height: 600 },
        );
      }, []);
      return (
        <div
          data-testid="cropper"
          data-image={props.image}
          data-aspect={String(props.aspect)}
          data-zoom={String(props.zoom)}
        />
      );
    },
  };
});

const STATUS: StatusResponse = {
  accounts: [
    {
      id: 1,
      name: 'Gmail',
      kind: 'gmail',
      email: 'you@gmail.com',
      status: 'error',
      enabled: false,
      has_credentials: false,
      ms_client_id: null,
      last_sync_at: null,
      last_error: '停用前同步出错',
    },
  ],
  pending_llm: 0,
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderSettings() {
  return render(
    <ThemeModeProvider>
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    </ThemeModeProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SettingsPage 日历订阅', () => {
  function makeFetchMock(): ReturnType<typeof vi.fn> {
    return vi.fn(async (url: string | URL) => {
      const u = String(url);
      // CalDAV 分支写在日历分支之前（/api/caldav 与 /api/calendar 互不包含，顺序仅为将来防误伤）
      if (u.includes('/api/caldav')) {
        return json({ username: 'you@gmail.com', path: '/caldav/', configured: false });
      }
      // GET /api/calendar 返回令牌；其余请求按账户状态处理
      if (u.includes('/api/calendar')) return json({ token: 'abc' });
      return json(STATUS);
    });
  }

  it('fetch 返回令牌时展示订阅链接输入框，值以 /api/calendar/abc.ics 结尾', async () => {
    vi.stubGlobal('fetch', makeFetchMock());

    renderSettings();

    const input = (await screen.findByLabelText('订阅链接')) as HTMLInputElement;
    expect(input.value.endsWith('/api/calendar/abc.ics')).toBe(true);
  });

  it('「在 iPhone 上订阅」是 webcal:// 开头的链接', async () => {
    vi.stubGlobal('fetch', makeFetchMock());

    renderSettings();

    const link = await screen.findByRole('link', { name: '在 iPhone 上订阅' });
    expect(link.getAttribute('href')).toMatch(/^webcal:\/\//);
  });
});

describe('SettingsPage 提醒事项同步', () => {
  const DAV = { username: 'a@x.com', path: '/caldav/', configured: false };

  function makeFetchMock(dav: unknown): ReturnType<typeof vi.fn> {
    return vi.fn(async (url: string | URL) => {
      const u = String(url);
      // CalDAV 分支写在日历分支之前（/api/caldav 与 /api/calendar 互不包含，顺序仅为将来防误伤）
      if (u.includes('/api/caldav/password')) return json({ password: 'p'.repeat(32) });
      if (u.includes('/api/caldav')) return json(dav);
      if (u.includes('/api/calendar')) return json({ token: 'abc' });
      return json(STATUS);
    });
  }

  it('configured=false 时出现「生成同步密码」按钮，无「同步密码」输入框，用户名显示 a@x.com', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ ...DAV, configured: false }));

    renderSettings();

    expect(await screen.findByRole('button', { name: '生成同步密码' })).toBeTruthy();
    expect(screen.queryByLabelText('同步密码')).toBeNull();
    const user = (await screen.findByLabelText('用户名')) as HTMLInputElement;
    expect(user.value).toBe('a@x.com');
  });

  it('点击生成只发一次 POST，随后出现 32 位同步密码与「只显示一次」告警', async () => {
    const fetchMock = makeFetchMock({ ...DAV, configured: false });
    vi.stubGlobal('fetch', fetchMock);

    renderSettings();

    fireEvent.click(await screen.findByRole('button', { name: '生成同步密码' }));

    const pw = (await screen.findByLabelText('同步密码')) as HTMLInputElement;
    expect(pw.value).toBe('p'.repeat(32));
    expect(screen.getByText(/只显示一次/)).toBeTruthy();
    expect(screen.getByText('已生成')).toBeTruthy();
    // 生成成功后按钮区切换为「重新生成密码」，不再出现「生成同步密码」
    expect(screen.queryByRole('button', { name: '生成同步密码' })).toBeNull();
    expect(screen.queryByRole('button', { name: '重新生成密码' })).not.toBeNull();
    const postCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/caldav/password'));
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0][1]?.method).toBe('POST');
  });

  it('configured=true 时出现「重新生成密码」，不出现「生成同步密码」，页面文本不含 32 个 p', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ ...DAV, configured: true }));

    renderSettings();

    expect(await screen.findByRole('button', { name: '重新生成密码' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '生成同步密码' })).toBeNull();
    expect(screen.queryByLabelText('同步密码')).toBeNull();
    expect(document.body.textContent ?? '').not.toContain('p'.repeat(32));
  });

  it('/api/caldav 返回 500 时出现失败告警，「日历订阅」分区不受影响', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/api/caldav')) return new Response('oops', { status: 500 });
      if (u.includes('/api/calendar')) return json({ token: 'abc' });
      return json(STATUS);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderSettings();

    expect(await screen.findByText('加载提醒事项同步配置失败')).toBeTruthy();
    const link = (await screen.findByLabelText('订阅链接')) as HTMLInputElement;
    expect(link.value.endsWith('/api/calendar/abc.ics')).toBe(true);
  });
});

describe('SettingsPage 检查更新', () => {
  function makeFetchMock(): ReturnType<typeof vi.fn> {
    return vi.fn(async (url: string | URL) => {
      const u = String(url);
      // CalDAV 分支写在日历分支之前（/api/caldav 与 /api/calendar 互不包含，顺序仅为将来防误伤）
      if (u.includes('/api/caldav')) {
        return json({ username: 'you@gmail.com', path: '/caldav/', configured: false });
      }
      if (u.includes('/api/calendar')) return json({ token: 'abc' });
      return json(STATUS);
    });
  }

  beforeEach(() => {
    checkForUpdateMock.mockReset().mockResolvedValue(true);
    vi.stubGlobal('fetch', makeFetchMock());
  });

  it('「检查更新」发起成功时提示已检查', async () => {
    renderSettings();

    fireEvent.click(await screen.findByRole('button', { name: '检查更新' }));
    expect(checkForUpdateMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('已检查，若有新版本会自动重载')).toBeTruthy();
  });

  it('环境不支持（返回 false）时提示当前环境不支持自动更新', async () => {
    checkForUpdateMock.mockResolvedValue(false);
    renderSettings();

    fireEvent.click(await screen.findByRole('button', { name: '检查更新' }));
    expect(await screen.findByText('当前环境不支持自动更新')).toBeTruthy();
  });
});

describe('SettingsPage 玻璃分区与按钮配色', () => {
  function makeFetchMock(): ReturnType<typeof vi.fn> {
    return vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/api/caldav')) {
        return json({ username: 'you@gmail.com', path: '/caldav/', configured: false });
      }
      if (u.includes('/api/calendar')) return json({ token: 'abc' });
      return json(STATUS);
    });
  }

  it('八个分区（账户状态…关于）都包在 data-glass="panel" 玻璃面板里，按渲染顺序对应', async () => {
    vi.stubGlobal('fetch', makeFetchMock());
    render(
      <ThemeModeProvider>
        <MemoryRouter>
          <SettingsPage />
        </MemoryRouter>
      </ThemeModeProvider>,
    );

    // 分区标题是静态内容，渲染即可断言；渲染顺序与页面书写顺序一致
    // （「同步状态」入口在「关于」之前）
    const titles = ['邮箱账户', '外观', '壁纸', '日历订阅', '提醒事项同步', '账户', '同步状态', '关于'];
    const panels = Array.from(document.querySelectorAll('[data-glass="panel"]'));
    expect(panels).toHaveLength(titles.length);
    panels.forEach((panel, i) => {
      expect(panel.textContent, `第 ${i + 1} 个面板应含「${titles[i]}」`).toContain(titles[i]);
    });
  });

  it('按钮不再有 warning 配色（源码断言）：color="warning" 已删除', () => {
    expect(settingsPageSource).not.toContain('color="warning"');
  });

  it('行与行之间的分隔线是 inset 发丝线：起点与文字左缘对齐，首行上方与末行下方不画', async () => {
    vi.stubGlobal('fetch', makeFetchMock());
    render(
      <ThemeModeProvider>
        <MemoryRouter>
          <SettingsPage />
        </MemoryRouter>
      </ThemeModeProvider>,
    );

    // 日历订阅面板：说明行 → 订阅链接行 → 按钮行，三行两线
    await screen.findByLabelText('订阅链接');
    const panels = Array.from(document.querySelectorAll('[data-glass="panel"]'));
    const calendar = panels.find((p) => p.textContent?.includes('日历订阅')) as HTMLElement;
    const rows = Array.from(calendar.querySelectorAll('[data-setting-row]')) as HTMLElement[];
    expect(rows.length).toBeGreaterThanOrEqual(3);

    // 线画在伪元素上，不占盒子的边框：行自己不带 border-top，也就没有
    // 「首行上方 / 末行下方多一条线」以及「边框从行最左端画起」的问题
    for (const row of rows) {
      expect(getComputedStyle(row).borderTopWidth).not.toBe('1px');
    }

    // 所有行的左内边距完全一致，且只有 ROW_SX 那一条（px:1 → 8px）；
    // 旧写法会给相邻行补一条 padding-left:8px 把标签右推，这个序列不会出现。
    // 分隔线也不再落在行的边框上（border-top 由伪元素取代，盒子不带 border）。
    const css = allStyleText();
    for (const row of rows) {
      const own = ownRules(css, row);
      expect(own).not.toBe('');
      const paddings = own.match(/padding-left:[^;}]*/g) ?? [];
      expect(paddings).toEqual(['padding-left:8px']);
      expect(own).not.toContain('border-top');
    }
    // 线本身：第二行上的 `& + &::before` 规则存在，并且带 left（从文字左缘起，
    // 不靠给相邻行补内边距）与 height:1px（发丝线）。
    // 「首行上方不画线」由两条锁定：行的规则里没有任何 border-top 声明（上面已断言），
    // 而伪元素的定位是 `& + &::before`——不相邻任何行的首行不会命中该选择器。
    const second = ownRules(css, rows[1]);
    expect(second).toContain('::before');
    expect(second).toContain('left:8px');
    expect(second).toContain('height:1px');
    expect(second).toContain('pointer-events:none');
  });

  it('设置行是统一结构：最小高度 48px，标签 13px、值/说明 12px（字阶区分层级而不是变淡文字）', async () => {
    vi.stubGlobal('fetch', makeFetchMock());
    render(
      <ThemeModeProvider>
        <MemoryRouter>
          <SettingsPage />
        </MemoryRouter>
      </ThemeModeProvider>,
    );

    await screen.findByLabelText('订阅链接');
    const panels = Array.from(document.querySelectorAll('[data-glass="panel"]'));
    const calendar = panels.find((p) => p.textContent?.includes('日历订阅')) as HTMLElement;
    const rows = Array.from(calendar.querySelectorAll('[data-setting-row]')) as HTMLElement[];
    // 所有行共用一个最小高度常量，不是各面板各写一个
    for (const row of rows.slice(0, 3)) {
      expect(getComputedStyle(row).minHeight).toBe(`${ROW_MIN_HEIGHT_PX}px`);
    }

    // 值 / 说明字阶：caption（label-12 = 12px / 1.5），与标签的 body2（13px）差一档
    const hint = Array.from(calendar.querySelectorAll('.MuiTypography-caption')).find((el) =>
      (el.textContent ?? '').includes('有截止日的未完成任务会出现在日历里'),
    ) as HTMLElement;
    expect(hint, '日历订阅的说明文字应是 caption 字阶').toBeTruthy();
    expect(hint.className).toMatch(/MuiTypography-caption/);
    // 字阶只认 caption 这一档：emotion 把 12px 下成 0.75rem（html font-size 14px 背景下的同一值）
    expect(['0.75rem', '12px']).toContain(getComputedStyle(hint).fontSize);
    // 说明文字在玻璃上取正文色，不用次级色（n7 在玻璃上只有 2.4–2.6 对比度）
    expect(hint.className).not.toMatch(/MuiTypography-root css-.*secondary/);
    // 说明文字的行距常量只有一处定义（SettingsRow 导出，页面不各写一份 sx）
    expect(settingsPageSource).toContain('HINT_SX');
  });

  it('外观三态是 radiogroup / radio：aria-checked 跟着选中项走', async () => {
    vi.stubGlobal('fetch', makeFetchMock());
    render(
      <ThemeModeProvider>
        <MemoryRouter>
          <SettingsPage />
        </MemoryRouter>
      </ThemeModeProvider>,
    );

    const group = screen.getByRole('radiogroup', { name: '外观' });
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(group.contains(radios[0])).toBe(true);
    // 默认 system：跟随系统选中，其余未选
    expect(screen.getByRole('radio', { name: '跟随系统' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: '深色' }).getAttribute('aria-checked')).toBe('false');
    // 单选组只有一个 tab 停点（APG 的 roving tabindex）
    expect(screen.getByRole('radio', { name: '跟随系统' }).getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('radio', { name: '深色' }).getAttribute('tabindex')).toBe('-1');
  });

  it('外观分段控件是「中性轨道 + 抬起的滑块」：组无边框、段无边框无竖线、选中项才抬起', async () => {
    vi.stubGlobal('fetch', makeFetchMock());
    // 这一条要断言色值，必须用应用真实主题渲染（token 原值；ThemeModeProvider 之外的
    // MUI Provider 用默认主题时 background.paper 是白色，断言会空转）
    render(
      <AppThemeProvider>
        <MemoryRouter>
          <SettingsPage />
        </MemoryRouter>
      </AppThemeProvider>,
    );

    const group = screen.getByRole('radiogroup', { name: '外观' });
    const css = allStyleText();
    const groupRule = ownRules(css, group);

    // 组：无外框、浅填充轨道、2px 内边距、36px 高
    expect(groupRule).not.toBe('');
    expect(groupRule).not.toMatch(/border(-top|-right|-bottom|-left)?:\s*1px/);
    expect(groupRule).toContain('background-color:rgba(20, 19, 18, 0.04)'); // action.hover = alpha(n10, 4%)
    expect(groupRule).toContain('padding:2px');
    expect(groupRule).toContain('height:36px');
    // 段间竖线已删除（旧写法是相邻选择器的 border-left）
    expect(groupRule).not.toContain('border-left');

    // 段：不描边；选中项 = 纸色滑块 + whisper 阴影 + 字重 600，未选中 = 透明底 + 字重 500
    const selected = screen.getByRole('radio', { name: '跟随系统' });
    const idle = screen.getByRole('radio', { name: '深色' });
    const selectedRule = ownRules(css, selected);
    const idleRule = ownRules(css, idle);
    expect(selectedRule).not.toMatch(/border:\s*1px/);
    expect(idleRule).not.toMatch(/border:\s*1px/);
    expect(selectedRule).toContain('background-color:#f0efeb'); // background.paper = n2
    expect(selectedRule).toContain('box-shadow:0 1px 2px rgba(20, 19, 18, 0.06)'); // shadows[1] = whisper 一档
    expect(idleRule).toContain('background-color:transparent');
    expect(idleRule).toContain('box-shadow:none');
    // 切换的过渡走 motion.md 的短时长 + 标准缓动
    expect(selectedRule).toContain(`background-color ${MOTION.state}ms ${MOTION.easeStandard}`);
    expect(selectedRule).toContain(`box-shadow ${MOTION.state}ms ${MOTION.easeStandard}`);
    // 段圆角 = RADIUS.card - 2
    expect(selectedRule).toContain(`border-radius:${RADIUS.card - 2}px`);
  });

  it('外观分段控件在行内占满宽度：三段等宽、段内文字不换行（375 与 1280 下都单行）', async () => {
    vi.stubGlobal('fetch', makeFetchMock());
    render(
      <AppThemeProvider>
        <MemoryRouter>
          <SettingsPage />
        </MemoryRouter>
      </AppThemeProvider>,
    );

    const group = screen.getByRole('radiogroup', { name: '外观' });
    const row = group.closest('[data-setting-row]') as HTMLElement;
    const css = allStyleText();

    // 这一行是纵排：标签在上、控件在下并占满行宽——挤在同一行右侧时三段只剩 180px，
    // 最长的一段会被折行。行的内边距与分隔线规则不变（仍是同一套 SettingsRow）。
    const rowRule = ownRules(css, row);
    expect(rowRule).toContain('flex-direction:column');
    expect(rowRule).toMatch(/padding-left:8px/);
    expect(rowRule).toContain('min-height:48px');
    expect(rowRule).toContain('::before');

    // 控件占满行宽，且自己的盒模型是 border-box（36px 高含 2px 内边距）
    const groupRule = ownRules(css, group);
    expect(groupRule).toContain('width:100%');
    expect(groupRule).toContain('box-sizing:border-box');
    // 占满的宽度来自「值槽是一个 flex 容器」：控件不是靠自身百分比宽度去挤父级
    expect(getComputedStyle(group.parentElement as HTMLElement).display).toBe('flex');
    expect(ownRules(css, group.parentElement as HTMLElement)).toContain('width:100%');

    // 三段等宽：flex: 1 1 0（grow/shrink 相同 + basis 0），且每段都一样
    const segments = screen.getAllByRole('radio');
    expect(segments).toHaveLength(3);
    for (const segment of segments) {
      expect(ownRules(css, segment)).toContain('flex:1 1 0');
    }
    // 段内文字不换行：折成两行会让三段文字基线错开
    for (const label of ['跟随系统', '浅色', '深色']) {
      const text = screen.getByText(label);
      expect(text.className).toMatch(/MuiTypography-body2/);
      expect(getComputedStyle(text).whiteSpace).toBe('nowrap');
    }
  });

  it('外观三态：方向键切换选中并把焦点移到新选中项，Home / End 到首尾', async () => {
    vi.stubGlobal('fetch', makeFetchMock());
    render(
      <ThemeModeProvider>
        <MemoryRouter>
          <SettingsPage />
        </MemoryRouter>
      </ThemeModeProvider>,
    );

    // 每次都按可访问名现取：焦点移动发生在 effect 里，React 提交后节点引用会变，
    // 抓住旧引用断言读到的还是上一轮的属性
    const radio = (name: string) => screen.getByRole('radio', { name });
    /** 按一次键并等这次提交（含焦点的 effect）跑完 */
    const press = (name: string, key: string) =>
      act(async () => {
        fireEvent.keyDown(radio(name), { key });
      });

    act(() => radio('跟随系统').focus());

    // → 从「跟随系统」到「浅色」：选中与焦点一起移动
    await press('跟随系统', 'ArrowRight');
    expect(radio('浅色').getAttribute('aria-checked')).toBe('true');
    expect(radio('跟随系统').getAttribute('aria-checked')).toBe('false');
    expect(document.activeElement).toBe(radio('浅色'));
    expect(localStorage.getItem('rakkotasks.theme-mode')).toBe('light');

    await press('浅色', 'ArrowRight');
    expect(document.activeElement).toBe(radio('深色'));
    expect(localStorage.getItem('rakkotasks.theme-mode')).toBe('dark');

    // 末端回绕到首项：方向键在组内循环，不会卡在最后一格
    await press('深色', 'ArrowRight');
    expect(radio('跟随系统').getAttribute('aria-checked')).toBe('true');

    // ← 反方向
    await press('跟随系统', 'ArrowLeft');
    expect(radio('深色').getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(radio('深色'));

    // End / Home 到首尾
    await press('深色', 'Home');
    expect(radio('跟随系统').getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(radio('跟随系统'));
    await press('跟随系统', 'End');
    expect(radio('深色').getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(radio('深色'));
  });

  it('日历操作排：主操作「在 iPhone 上订阅」是 contained，「重新生成」不再是 warning 色', async () => {
    vi.stubGlobal('fetch', makeFetchMock());
    render(
      <ThemeModeProvider>
        <MemoryRouter>
          <SettingsPage />
        </MemoryRouter>
      </ThemeModeProvider>,
    );

    await screen.findByLabelText('订阅链接');
    const subscribe = screen.getByRole('link', { name: '在 iPhone 上订阅' });
    expect(subscribe.className).toMatch(/MuiButton-contained/);
    const rotate = screen.getByRole('button', { name: '重新生成' });
    expect(rotate.className).not.toMatch(/colorWarning/);
    // 进入破坏性流程的入口 = text error（旧的 outlined + error 已收敛掉）
    expect(rotate.className).toMatch(/MuiButton-text/);
    expect(rotate.className).toMatch(/MuiButton-colorError/);
  });

  it('危险操作的最终确认是 contained error，取消是 text inherit，取消在左确认在右', async () => {
    vi.stubGlobal('fetch', makeFetchMock());
    render(
      <ThemeModeProvider>
        <MemoryRouter>
          <SettingsPage />
        </MemoryRouter>
      </ThemeModeProvider>,
    );

    await screen.findByLabelText('订阅链接');
    fireEvent.click(screen.getByRole('button', { name: '重新生成' }));

    const dialog = await screen.findByRole('dialog');
    const cancel = within(dialog).getByRole('button', { name: '取消' });
    const confirm = within(dialog).getByRole('button', { name: '确认' });
    // 全站只有四种按钮层级：取消 = text inherit，破坏性最终确认 = contained error
    expect(cancel.className).toMatch(/MuiButton-text/);
    expect(cancel.className).toMatch(/MuiButton-colorInherit/);
    expect(confirm.className).toMatch(/MuiButton-contained/);
    expect(confirm.className).toMatch(/MuiButton-colorError/);
    // 同一行右对齐，取消在确认左边
    const actions = cancel.parentElement as HTMLElement;
    expect(actions).toBe(confirm.parentElement);
    expect(Array.from(actions.children).indexOf(cancel)).toBeLessThan(
      Array.from(actions.children).indexOf(confirm),
    );
  });

  it('退出登录是危险入口：text error（旧的 outlined + error 已收敛掉）', async () => {
    vi.stubGlobal('fetch', makeFetchMock());
    render(
      <ThemeModeProvider>
        <MemoryRouter>
          <SettingsPage />
        </MemoryRouter>
      </ThemeModeProvider>,
    );

    const logout = await screen.findByRole('button', { name: '退出登录' });
    expect(logout.className).toMatch(/MuiButton-text/);
    expect(logout.className).toMatch(/MuiButton-colorError/);
  });

  it('分区标题只有一种样式与位置：面板内顶部的 overline', async () => {
    vi.stubGlobal('fetch', makeFetchMock());
    render(
      <ThemeModeProvider>
        <MemoryRouter>
          <SettingsPage />
        </MemoryRouter>
      </ThemeModeProvider>,
    );

    const titles = ['外观', '壁纸', '日历订阅', '提醒事项同步', '账户', '同步', '关于'];
    for (const title of titles) {
      const heading = screen.getByRole('heading', { name: title });
      expect(heading.className, `${title} 应是 overline 字阶`).toMatch(/MuiTypography-overline/);
      // 标题是面板的第一个子节点（位置统一，不随分区内容变化）
      const panel = heading.closest('[data-glass="panel"]') as HTMLElement;
      expect(panel.firstElementChild, `${title} 应是面板首个子元素`).toBe(heading);
    }
  });

  it('Snackbar 不再写死自动关闭时长，也不在设置页拼边界色（颜色只来自 theme.palette）', () => {
    // 4 秒由主题的 MuiSnackbar.defaultProps 统一给（A 路的主题层），调用点不再传
    expect(settingsPageSource).not.toContain('autoHideDuration');
    // 组件里不写新的 #hex / rgb 字面量
    expect(settingsPageSource).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(settingsPageSource).not.toMatch(/rgba?\(/);
  });
});

describe('SettingsPage 壁纸', () => {
  const DAV = { username: 'a@x.com', path: '/caldav/', configured: false };
  const OBJECT_URL = 'blob:wallpaper-source';
  /** 替身 renderWallpaper 的返回值：形状要是合法 data URL，readWallpaper 才认 */
  const RENDERED = 'data:image/jpeg;base64,UkVOREVSRUQ=';

  function makeFetchMock(): ReturnType<typeof vi.fn> {
    return vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/api/caldav')) return json(DAV);
      if (u.includes('/api/calendar')) return json({ token: 'abc' });
      return json(STATUS);
    });
  }

  beforeEach(() => {
    setWallpaper(null);
    loadWallpaperSourceMock.mockReset().mockResolvedValue({
      url: OBJECT_URL,
      image: document.createElement('img'),
    });
    renderWallpaperMock.mockReset().mockReturnValue(RENDERED);
  });

  afterEach(() => {
    setWallpaper(null);
    vi.restoreAllMocks();
  });

  function renderSettings() {
    vi.stubGlobal('fetch', makeFetchMock());
    render(
      <ThemeModeProvider>
        <MemoryRouter>
          <SettingsPage />
        </MemoryRouter>
      </ThemeModeProvider>,
    );
  }

  /** 触发「选择图片」的隐藏 file input，模拟用户选中一张图 */
  function pickImage() {
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'photo.jpg', { type: 'image/jpeg' })] },
    });
  }

  /** 选图并等裁剪就绪：替身上报裁剪像素之前「设为壁纸」是禁用的，点了也不会生效 */
  async function openCropDialog() {
    pickImage();
    await screen.findByText('裁剪壁纸');
    await waitFor(() => expect(screen.getByRole('button', { name: '设为壁纸' })).toBeEnabled());
  }

  it('未设壁纸：只有「选择图片」，没有「恢复默认壁纸」也没有「壁纸预览」', async () => {
    renderSettings();

    expect(await screen.findByRole('button', { name: '选择图片' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '恢复默认壁纸' })).toBeNull();
    expect(screen.queryByLabelText('壁纸预览')).toBeNull();
  });

  it('已设壁纸：出现「恢复默认壁纸」但没有「壁纸预览」；点击后 readWallpaper() 返回 null、按钮同步消失', async () => {
    setWallpaper('data:image/jpeg;base64,AAAA');
    renderSettings();

    expect(await screen.findByRole('button', { name: '恢复默认壁纸' })).toBeTruthy();
    expect(screen.queryByLabelText('壁纸预览')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '恢复默认壁纸' }));
    expect(readWallpaper()).toBeNull();
    expect(screen.queryByRole('button', { name: '恢复默认壁纸' })).toBeNull();
    expect(screen.queryByLabelText('壁纸预览')).toBeNull();
  });

  it('页面源码不写 theme.shape.borderRadius：sx 里的数字圆角是乘数，要写 px 字面量', () => {
    // jsdom 拿不到 emotion 生成样式的计算值，退一步做源码断言
    expect(settingsPageSource).not.toContain('theme.shape.borderRadius');
  });

  it('选图后进裁剪：替身拿到 object URL 与视口比例（390×844 视口下即 390/844）', async () => {
    const originalWidth = window.innerWidth;
    const originalHeight = window.innerHeight;
    window.innerWidth = 390;
    window.innerHeight = 844;
    try {
      renderSettings();
      await screen.findByRole('button', { name: '选择图片' });

      await openCropDialog();

      const cropper = screen.getByTestId('cropper');
      expect(cropper.getAttribute('data-image')).toBe(OBJECT_URL);
      expect(cropper.getAttribute('data-aspect')).toBe(String(390 / 844));
    } finally {
      window.innerWidth = originalWidth;
      window.innerHeight = originalHeight;
    }
  });

  it('点「设为壁纸」：以替身上报的裁剪像素渲染，并把渲染结果写进 localStorage', async () => {
    renderSettings();
    await screen.findByRole('button', { name: '选择图片' });
    await openCropDialog();

    fireEvent.click(screen.getByRole('button', { name: '设为壁纸' }));

    expect(renderWallpaperMock).toHaveBeenCalledWith(expect.any(HTMLImageElement), {
      x: 10,
      y: 20,
      width: 300,
      height: 600,
    });
    expect(readWallpaper()).toBe(RENDERED);
  });

  it('点「取消」：不渲染也不写入（readWallpaper 仍为 null）', async () => {
    renderSettings();
    await screen.findByRole('button', { name: '选择图片' });
    await openCropDialog();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(renderWallpaperMock).not.toHaveBeenCalled();
    expect(readWallpaper()).toBeNull();
  });

  it('退场期间不撤 object URL：对话框仍在 DOM、revoke 未被调用；退场跑完才 revoke 一次', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      renderSettings();
      // 假定时器下不用 findBy*（waitFor 会被计时器接管），渲染与微任务各推进一次即可
      screen.getByRole('button', { name: '选择图片' });
      pickImage();
      await act(async () => {});
      expect(screen.getByText('裁剪壁纸')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: '设为壁纸' }));
      // 写入是同步的，退场还在跑
      expect(readWallpaper()).toBe(RENDERED);

      await act(async () => {
        vi.advanceTimersByTime(Math.floor(MOTION.largeExit / 2));
      });
      expect(screen.queryByText('裁剪壁纸')).not.toBeNull();
      expect(revoke).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(MOTION.largeExit + 50);
      });
      expect(screen.queryByText('裁剪壁纸')).toBeNull();
      expect(revoke).toHaveBeenCalledTimes(1);
      expect(revoke).toHaveBeenCalledWith(OBJECT_URL);
    } finally {
      vi.useRealTimers();
    }
  });

  it('退场途中再点「设为壁纸」：不重复渲染也不重复写入', async () => {
    vi.useFakeTimers();
    try {
      renderSettings();
      screen.getByRole('button', { name: '选择图片' });
      pickImage();
      await act(async () => {});

      fireEvent.click(screen.getByRole('button', { name: '设为壁纸' }));
      await act(async () => {
        vi.advanceTimersByTime(Math.floor(MOTION.largeExit / 2));
      });

      // 退场还没跑完，按钮仍在 DOM 里可点——这一次不许再走一遍渲染与写入
      fireEvent.click(screen.getByRole('button', { name: '设为壁纸' }));

      expect(renderWallpaperMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('拖动缩放条：替身收到的 zoom 跟着变', async () => {
    renderSettings();
    await screen.findByRole('button', { name: '选择图片' });
    await openCropDialog();

    // MUI Slider 的取值口是它内部那个 range input
    fireEvent.change(screen.getByLabelText('缩放'), { target: { value: '2' } });

    expect(screen.getByTestId('cropper').getAttribute('data-zoom')).toBe('2');
  });

  it('图片解码失败：提示「图片处理失败」，不进裁剪', async () => {
    loadWallpaperSourceMock.mockRejectedValue(new Error('decode failed'));
    renderSettings();
    await screen.findByRole('button', { name: '选择图片' });

    pickImage();

    expect(await screen.findByText('图片处理失败')).toBeTruthy();
    expect(screen.queryByText('裁剪壁纸')).toBeNull();
  });

  it('渲染裁剪区域失败：提示「图片处理失败」，不写入壁纸', async () => {
    renderWallpaperMock.mockImplementation(() => {
      throw new Error('canvas 2d 上下文不可用');
    });
    renderSettings();
    await screen.findByRole('button', { name: '选择图片' });
    await openCropDialog();

    fireEvent.click(screen.getByRole('button', { name: '设为壁纸' }));

    expect(await screen.findByText('图片处理失败')).toBeTruthy();
    expect(readWallpaper()).toBeNull();
  });

  it('写入抛 QuotaExceededError（超配额）：提示「图片太大，换一张小一点的」', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    renderSettings();
    await screen.findByRole('button', { name: '选择图片' });
    await openCropDialog();

    fireEvent.click(screen.getByRole('button', { name: '设为壁纸' }));

    expect(await screen.findByText('图片太大，换一张小一点的')).toBeTruthy();
  });

  it('写入抛普通 Error（隐私模式等存储不可用）：提示「无法保存壁纸，浏览器存储不可用」，不误导成换小图', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage denied');
    });
    renderSettings();
    await screen.findByRole('button', { name: '选择图片' });
    await openCropDialog();

    fireEvent.click(screen.getByRole('button', { name: '设为壁纸' }));

    expect(await screen.findByText('无法保存壁纸，浏览器存储不可用')).toBeTruthy();
    expect(screen.queryByText(/图片太大/)).toBeNull();
  });
});
