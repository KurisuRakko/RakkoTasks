// 任务页：分类筛选 + 按截止日期分组列表（今天/本周/无期限）。
// 列表数据来自 list-cache 模块级缓存（唯一数据源）：挂载先显示缓存旧数据、后台
// 静默刷新，不再每次先闪加载圈；勾选 → 离场动画 → moveItem 进 done 缓存并 PATCH。
// 入场 stagger 只在「这份列表首次拿到数据」时跑（useCachedList.animateEnter），
// 命中缓存直接就位不重放。已完成列表在 /done，本页不持有 done 数据。
// 条目左侧小蓝点表示源邮件是今天发的，按日期自动过期，与查看/勾选状态无关。
// 列表行与详情 Dialog 共用 VT_NAMES.sheet 做容器变换（点哪行哪行长成对话框）；
// 右下角悬浮按钮经 portal 挂到 body——路由转场内层动画盒的 transform 会成为
// fixed 后代的包含块，换页后按钮会跟着内容漂移。按钮只打 data-vt-shell 标记，
// 与编辑器共用名字的持名时机由样式层按转场种类决定（见 FAB 处注释）。
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
import { createItem, fetchItems, parseTask, patchItem, quickAddTask } from '../lib/api';
import { formatDueDate, groupItems, isNewToday, isOverdue } from '../lib/grouping';
import { moveItem, openKey, removeItem, upsertOpenItem, useCachedList } from '../lib/list-cache';
import { LEAVE_DURATION, rowSx, useMorphDialog, usePrefersReducedMotion } from '../lib/motion';
import { useLongPress } from '../lib/long-press';
import { cardRowSx } from '../lib/surface';
import { formatReminder, todayIso } from '../lib/time';
import { runViewTransition, shellAttr, VT_NAMES } from '../lib/view-transition';
import { GLASS } from '../rakko-tokens';
import type { Category, Item, ItemFields, Reminder } from '../types';
import AiAddDialog from '../components/AiAddDialog';
import CategoryChips from '../components/CategoryChips';
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

/**
 * 行上提醒 chip 的展示：🔔 最早一条提醒的展示文案，多于一条时追加「 +N」。
 * 显式按 remind_at 的绝对时刻排序取最早，不依赖后端数组顺序（后端契约虽是升序，
 * 展示方不赌调用方守约）。返回可见文案（label）与 aria-label 用的纯文案。
 */
function reminderChipLabel(reminders: Reminder[]): { text: string; label: string } {
  const sorted = [...reminders].sort(
    (a, b) => new Date(a.remind_at).getTime() - new Date(b.remind_at).getTime(),
  );
  const text = formatReminder(sorted[0].remind_at);
  const extra = sorted.length > 1 ? ` +${sorted.length - 1}` : '';
  return { text, label: `🔔 ${text}${extra}` };
}

/** Snackbar 内容：text 是提示文案；item 非 null 时右侧多一个「查看」按钮开详情 */
type Snack = { text: string; item: Item | null };

/** 行右键 / 长按菜单的弹出位置（视口坐标） */
type Point = { x: number; y: number };

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
  // 提醒 chip 的展示（最早一条 + 超出条数）；无提醒时不渲染
  const reminder = item.reminders.length > 0 ? reminderChipLabel(item.reminders) : null;
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
          // 长按行体时 iOS 会弹系统文本选择菜单（触摸保持 500ms 即触发），行内文字
          // 也不是可选中文本——userSelect 与 WebkitTouchCallout 一并关掉，长按只走
          // 我们自己的手势（合并进 cardRowSx 的 sx 数组，surface.ts 不动）
          { WebkitTouchCallout: 'none', userSelect: 'none' },
        ]}
        onClick={() => onOpen(item)}
        onContextMenu={(e) => {
          e.preventDefault(); // 不让浏览器弹系统菜单，改弹行上下文菜单
          onMenuOpen(item, { x: e.clientX, y: e.clientY });
        }}
        {...longPress}
      >
        <Box sx={{ width: 12, display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
          {isNewToday(item, today) && (
            <Box
              role="img"
              aria-label="今日新邮件"
              sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'primary.main' }}
            />
          )}
        </Box>
        <Checkbox
          edge="start"
          checked={leaving}
          tabIndex={-1}
          disableRipple
          onClick={(e) => {
            e.stopPropagation();
            onToggle(item);
          }}
        />
        <ListItemText
          primary={item.title}
          secondary={item.summary}
          secondaryTypographyProps={{
            sx: {
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
            },
          }}
        />
        {/* 右侧标签成组：整组 flexShrink: 0，长标题换行时标签不被挤压截断。
            行已由 rowSx 的 grid 列撑满容器宽度（见 motion.ts），标签组自然贴右 */}
        <Stack
          direction="row"
          spacing={0.5}
          alignItems="center"
          sx={{ ml: 1, flexShrink: 0 }}
        >
          {item.importance === 'high' && (
            <Chip
              label="重要"
              color="warning"
              size="small"
              variant="outlined"
            />
          )}
          <Chip label={item.category} size="small" variant="outlined" />
          {item.due_date && (
            <Chip
              label={formatDueDate(item.due_date)}
              size="small"
              color={isOverdue(item, today) ? 'error' : 'default'}
            />
          )}
          {reminder && (
            <Chip
              label={reminder.label}
              size="small"
              aria-label={`提醒 ${reminder.text}`}
            />
          )}
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

export default function TasksPage() {
  const [category, setCategory] = useState<Category | null>(null);
  const [leavingIds, setLeavingIds] = useState<number[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [snack, setSnack] = useState<Snack | null>(null);
  const [quickMode, setQuickMode] = useState<boolean>(readQuickMode);
  // 行右键 / 长按的上下文菜单：anchor 与当前条目收在页面，组件只挂一份
  const [rowMenu, setRowMenu] = useState<{ item: Item; point: Point } | null>(null);
  const reduced = usePrefersReducedMotion();
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

  // 保存新条目：成功写进缓存（分类匹配与否由缓存键决定），失败保持编辑器打开
  const handleCreate = useCallback(
    (fields: ItemFields) => {
      setCreating(true);
      createItem(fields)
        .then((item) => {
          upsertOpenItem(item);
          // 保存成功后编辑器关闭同样走容器变换，缩回悬浮按钮
          runViewTransition('collapse-fab', () => setAddOpen(false), reduced);
          setSnack({ text: '已添加', item: null });
        })
        .catch(() => setSnack({ text: '添加失败', item: null }))
        .finally(() => setCreating(false));
    },
    [reduced],
  );

  // 速记开关变更：写状态并持久化（写失败仅本次会话生效，不崩页面）
  const handleQuickModeChange = useCallback((next: boolean) => {
    setQuickMode(next);
    try {
      localStorage.setItem(QUICK_MODE_KEY, next ? 'on' : 'off');
    } catch {
      // 隐私模式下写不进去，下次进页回落默认「关」
    }
  }, []);

  // 非速记模式：一句话 → 字段交给 AiAddDialog 预览。失败由对话框自己捕获并显示
  // 兜底 UI（契约如此），这里不处理 reject。
  const handleParse = useCallback((text: string) => parseTask(text, todayIso()), []);

  // 速记模式：点「确定」立刻关窗——速记的全部意义就是打完就走，不让用户等 LLM。
  // 落库在后台跑，这个 Promise 故意不绑组件生命周期（不接 AbortController、卸载时
  // 不取消）：请求一旦到达服务端就会跑完并入库，用户切页也要让它继续。结果回来
  // 再弹提示：ai_parsed === false 是正常返回（HTTP 201，后端用原文兜底建了条目），
  // 只有网络失败 / 非 201 才进 catch。
  const handleQuickSubmit = useCallback(
    (text: string) => {
      runViewTransition('collapse-fab', () => setAddOpen(false), reduced);
      quickAddTask(text, todayIso())
        .then(({ item, ai_parsed }) => {
          upsertOpenItem(item);
          setSnack({
            text: ai_parsed ? `已添加：${item.title}` : 'AI 解析失败，已按原文添加',
            item,
          });
        })
        .catch(() => setSnack({ text: '添加失败', item: null }));
    },
    [reduced],
  );

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
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
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
          {(items ?? []).length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', py: 6 }}>
              没有待办任务
            </Typography>
          )}
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
        右下角 + ：手动添加待办。移动端浮在 64px 底栏（zIndex 1100）之上，计入安全区。
        portal 到 body：路由转场内层动画盒带 transform，会让 fixed 后代的定位退化成
        相对该盒（换页后按钮跟着内容滚）；挂到 body 下才保持视口角落定位。
        right/bottom/zIndex 保持原值不动。持名策略：编辑器打开期间这里内联 none 让名，
        名字由 AiAddDialog 的 paper 独占、做来源按钮 → 对话框整页的容器变换；换页与
        expand-fab / collapse-fab 时由样式层按 data-vt-shell 下发名字；打开详情
        （expand / collapse）时不持名，按钮留在 root 快照里跟遮罩一起压暗。
      */}
      {createPortal(
        <Fab
          color="primary"
          aria-label="添加任务"
          {...shellAttr(VT_NAMES.fab)}
          onClick={() => runViewTransition('expand-fab', () => setAddOpen(true), reduced)}
          sx={{
            position: 'fixed',
            right: { xs: 16, md: 24 },
            bottom: { xs: 'calc(16px + 64px + env(safe-area-inset-bottom))', md: 24 },
            zIndex: 1150,
            // 对话框打开期间内联 none 让名给 AiAddDialog 的 paper；其余交给样式层
            viewTransitionName: addOpen ? 'none' : undefined,
          }}
        >
          <AddIcon />
        </Fab>,
        document.body,
      )}
      {addOpen && (
        <AiAddDialog
          quickMode={quickMode}
          onQuickModeChange={handleQuickModeChange}
          onParse={handleParse}
          onSubmit={handleCreate}
          onQuickSubmit={handleQuickSubmit}
          submitting={creating}
          onClose={() => runViewTransition('collapse-fab', () => setAddOpen(false), reduced)}
          viewTransitionName={VT_NAMES.fab}
        />
      )}
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
