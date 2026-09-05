// 设置页「邮箱账户」分区（原「账户状态」分区的继任者）：
// 挂载时 fetchStatus()；列出账户卡片（名称/邮箱/类型/状态 Chip/上次同步/错误），
// 头部右侧「添加邮箱」，底部一行 AI 待处理数。
// 桌面（md 起）点卡片或「添加邮箱」在 Dialog 里开 详情/向导/移除二选一（同一个 Dialog 切内容）；
// 移动端跳独立路由页 /settings/accounts/*。Dialog 关闭或任一子流程完成后重新 fetchStatus。

import { useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import { fetchStatus } from '../../lib/api';
import { mainAreaDialogSx } from '../../lib/layout';
import { enterSx, usePrefersReducedMotion, useTransitionNavigate } from '../../lib/motion';
import { timeAgo } from '../../lib/time';
import { statusChipMeta, kindLabel } from './meta';
import AccountDetail from './AccountDetail';
import AccountWizard from './AccountWizard';
import RemoveAccountChoice from './RemoveAccountChoice';
import type { AccountInfo, StatusResponse } from '../../types';
import { dialogTransitionProps } from '../DialogTransition';

/** 桌面 Dialog 的三种内容：添加向导 / 账户详情 / 移除二选一，同一个 Dialog 切换 */
type AccountDialog =
  | { view: 'wizard' }
  | { view: 'detail'; account: AccountInfo }
  | { view: 'remove'; account: AccountInfo };

function dialogTitle(dialog: AccountDialog | null): string {
  if (!dialog) return '';
  switch (dialog.view) {
    case 'wizard':
      return '添加邮箱账户';
    case 'detail':
      return '账户详情';
    case 'remove':
      return '移除账户';
  }
}

export default function AccountsSection() {
  const theme = useTheme();
  const desktop = useMediaQuery(theme.breakpoints.up('md'));
  const go = useTransitionNavigate();
  const reduced = usePrefersReducedMotion();
  const [data, setData] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [dialog, setDialog] = useState<AccountDialog | null>(null);

  const load = useCallback(() => {
    let alive = true;
    setLoading(true);
    setError(false);
    fetchStatus()
      .then((s) => {
        if (alive) setData(s);
      })
      .catch(() => {
        if (alive) setError(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => load(), [load]);

  /** 桌面开 Dialog / 移动端跳路由，两条路径的入口共用一个判断 */
  const openAdd = () => {
    if (desktop) setDialog({ view: 'wizard' });
    else go('/settings/accounts/new');
  };
  const openDetail = (account: AccountInfo) => {
    if (desktop) setDialog({ view: 'detail', account });
    else go(`/settings/accounts/${account.id}`);
  };

  /** Dialog 关闭（含向导取消/完成、详情关闭）：收起并刷新列表 */
  const closeDialog = () => {
    setDialog(null);
    load();
  };

  // 三种视图的当前数据：null 表示该视图没开着（局部常量便于在回调里安全引用）
  const wizardOpen = dialog?.view === 'wizard';
  const detailAccount = dialog?.view === 'detail' ? dialog.account : null;
  const removeAccount = dialog?.view === 'remove' ? dialog.account : null;

  return (
    <Box>
      <Stack direction="row" alignItems="center" sx={{ mb: 1 }}>
        <Typography variant="overline" sx={{ flexGrow: 1 }}>
          邮箱账户
        </Typography>
        <Button variant="outlined" size="small" onClick={openAdd}>
          添加邮箱
        </Button>
      </Stack>

      {loading && !data ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      ) : error && !data ? (
        <Alert severity="error">加载账户失败</Alert>
      ) : data ? (
        <Stack spacing={1.5}>
          {data.accounts.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', py: 2 }}>
              还没有接入邮箱账户，点右上角「添加邮箱」开始接入。
            </Typography>
          ) : (
            <>
              {data.accounts.map((a, index) => {
                const chip = statusChipMeta(a);
                const disabled = !a.enabled;
                return (
                  <Card
                    key={a.id}
                    variant="outlined"
                    // 变暗用 filter 而非 opacity：入场动画 animation-fill-mode: both
                    // 会把关键帧终态 opacity: 1 保持在元素上（动画值优先级高于普通声明），
                    // 静态 opacity 会被压掉；filter 与动画互不干扰（见 settings-page.test）。
                    sx={{
                      ...enterSx(index, reduced),
                      filter: disabled ? 'opacity(0.6)' : 'none',
                    }}
                  >
                    <CardActionArea onClick={() => openDetail(a)}>
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
                              {kindLabel(a.kind)} · 上次同步：
                              {a.last_sync_at ? timeAgo(a.last_sync_at) : '从未'}
                            </Typography>
                          </Box>
                          <Chip
                            label={chip.label}
                            size="small"
                            color={chip.color}
                            variant="outlined"
                          />
                        </Stack>
                        {a.enabled && a.last_error && (
                          <Typography
                            variant="body2"
                            color="error"
                            sx={{
                              mt: 1,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {a.last_error}
                          </Typography>
                        )}
                      </CardContent>
                    </CardActionArea>
                  </Card>
                );
              })}
              <Alert severity="info" icon={false} sx={{ py: 0.5 }}>
                AI 待处理 {data.pending_llm} 封
              </Alert>
            </>
          )}
        </Stack>
      ) : null}

      {/* 桌面端交互收在同一个 Dialog 里：三种内容互切，移动端走路由页（本组件不渲染 Dialog） */}
      <Dialog
        open={dialog !== null && desktop}
        onClose={closeDialog}
        maxWidth="sm"
        fullWidth
        sx={mainAreaDialogSx}
        {...dialogTransitionProps()}
        aria-labelledby="accounts-dialog-title"
      >
        <DialogTitle id="accounts-dialog-title">
          <Stack direction="row" alignItems="center">
            <Typography variant="h6" sx={{ flexGrow: 1 }}>
              {dialogTitle(dialog)}
            </Typography>
            <IconButton edge="end" aria-label="关闭" onClick={closeDialog} size="small">
              <CloseIcon />
            </IconButton>
          </Stack>
        </DialogTitle>
        <Box sx={{ px: 3, pb: 3 }}>
          {wizardOpen && <AccountWizard onDone={closeDialog} onCancel={closeDialog} />}
          {detailAccount && (
            <AccountDetail
              key={detailAccount.id}
              account={detailAccount}
              onChanged={(updated) => {
                // 对话框内继续用新账户，列表随后台刷新同步
                setDialog({ view: 'detail', account: updated });
                load();
              }}
              onRemove={() => setDialog({ view: 'remove', account: detailAccount })}
            />
          )}
          {removeAccount && (
            <RemoveAccountChoice
              key={removeAccount.id}
              account={removeAccount}
              onDisabled={() => closeDialog()}
              onDeleted={() => closeDialog()}
              onCancel={() => setDialog({ view: 'detail', account: removeAccount })}
            />
          )}
        </Box>
      </Dialog>
    </Box>
  );
}
