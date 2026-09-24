// 待办页顶栏的刷新按钮：点它立刻请求同步，并把这一轮同步的进展直接做在标题上。
// 五个形态（idle / scheduled / manual / done / failed）由 lib/sync-status 的
// status 与 completion 推出，动效只用 theme 的色与 MOTION 时长。
//
// 抢标题（标题淡出、按钮滑到左边）只给手动轮次：用户点过刷新，这一轮的进度就该
// 出现在他刚才点的地方。定时轮次是后台自己的事，只把图标换成转圈，标题不动。
//
// 滑动的做法：外层是 [标题 | 按钮 | 占位] 三列网格，抢标题时标题列塌成 0fr、占位列
// 撑成 1fr 把按钮顶到左边。不用绝对定位、也不量宽度——绝对定位要脱离原来的占位，
// 按钮的起始位置得靠 JS 量出来，而网格两套模板之间是浏览器自己插值的。

import { useEffect } from 'react';
import type { ReactNode } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import CheckIcon from '@mui/icons-material/Check';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import RefreshIcon from '@mui/icons-material/Refresh';
import { usePrefersReducedMotion } from '../lib/motion';
import { useNavigateTo } from '../lib/nav';
import { useSyncStatus } from '../lib/sync-status';
import { MOTION } from '../rakko-tokens';
import type { SyncCompletion } from '../lib/sync-status';
import type { SyncStatus } from '../types';

/** 「同步完成」在顶栏停留的时长（ms），到点自己收起回「刷新」 */
export const DONE_HOLD_MS = 2400;

/** 顶栏按钮的五个形态 */
type Phase = 'idle' | 'scheduled' | 'manual' | 'done' | 'failed';

/** 完成态压过进行态：收尾提示还没收起时，按钮不该又变回转圈 */
function phaseOf(status: SyncStatus | null, completion: SyncCompletion | null): Phase {
  if (completion !== null) return completion.state === 'failed' ? 'failed' : 'done';
  if (status?.current?.trigger === 'scheduled') return 'scheduled';
  // pending_request：点了刷新但 worker 还没醒，这一轮是用户主动要的，照手动处理
  if (status?.pending_request || status?.current?.trigger === 'manual') return 'manual';
  return 'idle';
}

/** 按钮此刻的文字、读屏名、图标与点击行为 */
interface ButtonFace {
  text: string;
  ariaLabel: string;
  icon: ReactNode;
  onClick: () => void;
  /** 失败态整体转红（含图标），色值走 theme 的 error.main */
  danger: boolean;
}

export default function SyncTitleBar() {
  const { status, completion, trigger, dismissCompletion } = useSyncStatus();
  const go = useNavigateTo();
  const reduced = usePrefersReducedMotion();
  const phase = phaseOf(status, completion);
  const takeover = phase === 'manual' || phase === 'done' || phase === 'failed';

  // 完成态停 2.4 秒后自己收起
  useEffect(() => {
    if (completion === null || completion.state === 'failed') return;
    const timer = window.setTimeout(dismissCompletion, DONE_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [completion, dismissCompletion]);

  // 失败态不自动消失（要等用户点掉），但切走待办页时随组件卸载一起清掉——
  // 回到待办页不该还挂着上一次的失败提示
  useEffect(() => () => dismissCompletion(), [dismissCompletion]);

  const face: ButtonFace = (() => {
    switch (phase) {
      case 'scheduled':
        return {
          text: '刷新',
          ariaLabel: '刷新',
          icon: <CircularProgress size={18} color="primary" />,
          onClick: () => go('/sync'),
          danger: false,
        };
      case 'manual':
        return {
          text: '查看同步状态',
          ariaLabel: '查看同步状态',
          icon: <CircularProgress size={18} color="primary" />,
          onClick: () => go('/sync'),
          danger: false,
        };
      case 'done':
        return {
          text:
            completion !== null && completion.created > 0
              ? `同步完成，新增 ${completion.created} 条待办`
              : '同步完成',
          ariaLabel: '同步完成',
          icon: <CheckIcon sx={{ color: 'success.main' }} />,
          onClick: () => go('/sync'),
          danger: false,
        };
      case 'failed':
        return {
          text: '同步失败',
          ariaLabel: '同步失败，查看详情',
          icon: <ErrorOutlineIcon />,
          onClick: () => {
            dismissCompletion();
            go('/sync');
          },
          danger: true,
        };
      default:
        return {
          text: '刷新',
          ariaLabel: '刷新',
          icon: <RefreshIcon />,
          onClick: trigger,
          danger: false,
        };
    }
  })();

  return (
    <Box
      sx={{
        flexGrow: 1,
        display: 'grid',
        // 三格：标题 / 按钮 / 占位。占位格在非抢标题态是 0fr，但它必须始终在网格里：
        // 轨道数不同的两套模板之间 grid-template-columns 不可插值，只剩离散跳变，
        // 「滑到左边」会变成瞬移；0fr 与 1fr 之间才有过渡。列间距不设，多出来的
        // 0fr 轨道因此不改变非抢标题态的横向位置。
        gridTemplateColumns: takeover ? '0fr auto 1fr' : '1fr auto 0fr',
        alignItems: 'center',
        transition: reduced
          ? 'none'
          : `grid-template-columns ${MOTION.large}ms ${MOTION.easeStandard}`,
      }}
    >
      <Typography
        variant="h6"
        noWrap
        sx={{
          // minWidth: 0 + overflow: hidden 才是 0fr 收得干净的前提：grid 项默认
          // min-width: auto，标题的 min-content 会把塌缩的轨道重新撑回文字宽度
          minWidth: 0,
          overflow: 'hidden',
          opacity: takeover ? 0 : 1,
          transition: reduced ? 'none' : `opacity ${MOTION.fadeOut}ms ${MOTION.easeStandard}`,
        }}
      >
        RakkoTasks
      </Typography>
      <Button
        color="inherit"
        size="small"
        startIcon={face.icon}
        aria-label={face.ariaLabel}
        onClick={face.onClick}
        sx={face.danger ? { color: 'error.main' } : undefined}
      >
        {face.text}
      </Button>
      <Box />
    </Box>
  );
}
