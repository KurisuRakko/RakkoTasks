// 任务页：分类筛选 + 按截止日期分组列表（今天/本周/无期限）。
// 勾选 → 离场动画 → 移除并 PATCH done；已完成列表已拆到 /done，本页不再持有 done 数据。

import { useCallback, useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import Snackbar from '@mui/material/Snackbar';
import Typography from '@mui/material/Typography';
import { fetchItems, patchItem } from '../lib/api';
import { formatDueDate, groupItems, isOverdue } from '../lib/grouping';
import { enterSx, LEAVE_SX, usePrefersReducedMotion } from '../lib/motion';
import type { Category, Item } from '../types';
import CategoryChips from '../components/CategoryChips';
import ItemDialog from '../components/ItemDialog';

function GroupSection({
  title,
  items,
  today,
  leavingIds,
  onToggle,
  onOpen,
}: {
  title: string;
  items: Item[];
  today: Date;
  leavingIds: number[];
  onToggle: (item: Item) => void;
  onOpen: (item: Item) => void;
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
            sx={leaving ? LEAVE_SX : enterSx(index, reduced)}
          >
            <ListItemButton onClick={() => onOpen(item)}>
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
  const [editing, setEditing] = useState<Item | null>(null);
  const [snack, setSnack] = useState<string | null>(null);
  const reduced = usePrefersReducedMotion();
  const timers = useRef<number[]>([]);

  const today = new Date();

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
      }, reduced ? 0 : 260);
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
            onOpen={setEditing}
          />
          <GroupSection
            title="本周"
            items={grouped.thisWeek}
            today={today}
            leavingIds={leavingIds}
            onToggle={toggleItem}
            onOpen={setEditing}
          />
          <GroupSection
            title="无期限"
            items={grouped.later}
            today={today}
            leavingIds={leavingIds}
            onToggle={toggleItem}
            onOpen={setEditing}
          />
          {openItems.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', py: 6 }}>
              没有待办任务
            </Typography>
          )}
        </>
      )}
      {editing && <ItemDialog item={editing} onClose={() => setEditing(null)} />}
      <Snackbar
        open={snack !== null}
        autoHideDuration={3000}
        onClose={() => setSnack(null)}
        message={snack}
      />
    </Box>
  );
}
