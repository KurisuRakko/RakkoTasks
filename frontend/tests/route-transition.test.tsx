// RouteTransition 测试：裁剪样式必须加在带动画元素的**外层**（overflow 只裁后代不裁自身，
// 加在自身则 translateX 溢出仍会撑出横向滚动区——移动端实测的「页面变宽再缩回」）。
// 该两层结构只在「不支持 View Transitions」的回退路径出现（jsdom 默认无
// document.startViewTransition，因此原用例成立）；stub 该 API 后组件应彻底让位：
// 不套任何盒子，children 直接成为渲染结果。
// jsdom 不解析 @supports，因此取到的是 hidden 兜底值；clip 由真实浏览器验证。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import RouteTransition from '../src/components/RouteTransition';

// jsdom 运行时不实现 startViewTransition（TS DOM lib 有类型、运行时没有），
// 用可选属性 cast 后直接赋值 / 删除来 stub 与还原
const vtDoc = () => document as unknown as { startViewTransition?: unknown };

afterEach(() => {
  cleanup();
  delete vtDoc().startViewTransition;
});

describe('RouteTransition', () => {
  it('裁剪元素与动画元素分离：外层 overflow-x 不为 visible，且是内层动画元素的祖先', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route
            path="/"
            element={
              <RouteTransition>
                <div>内容</div>
              </RouteTransition>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    // 两层 Box：外层裁剪盒（不带 key）、内层动画盒（带 key）
    const clipEl = container.firstElementChild as HTMLElement;
    const animatedEl = clipEl.firstElementChild as HTMLElement;
    expect(getComputedStyle(clipEl).overflowX).not.toBe('visible');
    // 关键：裁剪必须作用在动画元素的祖先上（退回「加在自身」写法时此断言失败）
    expect(clipEl.contains(animatedEl)).toBe(true);
    expect(clipEl).not.toBe(animatedEl);
  });

  it('支持 View Transitions 时不套任何包裹盒：children 就是渲染结果的直接子元素', () => {
    // stub 让 supportsViewTransitions() 为真：转场完全交给 View Transitions，
    // 组件必须直接返回 children，不留 MUI Box 层（残留 transform 会让 fixed 子元素跟随滚动）
    const startViewTransition = vi.fn((callback: () => void) => {
      callback();
      return {
        finished: Promise.resolve(),
        ready: Promise.resolve(),
        updateCallbackDone: Promise.resolve(),
      };
    });
    vtDoc().startViewTransition = startViewTransition;

    const { container } = render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route
            path="/"
            element={
              <RouteTransition>
                <div>内容</div>
              </RouteTransition>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(startViewTransition).not.toHaveBeenCalled(); // 只是渲染，不触发转场
    // 唯一的直接子元素就是内容本身，没有被 MUI Box 包裹
    expect(container.childElementCount).toBe(1);
    const child = container.firstElementChild as HTMLElement;
    expect(child.tagName.toLowerCase()).toBe('div');
    expect(child.textContent).toBe('内容');
    expect(child.classList.contains('MuiBox-root')).toBe(false);
  });
});
