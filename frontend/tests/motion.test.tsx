// motion.ts 测试：容器变换对话框状态机（sourceName 的持名/让名时机）、
// rowSx 与离场时长 token；换页跳转 useNavigateTo（lib/nav）的导航行为与
// 「不碰 View Transitions」也在这里——它和容器变换共用同一份 stub 口径。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { LEAVE_DURATION, rowSx, useMorphDialog } from '../src/lib/motion';
import { useNavigateTo } from '../src/lib/nav';
import { ROW_GAP_PX, ROW_MIN_HEIGHT_PX } from '../src/lib/surface';
import { MOTION } from '../src/rakko-tokens';
import { VT_ATTR, VT_NAMES } from '../src/lib/view-transition';
// ?raw：读源文件原文做「无 backdrop-filter」断言；tsconfig 无 @types/node，node:fs 不可用
import tasksPageSource from '../src/pages/TasksPage.tsx?raw';
import donePageSource from '../src/pages/DonePage.tsx?raw';
import assistantPageSource from '../src/pages/AssistantPage.tsx?raw';
import chatComposerSource from '../src/components/assistant/ChatComposer.tsx?raw';
import chatMessageSource from '../src/components/assistant/ChatMessage.tsx?raw';
import receiptCardSource from '../src/components/assistant/ReceiptCard.tsx?raw';
import surfaceSource from '../src/lib/surface.ts?raw';

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
      const go = useNavigateTo();
      const location = useLocation();
      return { go, path: location.pathname, key: location.key };
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

describe('useNavigateTo', () => {
  it('C：跳到不同路径导航生效，且不调 startViewTransition、<html> 上没有 data-vt', () => {
    const startViewTransition = installStartViewTransition();
    const { result } = renderNavProbe('/assistant');
    act(() => result.current.go('/done'));
    expect(result.current.path).toBe('/done');
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(vt()).toBeNull();
  });

  it('D：目标与当前路径相同：不导航（location.key 原地不动，不重复压历史记录）', () => {
    installStartViewTransition();
    const { result } = renderNavProbe('/assistant');
    const before = result.current.key;
    // key 是每条历史记录的唯一标识：真发生一次 push（哪怕同址）它必然换新
    expect(before).toBeTruthy();
    act(() => result.current.go('/assistant'));
    expect(result.current.path).toBe('/assistant');
    expect(result.current.key).toBe(before);
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

  it('行间距做在 padding-bottom：leaving=false 是 ROW_GAP_PX，leaving=true 归零', () => {
    const open = rowSx(0, false, false, false) as Record<string, unknown>;
    expect(open.paddingBottom).toBe(`${ROW_GAP_PX}px`);
    const leaving = rowSx(0, true, false, false) as Record<string, unknown>;
    expect(leaving.paddingBottom).toBe(0);
  });

  it('离场时 padding-bottom 与 grid-template-rows 同长同曲线：transition 含 padding-bottom', () => {
    const sx = rowSx(0, false, false, false) as Record<string, unknown>;
    expect(sx.transition).toContain('padding-bottom');
  });

  it('行最小高度做在 & > * 上并随离场归零：leaving=false 是 ROW_MIN_HEIGHT_PX，leaving=true 归零', () => {
    const open = rowSx(0, false, false, false) as Record<string, Record<string, unknown>>;
    expect(open['& > *'].minHeight).toBe(`${ROW_MIN_HEIGHT_PX}px`);
    // 离场必须能收到 0：行高靠 grid-template-rows 从 1fr 收到 0fr 折叠，子元素若
    // 自带 min-height: 48px，行会卡在 48px 收不干净，折叠后留一条 48px 空隙
    const leaving = rowSx(0, true, false, false) as Record<string, Record<string, unknown>>;
    expect(leaving['& > *'].minHeight).toBe(0);
    // reduced 分支走的是同一个 box，离场同样要归零
    const openReduced = rowSx(0, false, true, false) as Record<string, Record<string, unknown>>;
    expect(openReduced['& > *'].minHeight).toBe(`${ROW_MIN_HEIGHT_PX}px`);
    const leavingReduced = rowSx(0, true, true, true) as Record<string, Record<string, unknown>>;
    expect(leavingReduced['& > *'].minHeight).toBe(0);
    // 值本身：48 的来历是无摘要的单行任务内容只有 22px、行本身该是 48px 的点击目标，
    // 且勾选框的盒高 24 + 9×2 = 42px 此前被行的 overflow: hidden 裁到与行等高
    // （有效触控 36px），48px 让 42px 的勾选框完整落在行内。落在 8px 网格上是为了
    // 与 ROW_GAP_PX（8）和 MUI 默认的 8px 竖向内边距对齐。
    expect(ROW_MIN_HEIGHT_PX).toBe(48);
    expect(ROW_MIN_HEIGHT_PX % 8).toBe(0);
  });

  it('reduced 分支同样带 paddingBottom：无动效时离场折叠也要收间距', () => {
    const open = rowSx(0, false, true, false) as Record<string, unknown>;
    expect(open.paddingBottom).toBe(`${ROW_GAP_PX}px`);
    const leaving = rowSx(0, true, true, true) as Record<string, unknown>;
    expect(leaving.paddingBottom).toBe(0);
    // reduced 分支仍是不带 transition / animation 的纯网格 box
    expect(leaving).not.toHaveProperty('transition');
    expect(leaving).not.toHaveProperty('animation');
  });
});

describe('列表卡片层无 backdrop-filter（预算第 3 条硬红线）', () => {
  it('两个列表页、助理页与它的三个子组件、以及 surface.ts 的源码里都没有 backdrop-filter', () => {
    for (const source of [
      tasksPageSource,
      donePageSource,
      assistantPageSource,
      chatComposerSource,
      chatMessageSource,
      receiptCardSource,
      surfaceSource,
    ]) {
      expect(source).not.toContain('backdrop-filter');
    }
  });
});

describe('LEAVE_DURATION', () => {
  it('等于 MOTION.largeExit', () => {
    expect(LEAVE_DURATION).toBe(MOTION.largeExit);
  });
});
