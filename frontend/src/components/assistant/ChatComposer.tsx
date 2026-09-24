// 助理页的输入台：一整块 panel 玻璃，输入框、发送按钮、进度条、错误告警都坐在上面。
// 玻璃不嵌套是既有不变量，所以玻璃挂在外层容器而不是 TextField 的 FormControl 根：
// 输入框只是玻璃上的一个控件。宿主只补配方不管的圆角（RADIUS.card）与内边距，
// 不写 background / boxShadow —— 一写就盖掉 rakko-glass.css 的 panel 配方。

import type { KeyboardEvent, Ref } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import TextField from '@mui/material/TextField';
import SendIcon from '@mui/icons-material/Send';
import {
  INPUT_MAX,
  sendMessage,
  setDraft,
  useChatDraft,
  useChatError,
  useChatPending,
} from '../../lib/chat';
import { BOTTOM_NAV_HEIGHT_PX } from '../../lib/layout';
import { hitSlopSx } from '../../lib/surface';
import { RADIUS } from '../../rakko-tokens';

interface Props {
  /** 页面持有输入框引用：空态建议只填字不发送，填完要做焦点回来 */
  inputRef?: Ref<HTMLTextAreaElement>;
}

/** 回车发送、Shift+Enter 换行、输入法组合中不发送 */
function onComposerKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
  if (e.key !== 'Enter' || e.shiftKey) return;
  // Safari 上确认输入法候选的那次回车 isComposing 已是 false、keyCode 却是 229，
  // 只判 isComposing 会把拼音/日文的首个候选直接当发送，这里把 229 一起挡掉。
  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
  e.preventDefault();
  void sendMessage();
}

export default function ChatComposer({ inputRef }: Props) {
  const draft = useChatDraft();
  const pending = useChatPending();
  const error = useChatError();

  return (
    <Box
      data-glass="panel"
      sx={{
        borderRadius: `${RADIUS.card}px`,
        p: 1.5,
        // 贴在移动端底栏上方：页面短时它与正常流位置重合（不跳），滚长了自然吸底
        position: 'sticky',
        bottom: {
          xs: `calc(${BOTTOM_NAV_HEIGHT_PX}px + env(safe-area-inset-bottom) + 8px)`,
          md: '16px',
        },
        mb: { xs: 1, md: 2 },
        zIndex: 1,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: 1 }}>
        <TextField
          fullWidth
          multiline
          minRows={1}
          maxRows={6}
          size="small"
          placeholder="问邮件、记待办，直接说"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onComposerKeyDown}
          inputRef={inputRef}
          slotProps={{
            htmlInput: {
              maxLength: INPUT_MAX,
              enterKeyHint: 'send',
              'aria-label': '给助理的消息',
            },
          }}
          sx={{
            '& .MuiOutlinedInput-root': {
              backgroundColor: 'transparent',
              '& .MuiOutlinedInput-notchedOutline': { border: 'none' },
            },
          }}
        />
        <IconButton
          color="primary"
          aria-label="发送"
          disabled={pending || draft.trim() === ''}
          sx={hitSlopSx()}
          onClick={() => void sendMessage()}
        >
          <SendIcon />
        </IconButton>
      </Box>
      {pending && <LinearProgress sx={{ mt: 1 }} />}
      {error && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {error}
        </Alert>
      )}
    </Box>
  );
}
