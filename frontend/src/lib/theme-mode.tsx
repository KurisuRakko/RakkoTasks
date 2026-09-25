// 主题模式：system / light / dark 三态，localStorage 持久化。
// 读写一律 try/catch：隐私模式等场景访问会抛异常，失败回落 'system'。
//
// 还负责一处副作用：把 <meta name="theme-color"> 改写成当前解析模式下的页面背景色。
// PWA standalone 下这条 meta 就是 iOS/Android 状态栏的字面底色，index.html 里它是写死的
// 浅色纸色（#f9f8f5，与 NEUTRAL_LIGHT[0] 同值），深色用户会看到状态栏与页面之间有一道
// 浅色横条。取值与主题层同源：两支都是 palette.background.default（= n1），
// 也就是 CssBaseline 下发的 --color-paper。

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import useMediaQuery from '@mui/material/useMediaQuery';
import type { ReactNode } from 'react';
import { NEUTRAL_DARK, NEUTRAL_LIGHT } from '../rakko-tokens';

export type ThemeMode = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'rakkotasks.theme-mode';

/** 状态栏底色：解析后的模式 → 该模式的页面背景色（n1 = palette.background.default） */
const THEME_COLOR_BY_MODE = {
  light: NEUTRAL_LIGHT[0],
  dark: NEUTRAL_DARK[0],
} as const;

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
  useEffect(() => {
    // 不重写 index.html：那边是模块系统之外的静态首帧值，这里只负责随模式改写。
    // 查询放在 effect 内而不是模块顶层：测试与嵌入场景可能没有这条 meta。
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', THEME_COLOR_BY_MODE[resolved]);
  }, [resolved]);
  const value = useMemo(() => ({ mode, setMode, resolved }), [mode, setMode, resolved]);
  return <ThemeModeContext.Provider value={value}>{children}</ThemeModeContext.Provider>;
}

export function useThemeMode(): ThemeModeValue {
  const ctx = useContext(ThemeModeContext);
  if (!ctx) throw new Error('useThemeMode 必须在 ThemeModeProvider 内使用');
  return ctx;
}
