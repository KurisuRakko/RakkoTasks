// 账户展示元信息单一来源：kind 中文 / 状态 Chip 的文案与颜色 / 默认名。
// 设置页分区、详情、添加向导共用，避免各处各写一份映射。

import type { AccountInfo, AccountKind } from '../../types';

export function kindLabel(kind: AccountKind): string {
  return kind === 'gmail' ? 'Gmail' : 'Outlook';
}

/** 添加向导里按类型预填的名称 */
export function defaultNameFor(kind: AccountKind): string {
  return kind === 'gmail' ? 'Gmail' : 'Outlook';
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
