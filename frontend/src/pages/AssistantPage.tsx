// 「AI 助理」页：多轮聊天（历史只在前端内存，见 lib/chat），回答经 SafeMarkdown 渲染，
// 下面跟本轮写操作的回执卡与引用邮件列表。页面级 AppBar 由 AppShell 统一渲染；
// 本页只保留「原邮件」Dialog 内部的 AppBar。
// 回执行 / 引用行与各自长出来的 Dialog paper 共用 VT_NAMES.sheet 做容器变换，
// 来源 key 带 turn.id（同一待办/邮件可能出现在多轮里，只用 id 会撞名）。

import { useEffect, useRef, useState } from 'react';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import IconButton from '@mui/material/IconButton';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import ChatComposer from '../components/assistant/ChatComposer';
import ChatMessage from '../components/assistant/ChatMessage';
import EmailViewer from '../components/EmailViewer';
import ItemDialog from '../components/ItemDialog';
import { dialogTransitionProps } from '../components/DialogTransition';
import { fetchItem } from '../lib/api';
import { setDraft, useChatPending, useChatTurns } from '../lib/chat';
import { PANEL_SX, columnDialogSx } from '../lib/layout';
import { removeItem, replaceItem, upsertOpenItem } from '../lib/list-cache';
import { useMorphDialog, usePrefersReducedMotion } from '../lib/motion';
import { VT_NAMES } from '../lib/view-transition';
import type { Item } from '../types';

/** 空态建议：点了只填进输入框，不自动发送——第三条发出去会真的建一条提醒 */
const SUGGESTIONS = [
  '这周有哪些快到期的待办？',
  '最近有什么账单邮件？',
  '提醒我明天上午 10 点交电费',
] as const;

export default function AssistantPage() {
  const turns = useChatTurns();
  const pending = useChatPending();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 正在打开的回执来源 key：非空期间其余回执禁用，避免两个容器变换同时起跑
  const [openingKey, setOpeningKey] = useState<string | null>(null);
  // 关闭只改 open、保留 text：Snackbar 退场动画期间文字不会先被抽空
  const [notice, setNotice] = useState({ open: false, text: '' });

  // 回执 / 原邮件两个容器变换各自持一份状态；key 是对话内的来源 key
  const receipt = useMorphDialog<{ key: string; item: Item }>((o) => o.key);
  const email = useMorphDialog<{ key: string; emailId: number }>((o) => o.key);

  const theme = useTheme();
  // 移动端全屏、桌面端限宽对话框
  const fullScreen = useMediaQuery(theme.breakpoints.down('md'));
  const reduced = usePrefersReducedMotion();
  // 首次滚动（含挂载时带着历史回来）不走平滑动画，直接落到底
  const firstScroll = useRef(true);

  useEffect(() => {
    if (turns.length === 0 && !pending) return;
    const behavior = firstScroll.current || reduced ? 'auto' : 'smooth';
    firstScroll.current = false;
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
  }, [turns.length, pending, reduced]);

  /** 打开回执对应的待办：先取最新数据——回执里那份快照可能已经过时 */
  const openReceipt = async (key: string, itemId: number) => {
    if (openingKey !== null) return;
    setOpeningKey(key);
    try {
      const item = await fetchItem(itemId);
      receipt.open({ key, item });
    } catch {
      setNotice({ open: true, text: '这条待办暂时打不开，可能已被删除。' });
    } finally {
      setOpeningKey(null);
    }
  };

  return (
    <Box>
      <Box sx={{ px: 2, py: 2 }}>
        {turns.length === 0 && (
          <Box data-glass="panel" sx={[PANEL_SX, { mb: 2 }]}>
            <Typography variant="body1">
              可以问我邮件里的事，也可以让我新建、完成或修改待办。
            </Typography>
            <Stack direction="row" flexWrap="wrap" gap={1} sx={{ mt: 1.5 }}>
              {SUGGESTIONS.map((suggestion) => (
                <Chip
                  key={suggestion}
                  label={suggestion}
                  variant="outlined"
                  clickable
                  onClick={() => {
                    setDraft(suggestion);
                    inputRef.current?.focus();
                  }}
                />
              ))}
            </Stack>
          </Box>
        )}
        <Box
          role="log"
          aria-label="对话记录"
          aria-live="polite"
          sx={{ display: 'flex', flexDirection: 'column', gap: 2, mb: 2 }}
        >
          {turns.map((turn) => (
            <ChatMessage
              key={turn.id}
              turn={turn}
              openingKey={openingKey}
              receiptSourceName={receipt.sourceName}
              citationSourceName={email.sourceName}
              onOpenReceipt={(key, itemId) => void openReceipt(key, itemId)}
              onOpenCitation={(key, emailId) => email.open({ key, emailId })}
            />
          ))}
        </Box>
        {/* 输入台跟在消息流后面：对话短时它就在内容下方，长了自然吸底 */}
        <ChatComposer inputRef={inputRef} />
      </Box>
      {/* ItemDialog 自带 Dialog、过渡与持名；条目状态决定它归哪个列表口径 */}
      {receipt.current && (
        <ItemDialog
          item={receipt.current.item}
          onClose={receipt.close}
          onChanged={(item) => {
            if (item.status === 'open') upsertOpenItem(item);
            else replaceItem(item);
          }}
          onDeleted={(id) => removeItem(id)}
        />
      )}
      {/* 条件渲染而非常驻 + open 切换：View Transition 需要新态里对话框已在 DOM，
          容器变换才拍得到 paper 的目标位置 */}
      {email.current && (
        <Dialog
          fullScreen={fullScreen}
          maxWidth="md"
          fullWidth
          sx={columnDialogSx}
          {...dialogTransitionProps()}
          slotProps={{
            paper: { sx: { viewTransitionName: VT_NAMES.sheet } },
          }}
          open
          onClose={email.close}
        >
          <AppBar position="static" elevation={0}>
            <Toolbar>
              <IconButton edge="start" color="inherit" onClick={email.close} aria-label="关闭">
                <CloseIcon />
              </IconButton>
              <Typography variant="h6" sx={{ ml: 1 }} noWrap>
                原邮件
              </Typography>
            </Toolbar>
          </AppBar>
          <Box sx={{ px: 2, py: 2 }}>
            <EmailViewer emailId={email.current.emailId} />
          </Box>
        </Dialog>
      )}
      <Snackbar
        open={notice.open}
        autoHideDuration={3000}
        onClose={() => setNotice((n) => ({ ...n, open: false }))}
        message={notice.text}
      />
    </Box>
  );
}
