// RouteTransition 测试：换页只让内容列播入场动画（外层裁剪盒 + 内层动画盒），
// 与浏览器是否支持 View Transitions 无关——stub 出 document.startViewTransition 后
// 组件也必须照旧套盒子，且不调用该 API。
// 裁剪样式必须加在带动画元素的**外层**：overflow 只裁后代不裁自身，加在自身则
// translateX 溢出仍会撑出横向滚动区（移动端实测的「页面变宽再缩回」）。
// 入场动画的 fill-mode 必须是 backwards：动画跑完不得残留 transform，否则残留的
// translateX(0) 会让盒子成为 fixed 后代的包含块与层叠上下文。
// jsdom 不解析 @supports，因此取到的是 hidden 兜底值；clip 由真实浏览器验证。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import RouteTransition from '../src/components/RouteTransition';

// jsdom 运行时不实现 startViewTransition（TS DOM lib 有类型、运行时没有），
// 用可选属性 cast 后直接赋值 / 删除来 stub 与还原
const vtDoc = () => document as unknown as { startViewTransition?: unknown };

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

/** 目标路径的跳转按钮（放在内容列里，换页后的动画盒因此是新挂载的） */
function GoButton({ to }: { to: string }) {
  const navigate = useNavigate();
  return <button onClick={() => navigate(to)}>去 {to}</button>;
}

function renderTransition(initial: string) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route
          path="/"
          element={
            <RouteTransition>
              <div>任务</div>
              <GoButton to="/done" />
            </RouteTransition>
          }
        />
        <Route
          path="/done"
          element={
            <RouteTransition>
              <div>已完成</div>
              <GoButton to="/" />
            </RouteTransition>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

/** 两层 Box：外层裁剪盒（不带 key）、内层动画盒（以 pathname 为 key） */
function boxes(container: HTMLElement): { clipEl: HTMLElement; animatedEl: HTMLElement } {
  const clipEl = container.firstElementChild as HTMLElement;
  const animatedEl = clipEl.firstElementChild as HTMLElement;
  return { clipEl, animatedEl };
}

afterEach(() => {
  cleanup();
  delete vtDoc().startViewTransition;
});

describe('RouteTransition', () => {
  it('裁剪元素与动画元素分离：外层 overflow-x 不为 visible，且是内层动画元素的祖先', () => {
    const { container } = renderTransition('/');
    const { clipEl, animatedEl } = boxes(container);
    expect(getComputedStyle(clipEl).overflowX).not.toBe('visible');
    // 关键：裁剪必须作用在动画元素的祖先上（退回「加在自身」写法时此断言失败）
    expect(clipEl.contains(animatedEl)).toBe(true);
    expect(clipEl).not.toBe(animatedEl);
  });

  it('A：支持 View Transitions 时仍套剪辑盒 + 动画盒，动画是 backwards 收尾且不调该 API', () => {
    const startViewTransition = installStartViewTransition();
    const { container } = renderTransition('/');

    fireEvent.click(screen.getByRole('button', { name: '去 /done' }));
    expect(screen.getByText('已完成')).toBeTruthy();

    const { clipEl, animatedEl } = boxes(container);
    expect(clipEl.contains(animatedEl)).toBe(true);
    expect(clipEl).not.toBe(animatedEl);
    // 前进方向：从右滑入
    const animation = getComputedStyle(animatedEl).animation;
    expect(animation).toContain('rtk-route-right');
    expect(animation).toContain('backwards');
    // 动画结束不得残留 transform：both 会把 to 帧的 translateX(0) 一直留在元素上
    expect(animation).not.toContain('both');
    // 组件只是渲染，不发起转场（RouteTransition 不再碰 View Transitions）
    expect(startViewTransition).not.toHaveBeenCalled();
  });

  it('B：首次渲染（路径未变）内层动画盒不带 animation', () => {
    installStartViewTransition();
    const { container } = renderTransition('/');

    const { animatedEl } = boxes(container);
    expect(screen.getByText('任务')).toBeTruthy();
    expect(getComputedStyle(animatedEl).animation).toBe('');
  });
});
