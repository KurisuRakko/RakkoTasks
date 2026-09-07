// ItemFieldsForm：条目字段区的可复用受控表单（多行文本 + 分类 chip 单选 + 原生
// date input + 条件显示的清除按钮）。该区块原为 ItemEditor 的内部 JSX，抽成组件后
// 由 ItemEditor（手填）与 AiAddDialog（AI 解析预览）共用，保证两处 DOM 结构、
// className、aria 语义与文案完全一致——DOM 与文案任何改动都会同时打碎两方的测试。
// 校验态由父组件算好经 props 下传（invalid/helper），父组件共享同一份
// parseEditorText + MAX_TITLE_LENGTH 口径，本组件不重复实现校验逻辑。

import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ClearIcon from '@mui/icons-material/Clear';
import type { Ref } from 'react';
import { CATEGORIES } from '../types';
import type { Category } from '../types';

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
  inputRef,
  autoFocus,
}: ItemFieldsFormProps) {
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
    </Box>
  );
}
