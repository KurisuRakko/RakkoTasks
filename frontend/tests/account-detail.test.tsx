// AccountDetail 测试：组件直接读 account prop（不把 prop 同步进 state），
// 父组件经 onChanged 持有最新值并把新账户作为 prop 传回（模拟 AccountsSection /
// AccountPages 的真实行为）——回归「启用提示被 effect 清掉」的旧 bug。
// ① 停用微软账户点「启用」且返回无凭据：prop 回流后「还没有登录凭据」引导仍可见；
// ② 重命名保存：patchAccount({name}) 且 onChanged 收到返回值；
// ③ Gmail 换应用专用密码保存：密码框清空、折叠收起。
// 停用状态下凭据操作（更换密码/重新授权）不渲染。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import AccountDetail from '../src/components/accounts/AccountDetail';
import type { AccountInfo } from '../src/types';

const api = vi.hoisted(() => ({
  patchAccountMock: vi.fn(),
}));

vi.mock('../src/lib/api', () => ({ patchAccount: api.patchAccountMock }));

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

/** 模拟真实父组件：onChanged 把返回值写回 state 并作为新 prop 传回组件 */
function Harness({
  initial,
  onChanged,
}: {
  initial: AccountInfo;
  onChanged?: (account: AccountInfo) => void;
}) {
  const [account, setAccount] = useState<AccountInfo>(initial);
  return (
    <AccountDetail
      account={account}
      onChanged={(a) => {
        setAccount(a);
        onChanged?.(a);
      }}
      onRemove={vi.fn()}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AccountDetail 停用账户启用', () => {
  it('停用微软账户：不渲染凭据操作；点「启用」后 prop 回流，无凭据引导保持可见', async () => {
    const disabledMs = makeAccount({
      id: 5,
      name: 'Outlook',
      kind: 'microsoft',
      email: 'you@outlook.com',
      status: 'pending',
      enabled: false,
      has_credentials: false,
    });
    const enabledNoCreds = makeAccount({ ...disabledMs, enabled: true });
    api.patchAccountMock.mockResolvedValue(enabledNoCreds);

    render(<Harness initial={disabledMs} />);

    // 停用态只留名称/启用/危险区：凭据操作全部隐藏
    expect(screen.getByRole('button', { name: '启用' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重新授权' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '启用' }));

    await waitFor(() =>
      expect(api.patchAccountMock).toHaveBeenCalledWith(5, { enabled: true }),
    );
    // 启用成功且无凭据：引导必须可见——父组件此刻已把新账户作为 prop 传回，
    // 旧实现会因 prop 同步 effect 把 notice 清掉（回归点）
    expect(await screen.findByText(/还没有登录凭据/)).toBeTruthy();
    expect(screen.getByText(/「重新授权」完成授权后才会开始同步/)).toBeTruthy();
    // 启用后凭据区解禁：「重新授权」入口出现
    expect(screen.getByRole('button', { name: '重新授权' })).toBeTruthy();
  });
});

describe('AccountDetail 重命名', () => {
  it('保存名称：patchAccount({name}) 被调用，onChanged 收到返回值且界面同步', async () => {
    const renamed = makeAccount({ name: '工作邮箱' });
    api.patchAccountMock.mockResolvedValue(renamed);
    const received: AccountInfo[] = [];
    render(<Harness initial={makeAccount({})} onChanged={(a) => received.push(a)} />);

    const input = screen.getByLabelText('名称') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '工作邮箱' } });
    fireEvent.click(screen.getByRole('button', { name: '保存名称' }));

    await waitFor(() =>
      expect(api.patchAccountMock).toHaveBeenCalledWith(1, { name: '工作邮箱' }),
    );
    await waitFor(() => expect(received).toHaveLength(1));
    expect(received[0].name).toBe('工作邮箱');
    // prop 回流后输入框保持保存后的值
    await waitFor(() =>
      expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('工作邮箱'),
    );
  });
});

describe('AccountDetail Gmail 更换应用专用密码', () => {
  it('保存后密码框清空且折叠收起', async () => {
    api.patchAccountMock.mockResolvedValue(makeAccount({}));
    render(<Harness initial={makeAccount({})} />);

    // 展开折叠区
    const toggle = screen.getByRole('button', { name: '更换应用专用密码' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    const pwd = screen.getByLabelText('新的应用专用密码') as HTMLInputElement;
    fireEvent.change(pwd, { target: { value: 'abcd efgh ijkl mnop' } });
    fireEvent.click(screen.getByRole('button', { name: '保存密码' }));

    await waitFor(() =>
      expect(api.patchAccountMock).toHaveBeenCalledWith(1, {
        app_password: 'abcd efgh ijkl mnop',
      }),
    );
    // 成功后：密码框清空、折叠收起
    await waitFor(() =>
      expect((screen.getByLabelText('新的应用专用密码') as HTMLInputElement).value).toBe(''),
    );
    expect(screen.getByRole('button', { name: '更换应用专用密码' }).getAttribute('aria-expanded')).toBe('false');
  });
});
