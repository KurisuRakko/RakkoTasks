// 移除账户二选一（桌面 Dialog / 移动端路由页共用）：
// 「停用」= 只清凭据停止同步、保留邮件与任务（可恢复，重新启用后需补凭据）；
// 「彻底删除」= 连邮件与由其生成的任务一起删、不可恢复，需输入邮箱地址二次确认。
// 已停用账户进来时「停用」选项不可选并提示已停用。错误一律 Alert。

import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import RadioButtonCheckedIcon from '@mui/icons-material/RadioButtonChecked';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { deleteAccount, patchAccount } from '../../lib/api';
import type { AccountInfo } from '../../types';

type Choice = 'disable' | 'delete';

interface Props {
  account: AccountInfo;
  /** 停用成功（patchAccount enabled=false）后回调 */
  onDisabled: (account: AccountInfo) => void;
  /** 彻底删除成功后回调 */
  onDeleted: () => void;
  /** 返回上一级（账户详情） */
  onCancel: () => void;
}

interface Option {
  choice: Choice;
  title: string;
  description: string;
}

const OPTIONS: readonly Option[] = [
  {
    choice: 'disable',
    title: '停用',
    description: '只删除登录凭据，停止同步；已抓取的邮件与任务保留，之后可以重新启用。',
  },
  {
    choice: 'delete',
    title: '彻底删除',
    description: '删除这个邮箱及其全部邮件和由它生成的任务，手动添加的任务不受影响。此操作不可恢复。',
  },
];

export default function RemoveAccountChoice({ account, onDisabled, onDeleted, onCancel }: Props) {
  const [choice, setChoice] = useState<Choice | null>(account.enabled ? 'disable' : null);
  const [typedEmail, setTypedEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const alreadyDisabled = !account.enabled;
  // 邮箱地址本身不区分大小写：两边统一小写比较，手输大写不该被卡住
  const emailMatches =
    typedEmail.trim().toLowerCase() === account.email.trim().toLowerCase();

  const handleConfirm = () => {
    if (busy) return;
    setError(null);
    if (choice === 'disable') {
      setBusy(true);
      patchAccount(account.id, { enabled: false })
        .then((resp) => onDisabled(resp))
        .catch(() => {
          setError('停用失败，请稍后再试');
          setBusy(false);
        });
    } else if (choice === 'delete') {
      if (!emailMatches) return;
      setBusy(true);
      deleteAccount(account.id)
        .then(() => onDeleted())
        .catch(() => {
          setError('删除失败，请稍后再试');
          setBusy(false);
        });
    }
  };

  return (
    <Box>
      <Typography variant="caption" sx={{ display: 'block', mb: 1.5 }}>
        选择 {account.name}（{account.email}）的处理方式：
      </Typography>
      <Stack spacing={1} role="group" aria-label="移除方式">
        {OPTIONS.map((opt) => {
          const selected = choice === opt.choice;
          const selectable = opt.choice !== 'disable' || !alreadyDisabled;
          return (
            <Card
              key={opt.choice}
              variant="outlined"
              sx={{
                borderColor: selected ? 'primary.main' : undefined,
                // 未选中不铺纸：移动端这张卡坐在 data-glass="panel" 玻璃面板上，
                // 铺 background.paper 就是纸叠纸、把下面的玻璃闷掉。选中态靠主色描边
                // + 状态层底色区分就够。桌面端在 Dialog 里，透出的正是对话框自己的纸面。
                bgcolor: selected ? 'action.selected' : 'transparent',
                ...(alreadyDisabled && opt.choice === 'disable'
                  ? { opacity: 0.6, pointerEvents: 'none' }
                  : {}),
              }}
            >
              <CardActionArea
                onClick={() => setChoice(opt.choice)}
                disabled={!selectable}
                aria-label={opt.title}
              >
                <CardContent>
                  <Stack direction="row" spacing={1} alignItems="flex-start">
                    {selected ? (
                      <RadioButtonCheckedIcon color="primary" fontSize="small" sx={{ mt: 0.5 }} />
                    ) : (
                      <RadioButtonUncheckedIcon fontSize="small" sx={{ mt: 0.5 }} />
                    )}
                    <Box sx={{ minWidth: 0 }}>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Typography variant="subtitle1">{opt.title}</Typography>
                        {alreadyDisabled && opt.choice === 'disable' && (
                          <Chip label="已停用" size="small" color="default" variant="outlined" />
                        )}
                      </Stack>
                      <Typography variant="caption" sx={{ display: 'block' }}>
                        {opt.description}
                      </Typography>
                    </Box>
                  </Stack>
                </CardContent>
              </CardActionArea>
            </Card>
          );
        })}
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mt: 1.5 }}>
          {error}
        </Alert>
      )}

      {choice === 'disable' && !alreadyDisabled && (
        <Typography variant="caption" sx={{ display: 'block', mt: 1.5 }}>
          停用后该账户不再同步；要恢复使用，回到账户详情启用并重新设置凭据。
        </Typography>
      )}

      {/* 二次确认：彻底删除必须输入与该账户邮箱完全一致的地址才放行 */}
      {choice === 'delete' && (
        <TextField
          label="输入邮箱地址以确认彻底删除"
          helperText={`输入 ${account.email} 以确认。此操作不可恢复。`}
          size="small"
          fullWidth
          value={typedEmail}
          onChange={(e) => setTypedEmail(e.target.value)}
          error={typedEmail !== '' && !emailMatches}
          sx={{ mt: 1.5 }}
          inputProps={{ autoComplete: 'off' }}
        />
      )}

      <Stack direction="row" justifyContent="flex-end" spacing={1} sx={{ mt: 2 }}>
        {/* 取消只有一个变体：text + inherit（本页的「返回」就是取消） */}
        <Button variant="text" color="inherit" onClick={onCancel} disabled={busy}>
          返回
        </Button>
        {choice === 'delete' ? (
          <Button
            variant="contained"
            color="error"
            onClick={handleConfirm}
            disabled={!emailMatches || busy}
            // 进度圈作 startIcon：文字留在原位，按钮宽度不会在提交时缩掉一半
            startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}
          >
            确认彻底删除
          </Button>
        ) : choice === 'disable' && !alreadyDisabled ? (
          <Button
            variant="contained"
            onClick={handleConfirm}
            disabled={busy}
            startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}
          >
            确认停用
          </Button>
        ) : null}
      </Stack>
    </Box>
  );
}
