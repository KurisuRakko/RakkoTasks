// 主题模式：system / light / dark 三态，localStorage 持久化。
// 读写一律 try/catch：隐私模式等场景访问会抛异常，失败回落 'system'。

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import useMediaQuery from '@mui/material/useMediaQuery';
import type { ReactNode } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'rakkotasks.theme-mode';

function readStoredMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
  } catch {
    return 'system';
  }
}

function writeStoredMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // 写失败仅本次会话生效，下次仍回落默认
  }
}

interface ThemeModeValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  /** 实际生效的深浅色（system 时跟随系统偏好） */
  resolved: 'light' | 'dark';
}

const ThemeModeContext = createContext<ThemeModeValue | null>(null);

export function ThemeModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  const resolved = mode === 'system' ? (prefersDark ? 'dark' : 'light') : mode;
  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    writeStoredMode(m);
  }, []);
  const value = useMemo(() => ({ mode, setMode, resolved }), [mode, setMode, resolved]);
  return <ThemeModeContext.Provider value={value}>{children}</ThemeModeContext.Provider>;
}

export function useThemeMode(): ThemeModeValue {
  const ctx = useContext(ThemeModeContext);
  if (!ctx) throw new Error('useThemeMode 必须在 ThemeModeProvider 内使用');
  return ctx;
}
