// AiAddDialog：AI 快速新建待办的全屏对话框（移动端全屏、桌面端限宽），由右下角
// 悬浮按钮打开。与 ItemEditor 的分工：ItemEditor 是「手填四个字段」，这里是
// 「说一段话让 AI 填」，两者共用 ItemFieldsForm 渲染字段区。
//
// 三个阶段（用 Collapse/Fade 过渡，时长与缓动取 MOTION token）：
//   input   → 只有一个多行输入框，自动聚焦让 iOS 键盘弹起
//   parsing → 骨架卡（非速记模式等待 LLM 的 1-3 秒）
//   fields  → 解析结果预览，值可改后保存
//
// 一段话可以说好几件事，所以 fields 阶段持有的是 drafts 数组：
//   只有一条 → 直接铺 ItemFieldsForm（与只能记一条的那版完全一致）
//   多于一条 → 交给 ParsedTaskList 列成可展开的行
//
// 速记模式（AppBar 右上角 Switch）打开时跳过 parsing/fields：点「提交」直接把原文
// 交给 onQuickSubmit，由调用方立刻关窗并在后台落库。
//
// 入退场：固定用 SlideUp，两个方向都由 MUI 自己跑。**不要**改回
// dialogTransitionProps()——那个会在支持 View Transitions 的浏览器上把 MUI 过渡设成
// 0ms 让位给 VT，而 VT 在 iOS Safari / PWA 上一旦被跳过就两头落空。对称由 open prop
// 保证：组件常驻挂载，Dialog 自己在退场跑完后卸载内容，退场后经 onExited 复位状态。
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
import { SlideUp } from './DialogTransition';
import { MAX_TITLE_LENGTH, parseEditorText } from './ItemEditor';
import ItemFieldsForm from './ItemFieldsForm';
import ParsedTaskList from './ParsedTaskList';
import { usePrefersReducedMotion } from '../lib/motion';
import { mainAreaDialogSx } from '../lib/layout';

/** fields 阶段里一条待办的可编辑草案。text 的第一行是标题，其余是详情 */
export interface Draft {
  text: string;
  category: Category;
  /** YYYY-MM-DD，空串表示无截止日 */
  date: string;
  importance: Importance;
  /**
   * 是否需要用户亲自动手。全前端没有任何可见表现，也没有编辑控件，只在保存时
   * 原样带进载荷——不带的话速记与非速记两种模式对同一句话会存出不同的字段。
   */
  actionable: boolean;
  /** 提醒时刻，带 UTC 偏移的 ISO 8601 串 */
  reminders: string[];
}

export interface AiAddDialogProps {
  /**
   * 是否打开。组件常驻挂载、由 Dialog 按这个值跑入退场——**不要**改回调用方
   * 条件渲染：那样关闭时整棵子树被直接卸载，退场过渡根本没机会跑。
   */
  open: boolean;
  /** 速记模式当前值。受控：状态与持久化（localStorage）都在 TasksPage */
  quickMode: boolean;
  /** 用户拨动速记开关 */
  onQuickModeChange: (next: boolean) => void;
  /**
   * 非速记模式的解析入口：一段话 → 结构化字段列表（一件事也是一元数组）。
   * 由调用方注入而非本组件直接调 api.ts，测试才能不打 fetch 就驱动三个阶段。
   * reject 时组件停在 input 阶段并给出错误提示与「按原文保存」兜底。
   */
  onParse: (text: string) => Promise<ParsedTask[]>;
  /** 阶段二「保存」：与 ItemEditor.onSubmit 同语义，走 POST /api/items，一次可多条 */
  onSubmit: (fieldsList: ItemFields[]) => void;
  /**
   * 速记模式「提交」：只把原文交出去。关窗与后台落库（POST /api/items/quick）
   * 都由调用方负责——窗口要立刻关，落库不能绑在本组件的生命周期上。
   */
  onQuickSubmit: (text: string) => void;
  /** 阶段二保存中：禁用保存按钮 */
  submitting: boolean;
  onClose: () => void;
}

/** 三阶段：input → parsing（仅非速记）→ fields；解析失败回 input */
type Phase = 'input' | 'parsing' | 'fields';

/** 解析结果 → 可编辑草案。标题/详情按单个换行拼回，与 ItemEditor 处理 initial 一致 */
function toDraft(parsed: ParsedTask): Draft {
  return {
    text: [parsed.title, parsed.summary].filter(Boolean).join('\n'),
    category: parsed.category,
    date: parsed.due_date ?? '',
    importance: parsed.importance,
    actionable: parsed.actionable,
    reminders: parsed.reminders,
  };
}

/** 草案 → 保存载荷。reminders 只在非空时带键：创建场景下「没提醒」与「省略 reminders」
 *  对后端等价，载荷形状要与解析结果为空时完全一致。 */
function toFields(draft: Draft): ItemFields {
  const { title, summary } = parseEditorText(draft.text);
  const fields: ItemFields = {
    title,
    summary,
    category: draft.category,
    due_date: draft.date || null,
    importance: draft.importance,
    actionable: draft.actionable,
  };
  if (draft.reminders.length > 0) {
    fields.reminders = draft.reminders;
  }
  return fields;
}

/** 单条草案的校验提示；空串表示这条合法。口径与 ItemEditor 完全一致 */
function draftHelper(draft: Draft): string {
  const { title } = parseEditorText(draft.text);
  if (title.length === 0) return '第一行不能为空';
  if (title.length > MAX_TITLE_LENGTH) return `标题最多 ${MAX_TITLE_LENGTH} 字`;
  return '';
}

export default function AiAddDialog({
  open,
  quickMode,
  onQuickModeChange,
  onParse,
  onSubmit,
  onQuickSubmit,
  submitting,
  onClose,
}: AiAddDialogProps) {
  const theme = useTheme();
  // 移动端全屏、桌面端限宽对话框（与 ItemEditor 同款判断）
  const fullScreen = useMediaQuery(theme.breakpoints.down('md'));
  const reduced = usePrefersReducedMotion();

  const [phase, setPhase] = useState<Phase>('input');
  // input 阶段的原文。解析失败时保留不清空，绝不让用户白打一遍
  const [text, setText] = useState('');
  // fields 阶段的草案列表；input/parsing 阶段为空
  const [drafts, setDrafts] = useState<Draft[]>([]);
  // 多条时当前展开的那一条；单条不走 ParsedTaskList，与它无关
  const [expanded, setExpanded] = useState<number | null>(null);
  const [parseError, setParseError] = useState(false);
  // 阶段 input 的输入框：iOS Safari 上 Dialog 内 autoFocus 不可靠，改在过渡
  // 结束后手动 focus() 让键盘弹起
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  const inFields = phase === 'fields';
  const mainLabel = inFields ? '保存' : '解析';
  const anyInvalid = drafts.some((d) => draftHelper(d) !== '');
  const mainDisabled = inFields
    ? anyInvalid || submitting
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
      // 空结果与解析失败同义：进 fields 只会得到一屏空列表和一个点了没反应的「保存」
      // （anyInvalid 对空数组为 false，按钮不灰，handleSave 又直接 return）。
      // 扔回同一个 catch，走已有的兜底路径——留在 input、原文不清、给「按原文保存」。
      if (parsed.length === 0) throw new Error('空解析结果');
      setDrafts(parsed.map(toDraft));
      // 只有一条时 ParsedTaskList 不出场，expanded 无意义；多条默认全部收起
      setExpanded(null);
      setPhase('fields');
    } catch {
      // 解析失败回 input 并保留用户原文：绝不让用户白打一遍
      setPhase('input');
      setParseError(true);
    }
  };

  const handleSave = () => {
    if (anyInvalid || submitting || drafts.length === 0) return;
    onSubmit(drafts.map(toFields));
  };

  const handleMainClick = () => {
    if (inFields) {
      handleSave();
    } else {
      void handleConfirm();
    }
  };

  const handleInputKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Cmd/Ctrl + Enter = 点主按钮；裸 Enter 保持默认换行
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

  /** 退场跑完才复位：组件常驻挂载，不复位的话下次打开会看到上一次的内容。
   *  放在 onExited 而不是 onClose，是为了让用户在退场那 250ms 里看到的还是原内容，
   *  而不是文字先被抽空、空壳往下滑。 */
  const handleDialogExited = () => {
    setPhase('input');
    setText('');
    setDrafts([]);
    setExpanded(null);
    setParseError(false);
  };

  const updateDraft = (index: number, next: Draft) => {
    setDrafts((prev) => prev.map((d, i) => (i === index ? next : d)));
  };

  const removeDraft = (index: number) => {
    setDrafts((prev) => prev.filter((_, i) => i !== index));
    // 删掉的若在展开项之前，展开项要跟着往前挪一位，否则展开的会串到别条上
    setExpanded((prev) => {
      if (prev === null) return null;
      if (prev === index) return null;
      return prev > index ? prev - 1 : prev;
    });
  };

  const handleAddAsIs = () => {
    // 与其余路径同一口径：第一行是标题、其余是详情。标题超长的部分溢出到详情而不是
    // 丢掉——解析已经失败一次，不能再把用户打的内容吃掉。正常长度下 overflow 是空串，
    // 这条与直接用 parseEditorText 完全等价，不是特判。
    // importance / actionable 仍不带：解析失败时没有 AI 判断可透传。
    const { title, summary } = parseEditorText(text);
    const overflow = title.slice(MAX_TITLE_LENGTH).trim();
    onSubmit([
      {
        title: title.slice(0, MAX_TITLE_LENGTH),
        summary: [overflow, summary].filter(Boolean).join('\n'),
        category: '其他',
        due_date: null,
      },
    ]);
  };

  const single = drafts.length === 1 ? drafts[0] : null;

  return (
    <Dialog
      fullScreen={fullScreen}
      maxWidth="sm"
      fullWidth
      sx={mainAreaDialogSx}
      TransitionComponent={SlideUp}
      // 入退场时长刻意不等（MD2 惯例：出场比入场快一档），但两个方向都真的跑。
      // reduced 下整段取消，状态瞬时切换。
      transitionDuration={reduced ? 0 : { enter: MOTION.large, exit: MOTION.largeExit }}
      TransitionProps={{
        onEntered: handleDialogEntered,
        onExited: handleDialogExited,
      }}
      open={open}
      onClose={onClose}
    >
      <AppBar position="static" elevation={0}>
        <Toolbar>
          <IconButton edge="start" color="inherit" onClick={onClose} aria-label="关闭">
            <CloseIcon />
          </IconButton>
          <Typography variant="h6" sx={{ ml: 1, flexGrow: 1 }} noWrap>
            新建待办
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
      {/* 阶段内容区：入场用 Collapse+Fade，时长与缓动取 MOTION token。
          切阶段按 key 重挂载（旧阶段是被销毁而不是 in=false），所以这里只配
          enter 档——配 exit 是死配置，永远不会生效，留着只会误导。 */}
      <Collapse key={phase} in timeout={MOTION.enter} easing={MOTION.easeStandard}>
        <Fade in timeout={MOTION.enter} easing={MOTION.easeStandard}>
          {/* Fade 需要把 ref 挂到真实 DOM 元素：外包一层 Box，避免阶段内容是
              ItemFieldsForm 这类不透传 ref 的组件时 nodeRef 悬空 */}
          <Box>
            {phase === 'input' ? (
              <Box sx={{ px: 2, py: 2, pb: 'calc(16px + env(safe-area-inset-bottom))' }}>
                <TextField
                  label="待办内容"
                  placeholder="例如「明天 15:00 提醒我买奶茶，18:00 接斯卡蒂」"
                  multiline
                  minRows={4}
                  fullWidth
                  value={text}
                  onChange={(e) => handleTextChange(e.target.value)}
                  onKeyDown={handleInputKeyDown}
                  inputRef={inputRef}
                  inputProps={{ 'aria-label': '待办内容' }}
                />
                <Typography variant="caption" color="text.secondary">
                  {quickMode ? '速记模式已开启，提交后直接保存' : '提交后可先确认识别结果再保存'}
                </Typography>
                {parseError && (
                  <Alert
                    severity="warning"
                    sx={{ mt: 1.5 }}
                    action={
                      <Button size="small" color="inherit" onClick={handleAddAsIs}>
                        按原文保存
                      </Button>
                    }
                  >
                    未能识别内容，可重试或按原文保存
                  </Alert>
                )}
              </Box>
            ) : phase === 'parsing' ? (
              <Box
                aria-busy
                aria-label="正在识别"
                sx={{ px: 2, py: 2, pb: 'calc(16px + env(safe-area-inset-bottom))' }}
              >
                <Stack spacing={2}>
                  <Skeleton variant="text" width="60%" height={32} />
                  <Skeleton variant="text" width="85%" />
                  <Skeleton variant="rounded" height={32} />
                </Stack>
              </Box>
            ) : single ? (
              <ItemFieldsForm
                text={single.text}
                onTextChange={(next) => updateDraft(0, { ...single, text: next })}
                category={single.category}
                onCategoryChange={(next) => updateDraft(0, { ...single, category: next })}
                importance={single.importance}
                onImportanceChange={(next) => updateDraft(0, { ...single, importance: next })}
                date={single.date}
                onDateChange={(next) => updateDraft(0, { ...single, date: next })}
                invalid={draftHelper(single) !== ''}
                helper={draftHelper(single)}
                reminders={single.reminders}
                onRemindersChange={(next) => updateDraft(0, { ...single, reminders: next })}
              />
            ) : (
              <Box sx={{ pb: 'calc(16px + env(safe-area-inset-bottom))' }}>
                <Typography variant="caption" color="text.secondary" sx={{ px: 2, py: 1, display: 'block' }}>
                  识别出 {drafts.length} 条，点开可修改
                </Typography>
                <ParsedTaskList
                  drafts={drafts}
                  onChange={updateDraft}
                  onRemove={removeDraft}
                  expanded={expanded}
                  onExpandedChange={setExpanded}
                  invalidAt={(i) => draftHelper(drafts[i]) !== ''}
                  helperAt={(i) => draftHelper(drafts[i])}
                />
              </Box>
            )}
          </Box>
        </Fade>
      </Collapse>
    </Dialog>
  );
}
