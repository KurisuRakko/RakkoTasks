// 原邮件查看器（安全红线见 docs/DESIGN.md 第 7 节）：
// html 非空 → sandbox iframe（sandbox 属性必须为空串，不加任何 allow-*）；
// 无 html → 纯文本 <pre>；「显示远程图片」开关以 ?remote_images=1 重取并替换 srcDoc。

import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import { fetchEmail } from '../lib/api';
import type { Email } from '../types';

interface Props {
  emailId: number;
}

export default function EmailViewer({ emailId }: Props) {
  const [email, setEmail] = useState<Email | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [remoteImages, setRemoteImages] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetchEmail(emailId, { remoteImages })
      .then((e) => {
        if (alive) setEmail(e);
      })
      .catch(() => {
        if (alive) setError('加载邮件失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [emailId, remoteImages, retryKey]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress size={28} />
      </Box>
    );
  }

  if (error || !email) {
    return (
      <Stack spacing={1} alignItems="center" sx={{ py: 2 }}>
        <Alert severity="error">{error ?? '邮件不存在'}</Alert>
        <Button size="small" onClick={() => setRetryKey((k) => k + 1)}>
          重试
        </Button>
      </Stack>
    );
  }

  return (
    <Stack spacing={1} sx={{ width: '100%' }}>
      <Divider />
      <Typography variant="subtitle2" noWrap>
        {email.subject}
      </Typography>
      <Typography variant="caption" color="text.secondary" noWrap>
        {email.sender ?? '未知发件人'}
        {email.sent_at ? ` · ${email.sent_at}` : ''}
      </Typography>
      {email.html ? (
        <>
          <FormControlLabel
            control={<Switch size="small" checked={remoteImages} onChange={(e) => setRemoteImages(e.target.checked)} />}
            label="显示远程图片"
          />
          <Box
            component="iframe"
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={email.html}
            title="邮件原文"
            sx={{
              width: '100%',
              height: '70vh',
              border: 0,
              borderRadius: 1,
              bgcolor: 'background.paper',
            }}
          />
        </>
      ) : (
        <Box
          component="pre"
          sx={{
            m: 0,
            p: 1.5,
            maxHeight: '70vh',
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontFamily: 'inherit',
            fontSize: '0.875rem',
            bgcolor: 'action.hover',
            borderRadius: 1,
          }}
        >
          {email.text_body ?? '（无正文）'}
        </Box>
      )}
    </Stack>
  );
}
