// 条目详情 Dialog：元信息 + AI 详情（懒生成）+ 关联邮件（点击展开 EmailViewer）
// + 底部「显示原邮件/复制给 AI」（复制产物为 Markdown 纯文本，供粘贴给 AI）。
// 移动端全屏、桌面端限宽（md），带向上滑入过渡。

import type { ReactElement } from 'react';
import { forwardRef, useEffect, useState } from 'react';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Skeleton from '@mui/material/Skeleton';
import Slide from '@mui/material/Slide';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import CloseIcon from '@mui/icons-material/Close';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import EmailIcon from '@mui/icons-material/Email';
import { fetchEmail, fetchItemDetail, fetchItemExport, fetchStatus } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { formatDueDate } from '../lib/grouping';
import type { AccountInfo, Email, Item, RelatedEmail } from '../types';
import EmailViewer from './EmailViewer';
import SafeMarkdown from './SafeMarkdown';
import type { TransitionProps } from '@mui/material/transitions';

interface Props {
  item: Item;
  onClose: () => void;
}

// 模块级 Slide 过渡组件：避免在渲染函数体内内联定义导致 Dialog 每次渲染重挂载
const SlideUp = forwardRef<HTMLDivElement, TransitionProps & { children: ReactElement }>(
  (props, ref) => <Slide direction="up" ref={ref} {...props} />,
);

export default function ItemDialog({ item, onClose }: Props) {
  const [detail, setDetail] = useState<string | null>(item.detail_md);
  // 关联邮件优先用条目自带数据；详情懒生成成功后以后端返回的为准
  const [related, setRelated] = useState<RelatedEmail[]>(item.related ?? []);
  // 同一时间只展开一封关联邮件；null 表示全部收起
  const [openRelatedId, setOpenRelatedId] = useState<number | null>(null);
  const [detailLoading, setDetailLoading] = useState(item.detail_md === null);
  const [detailError, setDetailError] = useState(false);
  const [email, setEmail] = useState<Email | null>(null);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [showEmail, setShowEmail] = useState(false);
  const [copying, setCopying] = useState(false);
  const [snack, setSnack] = useState<string | null>(null);

  const theme = useTheme();
  // 移动端全屏、桌面端限宽对话框
  const fullScreen = useMediaQuery(theme.breakpoints.down('md'));

  // 详情为 null 时懒生成；同时预取邮件元信息（来源账户名映射用）
  useEffect(() => {
    let alive = true;
    if (detail === null && !detailError) {
      setDetailLoading(true);
      fetchItemDetail(item.id)
        .then((r) => {
          if (alive) {
            setDetail(r.detail_md);
            setRelated(r.related);
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

  const handleCopyToAI = () => {
    setCopying(true);
    // 导出内容可能较大，由 copyText 在用户手势内发起请求再写剪贴板
    copyText(() => fetchItemExport(item.id))
      .then(() => setSnack('已复制到剪贴板'))
      .catch(() => setSnack('复制失败'))
      .finally(() => setCopying(false));
  };

  return (
    <Dialog
      fullScreen={fullScreen}
      maxWidth="md"
      fullWidth
      TransitionComponent={SlideUp}
      open
      onClose={onClose}
    >
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
            <SafeMarkdown>{detail}</SafeMarkdown>
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary">
            暂无详情
          </Typography>
        )}
        {related.length > 0 && (
          <>
            <Typography variant="subtitle2" gutterBottom sx={{ mt: 1 }}>
              关联邮件
            </Typography>
            <List dense disablePadding>
              {related.map((r) => {
                const open = openRelatedId === r.email_id;
                return (
                  <ListItem
                    key={r.email_id}
                    disablePadding
                    sx={{ flexDirection: 'column', alignItems: 'stretch' }}
                  >
                    <ListItemButton
                      onClick={() => setOpenRelatedId(open ? null : r.email_id)}
                    >
                      <ListItemText
                        primary={r.subject}
                        secondary={[r.sent_at ? r.sent_at.slice(0, 10) : '', r.reason]
                          .filter(Boolean)
                          .join(' · ')}
                      />
                    </ListItemButton>
                    {open && (
                      <Box sx={{ mt: 1 }}>
                        <EmailViewer emailId={r.email_id} />
                      </Box>
                    )}
                  </ListItem>
                );
              })}
            </List>
          </>
        )}
        <Divider sx={{ my: 1.5 }} />
        <Stack direction="row" spacing={1}>
          <Button
            variant="outlined"
            startIcon={<EmailIcon />}
            sx={{ flex: 1 }}
            onClick={() => setShowEmail((v) => !v)}
          >
            {showEmail ? '收起原邮件' : '显示原邮件'}
          </Button>
          <Button
            variant="outlined"
            startIcon={<ContentCopyIcon />}
            sx={{ flex: 1 }}
            disabled={detailLoading || copying}
            onClick={handleCopyToAI}
          >
            复制给 AI
          </Button>
        </Stack>
        {showEmail && (
          <Box sx={{ mt: 1.5 }}>
            <EmailViewer emailId={item.email_id} />
          </Box>
        )}
      </Box>
      <Snackbar
        open={snack !== null}
        autoHideDuration={3000}
        onClose={() => setSnack(null)}
        message={snack}
      />
    </Dialog>
  );
}
