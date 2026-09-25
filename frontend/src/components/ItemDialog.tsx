// 条目详情 Dialog：元信息 + AI 详情（懒生成，仅邮件条目）+ 关联邮件（点击展开 EmailViewer）
// + 底部「显示原邮件/复制给 AI」（复制产物为 Markdown 纯文本，供粘贴给 AI）。
// 手动条目（email_id === null）降级：无 AI 详情/关联邮件/原邮件，summary 用 breaks
// 渲染保留换行；AppBar 提供「编辑」（ItemEditor + PATCH，任何条目都有，字段与提醒
// 均可改）与「删除」（确认后 DELETE，仅手动条目），成功后经 onChanged/onDeleted
// 通知父组件同步列表。
// 移动端全屏、桌面端限宽（md）；paper 挂 VT_NAMES.sheet，与来源列表行做容器变换。
// md 起经 columnDialogSx 与内容列重合（同宽、居中于主内容区），列表行长成对话框时
// 容器只在纵向生长，不再露出空白条。
// 纸面是不透明实色（见下面的 DIALOG_PAPER_PROPS）：详情是长文阅读面，可读性优先，
// 不用毛玻璃。段与段之间的分隔只用 Divider 一种（颜色走 theme.palette.divider），
// 段间距统一取 CHEATSHEET §Spacing 的 gap-4（16px，夹在 12px 的卡内间距与 24px 的
// 分区间距之间），不再各段一个数。实色纸面上恢复正常文字层级：标题 text.primary，
// 辅助文字 text.secondary——深浅两套下 text.secondary 对 background.paper 都过
// AA 4.5（浅 6.01 / 深 10.01，守卫用例在 tests/item-dialog.test.tsx 里）。

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
import type { Theme } from '@mui/material/styles';
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
import DueChip from './DueChip';
import { columnDialogSx, DIALOG_BODY_SX } from '../lib/layout';
import { formatReminder } from '../lib/time';
import type { AccountInfo, Email, Item, ItemFields, RelatedEmail } from '../types';
import EmailViewer from './EmailViewer';
import ItemEditor from './ItemEditor';
import SafeMarkdown from './SafeMarkdown';
import { dialogTransitionProps } from './DialogTransition';
import { VT_NAMES } from '../lib/view-transition';

interface Props {
  item: Item;
  onClose: () => void;
  /** 条目编辑保存成功（条目已变化，父组件用它同步列表项；手动/邮件条目皆可触发） */
  onChanged?: (item: Item) => void;
  /** 条目删除成功（父组件用它把条目移出列表；仅手动条目会触发） */
  onDeleted?: (id: number) => void;
}

// 详情对话框纸面：不透明实色纸（详情是长文，可读性优先于材质）。底色取
// background.paper，backgroundImage 压成 none（MUI 深色会给 Paper 叠一层 overlay
// 渐变，留着就不是纯实色了）；文字不用光晕（textShadow: 'none'）；阴影交回主题的
// Dialog 默认档（elevation 24 走 theme.shadows，这里不覆写）。
//
// 提成模块级常量与 RowContextMenu 的 MENU_PAPER_PROPS 同理：slotProps 的类型对行内
// 字面量做 excess property check，常量赋值可绕过该检查。VT_NAMES.sheet 保留——行↔
// 详情的容器变换不随纸面材质改变。
const DIALOG_PAPER_PROPS = {
  sx: (theme: Theme) => ({
    viewTransitionName: VT_NAMES.sheet,
    backgroundColor: theme.palette.background.paper,
    backgroundImage: 'none',
    textShadow: 'none',
  }),
};

// 段与段之间只有一种分隔：MUI 的 Divider（颜色默认取 theme.palette.divider，不重写）。
// 间距也只有一个数——CHEATSHEET §Spacing 的 gap-4（theme.spacing(2) = 16px）。
const SECTION_DIVIDER_SX = { my: 2 } as const;

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
  // 编辑 / 删除流程（编辑对所有条目可用；删除仅手动条目，邮件条目无删除按钮）
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

  /** 编辑保存：PATCH 条目字段；成功后本组件与父组件列表同步更新 */
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
      slotProps={{ paper: DIALOG_PAPER_PROPS }}
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
          {/* 编辑：任何条目都能改字段与提醒；删除：仅手动条目（邮件条目后端仍拒删）。
              删除是进入危险流程的入口，色取 error；最终确认在下面的确认框里。 */}
          <IconButton color="inherit" aria-label="编辑" onClick={() => setEditorOpen(true)}>
            <EditIcon />
          </IconButton>
          {manual && (
            <IconButton color="error" aria-label="删除" onClick={() => setConfirmDelete(true)}>
              <DeleteOutlineIcon />
            </IconButton>
          )}
        </Toolbar>
      </AppBar>
      <Box sx={DIALOG_BODY_SX}>
        {/* 实色纸面上的层级：标题是最强档 text.primary */}
        <Typography variant="h6" gutterBottom sx={{ color: 'text.primary' }}>
          {current.title}
        </Typography>
        <Stack direction="row" spacing={1} sx={{ mb: 1.5 }}>
          <Chip label={current.category} size="small" variant="outlined" />
          {/* 与列表行同一个 DueChip：逾期/今天/更远的三档配色口径只有一处，不会两边分叉 */}
          <DueChip item={current} today={new Date()} />
        </Stack>
        {/* 提醒列表：只读展示。任何条目点右上角「编辑」都能改字段与提醒——ItemEditor
            经 initial.reminders 拿到现有提醒，保存时整体替换——这里的列表本身只是
            只读展示，不提供行内编辑。按绝对时刻升序渲染，空则不出现。后端契约
            虽是升序，展示方不赌调用方守约，这里显式排一次。 */}
        {current.reminders.length > 0 && (
          <Box aria-label="提醒列表" sx={{ mb: 1.5, typography: 'body2' }}>
            {[...current.reminders]
              .sort(
                (a, b) =>
                  new Date(a.remind_at).getTime() - new Date(b.remind_at).getTime(),
              )
              .map((r) => (
                <Box key={r.id} component="div">
                  🔔 {formatReminder(r.remind_at)}
                </Box>
              ))}
          </Box>
        )}
        {manual ? (
          <>
            {/* 手动条目：无来源邮件；summary 是用户随手敲的纯文本，breaks 保留换行 */}
            <Box sx={{ typography: 'body2' }}>
              {current.summary ? (
                <SafeMarkdown breaks>{current.summary}</SafeMarkdown>
              ) : (
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                  暂无详情
                </Typography>
              )}
            </Box>
            <Divider sx={SECTION_DIVIDER_SX} />
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
            {/* 实色纸面上的辅助文字：来源账户是元信息，取次级档 text.secondary */}
            <Typography variant="body2" gutterBottom sx={{ color: 'text.secondary' }}>
              来源账户：{accountName ?? '…'}
            </Typography>
            {current.summary && (
              <Typography variant="body2" paragraph>
                {current.summary}
              </Typography>
            )}
            <Divider sx={SECTION_DIVIDER_SX} />
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
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>
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
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
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
                            // 这一行在实色纸面上：日期/原因是次级信息，取 MUI 默认的
                            // text.secondary（n7）——n7 压在 background.paper 上浅色
                            // 6.01、深色 10.01，都过 AA 正文的 4.5。层级由字号/字重承担
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
            <Divider sx={SECTION_DIVIDER_SX} />
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
            // 重要度：把条目现值带进编辑器（控件初始选中这一档），否则打开邮件
            // 条目编辑器时重要度会退回默认 normal，一保存就把 AI 的判断洗掉了。
            importance: current.importance,
            // ItemFieldsForm 的草案只在挂载时初始化，这里必须按绝对时刻升序喂好
            // （别赌调用方守约，与上面只读展示同一套显式排序写法）。
            reminders: [...current.reminders]
              .sort(
                (a, b) =>
                  new Date(a.remind_at).getTime() - new Date(b.remind_at).getTime(),
              )
              .map((r) => r.remind_at),
          }}
          submitting={saving}
          onSubmit={handleSaveEdit}
          onClose={() => setEditorOpen(false)}
        />
      )}
      {/* 删除确认框（仅手动条目会打开）：取消在左、确认在右，都在 DialogActions 这一行里 */}
      <Dialog
        open={confirmDelete}
        onClose={deleting ? undefined : () => setConfirmDelete(false)}
      >
        <DialogTitle>删除任务</DialogTitle>
        <DialogContent>
          <DialogContentText>删除这条任务？此操作不可撤销。</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button
            variant="text"
            color="inherit"
            onClick={() => setConfirmDelete(false)}
            disabled={deleting}
          >
            取消
          </Button>
          <Button variant="contained" color="error" onClick={handleConfirmDelete} disabled={deleting}>
            删除
          </Button>
        </DialogActions>
      </Dialog>
      <Snackbar
        open={snack !== null}
        // 自动关闭时长由主题层 MuiSnackbar.defaultProps 统一给
        onClose={() => setSnack(null)}
        message={snack}
      />
    </Dialog>
  );
}
