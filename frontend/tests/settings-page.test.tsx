// SettingsPage 测试：已停用账户的变暗必须由 filter 实现，不能靠 opacity——
// 入场动画 animation-fill-mode: both 会把关键帧终态 opacity: 1 保持在元素上
// （动画值优先级高于普通声明），静态 opacity 声明会被压掉、变暗失效。
// 账户分区逻辑迁去 AccountsSection 后仍在同一页面上渲染，这些断言继续适用；
// AccountsSection 内部会调用带方向导航的 hook，渲染需要 Router 上下文。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SettingsPage from '../src/pages/SettingsPage';
import { ThemeModeProvider } from '../src/lib/theme-mode';
import { readWallpaper, setWallpaper } from '../src/lib/wallpaper';
import type { WallpaperArea } from '../src/lib/wallpaper';
import { MOTION } from '../src/rakko-tokens';
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

  it('七个分区（账户状态…关于）都包在 data-glass="panel" 玻璃面板里，按渲染顺序对应', async () => {
    vi.stubGlobal('fetch', makeFetchMock());
    render(
      <ThemeModeProvider>
        <MemoryRouter>
          <SettingsPage />
        </MemoryRouter>
      </ThemeModeProvider>,
    );

    // 分区标题是静态内容，渲染即可断言；渲染顺序与页面书写顺序一致
    const titles = ['邮箱账户', '外观', '壁纸', '日历订阅', '提醒事项同步', '账户', '关于'];
    const panels = Array.from(document.querySelectorAll('[data-glass="panel"]'));
    expect(panels).toHaveLength(titles.length);
    panels.forEach((panel, i) => {
      expect(panel.textContent, `第 ${i + 1} 个面板应含「${titles[i]}」`).toContain(titles[i]);
    });
  });

  it('按钮不再有 warning 配色（源码断言）：color="warning" 与 <Divider 均已删除', () => {
    expect(settingsPageSource).not.toContain('color="warning"');
    expect(settingsPageSource).not.toContain('<Divider');
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

  it('未设壁纸：只有「选择图片」，没有「移除壁纸」也没有「壁纸预览」', async () => {
    renderSettings();

    expect(await screen.findByRole('button', { name: '选择图片' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '移除壁纸' })).toBeNull();
    expect(screen.queryByLabelText('壁纸预览')).toBeNull();
  });

  it('已设壁纸：出现「移除壁纸」但没有「壁纸预览」；点击移除后 readWallpaper() 返回 null、按钮同步消失', async () => {
    setWallpaper('data:image/jpeg;base64,AAAA');
    renderSettings();

    expect(await screen.findByRole('button', { name: '移除壁纸' })).toBeTruthy();
    expect(screen.queryByLabelText('壁纸预览')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '移除壁纸' }));
    expect(readWallpaper()).toBeNull();
    expect(screen.queryByRole('button', { name: '移除壁纸' })).toBeNull();
    expect(screen.queryByLabelText('壁纸预览')).toBeNull();
  });

  it('壁纸预览块已从页面源码里删除（不是靠样式藏起来）', () => {
    // jsdom 拿不到 emotion 生成样式的计算值，退一步做源码断言
    expect(settingsPageSource).not.toContain('壁纸预览');
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
