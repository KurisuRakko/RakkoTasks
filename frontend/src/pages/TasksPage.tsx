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

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
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
import { createItem, fetchItems, patchItem } from '../lib/api';
import { formatDueDate, groupItems, isNewToday, isOverdue } from '../lib/grouping';
import { moveItem, openKey, removeItem, upsertOpenItem, useCachedList } from '../lib/list-cache';
import { LEAVE_DURATION, rowSx, useMorphDialog, usePrefersReducedMotion } from '../lib/motion';
import { cardRowSx } from '../lib/surface';
import { runViewTransition, shellAttr, VT_NAMES } from '../lib/view-transition';
import type { Category, Item, ItemFields } from '../types';
import CategoryChips from '../components/CategoryChips';
import ItemDialog from '../components/ItemDialog';
import ItemEditor from '../components/ItemEditor';

function GroupSection({
  title,
  items,
  today,
  animateEnter,
  leavingIds,
  onToggle,
  onOpen,
  sourceName,
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
}) {
  const reduced = usePrefersReducedMotion();
  if (items.length === 0) return null; // 空组不渲染
  return (
    <List
      subheader={
        <ListSubheader component="div" sx={{ bgcolor: 'transparent' }}>
          {title}
        </ListSubheader>
      }
      disablePadding
    >
      {items.map((item, index) => {
        const leaving = leavingIds.includes(item.id);
        return (
          <ListItem
            key={item.id}
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
            <ListItemButton data-glass="panel" sx={cardRowSx()} onClick={() => onOpen(item)}>
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
              </Stack>
            </ListItemButton>
          </ListItem>
        );
      })}
    </List>
  );
}

export default function TasksPage() {
  const [category, setCategory] = useState<Category | null>(null);
  const [leavingIds, setLeavingIds] = useState<number[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [snack, setSnack] = useState<string | null>(null);
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

  // 保存新条目：成功写进缓存（分类匹配与否由缓存键决定），失败保持编辑器打开
  const handleCreate = useCallback(
    (fields: ItemFields) => {
      setCreating(true);
      createItem(fields)
        .then((item) => {
          upsertOpenItem(item);
          // 保存成功后编辑器关闭同样走容器变换，缩回悬浮按钮
          runViewTransition('collapse-fab', () => setAddOpen(false), reduced);
          setSnack('已添加');
        })
        .catch(() => setSnack('添加失败'))
        .finally(() => setCreating(false));
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
          setSnack('操作失败，已恢复');
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
          />
          {(items ?? []).length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', py: 6 }}>
              没有待办任务
            </Typography>
          )}
        </>
      )}
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
        名字由 ItemEditor 的 paper 独占、做来源按钮 → 编辑器整页的容器变换；换页与
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
            // 编辑器打开期间内联 none 让名给 ItemEditor 的 paper；其余交给样式层
            viewTransitionName: addOpen ? 'none' : undefined,
          }}
        >
          <AddIcon />
        </Fab>,
        document.body,
      )}
      {addOpen && (
        <ItemEditor
          heading="添加任务"
          submitting={creating}
          onSubmit={handleCreate}
          onClose={() => runViewTransition('collapse-fab', () => setAddOpen(false), reduced)}
          viewTransitionName={VT_NAMES.fab}
        />
      )}
      <Snackbar
        open={snack !== null}
        autoHideDuration={3000}
        onClose={() => setSnack(null)}
        message={snack}
      />
    </Box>
  );
}
