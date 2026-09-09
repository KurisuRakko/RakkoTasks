// 截止日标签：列表行与详情对话框共用的唯一出口。
//
// 配色三档（口径只在这里定义，两处调用方不各写一份）：
//   已逾期            → 实心主色（梅）
//   DUE_SOON_DAYS 天内 → 描边主色
//   更远              → 中性
// 两档同色系，快到期与已过期一眼挑得出来，又不至于让所有带截止日的条目糊成一片红。
//
// 无障碍：标签面上只有「9月2日」这样一个孤零零的日期，读屏念出来不知道它是截止日
// 还是别的什么，逾期与否更是纯靠颜色——颜色不是可访问的信息通道。aria-label 把
// 这两件事都说出来。

import Chip from '@mui/material/Chip';
import type { SxProps, Theme } from '@mui/material/styles';
import { DUE_SOON_DAYS, formatDueDate, isDueSoon, isOverdue } from '../lib/grouping';
import type { Item } from '../types';

interface Props {
  item: Item;
  /** 判定「今天」的基准（调用方持有，测试可注入固定日期） */
  today: Date;
  /** 尺寸微调：列表行的标签比详情里的再小一档 */
  sx?: SxProps<Theme>;
}

/** 三档的展示属性；due_date 为空时调用方不该渲染本组件 */
function tone(item: Item, today: Date): { color?: 'primary'; variant?: 'outlined' } {
  if (isOverdue(item, today)) return { color: 'primary' };
  if (isDueSoon(item, today)) return { color: 'primary', variant: 'outlined' };
  return {};
}

/** 读屏用的完整说法：把「这是截止日」与「是否逾期/临期」补进去 */
function ariaLabel(item: Item, today: Date, text: string): string {
  if (isOverdue(item, today)) return `截止 ${text}，已逾期`;
  if (isDueSoon(item, today)) return `截止 ${text}，${DUE_SOON_DAYS} 天内到期`;
  return `截止 ${text}`;
}

export default function DueChip({ item, today, sx }: Props) {
  if (!item.due_date) return null;
  const text = formatDueDate(item.due_date);
  return <Chip label={text} size="small" sx={sx} aria-label={ariaLabel(item, today, text)} {...tone(item, today)} />;
}
