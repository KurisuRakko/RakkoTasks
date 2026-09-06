// 玻璃接线层：材质配方来自 rakko-glass.css（design-system/src/glass.css 的逐字镜像），
// 本文件只放「本项目怎么用它」的决定——各路实现共用的常量单一来源。
//
// 整页只允许两次 backdrop 读回：顶栏（chrome）与内容玻璃板（panel）。两者几何上零重叠，
// 重叠区域会付两次读回。列表卡片、滚动容器、正文一律不上玻璃（性能预算第 3 条）。

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

/**
 * 列表卡片的纸底浓度：卡片叠在 panel 玻璃板上，只叠纸色、不做 backdrop-filter。
 * 契约性能预算第 3 条禁止滚动内容上玻璃——每行一个 backdrop-filter 就是每帧一次
 * 全区域读回。模糊只发生在玻璃板与顶栏两处，卡片单独负责层次。
 */
export const CARD_PAPER_OPACITY = '25%';

/** 内容玻璃板的圆角（px）：md 起是一块浮起的玻璃板，移动端贴边不给圆角 */
export const GLASS_PANEL_RADIUS = 12;
