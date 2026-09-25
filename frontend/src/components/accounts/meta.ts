// 账户展示元信息单一来源：kind 中文 / 默认名 / 头像字母 / 是否用密码类凭据及其叫法与
// 获取指引 / 状态 Chip 的文案与颜色。设置页分区、详情、添加向导共用，
// 避免各处各写一份映射（同一句指引在向导和详情里各写一遍，改一处就会漏另一处）。
// 所有按 kind 取值的地方都走下面这张表或 switch：漏了新 kind 时 TS 会直接报错。

import type { AccountInfo, AccountKind } from '../../types';

/**
 * 密码类凭据（Gmail 应用专用密码 / QQ 邮箱授权码）的获取指引。
 * 向导第 2 步与「账户详情」的更换折叠区共用同一份，两边呈现结构一致。
 */
export interface CredentialsGuide {
  /** 一步步怎么拿到的说明 */
  text: string;
  /** 跳转按钮文字 */
  linkText: string;
  /** 跳转目标 */
  href: string;
}

interface KindMeta {
  /** 界面上的类型名 */
  label: string;
  /** 添加向导里按类型预填的名称 */
  defaultName: string;
  /** 头像里的单个字母 */
  avatar: string;
  /**
   * 凭据是不是「用户自己去服务商页面生成的密码」：gmail / qq 是（应用专用密码 / 授权码），
   * 微软不是（走 OAuth 授权）。决定向导要不要密码框、创建请求带不带 app_password。
   */
  usesPassword: boolean;
  /** 上面那种凭据在这个类型下的叫法；usesPassword 为 false 时无意义 */
  passwordLabel: string;
  /** 上面那种凭据怎么拿；usesPassword 为 false 时无意义 */
  credentialsGuide?: CredentialsGuide;
}

const KIND_META: Record<AccountKind, KindMeta> = {
  gmail: {
    label: 'Gmail',
    defaultName: 'Gmail',
    avatar: 'G',
    usesPassword: true,
    passwordLabel: '应用专用密码',
    credentialsGuide: {
      text: 'Google 账号 → 安全性 → 开启两步验证 → 应用专用密码 → 生成 16 位密码。',
      linkText: '打开 Google 应用专用密码页面',
      href: 'https://myaccount.google.com/apppasswords',
    },
  },
  qq: {
    label: 'QQ 邮箱',
    defaultName: 'QQ 邮箱',
    avatar: 'Q',
    usesPassword: true,
    passwordLabel: '授权码',
    credentialsGuide: {
      text:
        '用电脑浏览器登录 QQ 邮箱网页版 → 设置 → 账号与安全 → 安全设置 → 开启' +
        '「IMAP/SMTP 服务」→ 按提示验证后生成 16 位授权码，填的是这串授权码、不是 QQ 密码' +
        '（IMAP 服务器后端内置，不用填）。',
      linkText: '打开 QQ 邮箱',
      href: 'https://mail.qq.com',
    },
  },
  microsoft: {
    label: 'Outlook',
    defaultName: 'Outlook',
    avatar: 'O',
    usesPassword: false,
    passwordLabel: '',
  },
};

export function kindLabel(kind: AccountKind): string {
  return KIND_META[kind].label;
}

/** 添加向导里按类型预填的名称 */
export function defaultNameFor(kind: AccountKind): string {
  return KIND_META[kind].defaultName;
}

/** 头像里的字母：不用真实品牌图标（各自一个字母已足够区分类型） */
export function kindAvatar(kind: AccountKind): string {
  return KIND_META[kind].avatar;
}

/** 这个类型的凭据是不是用户填的密码类凭据（见 KindMeta.usesPassword） */
export function usesPassword(kind: AccountKind): boolean {
  return KIND_META[kind].usesPassword;
}

/** 密码类凭据在该类型下的叫法（Gmail「应用专用密码」/ QQ「授权码」），用于 label 与提示文案 */
export function passwordLabel(kind: AccountKind): string {
  return KIND_META[kind].passwordLabel;
}

/** 密码类凭据的获取指引；不要凭据的类型（微软）为 undefined */
export function credentialsGuide(kind: AccountKind): CredentialsGuide | undefined {
  return KIND_META[kind].credentialsGuide;
}

/** 状态 Chip 的文案与颜色：已停用优先于状态；pending 按是否有凭据区分「待授权 / 等待首次同步」 */
export function statusChipMeta(
  account: AccountInfo,
): { label: string; color: 'success' | 'error' | 'warning' | 'default' } {
  if (!account.enabled) return { label: '已停用', color: 'default' };
  switch (account.status) {
    case 'ok':
      return { label: '正常', color: 'success' };
    case 'error':
      return { label: '出错', color: 'error' };
    case 'pending':
      return account.has_credentials
        ? { label: '等待首次同步', color: 'default' }
        : { label: '待授权', color: 'warning' };
  }
}

/**
 * 从任意 throw 值里安全取业务错误字段：ApiError 的运行时形状是 {code, kind?, detail?}，
 * 但 mock / 网关错误可能是普通 Error 或其它对象。只认 string 字段，非对象返回空对象，
 * 调用方据此映射中文文案，不再各自 as 一把。
 */
export function apiErrorFields(err: unknown): {
  code?: string;
  kind?: string;
  detail?: string;
} {
  if (typeof err !== 'object' || err === null) return {};
  const e = err as { code?: unknown; kind?: unknown; detail?: unknown };
  const out: { code?: string; kind?: string; detail?: string } = {};
  if (typeof e.code === 'string') out.code = e.code;
  if (typeof e.kind === 'string') out.kind = e.kind;
  if (typeof e.detail === 'string') out.detail = e.detail;
  return out;
}
