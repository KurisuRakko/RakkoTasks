// 应用根：主题模式 Provider（必须包在 ThemeProvider 外层）+ 登录引导（consumeCallback → getMe → startLogin）。
// 路由与壳层在 AppShell；本文件只保留 Provider 与 AuthGate。

import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import { BrowserRouter } from 'react-router-dom';
import { StyledEngineProvider, ThemeProvider } from '@mui/material/styles';
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
      {/* useTransitions={false}：react-router 默认把导航引发的状态更新包进 React.startTransition，
          flushSync 冲不动 transition lane，View Transitions 会因此拍到尚未更新的旧页面快照；
          本应用没有 Suspense 数据路由，关掉不损失任何东西 */}
      <BrowserRouter useTransitions={false}>
        <AuthGate />
      </BrowserRouter>
    </ThemeProvider>
  );
}

export default function App() {
  // injectFirst 让 MUI 的 emotion 样式插到 <head> 最前面，rakko-glass.css 作为静态 CSS
  // 排在其后。[data-glass='chrome'] 与 .MuiAppBar-colorDefault 特异性同为 (0,1,0)，
  // 同特异性下后插入的赢——不 injectFirst，MUI 自带的 background-color 会盖掉玻璃配方。
  return (
    <StyledEngineProvider injectFirst>
      <ThemeModeProvider>
        <ThemedApp />
      </ThemeModeProvider>
    </StyledEngineProvider>
  );
}
