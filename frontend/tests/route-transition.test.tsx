// RouteTransition 测试：裁剪样式必须加在带动画元素的**外层**（overflow 只裁后代不裁自身，
// 加在自身则 translateX 溢出仍会撑出横向滚动区——移动端实测的「页面变宽再缩回」）。
// jsdom 不解析 @supports，因此取到的是 hidden 兜底值；clip 由真实浏览器验证。

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import RouteTransition from '../src/components/RouteTransition';

afterEach(() => {
  cleanup();
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
});
