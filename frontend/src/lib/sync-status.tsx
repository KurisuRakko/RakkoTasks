// 同步状态上下文：GET /api/sync/status 在本应用里只有这一处轮询点，顶栏刷新按钮与
// /sync 状态页共用同一份结果。两处各自轮询会得到两个互相不同步的「正在同步」判断
// ——顶栏还在转圈而状态页已经收尾，或者反过来。
//
// 轮询节奏：页面加载拉一次，此后只在「有进行中的轮次（current）或已有未消费的唤醒
// 请求（pending_request）」时每 SYNC_POLL_MS 拉一次，闲下来就停。定时器由这个忙/闲
// 状态派生（effect 依赖 busy），不是自己管开关：状态一变，间隔随之建立或拆除。
//
// 完成判定要看「这一份快照相对上一份变了什么」，所以上一份的三个关键字段收在 ref 里：
// 快照本身进 state（驱动渲染），判定依据留在 ref（不该触发重渲染）。

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { fetchSyncStatus, triggerSync } from './api';
import { refreshLists } from './list-cache';
import type { SyncRun, SyncStatus } from '../types';

/** 轮询间隔（ms）：只在忙时按这个节奏拉 */
export const SYNC_POLL_MS = 1500;

/** HH:mm（本地时区）：同步界面只报几点几分，不报日期。状态页与设置页入口共用同一套
 *  时间口径，两处各写一遍 toLocaleTimeString 的选项迟早会不一致。 */
export function syncClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

/** 最近一轮的一句话摘要（设置页入口的 secondary）：没有记录时说明还没有跑过 */
export function syncLastSummary(run: SyncRun | null): string {
  if (run === null) return '还没有同步记录';
  const clock = syncClock(run.finished_at ?? run.started_at);
  const trigger = run.trigger === 'manual' ? '手动' : '定时';
  return `上次同步 ${clock} · ${trigger} · ${run.state === 'failed' ? '失败' : '成功'}`;
}

/** 一次同步收尾后给顶栏的提示（done 停 2.4 秒，failed 等用户处置） */
export interface SyncCompletion {
  runId: number;
  state: 'done' | 'failed';
  /** 本轮新增的待办数（last.stages.classify.created） */
  created: number;
}

export interface SyncStatusValue {
  /** null = 还没拿到过状态（首拉中或首拉失败） */
  status: SyncStatus | null;
  /** 首拉中：status 仍为 null 且尚未落定 */
  loading: boolean;
  completion: SyncCompletion | null;
  /** 请求唤醒同步 worker；失败静默（顶栏按钮保持「刷新」，可再点一次） */
  trigger: () => void;
  dismissCompletion: () => void;
}

/** 未挂 Provider 时的兜底：壳层必须能脱离 Provider 单独渲染（既有的壳层测试就是这么
 *  渲染 AppShell 的），此时按「没有同步状态」处理，trigger 是空操作。语义与 lib/session
 *  的「未登录时为 null」一致——不抛异常。 */
const EMPTY_SYNC_STATUS: SyncStatusValue = {
  status: null,
  loading: false,
  completion: null,
  trigger: () => {},
  dismissCompletion: () => {},
};

const SyncStatusContext = createContext<SyncStatusValue | null>(null);

/** 忙/闲：有进行中的轮次或有未消费的唤醒请求 */
function isBusy(status: SyncStatus | null): boolean {
  return status !== null && (status.current !== null || status.pending_request);
}

/** 跨快照的判定依据（就地更新，不触发重渲染） */
interface SnapshotMemory {
  /** 上一份快照：在忙？最近一轮的 id？这一轮是手动触发的吗？ */
  prev: { busy: boolean; lastId: number | null; manual: boolean };
  /** 本地是否点过「刷新」（收尾后复位）：worker 还没醒时 current 仍是 null，
   *  只有这个本地标记能说明即将出现的那一轮是手动触发的 */
  requested: { current: boolean };
  setStatus: Dispatch<SetStateAction<SyncStatus | null>>;
  setCompletion: Dispatch<SetStateAction<SyncCompletion | null>>;
}

/** 合并一份新快照：写进 status，并在「上一份在忙、这一份收尾」时重拉列表、（仅手动
 *  轮次）发出完成提示。写在组件外是为了让挂载取数与定时轮询共用同一份逻辑，且不互相
 *  前向引用。 */
function mergeSnapshot(next: SyncStatus, memory: SnapshotMemory): void {
  const { prev, requested, setStatus, setCompletion } = memory;
  const last = next.last;
  const busy = next.current !== null || next.pending_request;
  // 有 current 就以它的 trigger 为准（定时轮次不抢标题）；只有 pending_request 时
  // 按本地是否点过刷新来判
  const manual = next.current !== null ? next.current.trigger === 'manual' : requested.current;

  // 收尾：上一份在忙、这一份不忙，且 last 换成了新的一轮（从未跑过到有值也算）。
  // 只比 last 的 id 不看时间戳——时间戳格式随后端序列化口径走，id 才是稳定标识。
  if (prev.busy && !busy && last !== null && last.id !== prev.lastId) {
    // 定时轮次写进来的邮件同样是新待办，列表一律重拉
    refreshLists();
    // 完成提示只给手动轮次：定时同步是后台自己的事，顶栏不该突然抢标题报「同步完成」
    if (prev.manual) {
      setCompletion({
        runId: last.id,
        state: last.state === 'failed' ? 'failed' : 'done',
        created: last.stages.classify.created,
      });
    }
    requested.current = false;
  }

  prev.busy = busy;
  prev.lastId = last === null ? null : last.id;
  prev.manual = manual;
  setStatus(next);
}

export function SyncStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [completion, setCompletion] = useState<SyncCompletion | null>(null);
  // 卸载后落定的响应不许再写状态；定时器由下面的 effect 拆除
  const alive = useRef(true);
  // 上一拍还没回来就跳过这一拍，不叠加并发请求（服务端卡住时不至于越积越多）
  const inflight = useRef(false);
  const memory = useRef<Omit<SnapshotMemory, 'setStatus' | 'setCompletion'>>({
    prev: { busy: false, lastId: null, manual: false },
    requested: { current: false },
  });
  const busy = isBusy(status);

  const poll = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const next = await fetchSyncStatus();
      if (!alive.current) return;
      mergeSnapshot(next, { ...memory.current, setStatus, setCompletion });
      setLoading(false);
    } catch {
      // 状态接口失败不弹错也不打断轮询（worker 可能只是还没醒，下一拍还有机会）；
      // 首拉就失败时退出加载态，状态页显示空态而不是永远转圈
      if (alive.current) setLoading(false);
    } finally {
      inflight.current = false;
    }
  }, []);

  // 挂载拉一次
  useEffect(() => {
    alive.current = true;
    void poll();
    return () => {
      alive.current = false;
    };
  }, [poll]);

  // 忙时才轮询；一闲下来定时器就随 effect 清理一起拆掉
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => void poll(), SYNC_POLL_MS);
    return () => window.clearInterval(timer);
  }, [busy, poll]);

  const trigger = useCallback(() => {
    triggerSync()
      .then(() => {
        if (!alive.current) return;
        memory.current.requested.current = true;
        // 上一份快照若是「闲」的，收尾判定就无从谈起：本地先把在忙/手动两个标记立起来，
        // 否则一轮跑得比 1.5 秒还快时，第一次拉回来就已经收尾，完成提示会丢。
        memory.current.prev.busy = true;
        memory.current.prev.manual = true;
        // 立刻按「已受理」处理：worker 醒来之前 status 里的 current 还是 null，等下一拍
        // 轮询才转圈的话，点击与动效之间会空一拍。pending_request 是契约里现成的语义
        // （已有唤醒请求、worker 尚未开始），本地先置 true 与之后拉到的真实快照一致。
        setStatus((s) =>
          s === null
            ? { current: null, last: null, pending_request: true }
            : { ...s, pending_request: true },
        );
        setLoading(false);
      })
      .catch(() => {
        // 唤醒失败不弹错：顶栏按钮停在「刷新」，用户可再点一次
      });
  }, []);

  const dismissCompletion = useCallback(() => setCompletion(null), []);

  const value = useMemo(
    () => ({ status, loading, completion, trigger, dismissCompletion }),
    [status, loading, completion, trigger, dismissCompletion],
  );

  return <SyncStatusContext.Provider value={value}>{children}</SyncStatusContext.Provider>;
}

/** 同步状态；未挂 Provider 时返回兜底空值（见 EMPTY_SYNC_STATUS） */
export function useSyncStatus(): SyncStatusValue {
  return useContext(SyncStatusContext) ?? EMPTY_SYNC_STATUS;
}
