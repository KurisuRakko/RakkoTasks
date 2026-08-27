// 状态页：各邮箱账户健康卡片（同步状态 / 上次同步相对时间 / 错误）+ LLM 待处理计数。

import { useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import AppBar from '@mui/material/AppBar';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import RefreshIcon from '@mui/icons-material/Refresh';
import Stack from '@mui/material/Stack';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import { fetchStatus } from '../lib/api';
import type { StatusResponse } from '../types';

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 */
function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export default function StatusPage() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetchStatus()
      .then((s) => {
        if (alive) setStatus(s);
      })
      .catch(() => {
        if (alive) setError('加载状态失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => load(), [load]);

  return (
    <Box>
      <AppBar position="static" elevation={0}>
        <Toolbar>
          <Typography variant="h6" sx={{ flexGrow: 1 }} noWrap>
            状态
          </Typography>
          <IconButton color="inherit" onClick={load} aria-label="刷新" disabled={loading}>
            <RefreshIcon />
          </IconButton>
        </Toolbar>
      </AppBar>
      <Box sx={{ px: 2, py: 2 }}>
        {loading && !status ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        ) : error && !status ? (
          <Alert severity="error">{error}</Alert>
        ) : status ? (
          <Stack spacing={1.5}>
            <Alert severity="info" icon={false} sx={{ py: 0.5 }}>
              LLM 待处理邮件：{status.pending_llm} 封
            </Alert>
            {status.accounts.map((a) => (
              <Card key={a.id} variant="outlined">
                <CardContent>
                  <Stack direction="row" spacing={1.5} alignItems="center">
                    <Avatar>{a.kind === 'gmail' ? 'G' : 'O'}</Avatar>
                    <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                      <Typography variant="subtitle1" noWrap>
                        {a.name}
                      </Typography>
                      <Typography variant="body2" color="text.secondary" noWrap>
                        {a.email}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        上次同步：
                        {a.last_sync_at ? timeAgo(a.last_sync_at) : '从未'}
                      </Typography>
                    </Box>
                    <Chip
                      label={a.status === 'ok' ? '正常' : a.status === 'error' ? '异常' : '同步中'}
                      size="small"
                      color={a.status === 'ok' ? 'success' : a.status === 'error' ? 'error' : 'warning'}
                      variant="outlined"
                    />
                  </Stack>
                  {a.status === 'error' && a.last_error && (
                    <Typography
                      variant="body2"
                      color="error"
                      sx={{ mt: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {a.last_error}
                    </Typography>
                  )}
                </CardContent>
              </Card>
            ))}
          </Stack>
        ) : null}
      </Box>
    </Box>
  );
}
