// 玻璃接线层：材质配方来自 rakko-glass.css（design-system/src/glass.css 的逐字镜像），
// 本文件只剩壁纸接线——图源变量名（WALLPAPER_VAR）与壁纸布尔属性标记（WALLPAPER_ATTR）。
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

/** 壁纸图源的 CSS 变量：由 lib/wallpaper 写到 <html> 上，主题层的 body 背景消费。
 *  无壁纸时该变量为 none，body 退回纯纸色背景。 */
export const WALLPAPER_VAR = '--rtk-wallpaper';

/** <html> 上「有没有壁纸」的布尔属性标记（有壁纸时存在、无壁纸时移除）。CSS 没法对
 *  自定义属性的值做条件判断——WALLPAPER_VAR 只分 url(...) 与 none 两种值，主题层选择器
 *  匹配不到——所以除了图源变量还要这个属性标记，供主题层用
 *  :root:not([data-wallpaper]) 在无壁纸时改写玻璃高光。
 *  它归位在本文件而非 lib/wallpaper：这里是玻璃接线层常量的单一来源，WALLPAPER_VAR
 *  已经在此；两个同类常量分居两文件会让维护者困惑，也迫使 theme.ts 为一个字符串常量去
 *  import 带模块级副作用的 wallpaper.tsx（模块加载即读 localStorage 并写 <html>），
 *  这是不必要的依赖方向。 */
export const WALLPAPER_ATTR = 'data-wallpaper';

/** 壁纸承载层的元素 id：index.html 里的一个真实 DOM 节点（不是伪元素）。
 *  样式由主题层按 `#rtk-wallpaper` 下发，换页时的持名规则在 motion-styles 段 (g)。
 *  必须是真实元素：View Transitions 的捕获循环只遍历「已连接的元素」
 *  （css-view-transitions-1 §7.6），伪元素永远拿不到分组，写在 body::before 上的
 *  view-transition-name 不生效，壁纸就只能焊死在 root 快照里跟着淡出。
 *  id 在 index.html 里是手抄的（那边在模块系统之外），tests/wallpaper.test.tsx 断言两处一致。 */
export const WALLPAPER_LAYER_ID = 'rtk-wallpaper';
