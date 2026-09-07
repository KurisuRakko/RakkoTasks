// ItemEditor：新建/编辑手动条目的编辑器对话框（移动端全屏、桌面端限宽）。
// md 起居中于主内容区（mainAreaDialogSx）：编辑器从悬浮按钮长出而非列表行，宽度保持
// sm、不与内容列对齐，只做居中这一半，避免同屏两个对话框一个对齐列、一个对齐视口。
// 编辑框是普通多行文本框：第一行 = 标题（1~128 字，必填），其余行 = 详情；
// 另有分类 chip 单选与重要度 chip 单选（radiogroup/radio）及原生 date input 截止日期
// （不引日期库）。重要度三档（重要/普通/次要）与列表页/分组口径一致。
// 不做富文本/所见即所得；保存动作与提示交给父组件（TasksPage 添加 / ItemDialog 编辑）。
// viewTransitionName：容器变换时让 Dialog paper 顶替来源元素的名字（来源元素同时让名）；
// 不传则 paper 不带共享名（ItemDialog 内部编辑场景不参与容器变换）。

import { useState } from 'react';
import AppBar from '@mui/material/AppBar';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import IconButton from '@mui/material/IconButton';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import CloseIcon from '@mui/icons-material/Close';
import type { Category, Importance, ItemFields } from '../types';
import { dialogTransitionProps } from './DialogTransition';
import ItemFieldsForm from './ItemFieldsForm';
import { mainAreaDialogSx } from '../lib/layout';

/** 标题上限（与后端 POST/PATCH 契约一致：去首尾空白后 1~128 字符） */
export const MAX_TITLE_LENGTH = 128;

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
  const [importance, setImportance] = useState<Importance>(
    initial?.importance ?? 'normal',
  );
  const [date, setDate] = useState<string>(initial?.due_date ?? '');
  // 提醒时刻（带 UTC 偏移的绝对时刻串）：初值只在挂载时取自 initial.reminders，
  // 此后由 ItemFieldsForm 提醒编辑区的外发回调更新（它的草案行 state 同样只在
  // 挂载时初始化，见 ItemFieldsForm 文件头说明——两处都不随 props 重置）。
  const [reminders, setReminders] = useState<string[]>(initial?.reminders ?? []);

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
    onSubmit({
      title,
      summary,
      category,
      due_date: date || null,
      // reminders 语义（DESIGN.md 第 6 节）：省略 = 不改、传 [] = 清空。这里是
      // 「用户看着完整表单按下保存」，总是显式带当前数组（哪怕空）——省略会让
      // 「把最后一个提醒删掉再保存」变成静默无操作（后端以为你不想动提醒）。
      reminders,
      // importance 同理：省略 = 不改。这里是「用户看着完整表单按下保存」，总是
      // 显式带当前档位（哪怕没动过）——控件显示哪一档就保存哪一档，界面所见即
      // 提交载荷；POST 新建时后端对缺省落 normal，PATCH 时省略 = 保持旧值，两种
      // 路径语义不同，不做「没改就省略」就不必把这种差异留给调用方去赌。
      importance,
    });
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
      {/* 字段区：与 AiAddDialog 共用的受控表单（DOM/文案由 ItemFieldsForm 一处定义）。
          传了 reminders/onRemindersChange，提醒编辑区才会渲染（见 ItemFieldsForm 门槛） */}
      <ItemFieldsForm
        text={text}
        onTextChange={setText}
        category={category}
        onCategoryChange={setCategory}
        importance={importance}
        onImportanceChange={setImportance}
        date={date}
        onDateChange={setDate}
        reminders={reminders}
        onRemindersChange={setReminders}
        invalid={invalid}
        helper={helper}
        autoFocus
      />
    </Dialog>
  );
}
