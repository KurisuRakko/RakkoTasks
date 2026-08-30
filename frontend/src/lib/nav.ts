// 导航单一数据源：底栏 / 抽屉 / AppBar 标题全部从这里取，禁止各写一份。

import ChecklistIcon from '@mui/icons-material/Checklist';
import DoneAllIcon from '@mui/icons-material/DoneAll';
import SearchIcon from '@mui/icons-material/Search';

export const NAV_ITEMS = [
  { path: '/',       label: '任务',   icon: ChecklistIcon },
  { path: '/search', label: '搜索',   icon: SearchIcon },
  { path: '/done',   label: '已完成', icon: DoneAllIcon },
] as const;

/**
 * 路由 → 导航索引：/search→1、/done→2、其余→0；/settings 及未知名返回 -1。
 * 前缀匹配（/search/xxx 也命中），/ 用精确判断兜底。
 */
export function navIndexOf(pathname: string): number {
  if (pathname.startsWith('/search')) return 1;
  if (pathname.startsWith('/done')) return 2;
  if (pathname === '/') return 0;
  return -1;
}
