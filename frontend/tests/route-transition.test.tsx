// RouteTransition 测试：包裹元素必须横向裁剪（overflow-x 不为 visible），
// 否则入场位移 translateX(±24px) 会撑出横向滚动区（移动端实测的「页面变宽再缩回」）。
// jsdom 不解析 @supports，因此取到的是 hidden 兜底值；clip 由真实浏览器验证。

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import RouteTransition from '../src/components/RouteTransition';

afterEach(() => {
  cleanup();
});

describe('RouteTransition', () => {
  it('包裹元素的 overflow-x 不为 visible（位移期间不撑出横向滚动区）', () => {
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
    const box = container.firstElementChild as HTMLElement;
    expect(getComputedStyle(box).overflowX).not.toBe('visible');
  });
});
