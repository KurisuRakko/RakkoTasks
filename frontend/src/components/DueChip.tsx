// 截止日标签：列表行与详情对话框共用的唯一出口。
//
// 配色三档（口径只在这里定义，两处调用方不各写一份）：
//   已逾期 → 实心 error（语义就是「已经出事了」）
//   今天   → 描边 warning（今天之内要处理，还没出事）
//   更远   → 中性（MUI 的 default 色，不带任何语义色；形态保持既有的 filled，
//                 不改成 outlined——档位与形态都不动，只换语义色）
// 档位仍是三档、不增不减，只是把中档的口径从「临期窗口」（旧的 DUE_SOON_DAYS 天内）
// 收紧成「就是今天」：15 天内一律标 warning 等于把警告常态化，一周后的截止日不需要
// 用户现在就警惕。口径变了，中档的读屏文案也随之从「N 天内到期」改成「今天到期」。
//
// 为什么不用 primary 表达截止：accent 是焦点色（CTA / focus ring / 品牌标记），
// 覆盖面上限约 5%；列表里每个带截止日的行都染成梅色，焦点就不再落在任何一处，
// 而且「逾期」与「临期」同色系、只靠实心/描边区分轻重，语义读不出来。
//
// 无障碍：标签面上只有「9月2日」这样一个孤零零的日期，读屏念出来不知道它是截止日
// 还是别的什么，逾期与否更不能只靠颜色——颜色不是可访问的信息通道。aria-label 把
// 这两件事都说出来。

import Chip from '@mui/material/Chip';
import type { SxProps, Theme } from '@mui/material/styles';
import { formatDueDate, isOverdue, parseDueDate } from '../lib/grouping';
import { rowChipSx, stackSx } from '../lib/surface';
import type { Item } from '../types';

interface Props {
  item: Item;
  /** 判定「今天」的基准（调用方持有，测试可注入固定日期） */
  today: Date;
  /** 尺寸微调：默认走 rowChipSx（行内小标签档），调用方可再叠自己的 sx */
  sx?: SxProps<Theme>;
}

/** 截止日就是 today 所在的本地日期（非法日期串一律为假，当「更远」档处理）。
 *  与 grouping 的 isDueSoon 是两件事：那个的窗口是 DUE_SOON_DAYS 天、分组逻辑在用，
 *  这里只要「当天」这一格。 */
function isDueToday(item: Item, today: Date): boolean {
  if (!item.due_date) return false;
  const due = parseDueDate(item.due_date);
  if (Number.isNaN(due.getTime())) return false;
  return (
    due.getFullYear() === today.getFullYear() &&
    due.getMonth() === today.getMonth() &&
    due.getDate() === today.getDate()
  );
}

/** 三档的展示属性；due_date 为空时调用方不该渲染本组件。color 缺省即 MUI 的 default
 *  中性色，variant 缺省即 filled——逾期那一档要的正是实心语义色。 */
function tone(item: Item, today: Date): { color?: 'error' | 'warning'; variant?: 'outlined' } {
  if (isOverdue(item, today)) return { color: 'error' };
  if (isDueToday(item, today)) return { color: 'warning', variant: 'outlined' };
  return {};
}

/** 读屏用的完整说法：把「这是截止日」与「是否逾期/今天到期」补进去 */
function ariaLabel(item: Item, today: Date, text: string): string {
  if (isOverdue(item, today)) return `截止 ${text}，已逾期`;
  if (isDueToday(item, today)) return `截止 ${text}，今天到期`;
  return `截止 ${text}`;
}

export default function DueChip({ item, today, sx }: Props) {
  if (!item.due_date) return null;
  const text = formatDueDate(item.due_date);
  // 度量与行内「重要」标签同源（lib/surface 的 rowChipSx）：同一角色的标签只允许一种尺寸。
  // 与调用方的 sx 叠成数组要走 stackSx（MUI 的 sx 数组元素类型里没有 null，直接手写
  // 字面量数组的推断类型过不了重载；机制见 lib/surface 的 stackSx）
  const chipSx = stackSx([rowChipSx(), sx]);
  return (
    <Chip
      label={text}
      size="small"
      sx={chipSx}
      aria-label={ariaLabel(item, today, text)}
      {...tone(item, today)}
    />
  );
}
