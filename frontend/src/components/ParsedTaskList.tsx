// ParsedTaskList：一段速记文本被拆成多条时的确认列表。
//
// 只在 drafts 多于一条时出现——单条仍由 AiAddDialog 直接渲染 ItemFieldsForm，
// 与改版前完全一致，不给最常见的路径加一层壳。
//
// 收起态一行一条（标题 + 时间 + 分类），点开展成完整的 ItemFieldsForm。默认全部
// 收起：四条任务各自铺开一整套分类 chip、重要度 chip、日期与提醒区，在手机上要
// 滚很久才看得完，用户想核对的其实只有「拆对了没有、时间对不对」。
//
// 展开用 ListItemButton + Collapse 而不是 Accordion：项目里既有的展开模式就是这套
// （列表行也是 ListItemButton），Accordion 会带进另一套视觉默认值。

import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { MOTION } from '../rakko-tokens';
import { formatDueDate } from '../lib/grouping';
import { formatReminder } from '../lib/time';
import ItemFieldsForm from './ItemFieldsForm';
import { parseEditorText } from './ItemEditor';
import type { Draft } from './AiAddDialog';

export interface ParsedTaskListProps {
  drafts: Draft[];
  /** 第 index 条的某个字段变了：整条替换，父组件持有数组 */
  onChange: (index: number, next: Draft) => void;
  /** 删掉解析错的那条。只剩一条时父组件不会渲染本组件，所以这里总有得删 */
  onRemove: (index: number) => void;
  /** 当前展开的下标；null = 全部收起。受控，父组件在删除后要负责修正它 */
  expanded: number | null;
  onExpandedChange: (next: number | null) => void;
  /** 每条的校验态由父组件按同一份 parseEditorText 口径算好 */
  invalidAt: (index: number) => boolean;
  helperAt: (index: number) => string;
}

/** 收起态右侧的时间摘要：优先报第一个提醒时刻，没有提醒才报截止日；都没有就不占位。
 *  两者都走各自的中文格式化函数——同一行同一位置不能一个是「明天 10:00」、
 *  另一个是原始的 2026-09-10。 */
function timeSummary(draft: Draft): string {
  if (draft.reminders.length > 0) return formatReminder(draft.reminders[0]);
  return draft.date ? formatDueDate(draft.date) : '';
}

export default function ParsedTaskList({
  drafts,
  onChange,
  onRemove,
  expanded,
  onExpandedChange,
  invalidAt,
  helperAt,
}: ParsedTaskListProps) {
  return (
    <List disablePadding aria-label="识别结果">
      {drafts.map((draft, index) => {
        const { title } = parseEditorText(draft.text);
        const invalid = invalidAt(index);
        const isOpen = expanded === index;
        const time = timeSummary(draft);
        return (
          <ListItem
            key={index}
            disablePadding
            divider
            sx={{ display: 'block' }}
            secondaryAction={
              <IconButton
                edge="end"
                aria-label={`删除第 ${index + 1} 条`}
                onClick={() => onRemove(index)}
              >
                <DeleteOutlineIcon fontSize="small" />
              </IconButton>
            }
          >
            <ListItemButton
              onClick={() => onExpandedChange(isOpen ? null : index)}
              aria-expanded={isOpen}
              // 收起时读出标题就够；展开后表单自己有完整 label
              aria-label={`第 ${index + 1} 条：${title || '（空）'}`}
              sx={{ pr: 7 }}
            >
              <Stack sx={{ flexGrow: 1, minWidth: 0 }} spacing={0.25}>
                <Typography
                  variant="body2"
                  noWrap
                  // 校验不过的那条在收起态也要看得出来，否则「保存」灰着而用户
                  // 不知道该点开哪一条
                  color={invalid ? 'error.main' : 'text.primary'}
                >
                  {invalid ? helperAt(index) : title}
                </Typography>
                {time && (
                  <Typography variant="caption" color="text.secondary" noWrap>
                    {time}
                  </Typography>
                )}
              </Stack>
              <Chip label={draft.category} size="small" sx={{ ml: 1, flexShrink: 0 }} />
              {isOpen ? (
                <ExpandLessIcon fontSize="small" sx={{ ml: 1, color: 'text.secondary' }} />
              ) : (
                <ExpandMoreIcon fontSize="small" sx={{ ml: 1, color: 'text.secondary' }} />
              )}
            </ListItemButton>
            <Collapse
              in={isOpen}
              unmountOnExit
              timeout={{ enter: MOTION.enter, exit: MOTION.exit }}
              easing={{ enter: MOTION.easeStandard, exit: MOTION.easeStandard }}
            >
              <Box sx={{ pb: 1 }}>
                <ItemFieldsForm
                  text={draft.text}
                  onTextChange={(text) => onChange(index, { ...draft, text })}
                  category={draft.category}
                  onCategoryChange={(category) => onChange(index, { ...draft, category })}
                  importance={draft.importance}
                  onImportanceChange={(importance) => onChange(index, { ...draft, importance })}
                  date={draft.date}
                  onDateChange={(date) => onChange(index, { ...draft, date })}
                  invalid={invalid}
                  helper={helperAt(index)}
                  reminders={draft.reminders}
                  onRemindersChange={(reminders) => onChange(index, { ...draft, reminders })}
                />
              </Box>
            </Collapse>
          </ListItem>
        );
      })}
    </List>
  );
}
