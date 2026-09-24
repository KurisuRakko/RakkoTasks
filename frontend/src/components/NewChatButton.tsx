// 顶栏「新对话」：清空聊天记录（只在内存里，清掉就是清掉，不弹确认）。
// 没有对话、或有一轮在途时禁用——在途的回复带执行回执，中途清空会把回执弄丢。

import IconButton from '@mui/material/IconButton';
import AddCommentOutlinedIcon from '@mui/icons-material/AddCommentOutlined';
import { resetChat, useChatPending, useChatTurns } from '../lib/chat';

export default function NewChatButton() {
  const turns = useChatTurns();
  const pending = useChatPending();
  return (
    <IconButton
      color="inherit"
      aria-label="新对话"
      disabled={turns.length === 0 || pending}
      onClick={resetChat}
    >
      <AddCommentOutlinedIcon />
    </IconButton>
  );
}
