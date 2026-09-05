// 添加邮箱账户向导（桌面 Dialog / 移动端独立路由页共用）：
// ① 选类型（Gmail / Outlook·Microsoft 365）→ ② 名称邮箱（Gmail 附应用专用密码与生成指引，
// 微软可展开「高级」填自定义 client_id）→ ③ 微软授权引导（仅微软，复用 MicrosoftAuthGuide）
// → ④ 完成。Gmail 建好后直接进 ④；微软建好后凭据还没落库，进 ③ 引导两步授权。
// 错误一律 Alert 展示（可停留阅读）；第 1、2 步可取消，第 3 步可「稍后再授权」（账户已建）。

import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CardContent from '@mui/material/CardContent';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import CircularProgress from '@mui/material/CircularProgress';
import Collapse from '@mui/material/Collapse';
import Stack from '@mui/material/Stack';
import Step from '@mui/material/Step';
import StepLabel from '@mui/material/StepLabel';
import Stepper from '@mui/material/Stepper';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import { createAccount } from '../../lib/api';
import { defaultNameFor } from './meta';
import MicrosoftAuthGuide from './MicrosoftAuthGuide';
import type { AccountInfo, AccountKind } from '../../types';

interface Props {
  onDone: (account: AccountInfo) => void;
  onCancel: () => void;
}

interface KindOption {
  kind: AccountKind;
  title: string;
  subtitle?: string;
}

const KIND_OPTIONS: readonly KindOption[] = [
  { kind: 'gmail', title: 'Gmail' },
  {
    kind: 'microsoft',
    title: 'Outlook · Microsoft 365',
    subtitle: '个人 Outlook、学校与公司邮箱都选这个',
  },
];

/** POST /api/accounts 的错误码 → 中文；未列出的码给兜底文案 */
function createErrorMessage(err: unknown): string {
  const code = (err as { code?: string }).code;
  switch (code) {
    case 'account_exists':
      return '这个邮箱已经添加过了';
    case 'password_required':
      return '请填写应用专用密码';
    case 'bad_email':
      return '邮箱格式不对';
    default:
      return '添加失败，请稍后再试';
  }
}

export default function AccountWizard({ onDone, onCancel }: Props) {
  const theme = useTheme();
  // 移动端纵向步骤条、桌面端横向
  const vertical = useMediaQuery(theme.breakpoints.down('md'));

  const [kind, setKind] = useState<AccountKind | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const [msClientId, setMsClientId] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [activeStep, setActiveStep] = useState(0);
  const [created, setCreated] = useState<AccountInfo | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const microsoft = kind === 'microsoft';
  // 步骤条随类型伸缩：微软多一段「微软授权」；activeStep 的语义由 created/kind 推导
  const stepLabels = microsoft
    ? (['账户类型', '基本信息', '微软授权', '完成'] as const)
    : (['账户类型', '基本信息', '完成'] as const);
  const doneStep = stepLabels.length - 1;

  const pickKind = (k: AccountKind) => {
    // 名称没被手改过时跟着类型换默认值（空串或仍是旧类型默认名视为未手改）
    const untouched = name === '' || (kind !== null && name === defaultNameFor(kind));
    setKind(k);
    if (untouched) setName(defaultNameFor(k));
    setError(null);
  };

  const handleNext = () => {
    if (activeStep === 0) {
      if (!kind) return;
      setActiveStep(1);
      return;
    }
    // 第 2 步：先建账户；Gmail 建好即有凭据直接进完成页，微软进第 3 步授权
    if (!kind) return;
    const body: { name: string; kind: AccountKind; email: string; app_password?: string; ms_client_id?: string } = {
      name: name.trim(),
      kind,
      email: email.trim(),
    };
    if (kind === 'gmail') body.app_password = appPassword;
    else if (msClientId.trim() !== '') body.ms_client_id = msClientId.trim();
    setSubmitting(true);
    setError(null);
    createAccount(body)
      .then((account) => {
        setCreated(account);
        // gmail 跳完成页；微软进授权步
        setActiveStep(microsoft ? 2 : doneStep);
      })
      .catch((err: unknown) => setError(createErrorMessage(err)))
      .finally(() => setSubmitting(false));
  };

  const nameInvalid = name.trim() === '';
  const emailInvalid = !email.trim().includes('@');
  const nextDisabled =
    activeStep === 0 ? kind === null : nameInvalid || emailInvalid || submitting;

  return (
    <Box>
      <Stepper activeStep={activeStep} orientation={vertical ? 'vertical' : 'horizontal'}>
        {stepLabels.map((label, i) => (
          <Step key={label} completed={i < activeStep}>
            <StepLabel>{label}</StepLabel>
          </Step>
        ))}
      </Stepper>

      <Box sx={{ mt: 2 }}>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {activeStep === 0 && (
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1.5}
            role="group"
            aria-label="账户类型"
          >
            {KIND_OPTIONS.map((opt) => {
              const selected = kind === opt.kind;
              return (
                <Card
                  key={opt.kind}
                  variant="outlined"
                  sx={{
                    flex: 1,
                    // 选中卡片用主色描边 + 状态层底色区分，与主题其余控件一致
                    borderColor: selected ? 'primary.main' : undefined,
                    bgcolor: selected ? 'action.selected' : 'background.paper',
                  }}
                >
                  <CardActionArea
                    onClick={() => pickKind(opt.kind)}
                    aria-label={opt.title}
                    aria-pressed={selected}
                  >
                    <CardContent>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Avatar>{opt.kind === 'gmail' ? 'G' : 'O'}</Avatar>
                        <Box sx={{ minWidth: 0 }}>
                          <Typography variant="subtitle1" noWrap>
                            {opt.title}
                          </Typography>
                          {opt.subtitle && (
                            <Typography variant="body2" color="text.secondary">
                              {opt.subtitle}
                            </Typography>
                          )}
                        </Box>
                      </Stack>
                    </CardContent>
                  </CardActionArea>
                </Card>
              );
            })}
          </Stack>
        )}

        {activeStep === 1 && (
          <Stack spacing={1.5}>
            <TextField
              label="名称"
              size="small"
              fullWidth
              value={name}
              onChange={(e) => setName(e.target.value)}
              error={nameInvalid}
              helperText={nameInvalid ? '请填写名称' : undefined}
              inputProps={{ autoComplete: 'off' }}
            />
            <TextField
              label="邮箱"
              type="email"
              size="small"
              fullWidth
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={emailInvalid}
              helperText={emailInvalid ? '请填写正确的邮箱地址' : undefined}
              inputProps={{ autoComplete: 'off' }}
            />
            {kind === 'gmail' ? (
              <>
                <TextField
                  label="应用专用密码"
                  type="password"
                  size="small"
                  fullWidth
                  value={appPassword}
                  onChange={(e) => setAppPassword(e.target.value)}
                  inputProps={{ autoComplete: 'off' }}
                />
                <Typography variant="body2" color="text.secondary">
                  Google 账号 → 安全性 → 开启两步验证 → 应用专用密码 → 生成 16 位密码。
                </Typography>
                <Button
                  variant="text"
                  size="small"
                  component="a"
                  href="https://myaccount.google.com/apppasswords"
                  target="_blank"
                  rel="noopener noreferrer"
                  sx={{ alignSelf: 'flex-start' }}
                >
                  打开 Google 应用专用密码页面
                </Button>
              </>
            ) : (
              <>
                <Typography variant="body2" color="text.secondary">
                  使用这个邮箱登录微软并完成授权。默认使用 Thunderbird 公共客户端，学校或公司租户
                  通常不允许自注册应用——保持默认即可；只有需要自己注册应用的场景才填下面的 client_id。
                </Typography>
                <Button
                  size="small"
                  onClick={() => setAdvancedOpen((v) => !v)}
                  aria-expanded={advancedOpen}
                  sx={{ alignSelf: 'flex-start' }}
                >
                  高级
                  <KeyboardArrowDownIcon
                    fontSize="small"
                    sx={{ transform: advancedOpen ? 'rotate(180deg)' : 'none' }}
                  />
                </Button>
                <Collapse in={advancedOpen}>
                  <TextField
                    label="自定义 client_id（可选）"
                    size="small"
                    fullWidth
                    value={msClientId}
                    onChange={(e) => setMsClientId(e.target.value)}
                    sx={{ mt: 1 }}
                    inputProps={{ autoComplete: 'off' }}
                  />
                </Collapse>
              </>
            )}
          </Stack>
        )}

        {activeStep === 2 && microsoft && created && (
          <>
            <MicrosoftAuthGuide
              accountId={created.id}
              onAuthorized={(account) => {
                setCreated(account);
                setError(null);
                setActiveStep(3);
              }}
            />
            <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
              暂时不方便授权？可先保存账户，稍后在账户详情里重新授权。
            </Typography>
          </>
        )}

        {activeStep === doneStep && created && (
          <Stack alignItems="center" spacing={1} sx={{ py: 2 }}>
            <CheckCircleOutlineIcon color="success" sx={{ fontSize: 48 }} />
            <Typography variant="body2" sx={{ textAlign: 'center' }}>
              已接入 {created.name}。系统会在下一轮同步（最多 15 分钟）开始拉取最近 7 天的邮件并生成任务。
            </Typography>
          </Stack>
        )}
      </Box>

      {/* 底部动作：每步都有「下一步」推进；步骤 1/2 可取消；微软授权步提供「稍后再授权」；完成页只有「完成」 */}
      <Stack direction="row" justifyContent="flex-end" spacing={1} sx={{ mt: 2 }}>
        {activeStep === 0 && (
          <>
            <Button variant="outlined" onClick={onCancel} disabled={submitting}>
              取消
            </Button>
            <Button variant="contained" onClick={handleNext} disabled={nextDisabled}>
              {submitting ? <CircularProgress size={18} color="inherit" /> : '下一步'}
            </Button>
          </>
        )}
        {activeStep === 1 && (
          <>
            <Button variant="outlined" onClick={onCancel} disabled={submitting}>
              取消
            </Button>
            <Button variant="contained" onClick={handleNext} disabled={nextDisabled}>
              {submitting ? <CircularProgress size={18} color="inherit" /> : '下一步'}
            </Button>
          </>
        )}
        {activeStep === 2 && microsoft && created && (
          <Button variant="outlined" onClick={() => onDone(created)}>
            稍后再授权
          </Button>
        )}
        {activeStep === doneStep && created && (
          <Button variant="contained" onClick={() => onDone(created)}>
            完成
          </Button>
        )}
      </Stack>
    </Box>
  );
}
