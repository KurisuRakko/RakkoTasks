// 已完成页：勾掉即恢复为待办（乐观移除 + 离场动画 + PATCH open，失败回滚）。
// 列表数据来自 list-cache 模块级缓存（唯一数据源）：挂载命中缓存先同步展示、
// 后台静默刷新；恢复待办时 moveItem 同步进 open 列表的缓存。入场 stagger 只在
// 这份列表首次拿到数据时跑（useCachedList.animateEnter）。
// 列表行与详情 Dialog 共用 VT_NAMES.sheet 做容器变换。

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
import { DONE_KEY, moveItem, removeItem, replaceItem, useCachedList } from '../lib/list-cache';
import { LEAVE_DURATION, rowSx, useMorphDialog, usePrefersReducedMotion } from '../lib/motion';
import { cardRowSx } from '../lib/surface';
import type { Item } from '../types';
import ItemDialog from '../components/ItemDialog';

export default function DonePage() {
  const [leavingIds, setLeavingIds] = useState<number[]>([]);
  const [snack, setSnack] = useState<string | null>(null);
  const reduced = usePrefersReducedMotion();
  // 详情容器变换：current 非空即详情对话框打开（来源行与 paper 共享 VT_NAMES.sheet）
  const { current, open, close, sourceName } = useMorphDialog<Item>((item) => item.id);
  const timers = useRef<number[]>([]);

  // 列表的唯一数据源是 list-cache：命中缓存先展示旧数据、后台静默刷新
  const fetcher = useCallback(() => fetchItems({ status: 'done' }), []);
  const { items, loading, error, animateEnter } = useCachedList(DONE_KEY, fetcher);

  // 组件卸载时清掉所有离场动画定时器，避免卸载后 setState
  useEffect(() => {
    return () => {
      timers.current.forEach((t) => clearTimeout(t));
    };
  }, []);

  /** 请求失败回滚：移出 leaving、把条目放回 done 缓存、提示 */
  const restore = useCallback((item: Item) => {
    setLeavingIds((p) => p.filter((id) => id !== item.id));
    moveItem(item, 'done');
    setSnack('操作失败，已恢复');
  }, []);

  // 取消勾选：离场动画结束后移进 open 缓存并 PATCH open，失败回滚
  const handleUncheck = useCallback(
    (item: Item) => {
      if (leavingIds.includes(item.id)) return;
      setLeavingIds((p) => [...p, item.id]);
      const timer = window.setTimeout(() => {
        moveItem(item, 'open');
        patchItem(item.id, { status: 'open' }).catch(() => restore(item));
      }, reduced ? 0 : LEAVE_DURATION);
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
      ) : (items ?? []).length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', py: 6 }}>
          暂无已完成的条目
        </Typography>
      ) : (
        <List disablePadding>
          {(items ?? []).map((item, index) => {
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
                <ListItemButton sx={cardRowSx} onClick={() => open(item)}>
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
      {current && (
        <ItemDialog
          item={current}
          onClose={close}
          onChanged={(it) => replaceItem(it)}
          onDeleted={(id) => removeItem(id)}
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
