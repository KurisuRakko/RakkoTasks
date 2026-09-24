// 导航单一数据源：底栏 / 抽屉 / AppBar 标题全部从这里取，禁止各写一份。

import ChecklistIcon from '@mui/icons-material/Checklist';
import DoneAllIcon from '@mui/icons-material/DoneAll';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';

export const NAV_ITEMS = [
  { path: '/',          label: '任务',   icon: ChecklistIcon },
  { path: '/assistant', label: '助理',   icon: ForumOutlinedIcon },
  { path: '/done',      label: '已完成', icon: DoneAllIcon },
] as const;

/**
 * 路由 → 导航索引：/assistant→1、/done→2、其余→0；/settings 及未知名返回 -1。
 * 前缀匹配（/assistant/xxx 也命中），/ 用精确判断兜底。
 * /search 只是重定向到 /assistant 的过渡路径，不算导航页（索引 -1，一帧即过）。
 */
export function navIndexOf(pathname: string): number {
  if (pathname.startsWith('/assistant')) return 1;
  if (pathname.startsWith('/done')) return 2;
  if (pathname === '/') return 0;
  return -1;
}

/**
 * 路由转场方向（单一决策点，useTransitionNavigate 与 RouteTransition 回退路径共用）：
 * - 两边都不在设置组：按导航索引比大小，next > from → 前进；
 * - 进入设置组（to 索引 -1、from 不是）→ 前进；离开设置组 → 后退；
 * - 都在设置组（/settings 与 /settings/accounts/* 同属）：按路径段数比深度，
 *   更深 → 前进、更浅 → 后退、等深 → 前进。
 * 设置组含未知路径（navIndexOf 对未知名同样返回 -1），沿用旧行为即可。
 */
export function routeDirection(from: string, to: string): 'forward' | 'back' {
  const fromIndex = navIndexOf(from);
  const toIndex = navIndexOf(to);
  const fromInSettings = fromIndex === -1;
  const toInSettings = toIndex === -1;
  if (!fromInSettings && toInSettings) return 'forward';
  if (fromInSettings && !toInSettings) return 'back';
  if (!fromInSettings && !toInSettings) return toIndex > fromIndex ? 'forward' : 'back';
  const fromDepth = from.split('/').filter(Boolean).length;
  const toDepth = to.split('/').filter(Boolean).length;
  return toDepth >= fromDepth ? 'forward' : 'back';
}
