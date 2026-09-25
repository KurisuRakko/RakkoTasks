// 玻璃接线层：材质配方来自 rakko-glass.css（design-system/src/glass.css 的本地 Aero
// 定制版，基线是上游 main、光泽与厚度边在本地改过，偏离记录见该文件头），
// 本文件只剩壁纸接线——图源变量名（WALLPAPER_VAR）与默认图地址（DEFAULT_WALLPAPER_URL）；
// 此外还放着 Dialog 遮罩与壁纸裁剪框外遮罩共用的颜色（SCRIM_COLOR），它与壁纸无关，
// 是两处遮罩的同一个色值来源。
// 壁纸显示用户原图，不叠纸色。
//
// 现存的玻璃表面：三块 chrome（顶栏 / 桌面侧边栏 / 移动端底栏）加每个可见列表行一块
// panel。列表行自身就是 data-glass="panel" 的玻璃，直接压在壁纸上；不存在盖住内容列
// 的玻璃底板，也没有第三个 fixed 壳层。
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

/** 壁纸压暗层的 CSS 变量，由主题层下发到 :root。浅色是 none（浅色壁纸不叠任何层），
 *  深色是一层 35% 纯黑——亮壁纸透过半透明深纸会把黑纸染脏，压暗后玻璃与正文才落在
 *  深色纸上。压在壁纸之上、全部内容与玻璃之下。
 *  取值必须是 <image> 或 none（它是 background-image 的层，见下面的常量说明）。
 *  实现形式必须是**壁纸承载层自己的一条 background 叠层**（见 theme.ts 的
 *  `#rtk-wallpaper` 规则），不能新增 ::before 之类的伪元素：body::before + position:fixed
 *  的壁纸在 Chromium 里采样不到 backdrop-filter，新增伪元素等于改掉壁纸那块被读回的
 *  合成层结构，玻璃会连壁纸一起读丢。 */
export const WALLPAPER_SHADE_VAR = '--rtk-wallpaper-shade';

/** 深色壁纸压暗层的值：一层 12% 纯黑的**实心线性渐变**。
 *  必须写成渐变，不能写成 rgba() 色值：这个变量是 background-image 的**第一层**，而
 *  background-image 只接受 <image>，rgba(0,0,0,.35) 是 <color> 不是 <image>——整条
 *  background-image 声明会在计算值阶段失效，连后面的壁纸 url 一起丢掉（壁纸整张消失）。
 *  linear-gradient 两端同色即实心填充，等效于一层纯色像，且是合法 <image>。
 *  颜色用纯黑不用 n-10 墨色——它在深色主题是近白，压上去是漂白（同遮罩层的取舍）。
 *  12% 是「壁纸要看得见」这条约束的上限侧取值：压暗与玻璃纸底会相乘成同一个量
 *  （面板下 12% 压暗 + 60% 纸底 → 壁纸只剩约 1/8 的相对亮度），压暗再重一点壁纸就没了，
 *  整屏读作一块黑板。tests/theme-dark-glass.test.ts 的 D8 用这个乘积守住它。 */
export const WALLPAPER_SHADE_DARK = 'linear-gradient(rgba(0, 0, 0, 0.12), rgba(0, 0, 0, 0.12))';
