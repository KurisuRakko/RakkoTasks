// AiAddDialog：AI 快速添加任务的全屏对话框（移动端全屏、桌面端限宽），由右下角
// 悬浮按钮经 expand-fab 容器变换长出。与 ItemEditor 的分工：ItemEditor 是「手填
// 四个字段」，这里是「说一句话让 AI 填」，两者共用 ItemFieldsForm 渲染字段区。
//
// 三个阶段（用 Collapse/Fade 过渡，不新增 VtKind——那会连带改 motion-styles 的
// 转场契约与其断言；FAB 长出对话框那段容器变换沿用现成的 expand-fab）：
//   input   → 只有一个多行输入框，自动聚焦让 iOS 键盘弹起
//   parsing → 骨架卡（非速记模式等待 LLM 的 1-3 秒）
//   fields  → ItemFieldsForm，值由解析结果预填，用户可改后保存
//
// 速记模式（AppBar 右上角 Switch）打开时跳过 parsing/fields：点「确定」直接把原文
// 交给 onQuickSubmit，由调用方立刻关窗并在后台落库。
//
import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import Alert from '@mui/material/Alert';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Collapse from '@mui/material/Collapse';
import Dialog from '@mui/material/Dialog';
import Fade from '@mui/material/Fade';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import CloseIcon from '@mui/icons-material/Close';
import { MOTION } from '../rakko-tokens';
import type { Category, Importance, ItemFields, ParsedTask } from '../types';
import { dialogTransitionProps } from './DialogTransition';
import { MAX_TITLE_LENGTH, parseEditorText } from './ItemEditor';
import ItemFieldsForm from './ItemFieldsForm';
import { mainAreaDialogSx } from '../lib/layout';

export interface AiAddDialogProps {
  /** 速记模式当前值。受控：状态与持久化（localStorage）都在 TasksPage */
  quickMode: boolean;
  /** 用户拨动速记开关 */
  onQuickModeChange: (next: boolean) => void;
  /**
   * 非速记模式的解析入口：一句话 → 结构化字段。由调用方注入而非本组件直接调
   * api.ts，测试才能不打 fetch 就驱动三个阶段。
   * reject 时组件停在 input 阶段并给出错误提示与「按原文添加」兜底。
   */
  onParse: (text: string) => Promise<ParsedTask>;
  /** 阶段二「保存」：与 ItemEditor.onSubmit 同语义，走 POST /api/items */
  onSubmit: (fields: ItemFields) => void;
  /**
   * 速记模式「确定」：只把原文交出去。关窗与后台落库（POST /api/items/quick）
   * 都由调用方负责——窗口要立刻关，落库不能绑在本组件的生命周期上。
   */
  onQuickSubmit: (text: string) => void;
  /** 阶段二保存中：禁用保存按钮 */
  submitting: boolean;
  onClose: () => void;
  /** 容器变换共享名：传给 Dialog paper；缺省则 paper 不持名 */
  viewTransitionName?: string;
}

/** 三阶段：input → parsing（仅非速记）→ fields；解析失败回 input */
type Phase = 'input' | 'parsing' | 'fields';

export default function AiAddDialog({
  quickMode,
  onQuickModeChange,
  onParse,
  onSubmit,
  onQuickSubmit,
  submitting,
  onClose,
  viewTransitionName,
}: AiAddDialogProps) {
  const theme = useTheme();
  // 移动端全屏、桌面端限宽对话框（与 ItemEditor 同款判断）
  const fullScreen = useMediaQuery(theme.breakpoints.down('md'));

  const [phase, setPhase] = useState<Phase>('input');
  // 原文（input）与预填文本（fields）共用一个 state；解析失败时保留原文不清空
  const [text, setText] = useState('');
  const [category, setCategory] = useState<Category>('个人');
  const [date, setDate] = useState('');
  // AI 解析出的重要度/是否亲自动手：预览界面不给编辑控件，只在保存时原样带进载荷
  const [importance, setImportance] = useState<Importance>('normal');
  const [actionable, setActionable] = useState(true);
  // 提醒时刻（带 UTC 偏移的绝对时刻串）：fields 阶段交给 ItemFieldsForm 编辑，
  // 保存时原样带进载荷。初值来自解析结果，之后由编辑区的出参更新。
  const [reminders, setReminders] = useState<string[]>([]);
  const [parseError, setParseError] = useState(false);
  // 阶段 input 的输入框：iOS Safari 上 Dialog 内 autoFocus 不可靠，改在过渡
  // 结束后手动 focus() 让键盘弹起
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  // 校验口径与 ItemEditor 完全一致：同一份 parseEditorText + MAX_TITLE_LENGTH
  const { title, summary } = parseEditorText(text);
  const titleEmpty = title.length === 0;
  const titleTooLong = title.length > MAX_TITLE_LENGTH;
  const invalid = titleEmpty || titleTooLong;
  const helper = titleEmpty ? '第一行不能为空' : titleTooLong ? `标题最多 ${MAX_TITLE_LENGTH} 字` : '';
  const inFields = phase === 'fields';
  const mainLabel = inFields ? '保存' : '确定';
  const mainDisabled = inFields
    ? invalid || submitting
    : phase === 'parsing' || text.trim().length === 0;

  const handleConfirm = async () => {
    const raw = text.trim();
    if (raw.length === 0 || phase !== 'input') return;
    if (quickMode) {
      // 速记：只把原文交出去，关窗与后台落库由调用方负责
      onQuickSubmit(raw);
      return;
    }
    setParseError(false);
    setPhase('parsing');
    try {
      const parsed = await onParse(raw);
      // 预填 fields 阶段：与 ItemEditor 处理 initial 的方式一致（标题/详情单个换行拼回）
      setText([parsed.title, parsed.summary].filter(Boolean).join('\n'));
      setCategory(parsed.category);
      setDate(parsed.due_date ?? '');
      setImportance(parsed.importance);
      setActionable(parsed.actionable);
      setReminders(parsed.reminders);
      setPhase('fields');
    } catch {
      // 解析失败回 input 并保留用户原文：绝不让用户白打一遍
      setPhase('input');
      setParseError(true);
    }
  };

  const handleSave = () => {
    if (invalid || submitting) return;
    const fields: ItemFields = {
      title,
      summary,
      category,
      due_date: date || null,
      importance,
      actionable,
    };
    // 提醒只在非空时带：创建场景下「没提醒」与「省略 reminders」对后端等价，
    // 载荷形状保持与解析结果为空时完全一致（配对测试按无 reminders 键断言）。
    if (reminders.length > 0) {
      fields.reminders = reminders;
    }
    onSubmit(fields);
  };

  const handleMainClick = () => {
    if (inFields) {
      handleSave();
    } else {
      void handleConfirm();
    }
  };

  const handleInputKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Cmd/Ctrl + Enter = 点「确定」；裸 Enter 保持默认换行
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleConfirm();
    }
  };

  const handleTextChange = (next: string) => {
    setText(next);
    // 用户开始重打/修改即撤掉上次失败的提示
    if (parseError) setParseError(false);
  };

  const handleDialogEntered = () => {
    // iOS Safari 的 Dialog 里 autoFocus 不可靠：过渡结束、键盘可弹起时手动聚焦
    if (phase === 'input') {
      inputRef.current?.focus();
    }
  };

  const handleAddAsIs = () => {
    onSubmit({
      title: text.trim().slice(0, MAX_TITLE_LENGTH),
      summary: '',
      category: '其他',
      due_date: null,
    });
  };

  return (
    <Dialog
      fullScreen={fullScreen}
      maxWidth="sm"
      fullWidth
      sx={mainAreaDialogSx}
      {...dialogTransitionProps()}
      TransitionProps={{
        // 合并而非覆盖：dialogTransitionProps 的字段（TransitionComponent /
        // transitionDuration）经展开进 Dialog，这里只补 onEntered
        onEntered: handleDialogEntered,
      }}
      slotProps={{
        // 不传 viewTransitionName 时不给 paper 设共享名
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
            添加任务
          </Typography>
          {!inFields && (
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={quickMode}
                  onChange={(e) => onQuickModeChange(e.target.checked)}
                  disabled={phase === 'parsing'}
                  // MUI v6 的 Switch 渲染成原生 checkbox（role 不加则取 checkbox），
                  // 语义是开关：显式钉 role/aria-checked，供 AT 与测试按 switch 查询
                  inputProps={{ 'aria-label': '速记模式', role: 'switch', 'aria-checked': quickMode }}
                />
              }
              label="速记"
              slotProps={{ typography: { variant: 'caption' } }}
              sx={{ mr: 1 }}
            />
          )}
          <Button
            color="inherit"
            aria-label={mainLabel}
            onClick={handleMainClick}
            disabled={mainDisabled}
          >
            {mainLabel}
          </Button>
        </Toolbar>
      </AppBar>
      {/* 阶段内容区：Collapse/Fade 包住，时长与缓动取 MOTION token；切阶段按 key 重挂载 */}
      <Collapse
        key={phase}
        in
        timeout={{ enter: MOTION.enter, exit: MOTION.exit }}
        easing={{ enter: MOTION.easeStandard, exit: MOTION.easeStandard }}
      >
        <Fade
          in
          timeout={{ enter: MOTION.enter, exit: MOTION.exit }}
          easing={{ enter: MOTION.easeStandard, exit: MOTION.easeStandard }}
        >
          {/* Fade 需要把 ref 挂到真实 DOM 元素：外包一层 Box，避免阶段内容是
              ItemFieldsForm 这类不透传 ref 的组件时 nodeRef 悬空 */}
          <Box>
            {phase === 'input' ? (
              <Box sx={{ px: 2, py: 2, pb: 'calc(16px + env(safe-area-inset-bottom))' }}>
                <TextField
                  label="说一件事"
                  multiline
                  minRows={4}
                  fullWidth
                  value={text}
                  onChange={(e) => handleTextChange(e.target.value)}
                  onKeyDown={handleInputKeyDown}
                  inputRef={inputRef}
                  inputProps={{ 'aria-label': '要记的事' }}
                />
                <Typography variant="caption" color="text.secondary">
                  {quickMode ? '速记模式：确定后自动添加，不再确认' : '确定后先给你看一眼解析结果'}
                </Typography>
                {parseError && (
                  <Alert
                    severity="warning"
                    sx={{ mt: 1.5 }}
                    action={
                      <Button size="small" color="inherit" onClick={handleAddAsIs}>
                        按原文添加
                      </Button>
                    }
                  >
                    AI 解析失败，你可以重试，或按原文直接添加。
                  </Alert>
                )}
              </Box>
            ) : phase === 'parsing' ? (
              <Box
                aria-busy
                aria-label="正在解析"
                sx={{ px: 2, py: 2, pb: 'calc(16px + env(safe-area-inset-bottom))' }}
              >
                <Stack spacing={2}>
                  <Skeleton variant="text" width="60%" height={32} />
                  <Skeleton variant="text" width="85%" />
                  <Skeleton variant="rounded" height={32} />
                </Stack>
              </Box>
            ) : (
              <ItemFieldsForm
                text={text}
                onTextChange={setText}
                category={category}
                onCategoryChange={setCategory}
                date={date}
                onDateChange={setDate}
                invalid={invalid}
                helper={helper}
                reminders={reminders}
                onRemindersChange={setReminders}
              />
            )}
          </Box>
        </Fade>
      </Collapse>
    </Dialog>
  );
}
