// 应用壳：桌面常驻抽屉 + 移动底栏 + 统一 AppBar（标题随路由）+ 路由出口。
// 导航项全部来自 lib/nav 单一数据源；AppBar 不限宽，内容区限宽居中。
// 抽屉宽（DRAWER_WIDTH）与内容列宽（CONTENT_MAX_WIDTH）收在 lib/layout 单一来源，
// 从列表行长出来的详情对话框与内容列共用同一宽度（columnDialogSx）。
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
import { CONTENT_MAX_WIDTH, DRAWER_WIDTH } from '../lib/layout';
import { NAV_ITEMS, navIndexOf } from '../lib/nav';
import { shellAttr, VT_NAMES } from '../lib/view-transition';
import RouteTransition from './RouteTransition';
import TasksPage from '../pages/TasksPage';
import SearchPage from '../pages/SearchPage';
import DonePage from '../pages/DonePage';
import SettingsPage from '../pages/SettingsPage';

/** AppBar 标题：顺序与 NAV_ITEMS 索引对齐，末尾一位给设置页（索引 -1） */
const TITLES = ['RakkoTasks', 'AI 搜索', '已完成', '设置'] as const;

function titleFor(navIndex: number): string {
  return navIndex === -1 ? TITLES[3] : TITLES[navIndex];
}

/** 桌面抽屉 paper 的壳层属性：转场持名标记（何时持名由样式层按转场种类决定）+
 *  常驻 chrome 玻璃（侧边栏是常驻 chrome，身后是壁纸，材质由 rakko-glass.css 的
 *  chrome 档提供；主题层已让位）。chrome 档的发丝线在下缘、方向对不上侧边栏——
 *  右边框仍由主题层的 MuiDrawer.paper 提供（那条已经在，不要动）。 */
const NAV_DRAWER_PAPER_PROPS = {
  ...shellAttr(VT_NAMES.navDrawer),
  'data-glass': 'chrome',
} as const;

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
        slotProps={{ paper: NAV_DRAWER_PAPER_PROPS }}
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

      {/* 内容区不再有玻璃底板：列表行自己就是 data-glass="panel" 玻璃（对上游
          anti-patterns 的明知偏离，理由见 surface.ts 文件头），整页玻璃只剩壳层
          chrome（顶栏 / 侧边栏 / 底栏）与各行 panel。 */}
      <Box
        component="main"
        sx={{
          flexGrow: 1,
          minWidth: 0,
          pb: { xs: 'calc(64px + env(safe-area-inset-bottom))', md: 0 },
        }}
      >
        {/* AppBar 是换页转场共享元素：只打 data-vt-shell 标记，名字由样式层按转场种类下发 */}
        {/* 常驻 chrome 玻璃：材质来自 rakko-glass.css 的 data-glass="chrome"，主题层已让位
            （不再下发 background）。不要加 data-reveal="scroll"——滚动渐显的起点是完全
            透明，标题会直接裸在用户壁纸上，深色壁纸下对比度过不了 AA；顶栏必须常显玻璃，
            始终给标题一个底衬。 */}
        <AppBar position="sticky" elevation={0} data-glass="chrome" {...shellAttr(VT_NAMES.appBar)}>
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
        <Box sx={{ maxWidth: CONTENT_MAX_WIDTH, mx: 'auto', width: '100%' }}>
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

      {/* 移动端：底部导航（md 以下），固定定位，内容区已预留 padding。底栏自己就是
          一块 data-glass="chrome" 玻璃（与顶栏同档常驻 chrome），材质由 rakko-glass.css
          配方提供——主题层与局部 sx 都不能再下发 background，否则会盖掉配方（同
          MuiAppBar 让位的道理）。borderTop 保留：chrome 档的发丝线在下缘、底栏需要顶边。 */}
      <Paper
        elevation={0}
        data-glass="chrome"
        {...shellAttr(VT_NAMES.bottomNav)}
        sx={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 1100,
          pb: 'env(safe-area-inset-bottom)',
          display: { xs: 'block', md: 'none' },
          borderTop: (theme) => `1px solid ${theme.palette.divider}`,
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
