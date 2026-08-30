// 应用壳：桌面常驻抽屉 + 移动底栏 + 统一 AppBar（标题随路由）+ 路由出口。
// 导航项全部来自 lib/nav 单一数据源；AppBar 不限宽，内容区限宽 840px 居中。

import { useLocation, useNavigate, Navigate, Route, Routes } from 'react-router-dom';
import AppBar from '@mui/material/AppBar';
import BottomNavigation from '@mui/material/BottomNavigation';
import BottomNavigationAction from '@mui/material/BottomNavigationAction';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Paper from '@mui/material/Paper';
import SettingsIcon from '@mui/icons-material/Settings';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import { NAV_ITEMS, navIndexOf } from '../lib/nav';
import RouteTransition from './RouteTransition';
import TasksPage from '../pages/TasksPage';
import SearchPage from '../pages/SearchPage';
import DonePage from '../pages/DonePage';
import SettingsPage from '../pages/SettingsPage';

/** 桌面抽屉宽度 */
export const DRAWER_WIDTH = 240;

/** AppBar 标题：顺序与 NAV_ITEMS 索引对齐，末尾一位给设置页（索引 -1） */
const TITLES = ['RakkoTasks', 'AI 搜索', '已完成', '设置'] as const;

function titleFor(navIndex: number): string {
  return navIndex === -1 ? TITLES[3] : TITLES[navIndex];
}

export default function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const navIndex = navIndexOf(location.pathname);

  return (
    <Box sx={{ display: 'flex', minHeight: '100dvh' }}>
      {/* 桌面端：常驻抽屉（md=900px 起） */}
      <Drawer
        variant="permanent"
        sx={{
          display: { xs: 'none', md: 'block' },
          width: DRAWER_WIDTH,
          '& .MuiDrawer-paper': { width: DRAWER_WIDTH, boxSizing: 'border-box' },
        }}
      >
        <Toolbar>
          <Typography variant="h6" noWrap>
            RakkoTasks
          </Typography>
        </Toolbar>
        <Divider />
        <List disablePadding>
          {NAV_ITEMS.map((item) => (
            <ListItemButton
              key={item.path}
              selected={navIndexOf(location.pathname) === navIndexOf(item.path)}
              onClick={() => navigate(item.path)}
            >
              <ListItemIcon>
                <item.icon />
              </ListItemIcon>
              <ListItemText primary={item.label} />
            </ListItemButton>
          ))}
        </List>
        <Box sx={{ flexGrow: 1 }} />
        <Divider />
        {/* List 包裹：ListItemButton 根样式带 flex-grow:1，直接作为 Drawer 子元素会被撑满主轴 */}
        <List disablePadding>
          <ListItemButton selected={navIndex === -1} onClick={() => navigate('/settings')}>
            <ListItemIcon>
              <SettingsIcon />
            </ListItemIcon>
            <ListItemText primary="设置" />
          </ListItemButton>
        </List>
      </Drawer>

      <Box
        component="main"
        sx={{
          flexGrow: 1,
          minWidth: 0,
          pb: { xs: 'calc(64px + env(safe-area-inset-bottom))', md: 0 },
        }}
      >
        <AppBar position="sticky" elevation={0}>
          <Toolbar>
            <Typography variant="h6" noWrap sx={{ flexGrow: 1 }}>
              {titleFor(navIndex)}
            </Typography>
            {navIndex !== -1 && (
              <IconButton color="inherit" aria-label="设置" onClick={() => navigate('/settings')}>
                <SettingsIcon />
              </IconButton>
            )}
          </Toolbar>
        </AppBar>
        <Box sx={{ maxWidth: 840, mx: 'auto', width: '100%' }}>
          <RouteTransition>
            <Routes>
              <Route path="/" element={<TasksPage />} />
              <Route path="/search" element={<SearchPage />} />
              <Route path="/done" element={<DonePage />} />
              <Route path="/settings" element={<SettingsPage />} />
              {/* 旧书签 /status 兼容：重定向到设置页 */}
              <Route path="/status" element={<Navigate to="/settings" replace />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </RouteTransition>
        </Box>
      </Box>

      {/* 移动端：底部导航（md 以下），固定定位，内容区已预留 padding */}
      <Paper
        elevation={8}
        sx={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 1100,
          pb: 'env(safe-area-inset-bottom)',
          display: { xs: 'block', md: 'none' },
        }}
      >
        <BottomNavigation
          value={navIndex}
          onChange={(_e, v) => navigate(NAV_ITEMS[v].path)}
          showLabels
        >
          {NAV_ITEMS.map((item) => (
            <BottomNavigationAction key={item.path} label={item.label} icon={<item.icon />} />
          ))}
        </BottomNavigation>
      </Paper>
    </Box>
  );
}
