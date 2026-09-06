// 玻璃接线层：材质配方来自 rakko-glass.css（design-system/src/glass.css 的逐字镜像），
// 本文件只剩壁纸接线——图源变量名（WALLPAPER_VAR）与驯化层浓度（WALLPAPER_TAME_OPACITY）。
//
// 现存的玻璃表面：三块 chrome（顶栏 / 桌面侧边栏 / 移动端底栏）加每个可见列表行一块
// panel。列表行自身就是 data-glass="panel" 的玻璃，直接压在壁纸上；盖住内容列的整块
// 玻璃底板已删除，不再有第三个 fixed 壳层。
//
// 「每个列表行一块玻璃」是对上游 references/anti-patterns.md 中 "A glass surface per
// list item" 的明知偏离。玻璃的预算口径是「同时可见的 backdrop 表面个数」：上游实测
// 8 个 panel 约 1.0ms/帧、全部表面玻璃化约 4.1ms/帧，对照全关约 1.0ms/帧。项目所有者
// 在知晓该代价后为本产品决定破例；这不是契约默认允许的写法，不要把它当范例复制。

/** 壁纸图源的 CSS 变量：由 lib/wallpaper 写到 <html> 上，主题层的 body 背景消费。
 *  无壁纸时该变量为 none，body 退回纯纸色背景。 */
export const WALLPAPER_VAR = '--rtk-wallpaper';

/**
 * 驯化层浓度：壁纸之上、玻璃之下的一层纸色叠加。
 *
 * Rakko Design 的玻璃档位是按「玻璃身后是纸色系页面内容」调校的（chrome 45% /
 * panel 58% 纸底）。用户壁纸是任意图像：深色图会把顶栏标题的对比度压到 2.6:1，
 * 过不了 AA。先用这层把任意图像压进可控亮度区间，玻璃档位随后按原设计工作，
 * 最坏情况（纯黑 / 纯白壁纸）对比度回到 5.2:1 以上，深浅色主题都过 AA。
 *
 * 它与壁纸合成同一个元素的两层 background（纸色渐变叠在图上），不占额外 DOM，
 * 也不产生额外合成层。
 */
export const WALLPAPER_TAME_OPACITY = '35%';
