// 密码类凭据的获取指引：一行说明 + 一个跳转按钮。
// 向导第 2 步与账户详情页的更换折叠区都用它，两处文案与呈现因此天然一致
// （各写一遍的话，改了 QQ 那句就会漏掉另一处）。

import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import type { CredentialsGuide } from './meta';

interface Props {
  guide: CredentialsGuide;
}

export default function CredentialsGuideHint({ guide }: Props) {
  return (
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
        // 外链按钮跟着说明文字左对齐：父级 Stack 默认 stretch 会把它拉满宽
        sx={{ alignSelf: 'flex-start' }}
      >
        {guide.linkText}
      </Button>
    </>
  );
}
