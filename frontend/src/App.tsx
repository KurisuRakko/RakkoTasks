// 应用根：主题模式 Provider（必须包在 ThemeProvider 外层）+ 登录引导（consumeCallback → getMe → startLogin）。
// 路由与壳层在 AppShell；本文件只保留 Provider 与 AuthGate。

import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { consumeCallback, getMe, startLogin } from './lib/phainon';
import { useAppTheme } from './theme';
import { ThemeModeProvider } from './lib/theme-mode';
import { SessionProvider } from './lib/session';
import AppShell from './components/AppShell';
import type { PhainonMe } from './types';

function AuthGate() {
  const [booted, setBooted] = useState(false);
  const [me, setMe] = useState<PhainonMe | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      // 先消费回跳 hash（若有 login_code 则换 token 并清 hash），再验证身份
      await consumeCallback();
      const result = await getMe();
      if (!alive) return;
      if (result) {
        setMe(result);
      } else {
        startLogin();
      }
      setBooted(true);
    })().catch(() => {
      if (!alive) return;
      startLogin();
      setBooted(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!booted) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100dvh' }}>
        <CircularProgress />
      </Box>
    );
  }
  return me ? (
    <SessionProvider value={me}>
      <AppShell />
    </SessionProvider>
  ) : null;
}

function ThemedApp() {
  const theme = useAppTheme();
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <BrowserRouter>
        <AuthGate />
      </BrowserRouter>
    </ThemeProvider>
  );
}

export default function App() {
  return (
    <ThemeModeProvider>
      <ThemedApp />
    </ThemeModeProvider>
  );
}
