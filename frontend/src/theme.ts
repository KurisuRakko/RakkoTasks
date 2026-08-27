// 主题：跟随系统深浅色，MD2 默认调色，不做花哨定制。

import { useMemo } from 'react';
import { createTheme } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';

export function useAppTheme() {
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  return useMemo(
    () =>
      createTheme({
        palette: { mode: prefersDark ? 'dark' : 'light' },
      }),
    [prefersDark],
  );
}
