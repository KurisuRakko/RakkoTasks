// 同步状态页（/sync）：这一轮同步走到哪一步了。数据来自 lib/sync-status 的 status
// ——顶栏刷新按钮与设置页入口共用同一份轮询结果，本页自己不发请求，空闲时只多给一个
// 「立即同步」按钮。
//
// 分区写法与设置页一致：<Box data-glass="panel" sx={PANEL_SX}> + List dense。
// 行首图标是一套四态（CircularProgress / Check / ErrorOutline / RadioButtonUnchecked），
// 阶段行与邮箱行共用，颜色全部走 theme 语义色，不写裸色值。

import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import LinearProgress from '@mui/material/LinearProgress';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import CheckIcon from '@mui/icons-material/Check';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import { PAGE_SX, PANEL_SX } from '../lib/layout';
import { ROW_GAP_PX } from '../lib/surface';
import { syncClock, syncLastSummary, useSyncStatus } from '../lib/sync-status';
import type { SyncAccountState, SyncRun, SyncStageState } from '../types';

/** 阶段与邮箱行共用的四态图标 */
function StateIcon({ state }: { state: SyncStageState | SyncAccountState }) {
  if (state === 'running') return <CircularProgress size={18} color="primary" />;
  if (state === 'done') return <CheckIcon sx={{ color: 'success.main' }} />;
  if (state === 'failed') return <ErrorOutlineIcon sx={{ color: 'error.main' }} />;
  // pending（还没轮到）与 skipped（账户没凭据）都是「什么也没发生」
  return <RadioButtonUncheckedIcon sx={{ color: 'text.disabled' }} />;
}

/** 耗时（秒）：结束时间缺失（正在跑）时算到此刻 */
function elapsedSeconds(run: SyncRun): number {
  const start = new Date(run.started_at).getTime();
  const end = run.finished_at === null ? Date.now() : new Date(run.finished_at).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.round((end - start) / 1000));
}

/** 触发来源的短名 */
function triggerLabel(run: SyncRun): string {
  return run.trigger === 'manual' ? '手动' : '定时';
}

/** 结束时刻：finished_at 缺失时退回 started_at（正常不会缺，兜底只为不显示 Invalid Date） */
function finishedAt(run: SyncRun): string {
  return syncClock(run.finished_at ?? run.started_at);
}

/** 阶段收尾时的汇总错误：另起一行、error 色。写成 ListItem 而不是裸 Typography——
 *  List 渲染成 <ul>，非 <li> 的子元素是非法 HTML。fetch 阶段的错误按邮箱分行显示，
 *  不走这里。 */
function StageError({ error }: { error: string | null }) {
  if (error === null) return null;
  return (
    <ListItem sx={{ pl: 6 }}>
      <Typography variant="caption" sx={{ color: 'error.main' }}>
        {error}
      </Typography>
    </ListItem>
  );
}

export default function SyncStatusPage() {
  const { status, loading, trigger } = useSyncStatus();
  // 进行中取 current、否则取 last（都为空 = 从没跑过）
  const current = status === null ? null : status.current;
  const last = status === null ? null : status.last;
  const run = current ?? last;
  const running = current !== null;
  // 空态判据：没有进行中的轮次、也没有待唤醒的请求，这时才给「立即同步」
  const idle = status !== null && current === null && !status.pending_request;

  // running 期间「已用 N 秒」每秒刷新一次；不在跑就不起定时器
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  return (
    // 页面外壳与卡片间距同设置页：各分区是 data-glass="panel" 玻璃卡片
    <Box
      sx={{
        ...PAGE_SX,
        display: 'flex',
        flexDirection: 'column',
        gap: `${ROW_GAP_PX}px`,
      }}
    >
      {run === null ? (
        /* 从未同步过（或首拉还没回来 / 首拉失败）：给一句话和一个入口就够 */
        <Box data-glass="panel" sx={PANEL_SX}>
          {loading ? (
            <Skeleton variant="text" />
          ) : (
            <>
              <Typography variant="body1">还没有同步记录</Typography>
              <Button variant="outlined" sx={{ mt: 1 }} onClick={trigger}>
                立即同步
              </Button>
            </>
          )}
        </Box>
      ) : (
        <>
          {/* 概览：一行状态 + 一行细节 */}
          <Box data-glass="panel" sx={PANEL_SX}>
            {running ? (
              <Stack direction="row" spacing={1} alignItems="center">
                <CircularProgress size={18} color="primary" />
                <Typography variant="subtitle1">正在同步…</Typography>
              </Stack>
            ) : (
              <Typography
                variant="subtitle1"
                sx={run.state === 'failed' ? { color: 'error.main' } : undefined}
              >
                {run.state === 'failed' ? '同步失败' : `上次同步 ${finishedAt(run)}`}
              </Typography>
            )}
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              {running
                ? `${triggerLabel(run)}触发 · ${syncClock(run.started_at)} 开始 · 已用 ${elapsedSeconds(run)} 秒`
                : `${finishedAt(run)} · ${triggerLabel(run)} · 耗时 ${elapsedSeconds(run)} 秒 · 新增 ${run.stages.classify.created} 条待办`}
            </Typography>
            {/* 进行中同时又有上一轮：补一行上一轮的结果，避免「上次同步」被这一轮盖掉 */}
            {current !== null && last !== null && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                {syncLastSummary(last)}
              </Typography>
            )}
          </Box>

          {/* 三个阶段：拉取（按邮箱展开）→ AI 分类 → 生成详情 */}
          <Box data-glass="panel" sx={PANEL_SX}>
            <List dense>
              <ListItem>
                <ListItemIcon>
                  <StateIcon state={run.stages.fetch.state} />
                </ListItemIcon>
                <ListItemText
                  primary="拉取邮件"
                  secondary={`${run.stages.fetch.accounts.length} 个邮箱，新 ${run.stages.fetch.accounts.reduce(
                    (sum, acct) => sum + acct.new_count,
                    0,
                  )} 封`}
                />
              </ListItem>
              {/* 每个邮箱一行：失败行整行转红并带上那一句话原因 */}
              {run.stages.fetch.accounts.map((acct) => (
                <ListItem key={acct.email} sx={{ pl: 6 }}>
                  <ListItemIcon>
                    <StateIcon state={acct.state} />
                  </ListItemIcon>
                  <ListItemText
                    primary={`${acct.email} · 新 ${acct.new_count} 封`}
                    secondary={acct.state === 'skipped' ? '未配置凭据' : acct.error}
                    slotProps={
                      acct.state === 'failed'
                        ? {
                            primary: { sx: { color: 'error.main' } },
                            secondary: { sx: { color: 'error.main' } },
                          }
                        : undefined
                    }
                  />
                </ListItem>
              ))}

              <ListItem>
                <ListItemIcon>
                  <StateIcon state={run.stages.classify.state} />
                </ListItemIcon>
                <ListItemText
                  primary="AI 分类"
                  secondary={`${run.stages.classify.total} 封待分类，已完成 ${run.stages.classify.done} · 新增 ${run.stages.classify.created} 条待办`}
                />
              </ListItem>
              {run.stages.classify.state === 'running' && run.stages.classify.total > 0 && (
                // 缩进与上面按邮箱展开的行同档（pl: 6），让进度条与阶段行保持同一列
                <ListItem sx={{ pl: 6 }}>
                  <Box sx={{ width: '100%' }}>
                    <LinearProgress
                      variant="determinate"
                      value={(run.stages.classify.done / run.stages.classify.total) * 100}
                      // 半径带单位：sx 的数值 borderRadius 是乘数（乘 theme.shape.borderRadius=6），
                      // 写 2 出来的是 12px，2px 高的进度条会变成药丸
                      sx={{ height: 4, borderRadius: '2px' }}
                    />
                  </Box>
                </ListItem>
              )}
              <StageError error={run.stages.classify.error} />

              <ListItem>
                <ListItemIcon>
                  <StateIcon state={run.stages.detail.state} />
                </ListItemIcon>
                <ListItemText
                  primary="生成详情"
                  secondary={
                    run.trigger === 'manual'
                      ? `${run.stages.detail.total} 条（最近一周），已完成 ${run.stages.detail.done}`
                      : `${run.stages.detail.total} 条，已完成 ${run.stages.detail.done}`
                  }
                />
              </ListItem>
              <StageError error={run.stages.detail.error} />
            </List>
          </Box>

          {/* 空闲时（没有进行中的轮次、也没有待唤醒的请求）才给同步入口 */}
          {idle && (
            <Box data-glass="panel" sx={PANEL_SX}>
              <Button variant="outlined" onClick={trigger}>
                立即同步
              </Button>
            </Box>
          )}
        </>
      )}
    </Box>
  );
}
