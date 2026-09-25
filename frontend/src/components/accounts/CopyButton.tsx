// 全站唯一的「复制」按钮：IconButton + ContentCopy 图标 + Tooltip「复制」，
// 反馈一律交给 Snackbar（文案由调用方的 onFeedback 决定），按钮自己不留任何常驻文字。
//
// 为什么单独一个文件：设置页、提醒事项同步、微软授权引导原先各写一套（outlined Button
// 带文字 / IconButton / outlined Button + startIcon），反馈也有 Snackbar 与行内 caption
// 两种载体。同一角色只留一种零件，改动集中在这里。
//
// 触屏不加 Tooltip：MUI 明确建议在触屏上停用 Tooltip（长按会与按压/滚动冲突），
// 所以用 (hover: hover) 媒体查询只在指针设备上挂。

import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import useMediaQuery from '@mui/material/useMediaQuery';
import { copyText } from '../../lib/clipboard';
import { hitSlopSx } from '../../lib/surface';

interface Props {
  /** 取待复制文本的惰性函数：调用时才知道要复制的值（密码这类可能后生成） */
  getText: () => string;
  /** 复制成功 / 失败的回调，由调用方决定 Snackbar 文案 */
  onFeedback: (ok: boolean) => void;
  disabled?: boolean;
}

export default function CopyButton({ getText, onFeedback, disabled }: Props) {
  const canHover = useMediaQuery('(hover: hover)');
  return (
    <Tooltip title="复制" disableHoverListener={!canHover}>
      <IconButton
        size="small"
        aria-label="复制"
        disabled={disabled}
        // 命中区补齐到 44×44：IconButton size="small" 自身只有 30×30，
        // 够不到 WCAG 2.5.5 的触控下限（见 lib/surface.hitSlopSx）
        sx={hitSlopSx()}
        onClick={() => {
          copyText(() => Promise.resolve(getText()))
            .then(() => onFeedback(true))
            .catch(() => onFeedback(false));
        }}
      >
        <ContentCopyIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}
