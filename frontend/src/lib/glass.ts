// 玻璃接线层：材质配方来自 rakko-glass.css（design-system/src/glass.css 的逐字镜像），
// 本文件只剩壁纸接线——图源变量名（WALLPAPER_VAR）与默认图地址（DEFAULT_WALLPAPER_URL）；
// 此外还放着 Dialog 遮罩与壁纸裁剪框外遮罩共用的颜色（SCRIM_COLOR），它与壁纸无关，
// 是两处遮罩的同一个色值来源。
// 驯化层纸色叠加已随产品决定移除：壁纸显示用户原图，不再垫纸色。
//
// 现存的玻璃表面：三块 chrome（顶栏 / 桌面侧边栏 / 移动端底栏）加每个可见列表行一块
// panel。列表行自身就是 data-glass="panel" 的玻璃，直接压在壁纸上；盖住内容列的整块
// 玻璃底板已删除，不再有第三个 fixed 壳层。
//
// 「每个列表行一块玻璃」是对上游 references/anti-patterns.md 中 "A glass surface per
// list item" 的明知偏离。玻璃的预算口径是「同时可见的 backdrop 表面个数」：上游实测
// 8 个 panel 约 1.0ms/帧、全部表面玻璃化约 4.1ms/帧，对照全关约 1.0ms/帧。项目所有者
// 在知晓该代价后为本产品决定破例；这不是契约默认允许的写法，不要把它当范例复制。

/** 默认壁纸：public/ 下的静态文件，vite 构建时原样拷到 dist 根，后端 SPA fallback 按
 *  这个路径回同一份文件；因此它同时是浏览器地址（首帧内联脚本手抄同一字面量，见
 *  tests/wallpaper.test.tsx 的一致性断言）。用户没设过壁纸时由 lib/wallpaper 写到
 *  WALLPAPER_VAR，「没有壁纸」这个状态不存在。 */
export const DEFAULT_WALLPAPER_URL = '/wallpaper-default.jpg';

/** 壁纸图源的 CSS 变量：由 lib/wallpaper 写到 <html> 上，主题层的壁纸承载层背景消费。
 *  值恒为 url(...)——用户壁纸或 DEFAULT_WALLPAPER_URL，没有「空」态。 */
export const WALLPAPER_VAR = '--rtk-wallpaper';

/** 壁纸承载层的元素 id：index.html 里的一个真实 DOM 节点，整页不透明地板（纸色 + 壁纸原图）。
 *  样式由主题层按 `#rtk-wallpaper` 下发，z-index -1 让它落在页面内容与玻璃表面（backdrop-filter）
 *  之后。id 在 index.html 里是手抄的（那边在模块系统之外），tests/wallpaper.test.tsx 断言两处一致。 */
export const WALLPAPER_LAYER_ID = 'rtk-wallpaper';

/** Dialog 遮罩与壁纸裁剪框外遮罩共用的颜色（--glass-scrim-opacity 由主题层下发到 :root） */
export const SCRIM_COLOR = 'rgb(0 0 0 / var(--glass-scrim-opacity))';
