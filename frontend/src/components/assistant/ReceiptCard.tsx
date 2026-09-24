// 回执卡：助理这一轮真的执行了哪些写操作，一行一条，点开对应待办详情。
// 行本身就是一块 data-glass="panel" 玻璃（同 TasksPage / DonePage 的列表行，
// 对上游 anti-patterns "A glass surface per list item" 的明知偏离见 surface.ts 文件头），
// 圆角由 cardRowSx 补，纸底 / 边框 / 高光 / 阴影来自配方，宿主不下发 background。
// 玻璃上所有文字只用 text.primary（n9）：n7 压在 58% 纸色的玻璃上过不了 AA 4.5。

import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import AddTaskIcon from '@mui/icons-material/AddTask';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import ReplayIcon from '@mui/icons-material/Replay';
import TaskAltIcon from '@mui/icons-material/TaskAlt';
import DueChip from '../DueChip';
import { cardRowSx, ROW_GAP_PX } from '../../lib/surface';
import { formatReminder } from '../../lib/time';
import type { ChatAction, ChatActionField, ChatActionKind } from '../../types';

interface Props {
  action: ChatAction;
  /** 来源元素的 view-transition-name（不该持名时为 undefined） */
  sourceName: string | undefined;
  /** 有回执正在打开时禁止再点（同时只允许一个容器变换在跑） */
  disabled: boolean;
  onClick: () => void;
}

const ACTION_ICONS: Record<ChatActionKind, typeof AddTaskIcon> = {
  created: AddTaskIcon,
  completed: TaskAltIcon,
  reopened: ReplayIcon,
  updated: EditOutlinedIcon,
};

/** fields 的顺序由后端固定（title, category, due_date, reminders），这里照序取名字 */
const FIELD_LABELS: Record<ChatActionField, string> = {
  title: '标题',
  category: '分类',
  due_date: '截止日期',
  reminders: '提醒',
};

/** 动作文案；updated 的 fields 为空说明后端没细说改了哪几项，退回一句泛称 */
function actionText(action: ChatAction): string {
  switch (action.kind) {
    case 'created':
      return '新建了待办';
    case 'completed':
      return '标记为已完成';
    case 'reopened':
      return '重新打开了待办';
    case 'updated':
      return action.fields.length > 0
        ? `修改了${action.fields.map((field) => FIELD_LABELS[field]).join('、')}`
        : '修改了待办';
  }
}

export default function ReceiptCard({ action, sourceName, disabled, onClick }: Props) {
  const Icon = ACTION_ICONS[action.kind];
  const { item } = action;
  return (
    <ListItemButton
      data-glass="panel"
      disabled={disabled}
      onClick={onClick}
      sx={[cardRowSx(), { mb: `${ROW_GAP_PX}px`, viewTransitionName: sourceName }]}
    >
      <ListItemIcon sx={{ color: 'text.primary' }}>
        <Icon />
      </ListItemIcon>
      {/* 不用 ListItemText：它把 secondary 渲染成 <p>，里面再放 Chip 就是 div 落在 p 里 */}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body1" noWrap>
          {item.title}
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.primary' }}>
          {actionText(action)}
        </Typography>
        <Stack direction="row" flexWrap="wrap" alignItems="center" gap={0.75} sx={{ mt: 0.5 }}>
          <Chip label={item.category} size="small" variant="outlined" />
          <DueChip item={item} today={new Date()} />
          {item.reminders.length > 0 && (
            <Typography variant="caption" sx={{ color: 'text.primary' }}>
              {`🔔 ${formatReminder(item.reminders[0].remind_at)}`}
              {item.reminders.length > 1 ? ` 等 ${item.reminders.length} 个` : ''}
            </Typography>
          )}
        </Stack>
      </Box>
    </ListItemButton>
  );
}
