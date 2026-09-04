// 类型化 API 客户端：全部走 authedFetch（Bearer + 401 自动刷新重放），
// 契约见 docs/DESIGN.md 第 6 节。

import { authedFetch } from './phainon';
import { API_BASE_URL } from './env';
import type {
  CaldavInfo,
  CalendarTokenResponse,
  Category,
  Email,
  Item,
  ItemFields,
  ItemsResponse,
  ItemStatus,
  RelatedEmail,
  SearchResponse,
  StatusResponse,
} from '../types';

const API_BASE = `${API_BASE_URL}/api`;

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

/** POST /api/search {question}，agentic 检索总超时 180s */
export async function search(question: string): Promise<SearchResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  try {
    const res = await authedFetch(`${API_BASE}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as SearchResponse;
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
