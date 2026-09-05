// RemoveAccountChoice 测试：两种移除路径与二次确认。
// 「停用」→ patchAccount({enabled:false}) → onDisabled；「彻底删除」→ 输入邮箱与账户一致
// 前按钮禁用，一致后 deleteAccount → onDeleted。api 全部 mock ../src/lib/api。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import RemoveAccountChoice from '../src/components/accounts/RemoveAccountChoice';
import type { AccountInfo } from '../src/types';

const api = vi.hoisted(() => ({
  patchAccountMock: vi.fn(),
  deleteAccountMock: vi.fn(),
}));

vi.mock('../src/lib/api', () => ({
  patchAccount: api.patchAccountMock,
  deleteAccount: api.deleteAccountMock,
}));

const ACCOUNT: AccountInfo = {
  id: 7,
  name: 'Gmail',
  kind: 'gmail',
  email: 'you@gmail.com',
  status: 'ok',
  enabled: true,
  has_credentials: true,
  ms_client_id: null,
  last_sync_at: null,
  last_error: null,
};

function renderChoice(account: AccountInfo = ACCOUNT) {
  return render(
    <RemoveAccountChoice
      account={account}
      onDisabled={vi.fn()}
      onDeleted={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RemoveAccountChoice', () => {
  it('默认选「停用」：确认后 patchAccount({enabled:false}) 并回调 onDisabled', async () => {
    const disabled = { ...ACCOUNT, enabled: false, status: 'pending' as const };
    api.patchAccountMock.mockResolvedValue(disabled);
    const onDisabled = vi.fn();
    render(
      <RemoveAccountChoice
        account={ACCOUNT}
        onDisabled={onDisabled}
        onDeleted={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // 默认停在「停用」；直接点确认
    fireEvent.click(screen.getByRole('button', { name: '确认停用' }));

    await waitFor(() => expect(api.patchAccountMock).toHaveBeenCalledTimes(1));
    expect(api.patchAccountMock).toHaveBeenCalledWith(7, { enabled: false });
    await waitFor(() => expect(onDisabled).toHaveBeenCalledWith(disabled));
    expect(api.deleteAccountMock).not.toHaveBeenCalled();
  });

  it('彻底删除：邮箱一致前按钮禁用，一致后 deleteAccount 被调用', async () => {
    api.deleteAccountMock.mockResolvedValue(undefined);
    const onDeleted = vi.fn();
    render(
      <RemoveAccountChoice
        account={ACCOUNT}
        onDisabled={vi.fn()}
        onDeleted={onDeleted}
        onCancel={vi.fn()}
      />,
    );

    // 切到彻底删除：出现邮箱确认输入框，未输入/不一致时确认按钮禁用
    fireEvent.click(screen.getByRole('button', { name: '彻底删除' }));
    const confirm = screen.getByRole('button', { name: '确认彻底删除' }) as HTMLButtonElement;
    const input = screen.getByLabelText('输入邮箱地址以确认彻底删除') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'you@gmai.com' } });
    expect(confirm.disabled).toBe(true);

    // 一致后放行
    fireEvent.change(input, { target: { value: 'you@gmail.com' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => expect(api.deleteAccountMock).toHaveBeenCalledTimes(1));
    expect(api.deleteAccountMock).toHaveBeenCalledWith(7);
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(api.patchAccountMock).not.toHaveBeenCalled();
  });

  it('彻底删除：邮箱大小写不敏感，全大写输入同样放行', async () => {
    api.deleteAccountMock.mockResolvedValue(undefined);
    const onDeleted = vi.fn();
    render(
      <RemoveAccountChoice
        account={ACCOUNT}
        onDisabled={vi.fn()}
        onDeleted={onDeleted}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '彻底删除' }));
    const input = screen.getByLabelText('输入邮箱地址以确认彻底删除') as HTMLInputElement;
    // 邮箱地址不区分大小写：全大写写法与账户邮箱一致，不该被卡住
    fireEvent.change(input, { target: { value: 'YOU@GMAIL.COM' } });
    const confirm = screen.getByRole('button', { name: '确认彻底删除' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => expect(api.deleteAccountMock).toHaveBeenCalledTimes(1));
    expect(api.deleteAccountMock).toHaveBeenCalledWith(7);
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
  });

  it('已停用账户进入：「停用」选项禁用并提示「已停用」', () => {
    renderChoice({ ...ACCOUNT, enabled: false, status: 'pending' });

    expect(screen.getByText('已停用')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '确认停用' })).toBeNull();
    // 停用卡片禁用：点它不会选中（没有确认按钮出现）
    fireEvent.click(screen.getByRole('button', { name: '停用' }));
    expect(screen.queryByRole('button', { name: '确认停用' })).toBeNull();
  });
});
