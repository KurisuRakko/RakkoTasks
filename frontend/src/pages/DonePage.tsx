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
import { useLongPress } from '../lib/long-press';
import { LEAVE_DURATION, rowSx, useMorphDialog, usePrefersReducedMotion } from '../lib/motion';
import { cardRowSx } from '../lib/surface';
import type { Item } from '../types';
import ItemDialog from '../components/ItemDialog';
import RowContextMenu from '../components/RowContextMenu';

/** 行右键 / 长按菜单的弹出位置（视口坐标） */
type Point = { x: number; y: number };

/** 单行已完成条目（拆成独立组件：长按 hook 需要逐行一份实例，不能放在 map 的循环体里） */
function DoneRow({
  item,
  index,
  leaving,
  animateEnter,
  reduced,
  sourceName,
  onUncheck,
  onOpen,
  onMenuOpen,
}: {
  item: Item;
  index: number;
  leaving: boolean;
  animateEnter: boolean;
  reduced: boolean;
  /** 容器变换来源行命名：仅对话框关闭且该行是上一次来源时持名 */
  sourceName: (key: number) => string | undefined;
  onUncheck: (item: Item) => void;
  onOpen: (item: Item) => void;
  /** 右键 / 长按弹出上下文菜单：anchor 状态收在页面，这里只上报条目与落点 */
  onMenuOpen: (item: Item, point: Point) => void;
}) {
  // 长按 500ms 弹菜单（touch 路径与桌面 contextmenu 分开，理由见 lib/long-press.ts）
  const longPress = useLongPress((point) => onMenuOpen(item, point));
  return (
    <ListItem
      disablePadding
      sx={{
        ...rowSx(index, leaving, reduced, animateEnter),
        viewTransitionName: sourceName(item.id),
      }}
    >
      {/* 每行一块 data-glass="panel" 玻璃（偏离上游 anti-patterns 的决定，
          理由见 surface.ts 文件头），cardRowSx 只补圆角 */}
      <ListItemButton
        data-glass="panel"
        sx={[
          cardRowSx(),
          // 长按行体时 iOS 会弹系统文本选择菜单，行内文字也不是可选中文本——
          // userSelect 与 WebkitTouchCallout 一并关掉，长按只走我们自己的手势
          { WebkitTouchCallout: 'none', userSelect: 'none' },
        ]}
        onClick={() => onOpen(item)}
        onContextMenu={(e) => {
          e.preventDefault(); // 不让浏览器弹系统菜单，改弹行上下文菜单
          onMenuOpen(item, { x: e.clientX, y: e.clientY });
        }}
        {...longPress}
      >
        <Checkbox
          edge="start"
          checked={!leaving}
          tabIndex={-1}
          disableRipple
          onClick={(e) => {
            e.stopPropagation();
            onUncheck(item);
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
}

export default function DonePage() {
  const [leavingIds, setLeavingIds] = useState<number[]>([]);
  const [snack, setSnack] = useState<string | null>(null);
  // 行右键 / 长按的上下文菜单：anchor 与当前条目收在页面，组件只挂一份
  const [rowMenu, setRowMenu] = useState<{ item: Item; point: Point } | null>(null);
  const reduced = usePrefersReducedMotion();
  // 详情容器变换：current 非空即详情对话框打开（来源行与 paper 共享 VT_NAMES.sheet）
  const { current, open, close, sourceName } = useMorphDialog<Item>((item) => item.id);
  const timers = useRef<number[]>([]);

  // 列表的唯一数据源是 list-cache：命中缓存先展示旧数据、后台静默刷新
  const fetcher = useCallback(() => fetchItems({ status: 'done' }), []);
  const { items, loading, error, animateEnter } = useCachedList(DONE_KEY, fetcher);

  // 行右键 / 长按打开菜单：anchor 状态即此处；当前条目一起存，动作按条目构造
  const openRowMenu = useCallback((item: Item, point: Point) => {
    setRowMenu({ item, point });
  }, []);

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
          {(items ?? []).map((item, index) => (
            <DoneRow
              key={item.id}
              item={item}
              index={index}
              leaving={leavingIds.includes(item.id)}
              animateEnter={animateEnter}
              reduced={reduced}
              sourceName={sourceName}
              onUncheck={handleUncheck}
              onOpen={open}
              onMenuOpen={openRowMenu}
            />
          ))}
        </List>
      )}
      {/* 行右键 / 长按的上下文菜单：全页只挂这一份（anchor 状态在上面），动作全部
          复用页面既有处理函数。菜单纸面材质 data-glass="panel"，Menu 经 Portal 挂到
          body——与列表行只是视觉重叠、不是 DOM 后代，不构成嵌套玻璃（glass.md 明说
          portal 浮层不算 nesting），菜单面板的玻璃预算已在 RowContextMenu 文件头说明。
          动作设计：「编辑」打开详情——编辑流程在 ItemDialog 内，本页没有独立编辑
          入口，所以这一项就是打开详情，标签仍叫「编辑」；「删除」同样先打开详情——
          列表层不重复实现删除与确认流程（删除在 ItemDialog 内，带确认弹窗），若在
          列表层另写删除请求就会出现第二套删除路径。两项行为相同是刻意的，区别只在
          于给用户的预期：编辑 → 去改内容，删除 → 去确认后删除。 */}
      <RowContextMenu
        anchor={rowMenu ? rowMenu.point : null}
        actions={
          rowMenu
            ? [
                { key: 'restore', label: '恢复为待办', onSelect: () => handleUncheck(rowMenu.item) },
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
