// 主题：深浅色跟随 ThemeModeProvider 的 resolved 值（system 时跟随系统偏好），
// MD2 默认调色，不做花哨定制。

import { useMemo } from 'react';
import { createTheme } from '@mui/material/styles';
import { useThemeMode } from './lib/theme-mode';

export function useAppTheme() {
  const { resolved } = useThemeMode();
  return useMemo(() => createTheme({ palette: { mode: resolved } }), [resolved]);
}
