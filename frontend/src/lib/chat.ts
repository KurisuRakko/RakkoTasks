// 「AI 助理」的聊天状态：模块级单例 store（写法同 list-cache：模块级状态 + listeners
// + useSyncExternalStore）。会话级缓存——换路由不丢、浏览器刷新才丢；登出会走
// startLogin() 整页重载，聊天记录随之清空，不需要额外清理逻辑。
//
// 状态整体替换对象（不做就地改写）：订阅者按切片取值，打字只重渲输入台，不重渲消息流。

import { useSyncExternalStore } from 'react';
import { ApiError, chatAssistant } from './api';
import { moveItem, replaceItem, upsertOpenItem } from './list-cache';
import { todayIso } from './time';
import type { ChatAction, ChatMessageIn, EmailCitation } from '../types';

/** 发给后端的历史条数上限（后端上限 20，这里留一半余量给本轮问答） */
export const HISTORY_LIMIT = 12;
/** 助理单条回复进历史时的截断长度（后端上限 8000，截短免得历史越滚越胖） */
export const HISTORY_ASSISTANT_CHARS = 4000;
/** 输入框字数上限，与后端 user content 上限一致 */
export const INPUT_MAX = 2000;

export const RATE_LIMITED_MESSAGE = '请求太频繁了，请稍等一分钟再试。';
export const TIMEOUT_MESSAGE =
  '等了太久没有回应。如果刚才让助理改过待办，请先到待办页确认是否已经生效，再决定要不要重发。';
export const GENERIC_MESSAGE = '助理暂时不可用，请稍后再试。';

/** 对话里的一条消息；助理那条额外带回执（写操作）与引用邮件 */
export type ChatTurn =
  | { id: number; role: 'user'; content: string }
  | {
      id: number;
      role: 'assistant';
      content: string;
      citations: EmailCitation[];
      actions: ChatAction[];
    };

interface ChatState {
  turns: ChatTurn[];
  draft: string;
  pending: boolean;
  error: string | null;
}

const INITIAL_STATE: ChatState = { turns: [], draft: '', pending: false, error: null };

let state: ChatState = INITIAL_STATE;
/** 自增的消息 id：turn 的身份与来源 key 都靠它，刷新前不重复 */
let nextId = 1;
const listeners = new Set<() => void>();

/** 状态写入的唯一出口：整体替换后逐个通知订阅者 */
function setState(next: ChatState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

/** useSyncExternalStore 的订阅接口；模块级函数引用稳定，不会反复重订阅 */
export function subscribeChat(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// 按切片取值的 hook：各自只订阅自己那一格，输入时不会连带重渲整条消息流
export function useChatTurns(): ChatTurn[] {
  return useSyncExternalStore(subscribeChat, () => state.turns);
}
export function useChatDraft(): string {
  return useSyncExternalStore(subscribeChat, () => state.draft);
}
export function useChatPending(): boolean {
  return useSyncExternalStore(subscribeChat, () => state.pending);
}
export function useChatError(): string | null {
  return useSyncExternalStore(subscribeChat, () => state.error);
}

/** 输入台内容变化；发送/重置都从这里读写同一份草稿 */
export function setDraft(text: string): void {
  setState({ ...state, draft: text });
}

/** 截断后的历史：末尾 HISTORY_LIMIT 条，且必须以 user 开头（后端要求首尾合法），
 *  助理内容截到 HISTORY_ASSISTANT_CHARS，用户原文照发。切片里没有 user 时返回空数组。 */
export function buildHistory(turns: ChatTurn[]): ChatMessageIn[] {
  const tail = turns.slice(-HISTORY_LIMIT);
  const firstUser = tail.findIndex((turn) => turn.role === 'user');
  if (firstUser === -1) return [];
  return tail.slice(firstUser).map((turn) =>
    turn.role === 'user'
      ? { role: 'user' as const, content: turn.content }
      : { role: 'assistant' as const, content: turn.content.slice(0, HISTORY_ASSISTANT_CHARS) },
  );
}

/** 失败文案：限流单独说，超时提醒用户先确认在途的写操作用不用重发，其余一律兜底 */
function errorMessageOf(err: unknown): string {
  if (err instanceof ApiError && err.status === 429) return RATE_LIMITED_MESSAGE;
  // 按 name 判断而非 instanceof DOMException：测试与某些环境抛的是普通 Error
  if ((err as { name?: unknown } | null)?.name === 'AbortError') return TIMEOUT_MESSAGE;
  return GENERIC_MESSAGE;
}

/** 把本轮成功的写操作同步进列表缓存（口径同 TasksPage / DonePage 各自的处理） */
export function syncListCache(actions: ChatAction[]): void {
  for (const action of actions) {
    if (action.kind === 'created') upsertOpenItem(action.item);
    else if (action.kind === 'completed') moveItem(action.item, 'done');
    else if (action.kind === 'reopened') moveItem(action.item, 'open');
    else if (action.item.status === 'open') upsertOpenItem(action.item);
    else replaceItem(action.item);
  }
}

/** 发送当前草稿：先乐观上屏用户那条，成功补上回复，失败撤回并把原文还给用户。
 *  空白草稿或在途请求直接返回（按钮已禁用，这里是键盘路径的兜底）。 */
export async function sendMessage(): Promise<void> {
  const text = state.draft.trim();
  if (text === '' || state.pending) return;

  const userTurn: ChatTurn = { id: nextId, role: 'user', content: text };
  nextId += 1;
  const turns = [...state.turns, userTurn];
  setState({ turns, draft: '', pending: true, error: null });

  try {
    const res = await chatAssistant(buildHistory(turns), todayIso());
    syncListCache(res.actions);
    const assistantTurn: ChatTurn = {
      id: nextId,
      role: 'assistant',
      content: res.answer_md,
      citations: res.citations,
      actions: res.actions,
    };
    nextId += 1;
    setState({
      turns: [...state.turns, assistantTurn],
      draft: state.draft,
      pending: false,
      error: null,
    });
  } catch (err) {
    setState({
      // 撤回乐观上屏的那条：回答没来，留下孤零零的提问会让人以为已经问过了
      turns: state.turns.filter((turn) => turn.id !== userTurn.id),
      // 用户在请求期间又敲了内容就不覆盖他；草稿为空才把原文还回去
      draft: state.draft === '' ? text : state.draft,
      pending: false,
      error: errorMessageOf(err),
    });
  }
}

/** 开新对话：清空消息与错误、保留草稿。在途回复不收——它的回执不能丢。 */
export function resetChat(): void {
  if (state.pending) return;
  setState({ turns: [], draft: state.draft, pending: false, error: null });
}
