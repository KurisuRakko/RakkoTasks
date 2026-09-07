// ItemFieldsForm：条目字段区的可复用受控表单（多行文本 + 分类 chip 单选 + 原生
// date input + 条件显示的清除按钮 + 提醒行编辑区）。该区块原为 ItemEditor 的内部
// JSX，抽成组件后由 ItemEditor（手填）与 AiAddDialog（AI 解析预览）共用，保证两处
// DOM 结构、className、aria 语义与文案完全一致——DOM 与文案任何改动都会同时打碎
// 两方的测试。
// 校验态由父组件算好经 props 下传（invalid/helper），父组件共享同一份
// parseEditorText + MAX_TITLE_LENGTH 口径，本组件不重复实现校验逻辑。
//
// 提醒编辑区（截止日期行之下）与四个既有字段不同：datetime-local 输入框被用户
// 清空（value=''）时没有对应的带偏移 ISO 可回写 props，因此组件内部持一份
// 「本地墙上时刻串」草案 state，只在外发回调时才经 fromDatetimeLocalValue 转成
// 带偏移 ISO 并过滤空行——清空一行只是让它退出提交数组，输入框保留在原地。
// 编辑过程中不对行重排（光标会乱跳），排序去重只发生在出参上。
// 新区块由 onRemindersChange 是否存在决定是否渲染：ItemEditor 尚未接入提醒时
// 整个区块不出现，接入方（AiAddDialog、测试）传了才有——不加这个门槛，手填
// 编辑器会渲染出一个没有任何状态可写的提醒区。
//
// 注意：rows 草案只在挂载时从 props.reminders 初始化，之后不随 props 变化重置
// ——若每次父组件回写出参都重置，被清空的那一行会被抽走，「输入框还在」的语义
// 就被破坏了。父组件只要在进 fields 阶段前把解析结果准备好（AiAddDialog 在
// 阶段切换时整棵子树重挂载），初始化时机就足够。

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import ClearIcon from '@mui/icons-material/Clear';
import type { Ref } from 'react';
import { useState } from 'react';
import { fromDatetimeLocalValue, toDatetimeLocalValue } from '../lib/time';
import { CATEGORIES, DEFAULT_REMIND_HOUR, REMINDERS_MAX } from '../types';
import type { Category } from '../types';

/** 明天 DEFAULT_REMIND_HOUR 点的本地墙上时刻串（datetime-local 的 value 形态）。
 * 不能用 toISOString()（那是 UTC 墙上时刻），按本地分量手拼。 */
function tomorrowDefaultReminder(): string {
  const t = new Date();
  t.setDate(t.getDate() + 1);
  t.setHours(DEFAULT_REMIND_HOUR, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:00`;
}

export interface ItemFieldsFormProps {
  /** 编辑器文本：第一行是标题，其余是详情 */
  text: string;
  onTextChange: (next: string) => void;
  category: Category;
  onCategoryChange: (next: Category) => void;
  /** YYYY-MM-DD，空串表示无日期 */
  date: string;
  onDateChange: (next: string) => void;
  /** 校验态：由父组件算好传进来（两个使用方的校验口径必须一致） */
  invalid: boolean;
  helper: string;
  /**
   * 提醒时刻，带 UTC 偏移的 ISO 8601 串，按时间升序。
   * 与 onRemindersChange 成对出现；两个都不传（调用方尚未接入提醒）时提醒编辑区
   * 整块不渲染，四个既有字段保持原样。
   */
  reminders?: string[];
  /** 提醒行变更（增/删/改/清空）时外发：排序去重并剔除空行后的提交数组 */
  onRemindersChange?: (next: string[]) => void;
  /** 传给标题输入框的 ref，用于 iOS 上手动聚焦；可选 */
  inputRef?: Ref<HTMLInputElement | HTMLTextAreaElement>;
  /** 是否自动聚焦（ItemEditor 传 true 保持现有行为） */
  autoFocus?: boolean;
}

export default function ItemFieldsForm({
  text,
  onTextChange,
  category,
  onCategoryChange,
  date,
  onDateChange,
  invalid,
  helper,
  reminders,
  onRemindersChange,
  inputRef,
  autoFocus,
}: ItemFieldsFormProps) {
  // 草案 state：每行一个本地墙上时刻串。只读 reminders 做首渲染初始化，此后
  // 以本 state 为准（清空的行没有 ISO 可回写 props，不能让出参回填把行抽走）。
  const [rows, setRows] = useState<string[]>(() =>
    (reminders ?? []).map((iso) => toDatetimeLocalValue(iso)),
  );
  const hasReminderEditor = onRemindersChange !== undefined;

  /** 草案 → 出参：清空/非法行剔除，按绝对时刻升序去重（不去重同刻会撞后端 UNIQUE） */
  const commitRows = (nextRows: string[]) => {
    const byTime = new Map<number, string>();
    for (const wall of nextRows) {
      const iso = fromDatetimeLocalValue(wall);
      if (iso === null) continue;
      const t = new Date(iso).getTime();
      if (!byTime.has(t)) byTime.set(t, iso);
    }
    onRemindersChange?.(
      [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([, iso]) => iso),
    );
  };

  const handleAddReminder = () => {
    if (rows.length >= REMINDERS_MAX) return;
    const next = [...rows, tomorrowDefaultReminder()];
    setRows(next);
    commitRows(next);
  };

  const handleReminderChange = (index: number, value: string) => {
    const next = rows.map((row, i) => (i === index ? value : row));
    setRows(next);
    commitRows(next);
  };

  const handleRemoveReminder = (index: number) => {
    const next = rows.filter((_, i) => i !== index);
    setRows(next);
    commitRows(next);
  };

  return (
    <Box sx={{ px: 2, py: 2, pb: 'calc(16px + env(safe-area-inset-bottom))' }}>
      <TextField
        label="第一行是标题，从第二行开始是详情"
        multiline
        minRows={6}
        autoFocus={autoFocus}
        fullWidth
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        error={invalid}
        helperText={helper}
        inputRef={inputRef}
        inputProps={{ 'aria-label': '任务内容' }}
      />
      {/* 分类：单选 chip 行，radiogroup/radio 语义 */}
      <Stack
        direction="row"
        spacing={1}
        role="radiogroup"
        aria-label="分类"
        sx={{ mt: 1.5, flexWrap: 'wrap' }}
      >
        {CATEGORIES.map((c) => (
          <Chip
            key={c}
            label={c}
            variant={category === c ? 'filled' : 'outlined'}
            color="primary"
            onClick={() => onCategoryChange(c)}
            role="radio"
            aria-checked={category === c}
          />
        ))}
      </Stack>
      {/* 截止日期：原生 date input + 条件显示的清除按钮 */}
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 2 }}>
        <TextField
          type="date"
          label="截止日期"
          fullWidth
          size="small"
          value={date}
          onChange={(e) => onDateChange(e.target.value)}
          InputLabelProps={{ shrink: true }}
        />
        {date !== '' && (
          <IconButton
            size="small"
            aria-label="清除日期"
            onClick={() => onDateChange('')}
            sx={{ flexShrink: 0 }}
          >
            <ClearIcon fontSize="small" />
          </IconButton>
        )}
      </Stack>
      {/* 提醒：多个 datetime-local 行，行可删、底部可加。语义上跟在「到期」后面是
          「敲人」。仅在父组件接了 onRemindersChange 时渲染（见文件头说明） */}
      {hasReminderEditor && (
        <Box sx={{ mt: 2 }}>
          <Typography variant="caption" color="text.secondary">
            提醒
          </Typography>
          {rows.map((wall, index) => (
            <Stack
              key={index}
              direction="row"
              spacing={1}
              alignItems="center"
              sx={{ mt: 0.5 }}
            >
              <TextField
                type="datetime-local"
                size="small"
                fullWidth
                value={wall}
                onChange={(e) => handleReminderChange(index, e.target.value)}
                InputLabelProps={{ shrink: true }}
              />
              <IconButton
                size="small"
                aria-label={`删除提醒 ${index + 1}`}
                onClick={() => handleRemoveReminder(index)}
                sx={{ flexShrink: 0 }}
              >
                <ClearIcon fontSize="small" />
              </IconButton>
            </Stack>
          ))}
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.5 }}>
            <Button
              size="small"
              startIcon={<AddIcon />}
              aria-label="加提醒"
              disabled={rows.length >= REMINDERS_MAX}
              onClick={handleAddReminder}
            >
              加提醒
            </Button>
            {rows.length >= REMINDERS_MAX && (
              <Typography variant="caption" color="text.secondary">
                最多 {REMINDERS_MAX} 个
              </Typography>
            )}
          </Stack>
        </Box>
      )}
    </Box>
  );
}
