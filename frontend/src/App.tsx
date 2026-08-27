// 应用壳：登录引导（consumeCallback → getMe → startLogin）+ 底部导航 + 路由。

import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import BottomNavigation from '@mui/material/BottomNavigation';
import BottomNavigationAction from '@mui/material/BottomNavigationAction';
import CircularProgress from '@mui/material/CircularProgress';
import Paper from '@mui/material/Paper';
import ChecklistIcon from '@mui/icons-material/Checklist';
import MonitorHeartIcon from '@mui/icons-material/MonitorHeart';
import SearchIcon from '@mui/icons-material/Search';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { consumeCallback, getMe, startLogin } from './lib/phainon';
import { useAppTheme } from './theme';
import TasksPage from './pages/TasksPage';
import SearchPage from './pages/SearchPage';
import StatusPage from './pages/StatusPage';

function Nav() {
  const location = useLocation();
  const navigate = useNavigate();
  const value = location.pathname.startsWith('/search')
    ? 1
    : location.pathname.startsWith('/status')
      ? 2
      : 0;
  return (
    <Paper
      elevation={8}
      sx={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 1100,
        pb: 'env(safe-area-inset-bottom)',
      }}
    >
      <BottomNavigation
        value={value}
        onChange={(_e, v) => navigate(v === 1 ? '/search' : v === 2 ? '/status' : '/')}
        showLabels
      >
        <BottomNavigationAction label="任务" icon={<ChecklistIcon />} />
        <BottomNavigationAction label="搜索" icon={<SearchIcon />} />
        <BottomNavigationAction label="状态" icon={<MonitorHeartIcon />} />
      </BottomNavigation>
    </Paper>
  );
}

function Shell() {
  return (
    <>
      <Box
        component="main"
        sx={{ pb: 'calc(64px + env(safe-area-inset-bottom))', minHeight: '100dvh' }}
      >
        <Routes>
          <Route path="/" element={<TasksPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/status" element={<StatusPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Box>
      <Nav />
    </>
  );
}

function AuthGate() {
  const [booted, setBooted] = useState(false);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      // 先消费回跳 hash（若有 login_code 则换 token 并清 hash），再验证身份
      await consumeCallback();
      const me = await getMe();
      if (!alive) return;
      if (me) {
        setSignedIn(true);
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
  return signedIn ? <Shell /> : null;
}

export default function App() {
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
