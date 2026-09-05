// ItemEditor：新建/编辑手动条目的编辑器对话框（移动端全屏、桌面端限宽）。
// md 起居中于主内容区（mainAreaDialogSx）：编辑器从悬浮按钮长出而非列表行，宽度保持
// sm、不与内容列对齐，只做居中这一半，避免同屏两个对话框一个对齐列、一个对齐视口。
// 编辑框是普通多行文本框：第一行 = 标题（1~128 字，必填），其余行 = 详情；
// 另有分类 chip 单选（radiogroup/radio）与原生 date input 截止日期（不引日期库）。
// 不做富文本/所见即所得；保存动作与提示交给父组件（TasksPage 添加 / ItemDialog 编辑）。
// viewTransitionName：容器变换时让 Dialog paper 顶替来源元素的名字（来源元素同时让名）；
// 不传则 paper 不带共享名（ItemDialog 内部编辑场景不参与容器变换）。

import { useState } from 'react';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import CloseIcon from '@mui/icons-material/Close';
import ClearIcon from '@mui/icons-material/Clear';
import { CATEGORIES } from '../types';
import type { Category, ItemFields } from '../types';
import { dialogTransitionProps } from './DialogTransition';
import { mainAreaDialogSx } from '../lib/layout';

/** 标题上限（与后端 POST/PATCH 契约一致：去首尾空白后 1~128 字符） */
const MAX_TITLE_LENGTH = 128;

/**
 * 把编辑器文本拆成标题 + 详情：第一行为标题，其余行 join 保留中间换行；
 * 首尾空白 strip（title 可能为空串，由调用方校验）。
 */
export function parseEditorText(text: string): { title: string; summary: string } {
  const [first = '', ...rest] = text.split('\n');
  return { title: first.trim(), summary: rest.join('\n').trim() };
}

interface Props {
  /** 对话框标题：「添加任务」或「编辑任务」 */
  heading: string;
  /** 编辑时传入当前字段；新建不传 */
  initial?: ItemFields;
  submitting: boolean;
  onSubmit: (fields: ItemFields) => void;
  onClose: () => void;
  /** 容器变换共享名：传给 Dialog paper；缺省不设置（内部编辑场景） */
  viewTransitionName?: string;
}

export default function ItemEditor({
  heading,
  initial,
  submitting,
  onSubmit,
  onClose,
  viewTransitionName,
}: Props) {
  // 初始文本：编辑时标题与详情各自 trim 过，用单个换行拼回编辑器
  const [text, setText] = useState(
    initial ? [initial.title, initial.summary].filter(Boolean).join('\n') : '',
  );
  const [category, setCategory] = useState<Category>(initial?.category ?? '个人');
  const [date, setDate] = useState<string>(initial?.due_date ?? '');

  const theme = useTheme();
  // 移动端全屏、桌面端限宽对话框（与 ItemDialog 同款判断）
  const fullScreen = useMediaQuery(theme.breakpoints.down('md'));

  const { title, summary } = parseEditorText(text);
  const titleEmpty = title.length === 0;
  const titleTooLong = title.length > MAX_TITLE_LENGTH;
  const invalid = titleEmpty || titleTooLong;
  const helper = titleEmpty ? '第一行不能为空' : titleTooLong ? `标题最多 ${MAX_TITLE_LENGTH} 字` : '';

  const handleSubmit = () => {
    if (invalid || submitting) return;
    onSubmit({ title, summary, category, due_date: date || null });
  };

  return (
    <Dialog
      fullScreen={fullScreen}
      maxWidth="sm"
      fullWidth
      sx={mainAreaDialogSx}
      {...dialogTransitionProps()}
      slotProps={{
        // 不传 viewTransitionName 时不给 paper 设共享名（内部编辑不做容器变换）
        paper: { sx: viewTransitionName ? { viewTransitionName } : undefined },
      }}
      open
      onClose={onClose}
    >
      <AppBar position="static" elevation={0}>
        <Toolbar>
          <IconButton edge="start" color="inherit" onClick={onClose} aria-label="关闭">
            <CloseIcon />
          </IconButton>
          <Typography variant="h6" sx={{ ml: 1, flexGrow: 1 }} noWrap>
            {heading}
          </Typography>
          <Button color="inherit" aria-label="保存" onClick={handleSubmit} disabled={invalid || submitting}>
            保存
          </Button>
        </Toolbar>
      </AppBar>
      <Box sx={{ px: 2, py: 2, pb: 'calc(16px + env(safe-area-inset-bottom))' }}>
        <TextField
          label="第一行是标题，从第二行开始是详情"
          multiline
          minRows={6}
          autoFocus
          fullWidth
          value={text}
          onChange={(e) => setText(e.target.value)}
          error={invalid}
          helperText={helper}
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
              onClick={() => setCategory(c)}
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
            onChange={(e) => setDate(e.target.value)}
            InputLabelProps={{ shrink: true }}
          />
          {date !== '' && (
            <IconButton
              size="small"
              aria-label="清除日期"
              onClick={() => setDate('')}
              sx={{ flexShrink: 0 }}
            >
              <ClearIcon fontSize="small" />
            </IconButton>
          )}
        </Stack>
      </Box>
    </Dialog>
  );
}
