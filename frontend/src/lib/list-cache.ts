// 任务列表的模块级缓存（会话级，刷新页面即清空）：任务页 / 已完成页跨路由切换时
// 先显示上次数据、后台静默刷新（stale-while-revalidate），不再每次先闪加载圈。
// 缓存是列表的唯一数据源：增删改都写进缓存，useSyncExternalStore 通知所有订阅者，
// 两页因此始终一致。键：open 按分类筛选分键（null = 全部 '*'），done 只有一份。
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Category, Item, ItemStatus } from '../types';

/** open 列表的缓存键：按分类筛选分键，null（全部）用 '*' */
export function openKey(category: Category | null): string {
  return `open:${category ?? '*'}`;
}
/** done 列表的缓存键 */
export const DONE_KEY = 'done';

const lists = new Map<string, Item[]>();
const listeners = new Set<() => void>();
/** 缓存写入的唯一出口：逐个通知订阅者 */
const emit = (): void => listeners.forEach((listener) => listener());

/** 读某键缓存；undefined = 尚无数据（首载中或首载失败） */
export function readList(key: string): Item[] | undefined {
  return lists.get(key);
}
/** 整体写回（首次拉取 / 后台刷新结果），数组引用整体替换 */
export function writeList(key: string, items: Item[]): void {
  lists.set(key, items);
  emit();
}
/** useSyncExternalStore 的订阅接口；模块级函数引用稳定，不会反复重订阅 */
export function subscribeLists(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
/** 仅测试用：清空全部缓存 */
export function resetLists(): void {
  lists.clear();
}

/** 对每个已存在键做变更（只写回有变化者），最后统一通知一次 */
function updateKeys(change: (current: Item[], key: string) => void): void {
  for (const [key, current] of lists) change(current, key);
  emit();
}

/** 移除同 id 条目；内容无变化不写回，避免空通知引起多余渲染 */
function removeFrom(current: Item[], key: string, id: number): void {
  if (current.some((i) => i.id === id)) lists.set(key, current.filter((i) => i.id !== id));
}
/** 移除同 id 后按后端排序插入新条目 */
function insertSorted(current: Item[], key: string, item: Item): void {
  const next = current.filter((i) => i.id !== item.id);
  next.push(item);
  next.sort(compareItems);
  lists.set(key, next);
}

/** 与后端 GET /api/items 排序一致（backend/app/api.py list_items）：due_date 为空
 *  沉底 → 升序 → 同日期按 created_at 降序；本地插入照此排，后台刷新才不跳位置。 */
export function compareItems(a: Item, b: Item): number {
  if ((a.due_date === null) !== (b.due_date === null)) return a.due_date === null ? 1 : -1;
  if (a.due_date !== null && b.due_date !== null && a.due_date !== b.due_date) return a.due_date < b.due_date ? -1 : 1;
  return b.created_at.localeCompare(a.created_at);
}

/** 条目状态变更后同步所有已缓存列表：旧状态列表移除，新状态对应列表按排序插入 */
export function moveItem(item: Item, to: ItemStatus): void {
  updateKeys((current, key) => {
    if (key === DONE_KEY) {
      if (to === 'done') insertSorted(current, key, { ...item, status: 'done' });
      else removeFrom(current, key, item.id);
    } else if (key.startsWith('open:')) {
      if (to === 'open' && (key === openKey(null) || key === openKey(item.category))) {
        insertSorted(current, key, { ...item, status: 'open' });
      } else {
        removeFrom(current, key, item.id);
      }
    }
  });
}

/** 手动条目新建 / 编辑后同步 open 列表：匹配的键替换同 id 条目（位置不动）或按排序
 *  插入，不匹配的键移除（分类被改走）；done 键不归它管。 */
export function upsertOpenItem(item: Item): void {
  updateKeys((current, key) => {
    if (!key.startsWith('open:')) return;
    const index = current.findIndex((i) => i.id === item.id);
    const match = key === openKey(null) || key === openKey(item.category);
    if (!match) {
      if (index >= 0) removeFrom(current, key, item.id);
    } else if (index >= 0) {
      const next = current.slice();
      next[index] = item;
      lists.set(key, next);
    } else {
      insertSorted(current, key, item);
    }
  });
}

/** 就地替换所有列表里的同 id 条目（位置不变；已完成页编辑手动条目后用） */
export function replaceItem(item: Item): void {
  updateKeys((current, key) => {
    const index = current.findIndex((i) => i.id === item.id);
    if (index >= 0) {
      const next = current.slice();
      next[index] = item;
      lists.set(key, next);
    }
  });
}

/** 删除条目：从所有已缓存列表移除 */
export function removeItem(id: number): void {
  updateKeys((current, key) => removeFrom(current, key, id));
}

export interface CachedList {
  /** undefined = 尚无数据（首载中或首载失败） */
  items: Item[] | undefined;
  /** 首载中：items 为 undefined 且尚未失败 */
  loading: boolean;
  /** 首载失败（命中缓存时刷新失败不算，静默保留旧数据） */
  error: boolean;
  /** 本次挂载该 key 是否「首次拿到数据」：true 才跑入场 stagger（挂载即命中缓存则 false） */
  animateEnter: boolean;
}

/** 订阅某键列表：命中缓存先同步展示旧数据、后台拉新替换（失败且有数据则静默保留），
 *  无缓存则先 loading 再显示。fetcher 必须是稳定引用（useCallback），否则每次
 *  渲染都会重新请求。 */
export function useCachedList(key: string, fetcher: () => Promise<Item[]>): CachedList {
  const items = useSyncExternalStore(subscribeLists, () => readList(key));
  // 首次渲染该 key 时记下缓存是否已有数据，作为本次挂载的入场判定基准
  const seen = useRef(new Map<string, boolean>());
  if (!seen.current.has(key)) seen.current.set(key, readList(key) !== undefined);
  const animateEnter = !seen.current.get(key);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    setError(false);
    void fetcher()
      .then((list) => alive && writeList(key, list))
      .catch(() => alive && readList(key) === undefined && setError(true));
    return () => {
      alive = false;
    };
  }, [key, fetcher]);
  return { items, loading: items === undefined && !error, error, animateEnter };
}
