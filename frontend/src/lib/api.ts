// 类型化 API 客户端：全部走 authedFetch（Bearer + 401 自动刷新重放），
// 契约见 docs/DESIGN.md 第 6 节。

import { authedFetch } from './phainon';
import { API_BASE_URL } from './env';
import { localTimeZone } from './time';
import type {
  AccountCreate,
  AccountInfo,
  AccountPatch,
  AccountsResponse,
  AuthFailedKind,
  CaldavInfo,
  CalendarTokenResponse,
  Category,
  ChatMessageIn,
  ChatResponse,
  Email,
  Item,
  ItemFields,
  ItemsResponse,
  ItemStatus,
  ParsedTask,
  ParseResponse,
  QuickAddResponse,
  RelatedEmail,
  StatusResponse,
  SyncStatus,
  SyncTriggerResponse,
} from '../types';

const API_BASE = `${API_BASE_URL}/api`;

/** 后端按契约返回的业务错误：code/kind/detail 取自 JSON 体（解析失败时 code 退回 http_<status>） */
export class ApiError extends Error {
  status: number;
  code: string;
  /** 微软授权失败的细分原因（仅 auth_failed 携带） */
  kind?: AuthFailedKind;
  detail?: string;

  constructor(status: number, code: string, kind?: AuthFailedKind, detail?: string) {
    super(`HTTP ${status}`);
    this.status = status;
    this.code = code;
    if (kind !== undefined) this.kind = kind;
    if (detail !== undefined) this.detail = detail;
  }
}

/** 把非 2xx 响应解析成 ApiError 抛出（给账户 API 与助理端点用，其余函数维持原 throw 不动） */
async function raiseApiError(res: Response): Promise<never> {
  let code = `http_${res.status}`;
  let kind: AuthFailedKind | undefined;
  let detail: string | undefined;
  try {
    const body = (await res.json()) as {
      code?: unknown;
      kind?: unknown;
      detail?: unknown;
    };
    if (typeof body.code === 'string' && body.code !== '') code = body.code;
    if (
      body.kind === 'expired' ||
      body.kind === 'declined' ||
      body.kind === 'admin_required' ||
      body.kind === 'other'
    ) {
      kind = body.kind;
    }
    if (typeof body.detail === 'string') detail = body.detail;
  } catch {
    // 非 JSON 体：code 保持 http_<status>，调用方仍能拿到状态码兜底
  }
  throw new ApiError(res.status, code, kind, detail);
}

/** GET /api/items?status=&category=；响应为 {"items": [...]} 信封，返回其中的数组 */
export async function fetchItems(params: {
  status?: ItemStatus;
  category?: Category;
} = {}): Promise<Item[]> {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.category) qs.set('category', params.category);
  const suffix = qs.size > 0 ? `?${qs.toString()}` : '';
  const res = await authedFetch(`${API_BASE}/items${suffix}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as ItemsResponse;
  return data.items;
}

/** GET /api/items/{id} */
export async function fetchItem(id: number): Promise<Item> {
  const res = await authedFetch(`${API_BASE}/items/${id}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Item;
}

/** PATCH /api/items/{id}：手动条目可改 title/summary/category/due_date，任意条目可改 status */
export async function patchItem(
  id: number,
  patch: Partial<ItemFields> & { status?: ItemStatus },
): Promise<Item> {
  const res = await authedFetch(`${API_BASE}/items/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Item;
}

/** POST /api/items 新建手动条目；成功 201 + 完整 Item */
export async function createItem(fields: ItemFields): Promise<Item> {
  const res = await authedFetch(`${API_BASE}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (res.status !== 201) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Item;
}

/** DELETE /api/items/{id} 删除手动条目；成功 204 无正文 */
export async function deleteItem(id: number): Promise<void> {
  const res = await authedFetch(`${API_BASE}/items/${id}`, { method: 'DELETE' });
  if (res.status !== 204) throw new Error(`HTTP ${res.status}`);
}

/** GET /api/calendar 返回日历订阅令牌；该用户尚无令牌时服务端生成后返回 */
export async function fetchCalendarToken(): Promise<string> {
  const res = await authedFetch(`${API_BASE}/calendar`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as CalendarTokenResponse;
  return data.token;
}

/** POST /api/calendar/rotate 生成新令牌并覆盖旧令牌；旧订阅链接立即失效 */
export async function rotateCalendarToken(): Promise<string> {
  const res = await authedFetch(`${API_BASE}/calendar/rotate`, { method: 'POST' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as CalendarTokenResponse;
  return data.token;
}

/** 由令牌拼出订阅地址；webcal 把 http(s):// 换成 webcal://（iPhone 日历专用） */
export function calendarUrls(token: string): { https: string; webcal: string } {
  const base = API_BASE_URL || window.location.origin;
  const https = `${base}/api/calendar/${token}.ics`;
  return { https, webcal: https.replace(/^https?:\/\//, 'webcal://') };
}

/** GET /api/caldav 返回 iPhone「提醒事项」经 CalDAV 同步所需的连接信息 */
export async function fetchCaldavInfo(): Promise<CaldavInfo> {
  const res = await authedFetch(`${API_BASE}/caldav`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as CaldavInfo;
}

/** POST /api/caldav/password 生成一次性同步密码；每次调用都会重新生成，旧密码立即失效 */
export async function generateCaldavPassword(): Promise<string> {
  const res = await authedFetch(`${API_BASE}/caldav/password`, { method: 'POST' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { password: string };
  return data.password;
}

/** 由 CalDAV 根路径拼出 iOS 配置用的填表值：host 填「服务器」栏（靠 /.well-known/caldav 自动发现），url 为全路径备用 */
export function caldavTarget(path: string): { host: string; url: string } {
  const base = API_BASE_URL || window.location.origin;
  return { host: new URL(base).host, url: `${base}${path}` };
}

/** POST /api/items/{id}/detail 生成并缓存详情；返回详情与检索到的关联邮件 */
export async function fetchItemDetail(id: number): Promise<{
  detail_md: string | null;
  related: RelatedEmail[];
}> {
  const res = await authedFetch(`${API_BASE}/items/${id}/detail`, { method: 'POST' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { detail_md: string | null; related: RelatedEmail[] };
}

/** GET /api/items/{id}/export 生成可粘贴给 AI 的 Markdown 纯文本 */
export async function fetchItemExport(id: number): Promise<string> {
  const res = await authedFetch(`${API_BASE}/items/${id}/export`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { text: string };
  return data.text;
}

/** GET /api/emails/{id}；remoteImages 时附 ?remote_images=1（放行远程图片重渲染） */
export async function fetchEmail(id: number, opts: { remoteImages?: boolean } = {}): Promise<Email> {
  const suffix = opts.remoteImages ? '?remote_images=1' : '';
  const res = await authedFetch(`${API_BASE}/emails/${id}${suffix}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Email;
}

/** POST /api/assistant/chat {messages, today, tz}：多轮助理对话，agentic 检索总超时 180s。
 *  messages 是截断后的完整历史（最后一条必须是 user），today 为本地日期 YYYY-MM-DD，
 *  tz 为浏览器 IANA 时区（在函数内部取，调用方不用传）。非 2xx 抛 ApiError：
 *  调用方靠 status 区分 429 限流与其它失败。 */
export async function chatAssistant(
  messages: ChatMessageIn[],
  today: string,
): Promise<ChatResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  try {
    const res = await authedFetch(`${API_BASE}/assistant/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, today, tz: localTimeZone() }),
      signal: controller.signal,
    });
    if (!res.ok) await raiseApiError(res);
    return (await res.json()) as ChatResponse;
  } finally {
    clearTimeout(timer);
  }
}

/** POST /api/items/parse {text, today, tz}：一段自然语言 → 条目字段列表，不落库；期望 200。
 *  一段话说了几件事就返回几条（只说一件也是一元数组），解 `{tasks:[...]}` 信封。
 *  today 为本地日期 YYYY-MM-DD，作 AI 判读「今天/明天」的基准日；tz 为浏览器 IANA
 *  时区，后端据此把模型产出的提醒墙上时刻换算成带偏移的绝对时刻（在函数内部取，
 *  调用方不用传）。后端没有显式超时，客户端 180s 兜底（与 search 同值）是唯一防线。 */
export async function parseTask(text: string, today: string): Promise<ParsedTask[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  try {
    const res = await authedFetch(`${API_BASE}/items/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, today, tz: localTimeZone() }),
      signal: controller.signal,
    });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    return ((await res.json()) as ParseResponse).tasks;
  } finally {
    clearTimeout(timer);
  }
}

/** POST /api/items/quick {text, today, tz}：解析并落库；期望 201。一段话说了几件事就
 *  落几条。AI 解析失败时后端用原文兜底建**一条**（ai_parsed === false 仍是正常返回）。
 *  同样带 180s 客户端超时。
 *  tz 语义同 parseTask：浏览器时区，供后端换算提醒的绝对时刻。 */
export async function quickAddTask(text: string, today: string): Promise<QuickAddResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  try {
    const res = await authedFetch(`${API_BASE}/items/quick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, today, tz: localTimeZone() }),
      signal: controller.signal,
    });
    if (res.status !== 201) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as QuickAddResponse;
  } finally {
    clearTimeout(timer);
  }
}

/** GET /api/status */
export async function fetchStatus(): Promise<StatusResponse> {
  const res = await authedFetch(`${API_BASE}/status`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as StatusResponse;
}

/** GET /api/sync/status：同步轮次进度（current = 进行中，last = 最近一轮已结束） */
export async function fetchSyncStatus(): Promise<SyncStatus> {
  const res = await authedFetch(`${API_BASE}/sync/status`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as SyncStatus;
}

/** POST /api/sync/trigger：请求唤醒同步 worker；期望 202。已有一轮在跑（或已有未消费的
 *  唤醒请求）时后端不重复写请求，返回 already_running: true，状态码仍是 202——
 *  它不是错误，调用方照常按「已受理」处理。 */
export async function triggerSync(): Promise<SyncTriggerResponse> {
  const res = await authedFetch(`${API_BASE}/sync/trigger`, { method: 'POST' });
  if (res.status !== 202) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as SyncTriggerResponse;
}

/** GET /api/accounts：当前用户全部账户（含已停用），响应为信封，返回其中的数组 */
export async function fetchAccounts(): Promise<AccountInfo[]> {
  const res = await authedFetch(`${API_BASE}/accounts`);
  if (!res.ok) await raiseApiError(res);
  const data = (await res.json()) as AccountsResponse;
  return data.accounts;
}

/** POST /api/accounts 新建账户；成功 201 + 完整 AccountInfo */
export async function createAccount(body: AccountCreate): Promise<AccountInfo> {
  const res = await authedFetch(`${API_BASE}/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status !== 201) await raiseApiError(res);
  return (await res.json()) as AccountInfo;
}

/** PATCH /api/accounts/{id}：改名称 / Gmail 应用专用密码与 QQ 邮箱授权码 / 启停 */
export async function patchAccount(id: number, body: AccountPatch): Promise<AccountInfo> {
  const res = await authedFetch(`${API_BASE}/accounts/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) await raiseApiError(res);
  return (await res.json()) as AccountInfo;
}

/** DELETE /api/accounts/{id} 彻底删除账户及其邮件与任务；成功 204 无正文 */
export async function deleteAccount(id: number): Promise<void> {
  const res = await authedFetch(`${API_BASE}/accounts/${id}`, { method: 'DELETE' });
  if (res.status !== 204) await raiseApiError(res);
}

/** POST /api/accounts/{id}/auth-url 生成微软授权链接；返回 auth_uri（redirect_uri 缺省用服务端默认） */
export async function requestMsAuthUrl(id: number, redirectUri?: string): Promise<string> {
  const res = await authedFetch(`${API_BASE}/accounts/${id}/auth-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(redirectUri ? { redirect_uri: redirectUri } : {}),
  });
  if (!res.ok) await raiseApiError(res);
  const data = (await res.json()) as { auth_uri: string };
  return data.auth_uri;
}

/** POST /api/accounts/{id}/auth-code：用地址栏完整 URL（或裸授权码）换 token 落库 */
export async function submitMsAuthCode(id: number, authResponse: string): Promise<AccountInfo> {
  const res = await authedFetch(`${API_BASE}/accounts/${id}/auth-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth_response: authResponse }),
  });
  if (!res.ok) await raiseApiError(res);
  return (await res.json()) as AccountInfo;
}
