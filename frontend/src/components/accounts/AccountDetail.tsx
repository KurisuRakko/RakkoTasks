// 账户详情（桌面 Dialog / 移动端路由页共用）：
// 顶部账户标识（含状态 Chip）+ 同步状态（上次同步时间；出错时把 last_error 全文摊开——
// 列表行只能单行截断，详情页是用户点进来查原因的地方，不能再截）；可改名称；
// Gmail / QQ 邮箱折叠区换应用专用密码 / 授权码；微软「重新授权」
// 展开微软授权引导；停用账户只留「启用」（启用后无凭据时提示先补凭据），凭据操作在停用
// 状态下隐藏（改了没有意义，也避免与「启用」并列造成先后困惑）；底部危险区进入移除二选一。
// 表单提交中按钮 disabled + 进度；错误一律 Alert，成功反馈用瞬时 Snackbar（与全站一致）。
// 本组件不把 prop 拷进 state：父组件经 onChanged 持有最新账户并用 key/路由重挂载，
// 直接读 account prop 即是最新值（表单本地 state 只有 name 草稿与开关类）。

import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Collapse from '@mui/material/Collapse';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { patchAccount } from '../../lib/api';
import { timeAgo } from '../../lib/time';
import {
  apiErrorFields,
  credentialsGuide,
  kindAvatar,
  passwordLabel,
  statusChipMeta,
  usesPassword,
} from './meta';
import MicrosoftAuthGuide from './MicrosoftAuthGuide';
import type { AccountInfo, AccountKind } from '../../types';

interface Props {
  account: AccountInfo;
  /** 任一字段保存成功后回调（父组件用返回值刷新列表与对话框内容） */
  onChanged: (account: AccountInfo) => void;
  /** 底部「移除账户…」→ 交还父组件切换到移除二选一视图 */
  onRemove: () => void;
}

/** patch 失败的中文提示；密码类错误区分「必填」（叫法随账户类型：应用专用密码 / 授权码） */
function patchErrorMessage(err: unknown, kind: AccountKind | null): string {
  const { code } = apiErrorFields(err);
  if (kind !== null && usesPassword(kind) && code === 'password_required') {
    return `请填写${passwordLabel(kind)}`;
  }
  if (code === 'invalid_kind') return '该操作对这个类型的账户不可用';
  return '保存失败，请稍后再试';
}

export default function AccountDetail({ account, onChanged, onRemove }: Props) {
  const [name, setName] = useState(account.name);
  const [savingName, setSavingName] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [appPassword, setAppPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [snack, setSnack] = useState<string | null>(null);

  const microsoft = account.kind === 'microsoft';
  /** 凭据是用户自己生成的密码（Gmail 应用专用密码 / QQ 授权码）：决定折叠区出现与否与怎么叫 */
  const passwordKind = usesPassword(account.kind);
  /** 该凭据怎么拿（文案 + 跳转按钮，与向导第 2 步同一份）；微软没有这一项 */
  const guide = credentialsGuide(account.kind);
  const chip = statusChipMeta(account);
  // 停用态：凭据操作全部隐藏，只留名称 / 启用 / 危险区（见文件头注释）
  const showCredentials = account.enabled;

  /** 保存成功后的公共收尾：notice 只在本次操作带引导时设置，其余操作清掉旧引导 */
  const applyPatch = (resp: AccountInfo, successMsg: string, noticeMsg?: string) => {
    onChanged(resp);
    setSnack(successMsg);
    setNotice(noticeMsg ?? null);
  };

  const handleSaveName = () => {
    const trimmed = name.trim();
    if (trimmed === '' || trimmed === account.name || savingName) return;
    setSavingName(true);
    setError(null);
    patchAccount(account.id, { name: trimmed })
      .then((resp) => {
        setName(resp.name);
        applyPatch(resp, '已保存');
      })
      .catch((err: unknown) => setError(patchErrorMessage(err, null)))
      .finally(() => setSavingName(false));
  };

  const handleSavePassword = () => {
    const pwd = appPassword.trim();
    if (pwd === '' || savingPassword) return;
    setSavingPassword(true);
    setError(null);
    patchAccount(account.id, { app_password: pwd })
      .then((resp) => {
        setAppPassword('');
        setPasswordOpen(false);
        applyPatch(resp, '已保存');
      })
      .catch((err: unknown) => setError(patchErrorMessage(err, account.kind)))
      .finally(() => setSavingPassword(false));
  };

  const handleEnable = () => {
    if (enabling) return;
    setEnabling(true);
    setError(null);
    patchAccount(account.id, { enabled: true })
      .then((resp) => {
        // 停用会清空凭据：启用后没凭据要提示先补（Gmail / QQ 邮箱填密码类凭据，微软重新授权）
        applyPatch(
          resp,
          '已启用',
          resp.has_credentials
            ? undefined
            : microsoft
              ? '账户已启用，但还没有登录凭据：请用「重新授权」完成授权后才会开始同步。'
              : `账户已启用，但还没有登录凭据：请在下方「更换${passwordLabel(resp.kind)}」里填好${passwordLabel(resp.kind)}。`,
        );
      })
      .catch(() => setError('启用失败，请稍后再试'))
      .finally(() => setEnabling(false));
  };

  return (
    <Box>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {notice && (
        <Alert severity="info" sx={{ mb: 2 }}>
          {notice}
        </Alert>
      )}

      {/* 顶部账户标识 */}
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 2 }}>
        <Avatar>{kindAvatar(account.kind)}</Avatar>
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="subtitle1" noWrap>
              {account.name}
            </Typography>
            <Chip label={chip.label} size="small" color={chip.color} variant="outlined" />
          </Stack>
          <Typography variant="body2" color="text.secondary" noWrap>
            {account.email}
          </Typography>
        </Box>
      </Stack>

      {/* 同步状态：上次同步时间常驻；出错时把 last_error 全文摊开。
          与上面 error/notice 两个 Alert 是两回事（那两个说的是本次操作），可以同时出现。
          账户停用时后端会清空 last_error，所以停用态这条自然不出现，不需要额外条件。 */}
      <Stack spacing={1} sx={{ mb: 2 }}>
        <Typography variant="body2" color="text.secondary">
          上次同步：{account.last_sync_at ? timeAgo(account.last_sync_at) : '从未'}
        </Typography>
        {account.last_error && (
          // 报错里常有超长无空格串（URL、base64）：不给 anywhere 会把 Alert 撑出横向滚动
          <Alert severity="error" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {account.last_error}
          </Alert>
        )}
      </Stack>

      {/* 名称 */}
      <Stack direction="row" spacing={1} alignItems="flex-start">
        <TextField
          label="名称"
          size="small"
          fullWidth
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={name.trim() === ''}
          helperText={name.trim() === '' ? '请填写名称' : undefined}
          inputProps={{ autoComplete: 'off' }}
        />
        <Button
          variant="contained"
          onClick={handleSaveName}
          disabled={name.trim() === '' || name.trim() === account.name || savingName}
          // 进度圈作 startIcon：文字留在原位，按钮宽度不会在提交时缩掉一半
          startIcon={savingName ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          保存名称
        </Button>
      </Stack>

      {showCredentials && passwordKind && (
        <>
          {/* Gmail / QQ 邮箱：更换应用专用密码 / 授权码（折叠），文案随类型走 */}
          <Button
            size="small"
            onClick={() => setPasswordOpen((v) => !v)}
            aria-expanded={passwordOpen}
            sx={{ mt: 1.5, alignSelf: 'flex-start' }}
          >
            更换{passwordLabel(account.kind)}
          </Button>
          <Collapse in={passwordOpen}>
            <Stack spacing={1} sx={{ mt: 1 }}>
              <TextField
                label={`新的${passwordLabel(account.kind)}`}
                type="password"
                size="small"
                fullWidth
                value={appPassword}
                onChange={(e) => setAppPassword(e.target.value)}
                error={appPassword !== '' && appPassword.trim() === ''}
                helperText={
                  appPassword !== '' && appPassword.trim() === ''
                    ? `请填写${passwordLabel(account.kind)}`
                    : undefined
                }
                inputProps={{ autoComplete: 'off' }}
              />
              {guide && (
                <>
                  <Typography variant="body2" color="text.secondary">
                    {guide.text}
                  </Typography>
                  <Button
                    variant="text"
                    size="small"
                    component="a"
                    href={guide.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    sx={{ alignSelf: 'flex-start' }}
                  >
                    {guide.linkText}
                  </Button>
                </>
              )}
              <Button
                variant="outlined"
                onClick={handleSavePassword}
                disabled={appPassword.trim() === '' || savingPassword}
                sx={{ alignSelf: 'flex-start' }}
                startIcon={savingPassword ? <CircularProgress size={16} color="inherit" /> : undefined}
              >
                保存密码
              </Button>
            </Stack>
          </Collapse>
        </>
      )}

      {showCredentials && account.kind === 'microsoft' && (
        <>
          {/* 微软：重新授权（展开授权引导，成功后关闭） */}
          {authOpen ? (
            <Box sx={{ mt: 1.5 }}>
              <MicrosoftAuthGuide
                accountId={account.id}
                onAuthorized={(resp) => {
                  setAuthOpen(false);
                  applyPatch(resp, '授权完成');
                }}
              />
            </Box>
          ) : (
            <Button variant="outlined" onClick={() => setAuthOpen(true)} sx={{ mt: 1.5 }}>
              重新授权
            </Button>
          )}
        </>
      )}

      {/* 停用账户：启用入口（停用会清空凭据，启用后通常需要补凭据） */}
      {!account.enabled && (
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mt: 2 }}>
          <Typography variant="body2" color="text.secondary" sx={{ flexGrow: 1 }}>
            该账户已停用，邮件与任务都保留着。
          </Typography>
          <Button
            variant="contained"
            onClick={handleEnable}
            disabled={enabling}
            startIcon={enabling ? <CircularProgress size={16} color="inherit" /> : undefined}
          >
            启用
          </Button>
        </Stack>
      )}

      {/* 危险区：不用硬横线切（全站已改为靠间距与材质分层，见设置页改版），
          用一段间距 + 一行说明划边界 */}
      <Box sx={{ mt: 4 }}>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          停用或删除这个邮箱账户
        </Typography>
        <Button variant="outlined" color="error" startIcon={<DeleteOutlineIcon />} onClick={onRemove}>
          移除账户…
        </Button>
      </Box>

      <Snackbar
        open={snack !== null}
        autoHideDuration={3000}
        onClose={() => setSnack(null)}
        message={snack}
      />
    </Box>
  );
}
