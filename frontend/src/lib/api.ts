// 类型化 API 客户端：全部走 authedFetch（Bearer + 401 自动刷新重放），
// 契约见 docs/DESIGN.md 第 6 节。

import { authedFetch } from './phainon';
import { API_BASE_URL } from './env';
import type { Category, Email, Item, ItemStatus, SearchResponse, StatusResponse } from '../types';

const API_BASE = `${API_BASE_URL}/api`;

/** GET /api/items?status=&category= */
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
  return (await res.json()) as Item[];
}

/** GET /api/items/{id} */
export async function fetchItem(id: number): Promise<Item> {
  const res = await authedFetch(`${API_BASE}/items/${id}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Item;
}

/** PATCH /api/items/{id} {"status": "done"|"open"} */
export async function patchItem(id: number, patch: { status: ItemStatus }): Promise<Item> {
  const res = await authedFetch(`${API_BASE}/items/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Item;
}

/** POST /api/items/{id}/detail 生成并缓存详情，返回 detail_md */
export async function fetchItemDetail(id: number): Promise<string | null> {
  const res = await authedFetch(`${API_BASE}/items/${id}/detail`, { method: 'POST' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { detail_md: string | null };
  return data.detail_md;
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
