// AI 搜索页：多行问题输入 → agentic 全库检索（180s 超时）→ Markdown 回答 + 引用邮件列表。
// 会话内保留上一次问答结果（模块级缓存，页面刷新前不丢）。
// 页面级 AppBar 由 AppShell 统一渲染；本页只保留「原邮件」Dialog 内部的 AppBar。
// 引用列表项与「原邮件」Dialog paper 共用 VT_NAMES.sheet 做容器变换（点哪条引用哪条长成原邮件）。

import { useState } from 'react';
import Alert from '@mui/material/Alert';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import LinearProgress from '@mui/material/LinearProgress';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import SearchIcon from '@mui/icons-material/Search';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import { search } from '../lib/api';
import type { SearchCitation, SearchResponse } from '../types';
import EmailViewer from '../components/EmailViewer';
import SafeMarkdown from '../components/SafeMarkdown';
import { useMorphDialog } from '../lib/motion';
import { VT_NAMES } from '../lib/view-transition';
import { dialogTransitionProps } from '../components/DialogTransition';

// 模块级缓存：路由切换不丢，浏览器刷新才丢
let lastResultCache: SearchResponse | null = null;

export default function SearchPage() {
  const [question, setQuestion] = useState('');
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SearchResponse | null>(lastResultCache);
  // 原邮件容器变换：current 非空即对话框打开；对话框需条件渲染，VT 要求新态里已在 DOM
  const { current, open, close, sourceName } = useMorphDialog<SearchCitation>((c) => c.email_id);

  const theme = useTheme();
  // 移动端全屏、桌面端限宽对话框
  const fullScreen = useMediaQuery(theme.breakpoints.down('md'));

  const submit = async () => {
    const q = question.trim();
    if (!q || searching) return;
    setSearching(true);
    setError(null);
    try {
      const r = await search(q);
      lastResultCache = r;
      setResult(r);
    } catch {
      setError('搜索失败，请稍后重试');
    } finally {
      setSearching(false);
    }
  };

  return (
    <Box>
      <Box sx={{ px: 2, py: 2 }}>
        <TextField
          fullWidth
          multiline
          minRows={3}
          maxRows={6}
          placeholder="问你的邮件库：例如「下周三之前有哪些截止日期？」"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <Button
          fullWidth
          variant="contained"
          startIcon={<SearchIcon />}
          disabled={searching || question.trim() === ''}
          onClick={submit}
          sx={{ mt: 1.5 }}
        >
          搜索
        </Button>
        {searching && <LinearProgress sx={{ mt: 1.5 }} />}
        {error && (
          <Alert severity="error" sx={{ mt: 1.5 }}>
            {error}
          </Alert>
        )}
        {result && (
          <Box sx={{ mt: 2 }}>
            <Box sx={{ typography: 'body1' }}>
              <SafeMarkdown>{result.answer_md}</SafeMarkdown>
            </Box>
            {result.citations.length > 0 && (
              <>
                <Divider sx={{ my: 2 }} />
                <Typography variant="subtitle2" gutterBottom>
                  引用邮件（{result.citations.length}）
                </Typography>
                <List disablePadding>
                  {result.citations.map((c) => (
                    <ListItemButton
                      key={c.email_id}
                      divider
                      onClick={() => open(c)}
                      sx={{ viewTransitionName: sourceName(c.email_id) }}
                    >
                      <ListItemText
                        primary={c.subject}
                        secondary={c.sent_at ?? '时间未知'}
                        secondaryTypographyProps={{ noWrap: true }}
                      />
                    </ListItemButton>
                  ))}
                </List>
              </>
            )}
          </Box>
        )}
      </Box>
      {/* 条件渲染而非常驻 + open 切换：View Transition 需要新态里对话框已在 DOM，
          容器变换才拍得到 paper 的目标位置 */}
      {current && (
        <Dialog
          fullScreen={fullScreen}
          maxWidth="md"
          fullWidth
          {...dialogTransitionProps()}
          slotProps={{
            paper: { sx: { viewTransitionName: VT_NAMES.sheet } },
          }}
          open
          onClose={close}
        >
          <AppBar position="static" elevation={0}>
            <Toolbar>
              <IconButton edge="start" color="inherit" onClick={close} aria-label="关闭">
                <CloseIcon />
              </IconButton>
              <Typography variant="h6" sx={{ ml: 1 }} noWrap>
                原邮件
              </Typography>
            </Toolbar>
          </AppBar>
          <Box sx={{ px: 2, py: 2 }}>
            <EmailViewer emailId={current.email_id} />
          </Box>
        </Dialog>
      )}
    </Box>
  );
}
