// nav 单一数据源测试：navIndexOf 返回值与 NAV_ITEMS 的路径顺序。

import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, navIndexOf, routeDirection } from '../src/lib/nav';

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

describe('routeDirection', () => {
  it('设置组外：索引变大前进、变小后退', () => {
    expect(routeDirection('/', '/done')).toBe('forward');
    expect(routeDirection('/search', '/')).toBe('back');
  });

  it('进入设置组一律前进（哪怕目标索引 -1）', () => {
    expect(routeDirection('/', '/settings')).toBe('forward');
  });

  it('离开设置组一律后退', () => {
    expect(routeDirection('/settings', '/')).toBe('back');
    expect(routeDirection('/settings/accounts/1', '/done')).toBe('back');
  });

  it('设置组内：更深前进、更浅后退、等深前进', () => {
    expect(routeDirection('/settings', '/settings/accounts/new')).toBe('forward');
    expect(routeDirection('/settings/accounts/new', '/settings')).toBe('back');
    expect(routeDirection('/settings/accounts/1/remove', '/settings/accounts/1')).toBe('back');
    // 同深：切换账户详情不换方向；路径没变也按前进算（跳转层会自行跳过）
    expect(routeDirection('/settings/accounts/1', '/settings/accounts/2')).toBe('forward');
    expect(routeDirection('/settings', '/settings')).toBe('forward');
  });
});
