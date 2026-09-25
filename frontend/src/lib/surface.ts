// 列表行玻璃层：任务 / 已完成 / 搜索引用等列表行自己就是一块 data-glass="panel" 玻璃，
// 直接压在壁纸上——不再有「内容玻璃板」底板。层次由每行自己的玻璃配方（纸底 + 边框 +
// 内高光 + whisper 阴影）提供，壁纸不再被「58% 玻璃板 + 25% 卡片纸」两层纸叠加闷灰。
//
// 这是对 Rakko Design 契约的明知偏离：上游 references/anti-patterns.md 有一条专门的反
// 模式 "A glass surface per list item"，原文禁止滚动列表里每张卡片都挂 data-glass——
// 玻璃预算是**同时可见的 backdrop 表面个数**（上游实测：全部玻璃 4.1ms/帧 vs 全关
// 1.0ms/帧，8 个 panel 约占 1.0ms）。本项目所有者在知晓该代价后决定为本产品破例：
// 每行一块 panel 玻璃。这是产品决定，不是可以照抄的范例。
//
// 纸底 / 边框 / 高光 / 阴影全部由 rakko-glass.css 的 data-glass="panel" 档提供，主题层
// 与工具函数不再下发 background 与 border——否则会盖掉玻璃配方（同 MuiAppBar 让位的
// 道理）。这里只补配方不管的圆角。行间距见 ROW_GAP_PX。

import type { Theme } from '@mui/material/styles';
import type { SystemStyleObject } from '@mui/system';
import { MOTION, RADIUS, STATE_OPACITY, TYPE_SCALE } from '../rakko-tokens';

/** 列表行玻璃之间的竖向间距（px）。离场折叠时必须跟着归零：
 *  间距做在 ListItem 的 padding 上（见 motion.rowSx），折叠收行高时一并收起。 */
export const ROW_GAP_PX = 8;

/** 列表行玻璃的最小高度（px）。8px 网格；无摘要的单行任务内容只有 22px，
 *  6+22+6+2 的行看上去是一条扁带，且勾选框 42px 的触控盒会被行的 overflow: hidden
 *  裁到与行等高（36px），够不到 44px。48px 让 42px 的勾选框完整落在行内，
 *  行本身也成为 48px 的点击目标。带摘要的行自然高于它，此值对那些行无效。 */
export const ROW_MIN_HEIGHT_PX = 48;

/** 列表行玻璃的圆角：纸底 / 边框 / 高光 / 阴影归 data-glass="panel" 配方（见文件头），
 *  配方不管圆角，由这里补上。写成 `${RADIUS.card}px` 字符串而不是裸数字：sx 里 borderRadius
 *  的裸数字是 theme.shape.borderRadius 的**乘数**（本项目 = RADIUS.base = 6），裸写 6 会得到
 *  36px，字符串才原样进 CSS。 */
export function cardRowSx(): SystemStyleObject<Theme> {
  return { borderRadius: `${RADIUS.card}px` };
}

/** 行内小标签的高度（px）：契约 label-12 的行高（12 × 1.5 = 18）加上下各 2px 内边距。
 *  与行左侧「标题首行」中线基准 TITLE_LINE_H / 今日点的包裹盒同值——三个元素压在同一条
 *  中线上，chip 高了低了都会看出一列歪。 */
export const ROW_CHIP_HEIGHT_PX = 22;

/** 行内小标签的度量：label-12 字阶（12px）+ ROW_CHIP_HEIGHT_PX 盒高 + label 左右 6px。
 *  TasksPage 的「重要」与 DueChip 共用这一份——同一角色只允许一种尺寸。 */
export function rowChipSx(): SystemStyleObject<Theme> {
  return {
    height: ROW_CHIP_HEIGHT_PX,
    fontSize: `${TYPE_SCALE['label-12'].size}px`,
    '& .MuiChip-label': { px: 0.75 },
  };
}

/** 列表行的状态层：叠在纸面之上的一层（::after + opacity），不替换任何背景。
 *  hover/focus/pressed 取 STATE_OPACITY，层色取控件前景色，时长取 motion 的 state 档。
 *  焦点另加 primary 描边环——涟漪只在按下时出现，键盘 Tab 必须立刻看得见焦点在哪一行。 */
export function rowStateLayerSx(): SystemStyleObject<Theme> {
  return {
    // ButtonBase 自带 position: relative；这里重申一次，保证 ::after 的包含块就是行本身
    position: 'relative',
    '&::after': {
      content: '""',
      position: 'absolute',
      inset: 0,
      borderRadius: 'inherit',
      pointerEvents: 'none',
      backgroundColor: (theme: Theme) => theme.palette.text.primary,
      opacity: 0,
      transition: `opacity ${MOTION.state}ms ${MOTION.easeStandard}`,
    },
    '&:hover::after': { opacity: STATE_OPACITY.hover },
    '&.Mui-focusVisible::after': { opacity: STATE_OPACITY.focus },
    '&:active::after': { opacity: STATE_OPACITY.pressed },
    '&.Mui-focusVisible': {
      outline: (theme: Theme) => `2px solid ${theme.palette.primary.main}`,
      outlineOffset: '2px',
    },
  };
}

/** 行玻璃纸色的重申，抬到 (0,3,0) 才压得住 MUI：ListItemButton 根样式自带 `&:hover`
 *  与 `&.Mui-focusVisible` 的 background-color（(0,2,0)），高于配方 [data-glass='panel']
 *  的 (0,1,0)，悬停/聚焦会把 58% 纸色换成 4%/8% 的近透明色。值钉回配方同一表达式
 *  （同两个 CSS 变量，不写死数值），纸色地板在任何状态下都不下调。 */
export function rowGlassPaperSx(): SystemStyleObject<Theme> {
  const paper =
    'color-mix(in srgb, var(--color-paper) var(--glass-panel-opacity), transparent)';
  return {
    '&[data-glass="panel"]:hover': { backgroundColor: paper },
    '&[data-glass="panel"].Mui-focusVisible': { backgroundColor: paper },
  };
}

/** 触控命中区下限（px）：WCAG 2.5.5 目标尺寸（AAA）与 iOS HIG 的 44pt 同值 */
const HIT_SLOP_MIN_PX = 44;

/** 只扩命中区、不改视觉尺寸：给宿主盖一层居中的透明 ::after，把可点区域撑到 size×size。
 *
 *  为什么不直接放大按钮：MUI 的 IconButton size="small" 实测命中区只有 30×30、Checkbox
 *  42×42，都够不到 44×44 的触控下限；但把它们自身放大到 44 会撑坏既有的紧凑排版
 *  （列表行高、工具栏间距、对话框标题栏都是按小控件排的）。放宽的是「能点到哪」，
 *  不是「长多大」，所以走伪元素而不是改尺寸。
 *
 *  伪元素为什么能接收点击：绝对定位的 ::after 是宿主渲染盒的一部分，停在宿主上方即可
 *  命中宿主本身，点击事件照样冒泡到宿主上挂的 React handler 与 MUI 涟漪，不需要宿主
 *  再监听任何事件。伪元素不给任何可见样式（无背景、无边框），也就不影响宿主的观感。
 *
 *  调用方的裁剪风险：宿主被本函数置为 position: 'relative'，伪元素的包含块就是宿主，
 *  但它仍会被宿主的祖先裁掉——祖先若有 overflow: hidden 且可用高度小于 size（典型是列表行
 *  玻璃，行高由 ROW_MIN_HEIGHT_PX 兜底），伪元素的上下两端会被裁平，命中区实际达不到标称的
 *  size（已实测：36px 高的 overflow: hidden 行把 44px 命中区裁到约 36px）。相邻两个扩过命中区
 *  的控件如果挨得比 size 近，两片伪元素会重叠，重叠处由渲染顺序靠后的那个元素收走点击。
 *
 *  width / height 上的裸数字是 px 直通，不走 theme.spacing 乘算（spacing 只作用于
 *  padding / margin 家族）。 */
export function hitSlopSx(size = HIT_SLOP_MIN_PX): SystemStyleObject<Theme> {
  return {
    position: 'relative',
    '&::after': {
      content: '""',
      position: 'absolute',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      width: size,
      height: size,
    },
  };
}
