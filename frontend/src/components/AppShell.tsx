// 应用壳：桌面常驻抽屉 + 移动底栏 + 统一 AppBar（标题随路由）+ 路由出口。
// 导航项全部来自 lib/nav 单一数据源；AppBar 不限宽，内容区限宽居中。
// 抽屉宽（DRAWER_WIDTH）与内容列宽（CONTENT_MAX_WIDTH）收在 lib/layout 单一来源，
// 从列表行长出来的详情对话框与内容列共用同一宽度（columnDialogSx）。
// 壳层三件套（AppBar / 底栏 / 抽屉）不在任何转场里持名，也不打标记：换页只让内容列
// 播入场动画（见 RouteTransition），开关详情只有来源行与对话框 paper 参与容器变换。

import { useLocation, Navigate, Route, Routes } from 'react-router-dom';
import AppBar from '@mui/material/AppBar';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
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
import type { Theme } from '@mui/material/styles';
import type { SystemStyleObject } from '@mui/system';
import useMediaQuery from '@mui/material/useMediaQuery';
import { BOTTOM_NAV_HEIGHT_PX, CONTENT_MAX_WIDTH, DRAWER_WIDTH } from '../lib/layout';
import { NAV_ITEMS, navIndexOf, useNavigateTo } from '../lib/nav';
import { GLASS_NAV_RAIL_LIGHT } from '../rakko-tokens';
import RouteTransition from './RouteTransition';
import SyncTitleBar from './SyncTitleBar';
import NewChatButton from './NewChatButton';
import TasksPage from '../pages/TasksPage';
import AssistantPage from '../pages/AssistantPage';
import DonePage from '../pages/DonePage';
import SettingsPage from '../pages/SettingsPage';
import SyncStatusPage from '../pages/SyncStatusPage';
import { AccountDetailPage, AccountNewPage, AccountRemovePage } from '../pages/AccountPages';

/** AppBar 标题：顺序与 NAV_ITEMS 索引对齐；设置组（索引 -1）读末尾一位 */
const TITLES = ['RakkoTasks', 'AI 助理', '已完成'] as const;

/** 路径以 /settings/accounts 开头即邮箱账户子页（标题 + 返回箭头共用此判断） */
function isAccountPath(pathname: string): boolean {
  return pathname.startsWith('/settings/accounts');
}

/** 账户子页的返回目标：new 与 :id 回 /settings，:id/remove 回 /settings/accounts/:id */
function accountParent(pathname: string): string {
  return pathname.endsWith('/remove') ? pathname.slice(0, -'/remove'.length) : '/settings';
}

/** 需要返回箭头的子页（仅移动端）：账户子页或同步状态页 */
function isSubPage(pathname: string): boolean {
  return isAccountPath(pathname) || pathname.startsWith('/sync');
}

/** 子页的返回目标：同步状态页回待办页——它的主入口就是待办页顶栏的刷新按钮 */
function subPageParent(pathname: string): string {
  return isAccountPath(pathname) ? accountParent(pathname) : '/';
}

function titleFor(pathname: string): string {
  if (isAccountPath(pathname)) return '邮箱账户';
  if (pathname.startsWith('/sync')) return '同步状态';
  const navIndex = navIndexOf(pathname);
  return navIndex === -1 ? '设置' : TITLES[navIndex];
}

/** 侧栏 paper 的浅色削白改写（值与理由见 rakko-tokens 的 GLASS_NAV_RAIL_LIGHT）。
 *  改写挂在这一块 paper 上而不是 :root——chrome 档同时是顶栏、侧栏与移动底栏三块表面，
 *  改全局会一起改掉手机端的两块。自定义属性在元素上重声明即可覆盖 :root 的继承值，
 *  这是本仓已有的做法（见 AssistantPage / TasksPage 的 --glass-haze-bleed）。
 *  深色主题返回空对象：深底自带暗侧，那套 sheen 振幅已经够低。 */
const navRailGlassSx: (theme: Theme) => SystemStyleObject<Theme> = (theme) =>
  theme.palette.mode === 'light' ? { ...GLASS_NAV_RAIL_LIGHT } : {};

/** 桌面抽屉 paper 的壳层属性：常驻 chrome 玻璃（侧边栏是常驻 chrome，身后是壁纸，
 *  材质由 rakko-glass.css 的 chrome 档提供；主题层已让位）。chrome 档的发丝线在下缘、
 *  方向对不上侧边栏——右边框仍由主题层的 MuiDrawer.paper 提供（那条已经在，不要动）。
 *  sx 是上面那块常驻侧栏专属的削白改写；把组合收在这里，render 里不再新建对象。 */
const NAV_DRAWER_PAPER_PROPS = {
  'data-glass': 'chrome',
  sx: navRailGlassSx,
} as const;

export default function AppShell() {
  const location = useLocation();
  // 换页跳转；目标等于当前路径时它自己会跳过（不重复压同址历史记录）
  const go = useNavigateTo();
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
          pb: {
            xs: `calc(${BOTTOM_NAV_HEIGHT_PX}px + env(safe-area-inset-bottom))`,
            md: 0,
          },
        }}
      >
        {/* 常驻 chrome 玻璃：材质来自 rakko-glass.css 的 data-glass="chrome"，主题层已让位
            （不再下发 background）。不要加 data-reveal="scroll"——滚动渐显的起点是完全
            透明，标题会直接裸在用户壁纸上，深色壁纸下对比度过不了 AA；顶栏必须常显玻璃，
            始终给标题一个底衬。 */}
        <AppBar position="sticky" elevation={0} data-glass="chrome">
          <Toolbar>
            {/* 子页（邮箱账户 / 同步状态，仅移动端可达）：返回箭头回父路径；桌面端账户
                子页由页面内 <Navigate> 重定向回 /settings，/sync 桌面端直接可达，
                AppBar 只放标题 */}
            {isSubPage(location.pathname) && !desktop && (
              <IconButton
                edge="start"
                color="inherit"
                aria-label="返回"
                onClick={() => go(subPageParent(location.pathname))}
                sx={{ mr: 1 }}
              >
                <ArrowBackIcon />
              </IconButton>
            )}
            {/* 待办页的标题位让给「刷新 → 同步进度」那条动效；其他页面仍是纯标题 */}
            {location.pathname === '/' ? (
              <SyncTitleBar />
            ) : (
              <Typography variant="h6" noWrap sx={{ flexGrow: 1 }}>
                {titleFor(location.pathname)}
              </Typography>
            )}
            {/* 助理页的「新对话」：桌面与移动端都放在顶栏右侧（聊天只在内存里，不弹确认） */}
            {location.pathname === '/assistant' && <NewChatButton />}
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
              {/* 旧书签 /search 兼容：助理页取代了单轮搜索页 */}
              <Route path="/search" element={<Navigate to="/assistant" replace />} />
              <Route path="/assistant" element={<AssistantPage />} />
              <Route path="/done" element={<DonePage />} />
              <Route path="/settings" element={<SettingsPage />} />
              {/* 邮箱账户子页（移动端）：添加向导 / 账户详情 / 移除二选一；桌面用 Dialog，页面内重定向 */}
              <Route path="/settings/accounts/new" element={<AccountNewPage />} />
              <Route path="/settings/accounts/:id" element={<AccountDetailPage />} />
              <Route path="/settings/accounts/:id/remove" element={<AccountRemovePage />} />
              {/* 同步状态页（/sync）：顶栏刷新按钮与设置页入口都指向它；放在 `*` 之前，
                  否则会被兜底重定向吃掉 */}
              <Route path="/sync" element={<SyncStatusPage />} />
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
          MuiAppBar 让位的道理）。发丝线按上游 BottomNav 契约（docs/2026-09-20-bottom-nav.md
          决定 3）从 chrome 档的下缘翻到顶边：翻法只允许改 box-shadow，不许写成 border
          ——border 会占布局盒子，底栏高度会因此多 1px。
          component="nav" + aria-label 取契约的「一条固定的 <nav> 承载一排项」；
          内层保持 MUI BottomNavigationAction 的 role="button"（契约里的 tablist 语义来自
          @rakko/react 复用 Tabs 的实现细节，本项目没有 Tabs primitive，强套 role="tablist"
          会造出没有 tabpanel 的假语义）。 */}
      <Paper
        component="nav"
        aria-label="主导航"
        elevation={0}
        data-glass="chrome"
        sx={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 1100,
          pb: 'env(safe-area-inset-bottom)',
          display: { xs: 'block', md: 'none' },
          // 发丝线翻到顶边必须写成 &[data-glass="chrome"] 限定的嵌套选择器，裸
          // boxShadow 声明在真实浏览器里打不过配方：App.tsx 用 injectFirst 把 emotion
          // 插到 <head> 最前，rakko-glass.css 的 [data-glass='chrome'] 在其后，两者
          // 特异性同为 (0,1,0)，同特异性下后插入的赢（同 theme.ts 的 MuiPaper 要写
          // &:not([data-glass]) 的道理）。带上属性选择器抬到 (0,2,0) 才赢得下配方。
          // 值里保留 inset 0 1px 0 var(--glass-lip)：box-shadow 是整条替换，只写
          // 0 -1px 的话 Aero 配方那层内唇高光会被一起抹掉，底栏少一层厚度边。
          '&[data-glass="chrome"]': {
            boxShadow: 'inset 0 1px 0 var(--glass-lip), 0 -1px 0 var(--color-border)',
          },
        }}
      >
        {/* 明知偏离：契约（bottom-nav.css 的 .rk-bottom-nav__item）的未选中项是
            color: var(--color-neutral-7)，本项目用 text.primary = n9。理由和落点是
            实测事实，不是口味：底栏整块是 data-glass="chrome"（纸色 45%），n7 压在这块
            玻璃亮壁纸浅色主题下实测对比度 1.67，远低于 AA 正文要求的 4.5；提到 n9 才有
            数量级改善。覆盖用 :not(.Mui-selected) 精确排除选中项——选中态是 accent
            （primary.main），与可读性无关，不能被一起盖掉。要改回契约值先改上游
            tokens/实测结论，别只改这一行。

            指示条（契约的 .rk-bottom-nav__indicator，静态落在当前项上）用内层
            BottomNavigation 的 ::before 画：它不长出 DOM 节点，也就不占用
            BottomNavigation 的子元素位（该组件只认子项与分页两个角色）。宽度与位移
            全走纯 CSS —— 底栏项数固定且等宽平分，宽度 100% / NAV_ITEMS.length、
            位移 Math.max(navIndex, 0) * 100%（translate 的百分比按自身宽度解，正好
            是一格），不需要 JS 测量。设置组 navIndex 是 -1：位移钳到第一格、只靠
            opacity: 0 隐藏。不能直接乘 -1 把它甩到 -100%——transition 只列了
            translate，opacity 是瞬变，从设置页回首页时可见度先跳回 1、再从左边缘
            扫进来，正是契约里没有「没有当前项」这个态该避免的脏做法。 */}
        <BottomNavigation
          value={navIndex}
          onChange={(_e, v) => go(NAV_ITEMS[v].path)}
          showLabels
          // 玻璃条三边贴满，里层列表限宽居中（同 contract 的 .rk-bottom-nav__list：
          // 桌面上三个项摊在整屏宽会散得看不出是一组）。position: relative 是指示条的
          // 定位上下文。
          sx={(theme) => ({
            maxWidth: 'var(--rk-bottom-nav-max-width, 640px)',
            marginInline: 'auto',
            position: 'relative',
            '&::before': {
              content: '""',
              position: 'absolute',
              top: 0,
              left: 0,
              height: 2,
              width: `calc(100% / ${NAV_ITEMS.length})`,
              // 必须带单位：sx 的数值 borderRadius 是乘数，会乘 theme.shape.borderRadius
              // （RADIUS.base = 6），写 1 出来的是 6px 圆角，不是契约的 1px
              borderRadius: '1px',
              backgroundColor: theme.palette.primary.main,
              opacity: navIndex === -1 ? 0 : 1,
              // 时长与缓动取 theme.transitions（theme.ts 已把 rakko 的 MOTION 接进去：
              // standard = MOTION.enter，easeInOut = MOTION.easeStandard），不手写毫秒
              transition: `translate ${
                theme.transitions.duration.standard
              }ms ${theme.transitions.easing.easeInOut}`,
              translate: `${Math.max(navIndex, 0) * 100}% 0`,
              '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
            },
            '& .MuiBottomNavigationAction-root:not(.Mui-selected)': {
              color: 'text.primary',
            },
          })}
        >
          {NAV_ITEMS.map((item) => (
            <BottomNavigationAction key={item.path} label={item.label} icon={<item.icon />} />
          ))}
        </BottomNavigation>
      </Paper>
    </Box>
  );
}
