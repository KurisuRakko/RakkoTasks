// env.ts 默认值测试：未提供 VITE_* 时导出兜底默认值，提供时读取环境值。

import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('env 默认值', () => {
  it('未提供 VITE_* 时三个常量导出默认值，不以 undefined 开头', async () => {
    vi.stubEnv('VITE_API_BASE_URL', undefined);
    vi.stubEnv('VITE_PHAINON_API_BASE', undefined);
    vi.stubEnv('VITE_PHAINON_APP_ID', undefined);
    vi.resetModules();
    const env = await import('../src/lib/env');

    expect(env.API_BASE_URL).toBe('');
    expect(env.PHAINON_API_BASE).toBe('https://api.rakko.cn');
    expect(env.PHAINON_APP_ID).toBe('rakkotasks');
    // 组合出的 AUTH_BASE 不允许出现 "undefined" 字符串
    expect(`${env.PHAINON_API_BASE}/auth/priestess/oidc`).not.toContain('undefined');
  });

  it('提供 VITE_* 时读取环境变量值', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://example.com');
    vi.stubEnv('VITE_PHAINON_API_BASE', 'https://phainon.example.com');
    vi.stubEnv('VITE_PHAINON_APP_ID', 'my-app');
    vi.resetModules();
    const env = await import('../src/lib/env');

    expect(env.API_BASE_URL).toBe('https://example.com');
    expect(env.PHAINON_API_BASE).toBe('https://phainon.example.com');
    expect(env.PHAINON_APP_ID).toBe('my-app');
  });
});
