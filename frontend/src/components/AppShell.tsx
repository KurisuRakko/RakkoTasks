// 应用壳：桌面常驻抽屉 + 移动底栏 + 统一 AppBar（标题随路由）+ 路由出口。
// 导航项全部来自 lib/nav 单一数据源；AppBar 不限宽，内容区限宽 840px 居中。
// 壳层三件套（AppBar / 底栏 / 抽屉）不直接挂 view-transition-name，只打
// data-vt-shell 标记（见 lib/view-transition 的 shellAttr）；何时持名由样式层按
// <html data-vt> 的转场种类决定——换页（route-*）时下发名字作共享元素交叉淡化、
// 保持静止，开合详情（expand / collapse）时不下发，让壳层留在 root 快照里随
// 遮罩一起压暗。

import { useLocation, Navigate, Route, Routes } from 'react-router-dom';
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
import { useTheme } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTransitionNavigate } from '../lib/motion';
import { NAV_ITEMS, navIndexOf } from '../lib/nav';
import { shellAttr, VT_NAMES } from '../lib/view-transition';
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
  // 带方向的路由跳转（View Transitions）；目标等于当前路径时它自己会跳过
  const go = useTransitionNavigate();
  const navIndex = navIndexOf(location.pathname);
  const theme = useTheme();
  // 与抽屉 display: { xs: 'none', md: 'block' } 同一断点（md = 900px）：桌面端常驻
  // 抽屉里有「设置」入口，AppBar 的按钮只留给没有抽屉的移动端
  const desktop = useMediaQuery(theme.breakpoints.up('md'));

  return (
    <Box sx={{ display: 'flex', minHeight: '100dvh' }}>
      {/* 桌面端：常驻抽屉（md=900px 起） */}
      <Drawer
        variant="permanent"
        sx={{
          display: { xs: 'none', md: 'block' },
          width: DRAWER_WIDTH,
          // 抽屉与移动端底栏靠断点 display 互斥，同一时刻只有一个元素挂同一个标记，不会撞名
          '& .MuiDrawer-paper': {
            width: DRAWER_WIDTH,
            boxSizing: 'border-box',
          },
        }}
        slotProps={{ paper: shellAttr(VT_NAMES.navDrawer) }}
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
              onClick={() => go(item.path)}
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
          <ListItemButton selected={navIndex === -1} onClick={() => go('/settings')}>
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
        {/* AppBar 是换页转场共享元素：只打 data-vt-shell 标记，名字由样式层按转场种类下发 */}
        <AppBar position="sticky" elevation={0} {...shellAttr(VT_NAMES.appBar)}>
          <Toolbar>
            <Typography variant="h6" noWrap sx={{ flexGrow: 1 }}>
              {titleFor(navIndex)}
            </Typography>
            {/* 移动端入口：桌面端（md 起）抽屉左下角已有「设置」项，这里不重复放 */}
            {navIndex !== -1 && !desktop && (
              <IconButton color="inherit" aria-label="设置" onClick={() => go('/settings')}>
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
        {...shellAttr(VT_NAMES.bottomNav)}
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
          onChange={(_e, v) => go(NAV_ITEMS[v].path)}
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
