// 列表行卡片层：任务 / 已完成 / 搜索引用等列表行叠在内容玻璃板（panel）上，
// 以一张张半透明纸底卡片呈现——层次由纸色叠加提供，只叠纸底、不叠玻璃模糊。
// 契约性能预算第 3 条禁止滚动内容上玻璃：每行一次 backdrop 读回就是每帧一次
// 全区域重算，长列表直接掉帧；模糊由卡片身下的内容玻璃板统一提供（glass.ts）。
// 纸底浓度取 CARD_PAPER_OPACITY：与玻璃板 panel 档纸底叠加后壁纸仍可见约两成，
// 同时保证正文对比度在最坏壁纸下仍过 AA（驯化层逻辑见 glass.ts 注释）。

import type { Theme } from '@mui/material/styles';
import type { SystemStyleObject } from '@mui/system';
import { CARD_PAPER_OPACITY } from './glass';
import { RADIUS } from '../rakko-tokens';

/** 列表行卡片之间的竖向间距（px），卡片之间的呼吸感。离场折叠时必须跟着归零：
 *  间距做在 ListItem 的 padding 上（见 motion.rowSx），折叠收行高时一并收起。 */
export const ROW_GAP_PX = 8;

/** 列表行卡片视觉：半透明纸底 + 卡片圆角 + 1px 边框（纸底理由见文件头注释） */
export function cardRowSx(theme: Theme): SystemStyleObject<Theme> {
  return {
    backgroundColor: `color-mix(in srgb, ${theme.palette.background.paper} ${CARD_PAPER_OPACITY}, transparent)`,
    borderRadius: `${RADIUS.card}px`,
    border: `1px solid ${theme.palette.divider}`,
  };
}
