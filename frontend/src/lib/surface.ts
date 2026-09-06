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
import { RADIUS } from '../rakko-tokens';

/** 列表行玻璃之间的竖向间距（px）。离场折叠时必须跟着归零：
 *  间距做在 ListItem 的 padding 上（见 motion.rowSx），折叠收行高时一并收起。 */
export const ROW_GAP_PX = 8;

/** 列表行玻璃的圆角：纸底 / 边框 / 高光 / 阴影归 data-glass="panel" 配方（见文件头），
 *  配方不管圆角，由这里补上 */
export function cardRowSx(): SystemStyleObject<Theme> {
  return { borderRadius: `${RADIUS.card}px` };
}
