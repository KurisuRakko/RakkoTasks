// 条目详情全屏 Dialog：元信息 + AI 详情（懒生成）+ 「显示原邮件」展开 EmailViewer。

import { useEffect, useState } from 'react';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import EmailIcon from '@mui/icons-material/Email';
import ReactMarkdown from 'react-markdown';
import { fetchEmail, fetchItemDetail, fetchStatus } from '../lib/api';
import { formatDueDate } from '../lib/grouping';
import type { AccountInfo, Email, Item } from '../types';
import EmailViewer from './EmailViewer';

interface Props {
  item: Item;
  onClose: () => void;
}

export default function ItemDialog({ item, onClose }: Props) {
  const [detail, setDetail] = useState<string | null>(item.detail_md);
  const [detailLoading, setDetailLoading] = useState(item.detail_md === null);
  const [detailError, setDetailError] = useState(false);
  const [email, setEmail] = useState<Email | null>(null);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [showEmail, setShowEmail] = useState(false);

  // 详情为 null 时懒生成；同时预取邮件元信息（来源账户名映射用）
  useEffect(() => {
    let alive = true;
    if (detail === null && !detailError) {
      setDetailLoading(true);
      fetchItemDetail(item.id)
        .then((md) => {
          if (alive) {
            setDetail(md);
            setDetailLoading(false);
          }
        })
        .catch(() => {
          if (alive) {
            setDetailError(true);
            setDetailLoading(false);
          }
        });
    }
    fetchEmail(item.email_id)
      .then((e) => {
        if (alive) setEmail(e);
      })
      .catch(() => undefined);
    fetchStatus()
      .then((s) => {
        if (alive) setAccounts(s.accounts);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, detailError]);

  const accountName = email
    ? accounts.find((a) => a.id === email.account_id)?.name
    : undefined;

  return (
    <Dialog fullScreen open onClose={onClose}>
      <AppBar position="static" elevation={0}>
        <Toolbar>
          <IconButton edge="start" color="inherit" onClick={onClose} aria-label="关闭">
            <CloseIcon />
          </IconButton>
          <Typography variant="h6" sx={{ ml: 1 }} noWrap>
            任务详情
          </Typography>
        </Toolbar>
      </AppBar>
      <Box sx={{ px: 2, py: 2, pb: 'calc(16px + env(safe-area-inset-bottom))' }}>
        <Typography variant="h6" gutterBottom>
          {item.title}
        </Typography>
        <Stack direction="row" spacing={1} sx={{ mb: 1.5 }}>
          <Chip label={item.category} size="small" variant="outlined" />
          {item.due_date && <Chip label={formatDueDate(item.due_date)} size="small" />}
        </Stack>
        <Typography variant="body2" color="text.secondary" gutterBottom>
          来源账户：{accountName ?? '…'}
        </Typography>
        {item.summary && (
          <Typography variant="body2" color="text.secondary" paragraph>
            {item.summary}
          </Typography>
        )}
        <Divider sx={{ my: 1.5 }} />
        <Typography variant="subtitle2" gutterBottom>
          AI 详情
        </Typography>
        {detailLoading ? (
          <Stack spacing={1}>
            <Skeleton variant="text" />
            <Skeleton variant="text" />
            <Skeleton variant="text" width="70%" />
          </Stack>
        ) : detailError ? (
          <Stack alignItems="center" spacing={1} sx={{ py: 2 }}>
            <Typography variant="body2" color="text.secondary">
              详情生成失败
            </Typography>
            <Button
              variant="outlined"
              size="small"
              onClick={() => {
                setDetailError(false);
                setDetailLoading(true);
              }}
            >
              重试
            </Button>
          </Stack>
        ) : detail ? (
          <Box sx={{ typography: 'body2' }}>
            <ReactMarkdown>{detail}</ReactMarkdown>
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary">
            暂无详情
          </Typography>
        )}
        <Divider sx={{ my: 1.5 }} />
        <Button
          fullWidth
          variant="outlined"
          startIcon={<EmailIcon />}
          onClick={() => setShowEmail((v) => !v)}
        >
          {showEmail ? '收起原邮件' : '显示原邮件'}
        </Button>
        {showEmail && (
          <Box sx={{ mt: 1.5 }}>
            <EmailViewer emailId={item.email_id} />
          </Box>
        )}
      </Box>
    </Dialog>
  );
}
