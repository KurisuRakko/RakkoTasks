// 任务页：分类筛选 + 按截止日期分组列表（今天/本周/无期限）+ 底部已完成折叠区。

import { useCallback, useEffect, useState } from 'react';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Alert from '@mui/material/Alert';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import Snackbar from '@mui/material/Snackbar';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import { fetchItems, patchItem } from '../lib/api';
import { formatDueDate, groupItems, isOverdue } from '../lib/grouping';
import type { Category, Item, ItemStatus } from '../types';
import CategoryChips from '../components/CategoryChips';
import ItemDialog from '../components/ItemDialog';

function GroupSection({
  title,
  items,
  today,
  onToggle,
  onOpen,
}: {
  title: string;
  items: Item[];
  today: Date;
  onToggle: (item: Item) => void;
  onOpen: (item: Item) => void;
}) {
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
      {items.map((item) => (
        <ListItem key={item.id} disablePadding>
          <ListItemButton onClick={() => onOpen(item)}>
            <Checkbox
              edge="start"
              checked={false}
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
      ))}
    </List>
  );
}

export default function TasksPage() {
  const [category, setCategory] = useState<Category | null>(null);
  const [openItems, setOpenItems] = useState<Item[]>([]);
  const [doneItems, setDoneItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [doneLoaded, setDoneLoaded] = useState(false);
  const [doneExpanded, setDoneExpanded] = useState(false);
  const [editing, setEditing] = useState<Item | null>(null);
  const [snack, setSnack] = useState<string | null>(null);

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

  // 展开已完成折叠区时拉取 done 列表（只拉一次）
  useEffect(() => {
    if (!doneExpanded || doneLoaded) return;
    let alive = true;
    fetchItems({ status: 'done' })
      .then((items) => {
        if (alive) {
          setDoneItems(items);
          setDoneLoaded(true);
        }
      })
      .catch(() => {
        if (alive) setSnack('加载已完成列表失败');
      });
    return () => {
      alive = false;
    };
  }, [doneExpanded, doneLoaded]);

  // 勾选/反勾：乐观更新跨两表移动，失败回滚并提示
  const toggleItem = useCallback((item: Item) => {
    const target: ItemStatus = item.status === 'open' ? 'done' : 'open';
    if (item.status === 'open') {
      setOpenItems((p) => p.filter((i) => i.id !== item.id));
      setDoneItems((p) => [item, ...p]);
    } else {
      setDoneItems((p) => p.filter((i) => i.id !== item.id));
      setOpenItems((p) => [item, ...p]);
    }
    patchItem(item.id, { status: target }).catch(() => {
      // 回滚（列表顺序可能略有变化，状态保持一致）
      if (target === 'done') {
        setDoneItems((p) => p.filter((i) => i.id !== item.id));
        setOpenItems((p) => [item, ...p]);
      } else {
        setOpenItems((p) => p.filter((i) => i.id !== item.id));
        setDoneItems((p) => [item, ...p]);
      }
      setSnack('操作失败，已恢复');
    });
  }, []);

  const grouped = groupItems(openItems, today);

  return (
    <Box>
      <AppBar position="static" elevation={0}>
        <Toolbar>
          <Typography variant="h6" noWrap>
            RakkoTasks
          </Typography>
        </Toolbar>
      </AppBar>
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
            onToggle={toggleItem}
            onOpen={setEditing}
          />
          <GroupSection
            title="本周"
            items={grouped.thisWeek}
            today={today}
            onToggle={toggleItem}
            onOpen={setEditing}
          />
          <GroupSection
            title="无期限"
            items={grouped.later}
            today={today}
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
      <Accordion
        expanded={doneExpanded}
        onChange={(_e, expanded) => setDoneExpanded(expanded)}
        sx={{ mt: 2, mx: 1 }}
      >
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Typography variant="subtitle2">已完成</Typography>
        </AccordionSummary>
        <AccordionDetails sx={{ p: 0 }}>
          {doneItems.map((item) => (
            <ListItem key={item.id} disablePadding>
              <ListItemButton onClick={() => setEditing(item)}>
                <Checkbox
                  edge="start"
                  checked
                  tabIndex={-1}
                  disableRipple
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleItem(item);
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
          ))}
          {doneItems.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
              暂无已完成的条目
            </Typography>
          )}
        </AccordionDetails>
      </Accordion>
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
