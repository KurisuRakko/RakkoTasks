// nav 单一数据源测试：navIndexOf 返回值与 NAV_ITEMS 的路径顺序。

import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, navIndexOf } from '../src/lib/nav';

describe('navIndexOf', () => {
  it('/ → 0', () => {
    expect(navIndexOf('/')).toBe(0);
  });

  it('/search → 1', () => {
    expect(navIndexOf('/search')).toBe(1);
  });

  it('/done → 2', () => {
    expect(navIndexOf('/done')).toBe(2);
  });

  it('/settings → -1', () => {
    expect(navIndexOf('/settings')).toBe(-1);
  });

  it('/unknown → -1', () => {
    expect(navIndexOf('/unknown')).toBe(-1);
  });
});

describe('NAV_ITEMS', () => {
  it('长度为 3，路径顺序为 /、/search、/done', () => {
    expect(NAV_ITEMS).toHaveLength(3);
    expect(NAV_ITEMS.map((i) => i.path)).toEqual(['/', '/search', '/done']);
  });
});
