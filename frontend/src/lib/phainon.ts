// Phainon SPA 登录客户端（docs/integration.md 范式，APP_ID=rakkotasks）。
// 契约固定：GET {AUTH_BASE}/login、POST {AUTH_BASE}/exchange /refresh /logout、GET /me。
// refresh token 轮转一次性，必须单飞：同一时刻只允许一个 refresh 在途。

import type { PhainonMe } from '../types';

const AUTH_BASE = `${import.meta.env.VITE_PHAINON_API_BASE}/auth/priestess/oidc`;

export const ACCESS_TOKEN_KEY = 'phainon.access';
export const REFRESH_TOKEN_KEY = 'phainon.refresh';

interface TokenPair {
  access_token: string;
  refresh_token: string;
}

function readToken(key: string): string | null {
  return localStorage.getItem(key);
}

function writeTokens(pair: TokenPair): void {
  localStorage.setItem(ACCESS_TOKEN_KEY, pair.access_token);
  localStorage.setItem(REFRESH_TOKEN_KEY, pair.refresh_token);
}

/** 跳转到 Phainon 登录页（当前地址作为回跳目标） */
export function startLogin(returnTo: string = location.href): void {
  const params = new URLSearchParams({
    app_id: import.meta.env.VITE_PHAINON_APP_ID,
    return_to: returnTo,
  });
  location.assign(`${AUTH_BASE}/login?${params.toString()}`);
}

function clearHash(): void {
  history.replaceState(null, '', location.pathname + location.search);
}

/** 解析回跳 hash（#login_code=… / #auth_error=…），完成 token 交换后清掉 hash */
export async function consumeCallback(): Promise<void> {
  const raw = location.hash;
  if (!raw || raw === '#') return;
  const params = new URLSearchParams(raw.slice(1));
  const code = params.get('login_code');
  const error = params.get('auth_error');
  const errorDescription = params.get('auth_error_description');
  // 无论成功失败，先把 hash 从地址栏抹掉
  clearHash();
  if (error) {
    throw new Error(errorDescription || error);
  }
  if (code) {
    const res = await fetch(`${AUTH_BASE}/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login_code: code }),
    });
    if (!res.ok) {
      throw new Error(`登录交换失败：HTTP ${res.status}`);
    }
    writeTokens((await res.json()) as TokenPair);
  }
}

/** 刷新 token 并轮转存储；带单飞锁，并发调用共享同一在途请求 */
export function refresh(): Promise<void> {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

let refreshInFlight: Promise<void> | null = null;

async function doRefresh(): Promise<void> {
  const refreshToken = readToken(REFRESH_TOKEN_KEY);
  if (!refreshToken) {
    throw new Error('无 refresh token，需要重新登录');
  }
  const res = await fetch(`${AUTH_BASE}/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) {
    throw new Error(`刷新失败：HTTP ${res.status}`);
  }
  writeTokens((await res.json()) as TokenPair);
}

function clearTokens(): void {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}

/**
 * 带鉴权的 fetch：附 Bearer token；401 时刷新一次并重放；
 * 刷新失败则清除 token 并重新跳转登录。
 */
export async function authedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const access = readToken(ACCESS_TOKEN_KEY);
  const withAuth: RequestInit = access
    ? { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${access}` } }
    : init;
  let res = await fetch(input, withAuth);
  if (res.status === 401) {
    try {
      await refresh();
    } catch (err) {
      clearTokens();
      startLogin();
      throw err;
    }
    const access2 = readToken(ACCESS_TOKEN_KEY);
    const withAuth2: RequestInit = access2
      ? { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${access2}` } }
      : init;
    res = await fetch(input, withAuth2);
  }
  return res;
}

/** 登出：通知 Phainon（失败忽略）并清除本地 token */
export async function logout(): Promise<void> {
  const refreshToken = readToken(REFRESH_TOKEN_KEY);
  if (refreshToken) {
    try {
      await fetch(`${AUTH_BASE}/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
    } catch {
      // 忽略网络错误，本地登出照常进行
    }
  }
  clearTokens();
}

/** 获取当前用户；未登录（401）返回 null */
export async function getMe(): Promise<PhainonMe | null> {
  const access = readToken(ACCESS_TOKEN_KEY);
  if (!access) return null;
  try {
    const res = await fetch(`${AUTH_BASE}/me`, {
      headers: { Authorization: `Bearer ${access}` },
    });
    if (res.status === 401) return null;
    if (!res.ok) return null;
    return (await res.json()) as PhainonMe;
  } catch {
    return null;
  }
}
