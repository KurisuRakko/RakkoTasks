// 任务页：分类筛选 + 按截止日期分组列表（今天/本周/无期限）。
// 列表数据来自 list-cache 模块级缓存（唯一数据源）：挂载先显示缓存旧数据、后台
// 静默刷新，不再每次先闪加载圈；勾选 → 离场动画 → moveItem 进 done 缓存并 PATCH。
// 入场 stagger 只在「这份列表首次拿到数据」时跑（useCachedList.animateEnter），
// 命中缓存直接就位不重放。已完成列表在 /done，本页不持有 done 数据。
// 条目左侧今日点表示源邮件是今天发的，按日期自动过期，与查看/勾选状态无关。
// 列表行与详情 Dialog 共用 VT_NAMES.sheet 做容器变换（点哪行哪行长成对话框）；
// 右下角悬浮按钮经 portal 挂到 body——路由转场内层动画盒的 transform 会成为
// fixed 后代的包含块，换页后按钮会跟着内容漂移。
// 「+」打开的是 AI 快速添加对话框（AiAddDialog）：非速记模式先让 AI 把一句话解析
// 成字段、预览可改后再保存；速记模式点「确定」立刻关窗（打完就走，不让用户等
// LLM），落库请求（POST /api/items/quick）在后台跑完再弹结果提示。速记请求故意
// 不绑组件生命周期：请求一旦到达服务端就会跑完并落库，前端切页/卸载也让它继续，
// 卸载时取消只会白丢条目——真正的兜底在服务端。

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Fab from '@mui/material/Fab';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import { createItem, fetchItems, fetchStatus, parseTask, patchItem, quickAddTask } from '../lib/api';
import { groupItems, isNewToday } from '../lib/grouping';
import { EMPTY_STATE_BOX_SX } from '../lib/layout';
import { moveItem, openKey, removeItem, upsertOpenItem, useCachedList } from '../lib/list-cache';
import {
  LEAVE_DURATION,
  rowSx,
  useMorphDialog,
  usePrefersReducedMotion,
} from '../lib/motion';
import { useLongPress } from '../lib/long-press';
import { useNavigateTo } from '../lib/nav';
import { cardRowSx, hitSlopSx } from '../lib/surface';
import { todayIso } from '../lib/time';
import { GLASS, MOTION, TYPE_SCALE } from '../rakko-tokens';
import type { Category, Item, ItemFields } from '../types';
import AiAddDialog from '../components/AiAddDialog';
import CategoryChips from '../components/CategoryChips';
import DueChip from '../components/DueChip';
import ItemDialog from '../components/ItemDialog';
import RowContextMenu from '../components/RowContextMenu';

/** 速记模式开关的 localStorage 键（值只写 'on' / 'off'） */
const QUICK_MODE_KEY = 'rakkotasks.quick-mode';

/** 读速记开关：读不到或不是 'on' 一律回落「关」。读写都要 try/catch：隐私模式下
 *  localStorage 访问会抛异常，不能让整页崩。 */
function readQuickMode(): boolean {
  try {
    return localStorage.getItem(QUICK_MODE_KEY) === 'on';
  } catch {
    return false;
  }
}

/** Snackbar 内容：text 是提示文案；item 非 null 时右侧多一个「查看」按钮开详情 */
type Snack = { text: string; item: Item | null };

/** 行右键 / 长按菜单的弹出位置（视口坐标） */
type Point = { x: number; y: number };

/** 行内元信息标签：比 MUI 的 size="small"（24px / 13px）再小一档。标签横排在标题
 *  首行右侧，高度（20px）必须不超过 TITLE_LINE_H（22）才能与首行压在同一条中线上，
 *  不把行撑高；字号取 caption 档，label 左右内边距收到 6px。 */
const META_CHIP_H = 20;
// 间距取 Rakko Design CHEATSHEET §Spacing & radius 的 gap-1（4px，inline icon ↔ text）：
// 同一行内相邻小元素就该用这一档；3px 不在任何间距梯度上，是随手写下的数。
const META_CHIP_GAP = '4px';

const META_CHIP_SX = {
  height: META_CHIP_H,
  fontSize: '0.6875rem',
  '& .MuiChip-label': { px: 0.75 },
} as const;

/** 标题首行的行盒高度：行左侧的今日点与勾选框都以它为中线基准。与 theme 的
 *  body1 同源（copy-14），不另开一份数字。 */
const TITLE_LINE_H = Math.round(
  TYPE_SCALE['copy-14'].size * TYPE_SCALE['copy-14'].lineHeight,
); // 22

/** 单行任务（拆成独立组件：长按 hook 需要逐行一份实例，不能放在 map 的循环体里） */
function TaskRow({
  item,
  index,
  today,
  leaving,
  animateEnter,
  reduced,
  sourceName,
  onToggle,
  onOpen,
  onMenuOpen,
}: {
  item: Item;
  index: number;
  today: Date;
  leaving: boolean;
  animateEnter: boolean;
  reduced: boolean;
  /** 容器变换来源行命名：仅对话框关闭且该行是上一次来源时持名 */
  sourceName: (key: number) => string | undefined;
  onToggle: (item: Item) => void;
  onOpen: (item: Item) => void;
  /** 右键 / 长按弹出上下文菜单：anchor 状态收在页面，这里只上报条目与落点 */
  onMenuOpen: (item: Item, point: Point) => void;
}) {
  // 长按 500ms 弹菜单（touch 路径与桌面 contextmenu 分开，理由见 lib/long-press.ts）；
  // 触发点坐标给菜单定位。长按与点击各自独立：长按不吞行点击，弹菜单后由菜单项接手
  const longPress = useLongPress((point) => onMenuOpen(item, point));
  return (
    <ListItem
      disablePadding
      sx={{
        ...rowSx(index, leaving, reduced, animateEnter),
        viewTransitionName: sourceName(item.id),
      }}
    >
      {/* 每行一块玻璃：data-glass="panel" 直接压在壁纸上，不再有内容玻璃板底板。
          纸底/边框/高光/阴影由 rakko-glass.css 配方提供，cardRowSx 只补圆角。
          每行一次 backdrop 读回是对上游 anti-patterns "A glass surface per list
          item" 的明知偏离，理由见 surface.ts 文件头。行间空隙由 ListItem 的
          rowSx padding-bottom 提供；容器变换名字留在 ListItem */}
      <ListItemButton
        data-glass="panel"
        sx={[
          cardRowSx(),
          {
            // 行内是四列单行 grid：今日点(12px) / 勾选(auto) / 标题+摘要(可收缩 1fr) /
            // 元信息列(按内容)。标签此前独占第二行，可绝大多数条目只有一两枚
            // chip——整整一行高度里九成是空的。改成横排在标题首行右侧后那段留白消失，
            // 行高由标题决定。
            //
            // 元信息列写 max-content 而不是 auto，是「chip 不许被压扁截断」的结构性保证：
            // auto 轨道的最小尺寸是 min-content，而 .MuiChip-label 带 overflow: hidden，
            // 它作为 flex 项的自动最小尺寸会解析成 0——于是窄宽度下 chip 是可以被压成
            // 一个省略号的。max-content 轨道不可压缩，chip 拿到的永远是完整宽度；被挤的
            // 只能是标题列。宽度分档的特判不需要，也不该有。
            //
            // 标题列写 minmax(0, 1fr) 而不是 1fr：grid 项默认 min-width 是 auto，不写
            // minmax(0,…) 的话长标题会把自己撑出去、反过来挤扁 meta 列（此前那版把整组
            // 标签 flexShrink: 0 放在标题右侧，窄屏上标题被挤成竖排碎字，不能退回去）。
            // ListItemText 自身能收缩到轨道下限靠的是 MUI 根样式自带的 min-width: 0，
            // tasks-page 测试钉着它，上游若删掉那里会红。
            display: 'grid',
            gridTemplateColumns: '12px auto minmax(0, 1fr) max-content',
            gridTemplateAreas: '"dot cb text meta"',
            alignItems: 'start',
            // align-items: start 让四列内部都以标题首行对齐；align-content: center 管的是
            // 另一件事——这里是单行隐式轨道，row-min-height 撑出富余高度时整条轨道居中，
            // 无摘要的单行任务因此不会贴在行顶。多行行的轨道自然填满，这条声明对它们无效。
            alignContent: 'center',
            columnGap: '8px',
            // 长按行体时 iOS 会弹系统文本选择菜单（触摸保持 500ms 即触发），行内文字
            // 也不是可选中文本——userSelect 与 WebkitTouchCallout 一并关掉，长按只走
            // 我们自己的手势（合并进 cardRowSx 的 sx 数组，surface.ts 不动）
            WebkitTouchCallout: 'none',
            userSelect: 'none',
            // 竖向内边距不再覆盖：ListItemButton 的 MUI 默认值就是 8px，正好落在 8px
            // 网格上。此前压到 6px 是想把行压矮，可行高现在由 ROW_MIN_HEIGHT_PX 决定，
            // 6px 只对**带摘要的多行行**有效——而那恰恰是最需要留白的行，删掉。
            // （6px 本身也不在任何间距梯度上。）
          },
        ]}
        onClick={() => onOpen(item)}
        onContextMenu={(e) => {
          e.preventDefault(); // 不让浏览器弹系统菜单，改弹行上下文菜单
          onMenuOpen(item, { x: e.clientX, y: e.clientY });
        }}
        {...longPress}
      >
        <Box
          sx={{
            gridArea: 'dot',
            width: 12,
            height: TITLE_LINE_H,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          {isNewToday(item, today) && (
            <Box
              role="img"
              aria-label="今日新邮件"
              sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'primary.main' }}
            />
          )}
        </Box>
        {/* 勾选框与今日点共用「标题首行」这条中线：盒高取 TITLE_LINE_H、alignItems
            居中，比盒高的勾选框对称溢出——不再靠 marginTop 猜偏移（原来那个 -4px 只把
            中心从 21 挪到 17，离标题首行的 11 还差 6px，三个元素三条中线）。溢出的是
            勾选框透明的 padding（disableRipple，没有涟漪要画），被行的 overflow: hidden
            裁掉约 2px 不影响观感。 */}
        <Box sx={{ gridArea: 'cb', height: TITLE_LINE_H, display: 'flex', alignItems: 'center' }}>
          <Checkbox
            edge="start"
            checked={leaving}
            tabIndex={-1}
            disableRipple
            // 命中区补齐到 44×44：勾选框自身 42×42，伪元素横向多出的 1px 落在 8px 列间距里，
            // 不侵入右侧标题。纵向受行的 overflow: hidden 约束——无摘要的行高 48、勾选框在行内
            // 居中，44 完整落地；带摘要的行里勾选框贴着标题首行（中心比行中线高 10px），伪元素
            // 上端探出行上沿 3px 被裁，纵向实测约 41px（来源于上面那条中线对齐，非本次引入）。
            sx={hitSlopSx()}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(item);
            }}
          />
        </Box>
        <ListItemText
          primary={item.title}
          secondary={item.summary}
          sx={{ gridArea: 'text', margin: 0 }}
          // 标题不设行数上限：待办的标题是主信息，截断会让用户看不到自己写的东西，
          // 让它换行、让行长高即可。中文本来就能逐字换行，overflow-wrap: anywhere 是给
          // 「一长串不含空格的西文 / URL 标题」的——不给断点它就会直接溢出压到 chip 上。
          // 摘要直接压在行自己的 data-glass="panel" 玻璃上（纸色 58% 仍透壁纸）：
          // MUI 默认给 secondary 的 text.secondary（n7）实测对比度只有 2.4–2.6，
          // 远低于 AA 正文的 4.5。玻璃上没有次级色空间，层级靠字号字重（标题
          // 16/600 vs 摘要 13/400），颜色必须取 text.primary（n9）
          // 走 slotProps 而不是那两个已弃用的旧转发 prop：MUI 6.5 给它们标了
          // @deprecated、v7 移除，slotProps 是同一件事的现行写法。
          slotProps={{
            primary: { sx: { overflowWrap: 'anywhere' } },
            secondary: {
              color: 'text.primary',
              sx: {
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
              },
            },
          }}
        />
        {/* 元信息横排在标题首行右侧（gridArea: 'meta'）：一条任务最多两枚 chip——
            「重要」约 40px、最宽的截止日 12月31日约 47px，加 4px 间隙 ≈ 91px，宽度由
            内容自然封顶，列宽交给 grid 的 max-content，不需要 maxWidth 护栏。盒高取
            TITLE_LINE_H（22）：与今日点、勾选框共用「标题首行」这条中线，chip 以
            20px 居中压在同一条线上。分类不在这里重复显示——顶部的 CategoryChips
            过滤器已经承担分类切换，行内再放一枚只占高度、没有信息量。

            现在这个方向有三条写死的保证，各防一件事，缺一条就退回旧故障：
            · 列宽 max-content（行按钮 sx，机制见那里）：chip 不被压扁截断；
            · flex-wrap: nowrap（下面 sx）：chip 不换行、不折列，f429504 的两列故障不再可能；
            · 标题列 minmax(0, 1fr) + ListItemText 根样式的 min-width: 0：让位的永远是标题。
            更老的「整组标签 flexShrink: 0 摆在标题右侧」同样禁止：窄屏上标题会被挤成
            竖排碎字。 */}
        <Stack
          // useFlexGap：不开它的话，MUI 把 spacing 编译成后代选择器隔空改写子元素
          // ——相邻兄弟逐个加 marginTop、其余一律重置 margin: 0（防双重叠加），
          // 每个 chip 的 margin 都会被盖掉；写在容器上的 gap 才是直接机制。
          useFlexGap
          spacing={META_CHIP_GAP}
          direction="row"
          alignItems="center"
          // nowrap 是 flex 的默认值，本来可以不写——但这一行的历史故障正出在这个属性上
          // （f429504 就是在这里开了 wrap 折列）。写死并加守卫比依赖默认值可靠；
          // direction="row" 已由 prop 编译出同一条声明，不在这里重复写 flexDirection。
          // 也不加 flexShrink: 0：meta Stack 是 grid 项，flex-shrink 对它无效，是死声明。
          sx={{ gridArea: 'meta', height: TITLE_LINE_H, flexWrap: 'nowrap' }}
        >
          {item.importance === 'high' && (
            <Chip label="重要" color="warning" size="small" variant="outlined" sx={META_CHIP_SX} />
          )}
          {/* 截止日的三档配色与读屏文案收在 DueChip，详情对话框用的是同一个组件 */}
          <DueChip item={item} today={today} sx={META_CHIP_SX} />
        </Stack>
      </ListItemButton>
    </ListItem>
  );
}

function GroupSection({
  title,
  items,
  today,
  animateEnter,
  leavingIds,
  onToggle,
  onOpen,
  sourceName,
  onMenuOpen,
}: {
  title: string;
  items: Item[];
  today: Date;
  /** 该列表本次挂载是否首次拿到数据：true 才跑入场 stagger（见 motion.rowSx） */
  animateEnter: boolean;
  leavingIds: number[];
  onToggle: (item: Item) => void;
  onOpen: (item: Item) => void;
  /** 容器变换来源行命名：仅对话框关闭且该行是上一次来源时持名 */
  sourceName: (key: number) => string | undefined;
  /** 行右键 / 长按打开上下文菜单：anchor 状态收在页面，这里只上报条目与落点 */
  onMenuOpen: (item: Item, point: Point) => void;
}) {
  const reduced = usePrefersReducedMotion();
  if (items.length === 0) return null; // 空组不渲染
  return (
    <List
      subheader={
        <ListSubheader component="div" disableSticky sx={{ bgcolor: 'transparent' }}>
          {/* disableSticky：本应用滚的是 document，ListSubheader 默认吸顶的 top: 0 相对
              视口，不会给 64px 高的 sticky 顶栏让位——吸顶后的标题整个藏进顶栏底下
              （实测吸顶标题 {top:0,bottom:18} 对顶栏 {top:0,bottom:64}），用户根本看不到，
              这个吸顶功能本就无效。取消吸顶同时修好了层叠方向：sticky + z-index:1 会
              让标题连同它的雾浮在后续列表行之上，雾压在卡片玻璃上形成两层 backdrop
              叠加；回到普通流后雾按 DOM 顺序画在卡片之下，这才是产品要的方向。
              雾仍然挂在内层包裹元素上而不是 ListSubheader 本身：haze 配方会给宿主设
              position: relative 与 isolation: isolate，挂外层会改变 ListSubheader 自身
              的定位与层叠语义，内层承载更内聚。每个分组标题各一团雾是可以的——组与
              组之间隔着整组卡片，距离远超 bleed，雾不会互相重叠；上游禁止的是给相邻的
              每一行各挂一团。haze 配方会把文字色设成 n9（color:
              var(--color-neutral-9)），比原 ListSubheader 的 secondary（n7）更深：压在
              图像上的文字需要更高对比度，这是刻意的。形态用上游默认的 cloud——cloud 是
              默认形态，默认不写 data-haze，只有切 veil 才写该属性。宽度与 bleed 照搬
              上游 showcase 的 .glass-review__label：width: max-content 让盒子收缩贴合
              文字（宿主是块级盒 width 才生效，行内盒不吃 width；上游同一档的宿主也是
              块级 p），bleed 取 0.3 × GLASS.hazeBleed（28px → 8.4px）——这一档就是给
              12px 小标签用的，分组标题正是这个场景。 */}
          <Box
            data-glass="haze"
            sx={{ width: 'max-content', '--glass-haze-bleed': `calc(0.3 * ${GLASS.hazeBleed})` }}
          >
            {title}
          </Box>
        </ListSubheader>
      }
      disablePadding
    >
      {items.map((item, index) => (
        <TaskRow
          key={item.id}
          item={item}
          index={index}
          today={today}
          leaving={leavingIds.includes(item.id)}
          animateEnter={animateEnter}
          reduced={reduced}
          sourceName={sourceName}
          onToggle={onToggle}
          onOpen={onOpen}
          onMenuOpen={onMenuOpen}
        />
      ))}
    </List>
  );
}

/**
 * 保存成功的提示文案。一条时报标题（用户看得出记成了什么），多条时只报条数
 * ——四个标题连起来会撑爆 Snackbar 一行。
 * attempted 是本次提交的总条数：只在「部分失败」时才提，全成功不啰嗦。
 */
function savedText(saved: Item[], attempted = saved.length): string {
  const done = saved.length === 1 ? `已保存：${saved[0].title}` : `已保存 ${saved.length} 条`;
  return saved.length < attempted ? `${done}，${attempted - saved.length} 条失败` : done;
}

/** Snackbar 的「查看」按钮只在恰好保存一条时给：多条没有唯一的目标可看 */
function snackItem(saved: Item[]): Item | null {
  return saved.length === 1 ? saved[0] : null;
}

/**
 * 悬浮按钮距视口底边的距离。移动端要越过 64px 底栏并计入安全区。
 * 打开速记面板时按钮下沉让位，位移量按这个值算，两处必须同源。
 */
const FAB_BOTTOM = {
  xs: 'calc(16px + 64px + env(safe-area-inset-bottom))',
  md: '24px',
} as const;

/**
 * 让位位移：自身高度（translateY 的 100%，FAB 直径 56px）+ 距底距离 + 8px 余量，
 * 保证连投影一起移出视口下沿。
 */
const FAB_HIDDEN = {
  xs: `translateY(calc(100% + ${FAB_BOTTOM.xs} + 8px))`,
  md: `translateY(calc(100% + ${FAB_BOTTOM.md} + 8px))`,
} as const;

export default function TasksPage() {
  const [category, setCategory] = useState<Category | null>(null);
  const [leavingIds, setLeavingIds] = useState<number[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [snack, setSnack] = useState<Snack | null>(null);
  const [quickMode, setQuickMode] = useState<boolean>(readQuickMode);
  // 行右键 / 长按的上下文菜单：anchor 与当前条目收在页面，组件只挂一份
  const [rowMenu, setRowMenu] = useState<{ item: Item; point: Point } | null>(null);
  // 空态分流：条目为空时额外查一次账户（有账户 →「没有待办任务」，无账户 → 引导去设置接入）。
  // 只在这一轮列表确实为空时请求一次，不做每次刷新的常驻轮询；失败按「有账户」兜底。
  const [accountsExist, setAccountsExist] = useState<boolean | null>(null);
  const reduced = usePrefersReducedMotion();
  const go = useNavigateTo();
  // 详情容器变换：current 非空即详情对话框打开（来源行与 paper 共享 VT_NAMES.sheet）
  const { current, open, close, sourceName } = useMorphDialog<Item>((item) => item.id);
  const timers = useRef<number[]>([]);

  const today = new Date();

  // 列表的唯一数据源是 list-cache：挂载命中缓存先展示旧数据、后台静默刷新，
  // 未命中才先 loading；animateEnter 只在首次拿到数据的那次挂载为 true。
  const fetcher = useCallback(
    () => fetchItems({ status: 'open', category: category ?? undefined }),
    [category],
  );
  const { items, loading, error, animateEnter } = useCachedList(openKey(category), fetcher);

  // 行右键 / 长按打开菜单：anchor 状态即此处；当前条目一起存，动作按条目构造
  const openRowMenu = useCallback((item: Item, point: Point) => {
    setRowMenu({ item, point });
  }, []);

  useEffect(() => {
    if (loading || error || (items ?? []).length > 0 || accountsExist !== null) return;
    let alive = true;
    fetchStatus()
      .then((s) => {
        if (alive) setAccountsExist((s.accounts?.length ?? 0) > 0);
      })
      .catch(() => {
        // 状态接口失败静默按「有账户」处理，不阻断任务页本身
        if (alive) setAccountsExist(true);
      });
    return () => {
      alive = false;
    };
  }, [loading, error, items, accountsExist]);

  // 保存新条目（一次可能有好几条：一段速记文本拆出的多件事）。
  // 没有批量端点，逐条打 POST /api/items 复用已测代码；allSettled 而非 all，
  // 一条失败不该把已成功的那几条一起吞掉。
  // 只要有一条成功就关窗（那几条已经在列表里了，留着窗口没有意义）；
  // 全失败才保持打开，让用户能直接重试而不用重打一遍。
  const handleCreate = useCallback((fieldsList: ItemFields[]) => {
    setCreating(true);
    Promise.allSettled(fieldsList.map((fields) => createItem(fields)))
      .then((results) => {
        const saved = results
          .filter((r) => r.status === 'fulfilled')
          .map((r) => (r as PromiseFulfilledResult<Item>).value);
        saved.forEach(upsertOpenItem);
        if (saved.length === 0) {
          setSnack({ text: '保存失败', item: null });
          return;
        }
        setAddOpen(false);
        setSnack({ text: savedText(saved, fieldsList.length), item: snackItem(saved) });
      })
      .finally(() => setCreating(false));
  }, []);

  // 速记开关变更：写状态并持久化（写失败仅本次会话生效，不崩页面）
  const handleQuickModeChange = useCallback((next: boolean) => {
    setQuickMode(next);
    try {
      localStorage.setItem(QUICK_MODE_KEY, next ? 'on' : 'off');
    } catch {
      // 隐私模式下写不进去，下次进页回落默认「关」
    }
  }, []);

  // 非速记模式：一段话 → 字段列表交给 AiAddDialog 预览。失败由对话框自己捕获并显示
  // 兜底 UI（契约如此），这里不处理 reject。
  const handleParse = useCallback((text: string) => parseTask(text, todayIso()), []);

  // 速记模式：点「确定」立刻关窗——速记的全部意义就是打完就走，不让用户等 LLM。
  // 落库在后台跑，这个 Promise 故意不绑组件生命周期（不接 AbortController、卸载时
  // 不取消）：请求一旦到达服务端就会跑完并入库，用户切页也要让它继续。结果回来
  // 再弹提示：ai_parsed === false 是正常返回（HTTP 201，后端用原文兜底建了条目），
  // 只有网络失败 / 非 201 才进 catch。
  const handleQuickSubmit = useCallback((text: string) => {
    setAddOpen(false);
    quickAddTask(text, todayIso())
      .then(({ items: saved, ai_parsed }) => {
        saved.forEach(upsertOpenItem);
        setSnack({
          text: ai_parsed ? savedText(saved) : '未能识别内容，已按原文保存',
          item: snackItem(saved),
        });
      })
      .catch(() => setSnack({ text: '保存失败', item: null }));
  }, []);

  // 组件卸载时清掉所有离场动画定时器，避免卸载后 setState
  useEffect(() => {
    return () => {
      timers.current.forEach((t) => clearTimeout(t));
    };
  }, []);

  // 勾选：先入 leaving（离场动画 260ms），动画结束后移进 done 缓存并 PATCH；
  // 请求失败则移回 open 缓存、放行该行并提示。反向恢复由 /done 负责，本页不做。
  const toggleItem = useCallback(
    (item: Item) => {
      if (leavingIds.includes(item.id)) return;
      setLeavingIds((p) => [...p, item.id]);
      const timer = window.setTimeout(() => {
        moveItem(item, 'done');
        patchItem(item.id, { status: 'done' }).catch(() => {
          setLeavingIds((p) => p.filter((id) => id !== item.id));
          moveItem(item, 'open');
          setSnack({ text: '操作失败，已恢复', item: null });
        });
      }, reduced ? 0 : LEAVE_DURATION);
      timers.current.push(timer);
    },
    [leavingIds, reduced],
  );

  const grouped = groupItems(items ?? [], today);

  return (
    <Box>
      <CategoryChips value={category} onChange={setCategory} />
      {loading ? (
        <Box sx={EMPTY_STATE_BOX_SX}>
          <CircularProgress />
        </Box>
      ) : error ? (
        <Alert severity="error" sx={{ mx: 2 }}>
          加载任务失败
        </Alert>
      ) : (
        <>
          <GroupSection
            title="今天"
            items={grouped.today}
            today={today}
            animateEnter={animateEnter}
            leavingIds={leavingIds}
            onToggle={toggleItem}
            onOpen={open}
            sourceName={sourceName}
            onMenuOpen={openRowMenu}
          />
          <GroupSection
            title="本周"
            items={grouped.thisWeek}
            today={today}
            animateEnter={animateEnter}
            leavingIds={leavingIds}
            onToggle={toggleItem}
            onOpen={open}
            sourceName={sourceName}
            onMenuOpen={openRowMenu}
          />
          <GroupSection
            title="重要"
            items={grouped.important}
            today={today}
            animateEnter={animateEnter}
            leavingIds={leavingIds}
            onToggle={toggleItem}
            onOpen={open}
            sourceName={sourceName}
            onMenuOpen={openRowMenu}
          />
          <GroupSection
            title="无期限"
            items={grouped.later}
            today={today}
            animateEnter={animateEnter}
            leavingIds={leavingIds}
            onToggle={toggleItem}
            onOpen={open}
            sourceName={sourceName}
            onMenuOpen={openRowMenu}
          />
          {/* 空态：条目为空时立刻给「没有待办任务」（不等账户探测），只有确认没接入邮箱
              才切换成引导块——有账户/探测失败/探测中都不打断原有文案 */}
          {(items ?? []).length === 0 &&
            (accountsExist === false ? (
              <Stack alignItems="center" spacing={0.5} sx={{ py: 6, px: 2 }}>
                <Typography variant="body1">还没有接入邮箱</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center' }}>
                  接入 Gmail 或 Outlook 后，系统会自动把邮件里的待办整理到这里
                </Typography>
                <Button variant="contained" onClick={() => go('/settings')} sx={{ mt: 1 }}>
                  前往设置接入
                </Button>
              </Stack>
            ) : (
              <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', py: 6 }}>
                没有待办任务
              </Typography>
            ))}
        </>
      )}
      {/* 行右键 / 长按的上下文菜单：全页只挂这一份（anchor 状态在上面），动作全部
          复用页面既有处理函数。菜单纸面材质 data-glass="panel"，Menu 经 Portal 挂到
          body——与列表行只是视觉重叠、不是 DOM 后代，不构成嵌套玻璃（glass.md 明说
          portal 浮层不算 nesting），菜单面板的玻璃预算已在 RowContextMenu 文件头说明。
          动作设计：「编辑」打开详情——本页没有独立编辑入口，编辑流程在 ItemDialog 内
          （详情里手动条目可编辑），所以这一项就是打开详情，标签仍叫「编辑」；「删除」
          同样先打开详情——列表层不重复实现删除与确认流程（删除在 ItemDialog 内，带
          确认弹窗），若在列表层另写删除请求就会出现第二套删除路径。两项行为相同是
          刻意的，区别只在于给用户的预期：编辑 → 去改内容，删除 → 去确认后删除。 */}
      <RowContextMenu
        anchor={rowMenu ? rowMenu.point : null}
        actions={
          rowMenu
            ? [
                { key: 'complete', label: '完成', onSelect: () => toggleItem(rowMenu.item) },
                { key: 'edit', label: '编辑', onSelect: () => open(rowMenu.item) },
                {
                  key: 'delete',
                  label: '删除',
                  danger: true,
                  onSelect: () => open(rowMenu.item),
                },
              ]
            : []
        }
        onClose={() => setRowMenu(null)}
      />
      {current && (
        <ItemDialog
          item={current}
          onClose={close}
          onChanged={(it) => upsertOpenItem(it)}
          onDeleted={(id) => removeItem(id)}
        />
      )}
      {/*
        右下角 + ：新建待办。移动端浮在 64px 底栏（zIndex 1100）之上，计入安全区。
        portal 到 body：路由转场内层动画盒带 transform，会让 fixed 后代的定位退化成
        相对该盒（换页后按钮跟着内容滚）；挂到 body 下才保持视口角落定位。

        与速记面板的编排：按下时按钮下沉让位（state 160ms），面板同时从底部升起
        （large 300ms）；关闭时面板先落下（largeExit 250ms），按钮延后 fadeOut 90ms
        才回位，两者恰好同时收尾。只过渡 transform 一个属性，reduced 下整段取消。
      */}
      {createPortal(
        <Fab
          color="primary"
          aria-label="新建待办"
          onClick={() => setAddOpen(true)}
          sx={{
            position: 'fixed',
            right: { xs: 16, md: 24 },
            bottom: FAB_BOTTOM,
            zIndex: 1150,
            transform: addOpen ? FAB_HIDDEN : 'translateY(0)',
            transition: reduced ? 'none' : `transform ${MOTION.state}ms ${MOTION.easeStandard}`,
            // 打开时立刻让位；关闭时等面板落下去一截再回来，别和它迎头撞上
            transitionDelay: addOpen ? '0ms' : `${MOTION.fadeOut}ms`,
          }}
        >
          <AddIcon />
        </Fab>,
        document.body,
      )}
      {/*
        常驻挂载而不是 {addOpen && ...}：条件渲染会在关闭那一刻直接卸载整棵子树，
        MUI 的退场过渡根本跑不到（这正是改版前「打开有动画、关闭没有」的原因）。
        open 交给 Dialog，由它在退场跑完后自己卸载内容。
      */}
      <AiAddDialog
        open={addOpen}
        quickMode={quickMode}
        onQuickModeChange={handleQuickModeChange}
        onParse={handleParse}
        onSubmit={handleCreate}
        onQuickSubmit={handleQuickSubmit}
        submitting={creating}
        onClose={() => setAddOpen(false)}
      />
      <Snackbar
        open={snack !== null}
        autoHideDuration={3000}
        onClose={() => setSnack(null)}
        message={snack ? snack.text : null}
        action={
          snack?.item ? (
            <Button
              color="inherit"
              size="small"
              onClick={() => {
                if (snack?.item) {
                  open(snack.item);
                  setSnack(null);
                }
              }}
            >
              查看
            </Button>
          ) : undefined
        }
      />
    </Box>
  );
}
