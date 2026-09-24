// 助理页的输入台：一整块 panel 玻璃，输入框、发送按钮、进度条、错误告警都坐在上面。
// 定位取「Portal + position: fixed」而不是 sticky：sticky 在滚到它的流内位置之前不吸底，
// 对话短时输入台悬在消息下面、离视口底还差一截。走 Portal 挂到 body 下是因为 fixed 的
// 参照系是最近的建立包含块的祖先——祖先一旦带上 transform 或 filter 这类属性（路由转场
// 会给页面容器下发），fixed 就退化成相对那个祖先定位，输入台跟着内容跑。
// fixed 元素不占流：面板高度经 onHeightChange 交给页面，由页面在消息流末尾留出等高占位块，
// 否则最后一条消息会被压在玻璃下面。定位层横跨整屏（左右各到视口边）却不吃事件——
// pointerEvents 默认值会把那条带子上的点击全拦下，none 让内容照常可点，内层再收回来。
// 玻璃不嵌套是既有不变量，所以玻璃挂在内层容器上而不是 TextField 的 FormControl 根：
// 输入框只是玻璃上的一个控件。宿主只补配方不管的圆角（RADIUS.card）与内边距，
// 不写 background / boxShadow —— 一写就盖掉 rakko-glass.css 的 panel 配方。

import { useEffect, useRef } from 'react';
import type { KeyboardEvent, Ref } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import Portal from '@mui/material/Portal';
import TextField from '@mui/material/TextField';
import SendIcon from '@mui/icons-material/Send';
import {
  INPUT_MAX,
  sendMessage,
  setDraft,
  useChatDraft,
  useChatError,
  useChatPending,
} from '../../lib/chat';
import { BOTTOM_NAV_HEIGHT_PX, CONTENT_MAX_WIDTH, DRAWER_WIDTH } from '../../lib/layout';
import { hitSlopSx } from '../../lib/surface';
import { RADIUS } from '../../rakko-tokens';

/** 量不到面板高度时上报的兜底值（单行输入台的近似高度）：ResizeObserver 在 jsdom 里
 *  不存在，页面据它留位，占位块不会塌成 0 */
export const COMPOSER_FALLBACK_HEIGHT = 88;

interface Props {
  /** 页面持有输入框引用：空态建议只填字不发送，填完要做焦点回来 */
  inputRef?: Ref<HTMLTextAreaElement>;
  /** 面板实际高度（多行输入会长高）：fixed 元素不占流，页面据此在消息流末尾留位 */
  onHeightChange?: (height: number) => void;
}

/** 回车发送、Shift+Enter 换行、输入法组合中不发送 */
function onComposerKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
  if (e.key !== 'Enter' || e.shiftKey) return;
  // Safari 上确认输入法候选的那次回车 isComposing 已是 false、keyCode 却是 229，
  // 只判 isComposing 会把拼音/日文的首个候选直接当发送，这里把 229 一起挡掉。
  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
  e.preventDefault();
  void sendMessage();
}

export default function ChatComposer({ inputRef, onHeightChange }: Props) {
  const draft = useChatDraft();
  const pending = useChatPending();
  const error = useChatError();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    // ResizeObserver 缺席（jsdom）时上报兜底高度：没有它页面只能按 0 留位
    if (typeof ResizeObserver === 'undefined') {
      onHeightChange?.(COMPOSER_FALLBACK_HEIGHT);
      return;
    }
    const observer = new ResizeObserver(() => {
      onHeightChange?.(panel.getBoundingClientRect().height);
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [onHeightChange]);

  return (
    <Portal>
      {/* 定位层：铺满抽屉右侧的整条视口底边，自身不挂玻璃、不吃事件 */}
      <Box
        sx={{
          position: 'fixed',
          left: { xs: 0, md: DRAWER_WIDTH },
          right: 0,
          // 移动端让开固定底栏与安全区；桌面端与内容列同一份 16px 呼吸
          bottom: {
            xs: `calc(${BOTTOM_NAV_HEIGHT_PX}px + env(safe-area-inset-bottom) + 8px)`,
            md: '16px',
          },
          // 内容之上、底栏（1100）/ 抽屉（1200）/ Dialog（1300）之下
          zIndex: (theme) => theme.zIndex.appBar - 1,
          pointerEvents: 'none',
        }}
      >
        {/* 内层容器与 AppShell 的内容列同一个居中口径（maxWidth + mx auto），
            px 与页面的横向内边距对齐，玻璃面板因此正好落在消息列的左右边界内 */}
        <Box sx={{ maxWidth: CONTENT_MAX_WIDTH, mx: 'auto', px: 2, pointerEvents: 'auto' }}>
          <Box
            ref={panelRef}
            data-glass="panel"
            sx={{
              borderRadius: `${RADIUS.card}px`,
              p: 1.5,
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: 1 }}>
              <TextField
                fullWidth
                multiline
                minRows={1}
                maxRows={6}
                size="small"
                placeholder="问邮件、记待办，直接说"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onComposerKeyDown}
                inputRef={inputRef}
                slotProps={{
                  htmlInput: {
                    maxLength: INPUT_MAX,
                    enterKeyHint: 'send',
                    'aria-label': '给助理的消息',
                  },
                }}
                sx={{
                  '& .MuiOutlinedInput-root': {
                    backgroundColor: 'transparent',
                    '& .MuiOutlinedInput-notchedOutline': { border: 'none' },
                  },
                }}
              />
              <IconButton
                color="primary"
                aria-label="发送"
                disabled={pending || draft.trim() === ''}
                sx={hitSlopSx()}
                onClick={() => void sendMessage()}
              >
                <SendIcon />
              </IconButton>
            </Box>
            {pending && <LinearProgress sx={{ mt: 1 }} />}
            {error && (
              <Alert severity="error" sx={{ mt: 1 }}>
                {error}
              </Alert>
            )}
          </Box>
        </Box>
      </Box>
    </Portal>
  );
}
