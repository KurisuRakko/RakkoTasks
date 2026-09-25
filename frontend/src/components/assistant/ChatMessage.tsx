// 对话里的一条消息。用户那条是一块 panel 玻璃气泡（原文是纯文本，不走 Markdown）；
// 助理那条没有玻璃底：回答挂一团 haze（整块一团，不给每个段落各挂一团），
// 下面是写操作回执与引用邮件列表，两者与回答雾是兄弟关系——玻璃不嵌套。
// 「引用邮件（N）」标题沿用 label 档雾（width: max-content 贴合单行短标题）。

import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import SafeMarkdown from '../SafeMarkdown';
import ReceiptCard from './ReceiptCard';
import { GLASS, RADIUS } from '../../rakko-tokens';
import { ROW_GAP_PX, cardRowSx } from '../../lib/surface';
import type { ChatTurn } from '../../lib/chat';

interface Props {
  turn: ChatTurn;
  /** 非空表示已有回执在打开中，此时其余回执禁用 */
  openingKey: string | null;
  /** 第 key 条回执此刻该用的 view-transition-name（不该持名时 undefined） */
  receiptSourceName: (key: string) => string | undefined;
  /** 第 key 条引用此刻该用的 view-transition-name（不该持名时 undefined） */
  citationSourceName: (key: string) => string | undefined;
  onOpenReceipt: (key: string, itemId: number) => void;
  onOpenCitation: (key: string, emailId: number) => void;
}

export default function ChatMessage({
  turn,
  openingKey,
  receiptSourceName,
  citationSourceName,
  onOpenReceipt,
  onOpenCitation,
}: Props) {
  if (turn.role === 'user') {
    return (
      <Box
        data-glass="panel"
        sx={{
          alignSelf: 'flex-end',
          maxWidth: '85%',
          px: 1.5,
          py: 1,
          borderRadius: `${RADIUS.card}px`,
        }}
      >
        <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {turn.content}
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ alignSelf: 'stretch' }}>
      {/* 整块回答挂一团雾：多行长文本只给整块挂，max-width: 72ch 占住可读行宽。
          bleed 取满档 GLASS.hazeBleed——上游 note 档的 0.4 倍（约 11px）压在壁纸上显得太小，
          长回答四角会露在云团实心核心之外。
          cloud 是默认形态，不写 data-haze——只有切 veil 才写该属性。 */}
      <Box
        data-glass="haze"
        sx={{
          typography: 'body1',
          maxWidth: '72ch',
          '--glass-haze-bleed': GLASS.hazeBleed,
        }}
      >
        <SafeMarkdown breaks>{turn.content}</SafeMarkdown>
      </Box>
      {turn.actions.length > 0 && (
        // 回执行与引用行同为 panel 玻璃，是回答雾的兄弟（雾内部不允许再出现玻璃）
        <List disablePadding aria-label="已执行的操作" sx={{ mt: 1.5 }}>
          {turn.actions.map((action, index) => {
            // 来源 key 必须带 turn.id：同一条待办可能出现在多轮里，只用 id 会撞名，
            // 浏览器会因 view-transition-name 重复整段跳过转场
            const key = `${turn.id}:${index}`;
            return (
              <ReceiptCard
                key={key}
                action={action}
                sourceName={receiptSourceName(key)}
                disabled={openingKey !== null}
                onClick={() => onOpenReceipt(key, action.item.id)}
              />
            );
          })}
        </List>
      )}
      {turn.citations.length > 0 && (
        <>
          <Divider sx={{ my: 2 }} />
          <Typography
            variant="subtitle2"
            gutterBottom
            data-glass="haze"
            sx={{
              width: 'max-content',
              '--glass-haze-bleed': `calc(0.6 * ${GLASS.hazeBleed})`,
            }}
          >
            引用邮件（{turn.citations.length}）
          </Typography>
          <List disablePadding>
            {turn.citations.map((citation) => {
              const key = `${turn.id}:${citation.email_id}`;
              return (
                <ListItemButton
                  key={key}
                  data-glass="panel"
                  onClick={() => onOpenCitation(key, citation.email_id)}
                  sx={[
                    cardRowSx(),
                    {
                      mb: `${ROW_GAP_PX}px`,
                      viewTransitionName: citationSourceName(key),
                    },
                  ]}
                >
                  <ListItemText
                    primary={citation.subject}
                    secondary={citation.sent_at ?? '时间未知'}
                    // 摘要压在自己这块行玻璃上：text.secondary（n7）实测过不了 AA 4.5，
                    // 玻璃上没有次级色空间，层级靠字号字重，颜色取 text.primary（n9）
                    secondaryTypographyProps={{
                      noWrap: true,
                      color: 'text.primary',
                    }}
                  />
                </ListItemButton>
              );
            })}
          </List>
        </>
      )}
    </Box>
  );
}
