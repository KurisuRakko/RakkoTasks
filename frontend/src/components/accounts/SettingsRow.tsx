// 设置页与账户页共用的「设置行」零件：HIG inset grouped row 的落点——
// 一行 = 左侧标签（可带一行说明）+ 右侧值或控件，行与行之间一条与文字左缘对齐的发丝线。
//
// 为什么放在 components/accounts/ 而不是 components/ 或 lib/：本路只允许改
// pages/{SettingsPage,AccountPages}.tsx 与 components/accounts/**，新建一个顶层
// components/SettingsRow.tsx 会越界。所以零件落在这里（两个消费方都在本路范围内），
// 语义上它属于设置页，将来整体提取到 components/ 时直接整文件搬走即可，不改任何调用点。
//
// 一个面板里只有一种行结构：行的左右内边距、最小高度、分隔线都在本文件，页面里不再各写
// sx。分隔线不写在行自己身上，而是 `& + &`——相邻两行之间才有一条，首行上方与末行下方
// 天然不画，也不需要按 index 特判。
//
// 文字一律 n9（text.primary，继承即可）：玻璃上的次级文字 n7 实测对比度只有 2.4–2.6，
// 层级改用字阶区分——标签 13px（body2）、值/说明 12px（caption）。

import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Typography from '@mui/material/Typography';
import type { ReactNode } from 'react';
import type { SystemStyleObject } from '@mui/system';
import type { Theme } from '@mui/material/styles';

/** 行最小高度（px）：48 与列表行玻璃同一档（lib/surface 的 ROW_MIN_HEIGHT_PX），
 *  控件行与文字行落在同一个节奏上，不会因为内容只有一行字就塌下去 */
export const ROW_MIN_HEIGHT_PX = 48;

/** 行自身：左右内边距 + 最小高度 + 垂直居中 + 定位上下文（伪元素分隔线的包含块） */
export const ROW_SX = {
  position: 'relative',
  px: 1,
  minHeight: `${ROW_MIN_HEIGHT_PX}px`,
  display: 'flex',
  alignItems: 'center',
  gap: 1.5,
} as const;

/**
 * 相邻两行之间的发丝分隔线：线从文字左缘起、画在相邻行之间。
 *
 * 用伪元素而不是 `border-top`：边框画在整个盒子的边框上，从行的最左端到最右端，
 * 内边距不会让它内缩（内边距在边框内侧），只会把相邻行的标签整体右推。伪元素可以
 * 单独定位在内容左缘（left = 行的左内边距），而所有行的内边距完全一致。
 * 色值取 theme.palette.divider（本项目 BORDER token：浅色 n10 10% / 深色白 12%）。
 * 位置相对行定位，`& + &::before` 保证只有相邻行之间才有一条，首行上方与末行下方不画。
 */
export function rowSeparatorSx(theme: Theme): SystemStyleObject<Theme> {
  return {
    '& + &::before': {
      content: '""',
      position: 'absolute',
      top: 0,
      // 与行自身的左内边距同源（theme.spacing(1) = 8px），两处不会各自漂移
      left: theme.spacing(1),
      right: 0,
      height: '1px',
      backgroundColor: theme.palette.divider,
      // 纯装饰、不接收指针事件：压在相邻行上也不改变点击目标
      pointerEvents: 'none',
    },
  };
}

/** 行内说明与元信息的字阶：玻璃上只有一种次级字阶（caption = 12px / label-12）。
 *  层级靠字号与字重拉开，不靠颜色变淡——玻璃上的 n7 对比度只有 2.4–2.6。 */
export const HINT_SX = {
  display: 'block',
  mt: '2px',
} as const;

interface Props {
  /** 最左侧的固定宽零件（账户行的头像这类），纵向居中 */
  leading?: ReactNode;
  /** 左侧标签；说明文字另用 HINT_SX 包一层 caption 放在同一个节点里 */
  label?: ReactNode;
  /** 右侧的值或控件。给字符串时按统一的值字阶（caption / n9 / 右对齐）渲染 */
  value?: ReactNode;
  /** 整行可点时的动作；给了就渲染成 ButtonBase，按压反馈由 state layer 提供 */
  onClick?: () => void;
  /** 行级稳定钩子（如 data-account-row），供测试与样式定位 */
  rowDataAttr?: Record<string, string>;
  /** 行内排布方向。默认 row（标签左、值右）；'column' 时标签在上、值在下并占满行宽——
   *  控件自身有合适宽度时（分段控件这类）不该被塞进右侧的小格子里挤到换行 */
  direction?: 'row' | 'column';
  sx?: SystemStyleObject<Theme>;
}

/**
 * 一行设置。两种形态共用同一套内边距、最小高度与分隔线：
 * - 静态行：左标签 + 右值 / 右控件（direction="column" 时改成标签在上、值在下占满行宽）；
 * - 可点行（onClick）：整行一个 ButtonBase，左侧仍是同样的标签与说明。
 */
export default function SettingsRow({
  leading,
  label,
  value,
  onClick,
  rowDataAttr,
  direction = 'row',
  sx,
}: Props) {
  // 纵向时值槽占满剩余宽度（含被标签挤出的情况）：控件的宽度由自己决定，
  // 行只负责给它一整行
  const valueSx =
    direction === 'column'
      ? { display: 'flex', width: '100%', minWidth: 0 }
      : { display: 'flex', flexShrink: 0, minWidth: 0, maxWidth: '100%' };
  const content = (
    <>
      {leading !== undefined && leading !== null && <Box sx={{ flexShrink: 0 }}>{leading}</Box>}
      {label !== undefined && label !== null && (
        <Box
          sx={{
            flexGrow: 1,
            minWidth: 0,
            textAlign: 'left',
            // 纵向时标签不该被拉成一块大盒子（值是 36px 高的控件，行高由内容决定）
            ...(direction === 'column' ? { flexGrow: 0, flexShrink: 0 } : {}),
          }}
        >
          {label}
        </Box>
      )}
      {value !== undefined &&
        value !== null &&
        (typeof value === 'string' ? (
          <Typography variant="caption" sx={{ flexShrink: 0, textAlign: 'right' }}>
            {value}
          </Typography>
        ) : (
          <Box sx={valueSx}>{value}</Box>
        ))}
    </>
  );

  if (onClick) {
    return (
      <ButtonBase
        onClick={onClick}
        data-setting-row
        {...rowDataAttr}
        sx={[
          ROW_SX,
          rowSeparatorSx,
          { display: 'flex', flexDirection: direction, width: '100%' },
          ...(sx ? [sx] : []),
        ]}
      >
        {content}
      </ButtonBase>
    );
  }
  return (
    <Box
      data-setting-row
      {...rowDataAttr}
      sx={[ROW_SX, rowSeparatorSx, { flexDirection: direction }, ...(sx ? [sx] : [])]}
    >
      {content}
    </Box>
  );
}
