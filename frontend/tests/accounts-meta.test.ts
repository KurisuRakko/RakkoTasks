// meta.ts 里按 kind 取值的展示元信息单测。
// 这些函数是「加新 kind 时唯一要改的一处」，所以用例把每个 kind 的期望值逐个钉死——
// 任何一处映射被改错（或新 kind 落进别人的分支）都会在这里红，而不是等界面串味。

import { describe, expect, it } from 'vitest';
import {
  credentialsGuide,
  defaultNameFor,
  kindAvatar,
  kindLabel,
  passwordLabel,
  statusChipMeta,
  usesPassword,
  apiErrorFields,
} from '../src/components/accounts/meta';
import type { AccountInfo, AccountKind } from '../src/types';

const ALL_KINDS: readonly AccountKind[] = ['gmail', 'qq', 'microsoft'];

function makeAccount(partial: Partial<AccountInfo>): AccountInfo {
  return {
    id: 1,
    name: 'Gmail',
    kind: 'gmail',
    email: 'you@gmail.com',
    status: 'ok',
    enabled: true,
    has_credentials: true,
    ms_client_id: null,
    last_sync_at: null,
    last_error: null,
    ...partial,
  };
}

describe('kindLabel / defaultNameFor', () => {
  it('每个 kind 的类型名与默认名称都对得上（QQ 邮箱夹在 Gmail 与 Outlook 之间）', () => {
    expect(ALL_KINDS.map(kindLabel)).toEqual(['Gmail', 'QQ 邮箱', 'Outlook']);
    expect(ALL_KINDS.map(defaultNameFor)).toEqual(['Gmail', 'QQ 邮箱', 'Outlook']);
  });
});

describe('kindAvatar', () => {
  it('三个 kind 各一个字母，互不重样', () => {
    expect(ALL_KINDS.map(kindAvatar)).toEqual(['G', 'Q', 'O']);
    expect(new Set(ALL_KINDS.map(kindAvatar)).size).toBe(ALL_KINDS.length);
  });
});

describe('usesPassword / passwordLabel', () => {
  it('Gmail 与 QQ 邮箱要用户自己生成的密码类凭据，微软走 OAuth 不要', () => {
    expect(ALL_KINDS.map(usesPassword)).toEqual([true, true, false]);
  });

  it('凭据叫法随 kind：Gmail 应用专用密码、QQ 邮箱授权码', () => {
    expect(ALL_KINDS.map(passwordLabel)).toEqual(['应用专用密码', '授权码', '']);
  });

  it('要密码的 kind 必须有叫法：label 为空却 usesPassword 为真，界面会显示空文案', () => {
    for (const kind of ALL_KINDS) {
      if (usesPassword(kind)) expect(passwordLabel(kind)).not.toBe('');
    }
  });
});

describe('credentialsGuide', () => {
  it('要密码的 kind 都有获取指引，微软没有', () => {
    expect(credentialsGuide('gmail')?.href).toBe('https://myaccount.google.com/apppasswords');
    expect(credentialsGuide('qq')?.href).toBe('https://mail.qq.com');
    expect(credentialsGuide('microsoft')).toBeUndefined();
  });

  it('QQ 指引含完整路径、16 位授权码，并点明「不是 QQ 密码」', () => {
    const guide = credentialsGuide('qq');
    expect(guide?.text).toContain('设置 → 账号与安全 → 安全设置');
    expect(guide?.text).toContain('IMAP/SMTP 服务');
    expect(guide?.text).toContain('16 位授权码');
    // 用户最容易踩的坑：把 QQ 登录密码当授权码填进来
    expect(guide?.text).toContain('不是 QQ 密码');
    // IMAP 服务器后端内置，指引里不该让用户去填
    expect(guide?.text).toContain('不用填');
  });

  it('要密码的 kind 必有指引：有密码框却没有获取路径，用户只能干瞪眼', () => {
    for (const kind of ALL_KINDS) {
      if (usesPassword(kind)) expect(credentialsGuide(kind)).toBeDefined();
      else expect(credentialsGuide(kind)).toBeUndefined();
    }
  });
});

describe('statusChipMeta（回归：改动 kind 元信息不该影响状态文案）', () => {
  it('已停用优先于状态；pending 按有无凭据区分', () => {
    expect(statusChipMeta(makeAccount({ enabled: false, status: 'error' })).label).toBe('已停用');
    expect(statusChipMeta(makeAccount({ status: 'ok' })).label).toBe('正常');
    expect(statusChipMeta(makeAccount({ status: 'error' })).label).toBe('出错');
    expect(statusChipMeta(makeAccount({ status: 'pending', has_credentials: true })).label).toBe(
      '等待首次同步',
    );
    expect(statusChipMeta(makeAccount({ status: 'pending', has_credentials: false })).label).toBe(
      '待授权',
    );
  });
});

describe('apiErrorFields', () => {
  it('非对象与缺字段一律给空对象，不抛', () => {
    expect(apiErrorFields(null)).toEqual({});
    expect(apiErrorFields('boom')).toEqual({});
    expect(apiErrorFields(new Error('HTTP 500'))).toEqual({});
    expect(apiErrorFields({ code: 'password_required' })).toEqual({ code: 'password_required' });
  });
});
