// 条目详情 Dialog：元信息 + AI 详情（懒生成，仅邮件条目）+ 关联邮件（点击展开 EmailViewer）
// + 底部「显示原邮件/复制给 AI」（复制产物为 Markdown 纯文本，供粘贴给 AI）。
// 手动条目（email_id === null）降级：无 AI 详情/关联邮件/原邮件，summary 用 breaks
// 渲染保留换行；AppBar 提供「编辑」（ItemEditor + PATCH）与「删除」（确认后 DELETE），
// 成功后经 onChanged/onDeleted 通知父组件同步列表。
// 移动端全屏、桌面端限宽（md）；paper 挂 VT_NAMES.sheet，与来源列表行做容器变换。
// md 起经 columnDialogSx 与内容列重合（同宽、居中于主内容区），列表行长成对话框时
// 容器只在纵向生长，不再露出空白条。

import { useEffect, useState } from 'react';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Skeleton from '@mui/material/Skeleton';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import CloseIcon from '@mui/icons-material/Close';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
import EmailIcon from '@mui/icons-material/Email';
import {
  deleteItem,
  fetchEmail,
  fetchItemDetail,
  fetchItemExport,
  fetchStatus,
  patchItem,
} from '../lib/api';
import { copyText } from '../lib/clipboard';
import { formatDueDate } from '../lib/grouping';
import { columnDialogSx } from '../lib/layout';
import type { AccountInfo, Email, Item, ItemFields, RelatedEmail } from '../types';
import EmailViewer from './EmailViewer';
import ItemEditor from './ItemEditor';
import SafeMarkdown from './SafeMarkdown';
import { dialogTransitionProps } from './DialogTransition';
import { VT_NAMES } from '../lib/view-transition';

interface Props {
  item: Item;
  onClose: () => void;
  /** 手动条目编辑保存成功（条目已变化，父组件用它同步列表项） */
  onChanged?: (item: Item) => void;
  /** 手动条目删除成功（父组件用它把条目移出列表） */
  onDeleted?: (id: number) => void;
}

export default function ItemDialog({ item, onClose, onChanged, onDeleted }: Props) {
  // 渲染一律读 current：编辑/删除会更新它，父组件列表经 onChanged/onDeleted 同步
  const [current, setCurrent] = useState<Item>(item);
  const [detail, setDetail] = useState<string | null>(item.detail_md);
  // 关联邮件优先用条目自带数据；详情懒生成成功后以后端返回的为准
  const [related, setRelated] = useState<RelatedEmail[]>(item.related ?? []);
  // 同一时间只展开一封关联邮件；null 表示全部收起
  const [openRelatedId, setOpenRelatedId] = useState<number | null>(null);
  // 手动条目 detail_md 恒为 null 且无源邮件：无需懒生成（detailLoading 保持 false）
  const [detailLoading, setDetailLoading] = useState(
    item.detail_md === null && item.email_id !== null,
  );
  const [detailError, setDetailError] = useState(false);
  const [email, setEmail] = useState<Email | null>(null);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [showEmail, setShowEmail] = useState(false);
  const [copying, setCopying] = useState(false);
  const [snack, setSnack] = useState<string | null>(null);
  // 手动条目的编辑 / 删除流程
  const [editorOpen, setEditorOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const theme = useTheme();
  // 移动端全屏、桌面端限宽对话框
  const fullScreen = useMediaQuery(theme.breakpoints.down('md'));
  const manual = current.email_id === null;

  // 邮件条目：详情为 null 时懒生成；同时预取邮件元信息（来源账户名映射用）。
  // 手动条目：两个请求都必须跳过（detail_md 恒为 null、没有 email_id 可取）。
  useEffect(() => {
    let alive = true;
    if (current.email_id === null) {
      return () => {
        alive = false;
      };
    }
    if (detail === null && !detailError) {
      setDetailLoading(true);
      fetchItemDetail(current.id)
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
    fetchEmail(current.email_id)
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
  }, [current.id, detailError]);

  const accountName = email
    ? accounts.find((a) => a.id === email.account_id)?.name
    : undefined;

  const handleCopyToAI = () => {
    setCopying(true);
    // 导出内容可能较大，由 copyText 在用户手势内发起请求再写剪贴板
    copyText(() => fetchItemExport(current.id))
      .then(() => setSnack('已复制到剪贴板'))
      .catch(() => setSnack('复制失败'))
      .finally(() => setCopying(false));
  };

  /** 编辑保存：PATCH 手动条目；成功后本组件与父组件列表同步更新 */
  const handleSaveEdit = (fields: ItemFields) => {
    setSaving(true);
    patchItem(current.id, fields)
      .then((updated) => {
        setCurrent(updated);
        onChanged?.(updated);
        setEditorOpen(false);
        setSnack('已保存');
      })
      .catch(() => setSnack('保存失败'))
      .finally(() => setSaving(false));
  };

  /** 删除确认：DELETE 手动条目；成功后通知父组件移除并关闭本对话框 */
  const handleConfirmDelete = () => {
    setDeleting(true);
    deleteItem(current.id)
      .then(() => {
        setConfirmDelete(false);
        onDeleted?.(current.id);
        onClose();
      })
      .catch(() => {
        setConfirmDelete(false);
        setSnack('删除失败');
      })
      .finally(() => setDeleting(false));
  };

  return (
    <Dialog
      fullScreen={fullScreen}
      maxWidth="md"
      fullWidth
      sx={columnDialogSx}
      {...dialogTransitionProps()}
      slotProps={{
        paper: { sx: { viewTransitionName: VT_NAMES.sheet } },
      }}
      open
      onClose={onClose}
    >
      <AppBar position="static" elevation={0}>
        <Toolbar>
          <IconButton edge="start" color="inherit" onClick={onClose} aria-label="关闭">
            <CloseIcon />
          </IconButton>
          <Typography variant="h6" sx={{ ml: 1, flexGrow: 1 }} noWrap>
            任务详情
          </Typography>
          {manual && (
            <>
              <IconButton color="inherit" aria-label="编辑" onClick={() => setEditorOpen(true)}>
                <EditIcon />
              </IconButton>
              <IconButton color="inherit" aria-label="删除" onClick={() => setConfirmDelete(true)}>
                <DeleteOutlineIcon />
              </IconButton>
            </>
          )}
        </Toolbar>
      </AppBar>
      <Box sx={{ px: 2, py: 2, pb: 'calc(16px + env(safe-area-inset-bottom))' }}>
        <Typography variant="h6" gutterBottom>
          {current.title}
        </Typography>
        <Stack direction="row" spacing={1} sx={{ mb: 1.5 }}>
          <Chip label={current.category} size="small" variant="outlined" />
          {current.due_date && <Chip label={formatDueDate(current.due_date)} size="small" />}
        </Stack>
        {manual ? (
          <>
            {/* 手动条目：无来源邮件；summary 是用户随手敲的纯文本，breaks 保留换行 */}
            <Box sx={{ typography: 'body2' }}>
              {current.summary ? (
                <SafeMarkdown breaks>{current.summary}</SafeMarkdown>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  暂无详情
                </Typography>
              )}
            </Box>
            <Divider sx={{ my: 1.5 }} />
            <Stack direction="row" spacing={1}>
              <Button
                variant="outlined"
                startIcon={<ContentCopyIcon />}
                sx={{ flex: 1 }}
                disabled={copying}
                onClick={handleCopyToAI}
              >
                复制给 AI
              </Button>
            </Stack>
          </>
        ) : (
          <>
            <Typography variant="body2" color="text.secondary" gutterBottom>
              来源账户：{accountName ?? '…'}
            </Typography>
            {current.summary && (
              <Typography variant="body2" color="text.secondary" paragraph>
                {current.summary}
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
                <EmailViewer emailId={current.email_id!} />
              </Box>
            )}
          </>
        )}
      </Box>
      {editorOpen && (
        <ItemEditor
          heading="编辑任务"
          initial={{
            title: current.title,
            summary: current.summary ?? '',
            category: current.category,
            due_date: current.due_date,
          }}
          submitting={saving}
          onSubmit={handleSaveEdit}
          onClose={() => setEditorOpen(false)}
        />
      )}
      {/* 删除确认框（仅手动条目会打开） */}
      <Dialog
        open={confirmDelete}
        onClose={deleting ? undefined : () => setConfirmDelete(false)}
      >
        <DialogTitle>删除任务</DialogTitle>
        <DialogContent>
          <DialogContentText>删除这条任务？此操作不可撤销。</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDelete(false)} disabled={deleting}>
            取消
          </Button>
          <Button color="error" onClick={handleConfirmDelete} disabled={deleting}>
            删除
          </Button>
        </DialogActions>
      </Dialog>
      <Snackbar
        open={snack !== null}
        autoHideDuration={3000}
        onClose={() => setSnack(null)}
        message={snack}
      />
    </Dialog>
  );
}
