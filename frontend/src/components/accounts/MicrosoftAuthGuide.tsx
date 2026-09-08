// 微软授权引导（添加向导第 3 步 / 账户详情重新授权共用）：
// 授权码 + PKCE 走「引导式两步」——Thunderbird 公共客户端的注册重定向地址不是本站，
// 无法回跳，只能在新标签页登录后把停在空白页的完整地址粘回来（见 docs/DESIGN.md 第 2 节）。
// ① 生成授权链接 → 新标签打开 / 复制；② 登录并完成 MFA（浏览器停在 nativeclient 空白页）；
// ③ 把地址栏完整地址（或裸授权码）粘回 → submitMsAuthCode 换 token 落库。
// auth_failed 按 kind 给中文提示；expired / no_pending_flow 视为流程失效，重置回 ① 重新生成。

import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { requestMsAuthUrl, submitMsAuthCode } from '../../lib/api';
import { copyText } from '../../lib/clipboard';
import { apiErrorFields } from './meta';
import type { AccountInfo } from '../../types';

interface Props {
  accountId: number;
  /** 凭据落库成功（status=ok）时回调，返回后端给的最新账户 */
  onAuthorized: (account: AccountInfo) => void;
}

export default function MicrosoftAuthGuide({ accountId, onAuthorized }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [authText, setAuthText] = useState('');
  const [generating, setGenerating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);

  // 复制反馈是瞬时的：不自撤就会一直挂在按钮下面，重新生成链接时还带着上一次那句话
  useEffect(() => {
    if (copyMsg === null) return;
    const timer = window.setTimeout(() => setCopyMsg(null), 3000);
    return () => window.clearTimeout(timer);
  }, [copyMsg]);

  const handleGenerate = () => {
    setGenerating(true);
    setError(null);
    setCopyMsg(null);
    requestMsAuthUrl(accountId)
      .then((u) => setUrl(u))
      .catch(() => setError('生成授权链接失败，请稍后再试'))
      .finally(() => setGenerating(false));
  };

  const handleOpen = () => {
    if (!url) return;
    window.open(url, '_blank', 'noopener');
  };

  const handleCopy = () => {
    if (!url) return;
    copyText(() => Promise.resolve(url))
      .then(() => setCopyMsg('已复制链接'))
      .catch(() => setCopyMsg('复制失败'));
  };

  /** 流程失效类错误：保留错误提示、回到 ① 重新生成链接 */
  const resetToGenerate = (message: string) => {
    setUrl(null);
    setAuthText('');
    setError(message);
  };

  const handleSubmit = () => {
    const response = authText.trim();
    if (response === '' || submitting) return;
    setSubmitting(true);
    setError(null);
    submitMsAuthCode(accountId, response)
      .then((a) => onAuthorized(a))
      .catch((err: unknown) => {
        const { code, kind, detail } = apiErrorFields(err);
        if (code === 'no_pending_flow') {
          resetToGenerate('授权流程已失效，请重新生成链接');
        } else if (code === 'auth_failed') {
          switch (kind) {
            case 'expired':
              resetToGenerate('授权已过期，请重新生成链接');
              break;
            case 'declined':
              resetToGenerate('你在微软页面上拒绝了授权，可重新生成链接再试');
              break;
            case 'admin_required':
              setError(
                '该组织要求管理员同意此应用，请联系 IT 或在高级设置里换用自己注册的 client_id',
              );
              break;
            default:
              // other：后端 detail 有更具体的原因时展示它
              setError(detail ?? '授权失败，请稍后再试');
          }
        } else {
          setError('授权失败，请稍后再试');
        }
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <Stack spacing={1.5}>
      {error && <Alert severity="error">{error}</Alert>}
      {!url ? (
        <>
          <Typography variant="body2">
            Microsoft 365 使用第三方公共客户端登录，授权完成后浏览器会停在空白页。
            先在这里生成授权链接，再按下面步骤操作。
          </Typography>
          <Button variant="contained" onClick={handleGenerate} disabled={generating} sx={{ alignSelf: 'flex-start' }}>
            生成授权链接
          </Button>
        </>
      ) : (
        <>
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
            <Button variant="contained" startIcon={<OpenInNewIcon />} onClick={handleOpen}>
              在新标签页打开微软登录
            </Button>
            <Button variant="outlined" startIcon={<ContentCopyIcon />} onClick={handleCopy}>
              复制链接
            </Button>
          </Stack>
          {copyMsg && (
            <Typography variant="caption" color="text.secondary">
              {copyMsg}
            </Typography>
          )}
          <Typography variant="body2" color="text.secondary">
            用该邮箱登录并完成多因素验证。登录成功后浏览器会停在一个<strong>空白页</strong>
            ，地址以 login.microsoftonline.com/common/oauth2/nativeclient 开头——这是正常的。
          </Typography>
          <TextField
            label="把地址栏的完整地址粘贴到这里"
            helperText="也接受裸授权码"
            size="small"
            fullWidth
            multiline
            minRows={2}
            value={authText}
            onChange={(e) => setAuthText(e.target.value)}
            inputProps={{ autoComplete: 'off' }}
          />
          <Button
            variant="contained"
            onClick={handleSubmit}
            disabled={authText.trim() === '' || submitting}
            sx={{ alignSelf: 'flex-start' }}
          >
            完成授权
          </Button>
        </>
      )}
    </Stack>
  );
}
