// 任务页：分类筛选 + 按截止日期分组列表（今天/本周/无期限）。
// 勾选 → 离场动画 → 移除并 PATCH done；已完成列表已拆到 /done，本页不再持有 done 数据。
// 条目左侧小蓝点表示源邮件是今天发的，按日期自动过期，与查看/勾选状态无关。
// 列表行与详情 Dialog 共用 VT_NAMES.sheet 做容器变换（点哪行哪行长成对话框）；
// 右下角悬浮 + 与 ItemEditor 共用 VT_NAMES.fab 变换，经 portal 挂到 body ——
// 路由转场内层动画盒的 transform 会成为 fixed 后代的包含块，换页后按钮会跟着内容漂移。

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
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import { createItem, fetchItems, patchItem } from '../lib/api';
import { formatDueDate, groupItems, isNewToday, isOverdue } from '../lib/grouping';
import { LEAVE_DURATION, rowSx, useMorphDialog, usePrefersReducedMotion } from '../lib/motion';
import { runViewTransition, VT_NAMES } from '../lib/view-transition';
import type { Category, Item, ItemFields } from '../types';
import CategoryChips from '../components/CategoryChips';
import ItemDialog from '../components/ItemDialog';
import ItemEditor from '../components/ItemEditor';

function GroupSection({
  title,
  items,
  today,
  leavingIds,
  onToggle,
  onOpen,
  sourceName,
}: {
  title: string;
  items: Item[];
  today: Date;
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
              ...rowSx(index, leaving, reduced),
              viewTransitionName: sourceName(item.id),
            }}
          >
            <ListItemButton onClick={() => onOpen(item)}>
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
              {item.importance === 'high' && (
                <Chip label="重要" color="warning" size="small" variant="outlined" sx={{ ml: 1 }} />
              )}
              <Chip label={item.category} size="small" variant="outlined" sx={{ ml: 1 }} />
              {item.due_date && (
                <Chip
                  label={formatDueDate(item.due_date)}
                  size="small"
                  color={isOverdue(item, today) ? 'error' : 'default'}
                  sx={{ ml: 0.5 }}
                />
              )}
            </ListItemButton>
          </ListItem>
        );
      })}
    </List>
  );
}

export default function TasksPage() {
  const [category, setCategory] = useState<Category | null>(null);
  const [openItems, setOpenItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [leavingIds, setLeavingIds] = useState<number[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [snack, setSnack] = useState<string | null>(null);
  const reduced = usePrefersReducedMotion();
  // 详情容器变换：current 非空即详情对话框打开（来源行与 paper 共享 VT_NAMES.sheet）
  const { current, open, close, sourceName } = useMorphDialog<Item>((item) => item.id);
  const timers = useRef<number[]>([]);

  const today = new Date();

  // 保存新条目：成功插入本页列表头部（若当前分类筛选为空或命中新条目分类），失败保持编辑器打开
  const handleCreate = useCallback(
    (fields: ItemFields) => {
      setCreating(true);
      createItem(fields)
        .then((item) => {
          if (category === null || category === item.category) {
            setOpenItems((p) => [item, ...p]);
          }
          // 保存成功后编辑器关闭同样走容器变换，缩回悬浮按钮
          runViewTransition('collapse', () => setAddOpen(false), reduced);
          setSnack('已添加');
        })
        .catch(() => setSnack('添加失败'))
        .finally(() => setCreating(false));
    },
    [category, reduced],
  );

  const loadOpen = useCallback(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    fetchItems({ status: 'open', category: category ?? undefined })
      .then((items) => {
        if (alive) setOpenItems(items);
      })
      .catch(() => {
        if (alive) setLoadError('加载任务失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [category]);

  useEffect(() => {
    return loadOpen();
  }, [loadOpen]);

  // 组件卸载时清掉所有离场动画定时器，避免卸载后 setState
  useEffect(() => {
    return () => {
      timers.current.forEach((t) => clearTimeout(t));
    };
  }, []);

  // 勾选：先入 leaving（离场动画 260ms），动画结束后移除并 PATCH done；
  // 请求失败则放回原列表并提示。反向恢复由 /done 负责，本页不做。
  const toggleItem = useCallback(
    (item: Item) => {
      if (leavingIds.includes(item.id)) return;
      setLeavingIds((p) => [...p, item.id]);
      const timer = window.setTimeout(() => {
        setOpenItems((p) => p.filter((i) => i.id !== item.id));
        patchItem(item.id, { status: 'done' }).catch(() => {
          setLeavingIds((p) => p.filter((id) => id !== item.id));
          setOpenItems((p) => (p.some((i) => i.id === item.id) ? p : [item, ...p]));
          setSnack('操作失败，已恢复');
        });
      }, reduced ? 0 : LEAVE_DURATION);
      timers.current.push(timer);
    },
    [leavingIds, reduced],
  );

  const grouped = groupItems(openItems, today);

  return (
    <Box>
      <CategoryChips value={category} onChange={setCategory} />
      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      ) : loadError ? (
        <Alert severity="error" sx={{ mx: 2 }}>
          {loadError}
        </Alert>
      ) : (
        <>
          <GroupSection
            title="今天"
            items={grouped.today}
            today={today}
            leavingIds={leavingIds}
            onToggle={toggleItem}
            onOpen={open}
            sourceName={sourceName}
          />
          <GroupSection
            title="本周"
            items={grouped.thisWeek}
            today={today}
            leavingIds={leavingIds}
            onToggle={toggleItem}
            onOpen={open}
            sourceName={sourceName}
          />
          <GroupSection
            title="重要"
            items={grouped.important}
            today={today}
            leavingIds={leavingIds}
            onToggle={toggleItem}
            onOpen={open}
            sourceName={sourceName}
          />
          <GroupSection
            title="无期限"
            items={grouped.later}
            today={today}
            leavingIds={leavingIds}
            onToggle={toggleItem}
            onOpen={open}
            sourceName={sourceName}
          />
          {openItems.length === 0 && (
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
          onChanged={(it) => setOpenItems((p) => p.map((i) => (i.id === it.id ? it : i)))}
          onDeleted={(id) => setOpenItems((p) => p.filter((i) => i.id !== id))}
        />
      )}
      {/*
        右下角 + ：手动添加待办。移动端浮在 64px 底栏（zIndex 1100）之上，计入安全区。
        portal 到 body：路由转场内层动画盒带 transform，会让 fixed 后代的定位退化成
        相对该盒（换页后按钮跟着内容滚）；挂到 body 下才保持视口角落定位。
        right/bottom/zIndex 保持原值不动。编辑器打开期间按钮让名（'none'），
        由 ItemEditor 的 paper 独占 VT_NAMES.fab，做来源按钮 → 编辑器整页的容器变换。
      */}
      {createPortal(
        <Fab
          color="primary"
          aria-label="添加任务"
          onClick={() => runViewTransition('expand', () => setAddOpen(true), reduced)}
          sx={{
            position: 'fixed',
            right: { xs: 16, md: 24 },
            bottom: { xs: 'calc(16px + 64px + env(safe-area-inset-bottom))', md: 24 },
            zIndex: 1150,
            viewTransitionName: addOpen ? 'none' : VT_NAMES.fab,
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
          onClose={() => runViewTransition('collapse', () => setAddOpen(false), reduced)}
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
