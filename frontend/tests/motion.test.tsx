// motion.ts 测试：带方向的 View Transitions 路由跳转（data-vt 标记与导航行为）、
// 容器变换对话框状态机（sourceName 的持名/让名时机）、rowSx 与离场时长 token。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { LEAVE_DURATION, rowSx, useMorphDialog, useTransitionNavigate } from '../src/lib/motion';
import { MOTION } from '../src/rakko-tokens';
import { VT_ATTR, VT_NAMES } from '../src/lib/view-transition';

// jsdom 运行时不实现 startViewTransition（TS DOM lib 有类型、运行时没有），
// 用可选属性 cast 后直接赋值 / 删除来 stub 与还原
const vtDoc = () => document as unknown as { startViewTransition?: unknown };

interface Row {
  key: number;
  label: string;
}

/** stub document.startViewTransition：同步执行回调，finished 为已 resolve 的 Promise */
function installStartViewTransition(): ReturnType<typeof vi.fn> {
  const fn = vi.fn((callback: () => void) => {
    callback();
    return {
      finished: Promise.resolve(),
      ready: Promise.resolve(),
      updateCallbackDone: Promise.resolve(),
    };
  });
  vtDoc().startViewTransition = fn;
  return fn;
}

const vt = () => document.documentElement.getAttribute(VT_ATTR);

afterEach(() => {
  cleanup();
  delete vtDoc().startViewTransition;
  document.documentElement.removeAttribute(VT_ATTR);
  vi.restoreAllMocks();
});

function themeWrapper({ children }: { children: ReactNode }) {
  return <ThemeProvider theme={createTheme()}>{children}</ThemeProvider>;
}

function renderNavProbe(initial: string) {
  return renderHook(
    () => {
      const go = useTransitionNavigate();
      const location = useLocation();
      return { go, path: location.pathname };
    },
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <ThemeProvider theme={createTheme()}>
          <MemoryRouter initialEntries={[initial]} useTransitions={false}>
            {children}
          </MemoryRouter>
        </ThemeProvider>
      ),
    },
  );
}

describe('useTransitionNavigate 方向映射', () => {
  it('/ → /done 是 route-forward，导航生效且结束后清除标记', async () => {
    installStartViewTransition();
    const { result } = renderNavProbe('/');
    act(() => result.current.go('/done'));
    expect(vt()).toBe('route-forward');
    expect(result.current.path).toBe('/done');
    await act(async () => {});
    expect(vt()).toBeNull();
  });

  it('/done → / 是 route-back', async () => {
    installStartViewTransition();
    const { result } = renderNavProbe('/done');
    act(() => result.current.go('/'));
    expect(vt()).toBe('route-back');
    expect(result.current.path).toBe('/');
    await act(async () => {});
    expect(vt()).toBeNull();
  });

  it('任意页 → /settings 按 route-forward（settings 视为更深一层）', async () => {
    installStartViewTransition();
    const { result } = renderNavProbe('/search');
    act(() => result.current.go('/settings'));
    expect(vt()).toBe('route-forward');
    expect(result.current.path).toBe('/settings');
    await act(async () => {});
    expect(vt()).toBeNull();
  });

  it('/settings → / 是 route-back', async () => {
    installStartViewTransition();
    const { result } = renderNavProbe('/settings');
    act(() => result.current.go('/'));
    expect(vt()).toBe('route-back');
    expect(result.current.path).toBe('/');
    await act(async () => {});
    expect(vt()).toBeNull();
  });

  it('目标等于当前路径：不发生导航、不调用转场、不打标记', async () => {
    const startViewTransition = installStartViewTransition();
    const { result } = renderNavProbe('/');
    act(() => result.current.go('/'));
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(result.current.path).toBe('/');
    expect(vt()).toBeNull();
  });
});

describe('useMorphDialog 状态机', () => {
  it('初始 current 为 null、sourceName 为 undefined；open 后名字归对话框；close 后来源持名，finished 后回落', async () => {
    installStartViewTransition();
    const key = 7;
    const item: Row = { key, label: '写周报' };
    const { result } = renderHook(() => useMorphDialog<Row>((row) => row.key), {
      wrapper: themeWrapper,
    });

    // 初始：对话框关闭，无来源持名
    expect(result.current.current).toBeNull();
    expect(result.current.sourceName(key)).toBeUndefined();

    // open：对话框已开，名字归对话框 paper，来源不再持名
    act(() => result.current.open(item));
    expect(result.current.current).toEqual(item);
    expect(result.current.sourceName(key)).toBeUndefined();
    expect(result.current.sourceName(999)).toBeUndefined();

    // close：current 立即清空；转场 finished 前来源元素重新持名
    act(() => result.current.close());
    expect(result.current.current).toBeNull();
    expect(result.current.sourceName(key)).toBe(VT_NAMES.sheet);

    // finished 之后 sourceName 回落为 undefined
    await act(async () => {});
    expect(result.current.sourceName(key)).toBeUndefined();
  });
});

describe('rowSx', () => {
  it('reduced + leaving：只有收起的网格样式，不含 transition 与 animation', () => {
    const sx = rowSx(0, true, true, true) as Record<string, unknown>;
    expect(sx).not.toHaveProperty('transition');
    expect(sx).not.toHaveProperty('animation');
    expect(sx.gridTemplateRows).toBe('0fr');
    // 显式 1fr 列撑满容器：行宽不再随内容长短变化，右侧标签每行对齐
    expect(sx.gridTemplateColumns).toBe('minmax(0, 1fr)');
  });

  it('正常入场：grid 行容器 + 入场 animation', () => {
    const sx = rowSx(0, false, false, true) as Record<string, unknown>;
    expect(sx.display).toBe('grid');
    expect(sx.gridTemplateRows).toBe('1fr');
    expect(sx.gridTemplateColumns).toBe('minmax(0, 1fr)');
    expect(sx.animation).toContain('rtk-enter-up');
  });

  it('stagger：index 2 的 animationDelay 大于 index 0', () => {
    const delay = (index: number) =>
      parseInt(String((rowSx(index, false, false, true) as Record<string, unknown>).animationDelay), 10);
    expect(delay(2)).toBeGreaterThan(delay(0));
  });

  it('enter 为 false（命中缓存，列表已就位）：无 animation / animationDelay，但保留 grid 与离场 transition', () => {
    const sx = rowSx(0, false, false, false) as Record<string, unknown>;
    expect(sx).not.toHaveProperty('animation');
    expect(sx).not.toHaveProperty('animationDelay');
    expect(sx).not.toHaveProperty('@keyframes rtk-enter-up');
    expect(sx.display).toBe('grid');
    expect(sx.gridTemplateColumns).toBe('minmax(0, 1fr)');
    expect(sx.transition).toContain('grid-template-rows');
  });

  it('enter 为 true 但 leaving：同样不挂 animation（离场与入场动画会互相覆盖 transform）', () => {
    const sx = rowSx(0, true, false, true) as Record<string, unknown>;
    expect(sx).not.toHaveProperty('animation');
    expect(sx.gridTemplateRows).toBe('0fr');
    expect(sx.transition).toContain('grid-template-rows');
  });
});

describe('LEAVE_DURATION', () => {
  it('等于 MOTION.largeExit', () => {
    expect(LEAVE_DURATION).toBe(MOTION.largeExit);
  });
});
