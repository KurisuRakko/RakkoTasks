// theme-mode Provider 测试：localStorage 读写、非法值回落、getItem 抛异常不崩溃。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeModeProvider, useThemeMode } from '../src/lib/theme-mode';

function Probe() {
  const { mode, setMode } = useThemeMode();
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <button onClick={() => setMode('dark')}>dark</button>
    </div>
  );
}

function renderProbe() {
  return render(
    <ThemeModeProvider>
      <Probe />
    </ThemeModeProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ThemeModeProvider', () => {
  it('setMode(dark) 后 localStorage 写入 rakkotasks.theme-mode=dark 并生效', () => {
    renderProbe();
    expect(screen.getByTestId('mode').textContent).toBe('system');
    fireEvent.click(screen.getByRole('button', { name: 'dark' }));
    expect(localStorage.getItem('rakkotasks.theme-mode')).toBe('dark');
    expect(screen.getByTestId('mode').textContent).toBe('dark');
  });

  it('初始化时读取已存的 light 并生效', () => {
    localStorage.setItem('rakkotasks.theme-mode', 'light');
    renderProbe();
    expect(screen.getByTestId('mode').textContent).toBe('light');
  });

  it('存了非法值时回落 system', () => {
    localStorage.setItem('rakkotasks.theme-mode', 'purple');
    renderProbe();
    expect(screen.getByTestId('mode').textContent).toBe('system');
  });

  it('getItem 抛异常时不崩溃且回落 system', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage denied');
    });
    renderProbe();
    expect(screen.getByTestId('mode').textContent).toBe('system');
  });
});
