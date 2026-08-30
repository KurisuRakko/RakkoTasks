// 已完成页：勾掉即恢复为待办（乐观移除 + 离场动画 + PATCH open，失败回滚）。

import { useCallback, useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Snackbar from '@mui/material/Snackbar';
import Typography from '@mui/material/Typography';
import { fetchItems, patchItem } from '../lib/api';
import { enterSx, LEAVE_SX, usePrefersReducedMotion } from '../lib/motion';
import type { Item } from '../types';
import ItemDialog from '../components/ItemDialog';

export default function DonePage() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [leavingIds, setLeavingIds] = useState<number[]>([]);
  const [editing, setEditing] = useState<Item | null>(null);
  const [snack, setSnack] = useState<string | null>(null);
  const reduced = usePrefersReducedMotion();
  const timers = useRef<number[]>([]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchItems({ status: 'done' })
      .then((list) => {
        if (alive) setItems(list);
      })
      .catch(() => {
        if (alive) setError(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // 组件卸载时清掉所有离场动画定时器，避免卸载后 setState
  useEffect(() => {
    return () => {
      timers.current.forEach((t) => clearTimeout(t));
    };
  }, []);

  /** 请求失败回滚：移出 leaving、放回列表、提示 */
  const restore = useCallback((item: Item) => {
    setLeavingIds((p) => p.filter((id) => id !== item.id));
    setItems((p) => (p.some((i) => i.id === item.id) ? p : [item, ...p]));
    setSnack('操作失败，已恢复');
  }, []);

  // 取消勾选：离场动画结束后移除并 PATCH open，失败回滚
  const handleUncheck = useCallback(
    (item: Item) => {
      if (leavingIds.includes(item.id)) return;
      setLeavingIds((p) => [...p, item.id]);
      const timer = window.setTimeout(() => {
        setItems((p) => p.filter((i) => i.id !== item.id));
        patchItem(item.id, { status: 'open' }).catch(() => restore(item));
      }, reduced ? 0 : 260);
      timers.current.push(timer);
    },
    [leavingIds, reduced, restore],
  );

  return (
    <Box>
      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      ) : error ? (
        <Alert severity="error" sx={{ mx: 2 }}>
          加载已完成列表失败
        </Alert>
      ) : items.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', py: 6 }}>
          暂无已完成的条目
        </Typography>
      ) : (
        <List disablePadding>
          {items.map((item, index) => {
            const leaving = leavingIds.includes(item.id);
            return (
              <ListItem
                key={item.id}
                disablePadding
                sx={leaving ? LEAVE_SX : enterSx(index, reduced)}
              >
                <ListItemButton onClick={() => setEditing(item)}>
                  <Checkbox
                    edge="start"
                    checked={!leaving}
                    tabIndex={-1}
                    disableRipple
                    onClick={(e) => {
                      e.stopPropagation();
                      handleUncheck(item);
                    }}
                  />
                  <ListItemText
                    primary={item.title}
                    secondary={item.summary}
                    secondaryTypographyProps={{ noWrap: true }}
                    sx={{ textDecoration: 'line-through', color: 'text.disabled' }}
                  />
                </ListItemButton>
              </ListItem>
            );
          })}
        </List>
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
