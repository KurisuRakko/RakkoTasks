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
import accountDetailSource from '../src/components/accounts/AccountDetail.tsx?raw';
import type { AccountInfo } from '../src/types';
import { allStyleText, ruleTextOf } from './glass-text-contrast.test-utils';

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

describe('AccountDetail 同步状态', () => {
  /** 一条真实长度的 IMAP 报错：列表行只能单行截断，详情页必须能看全 */
  const LONG_ERROR =
    'IMAP 登录失败：[AUTHENTICATIONFAILED] Invalid credentials (Failure) — ' +
    'https://support.google.com/mail/?p=BadCredentials 请确认应用专用密码仍然有效，' +
    '或在 Google 账号安全性页面重新生成一个 16 位密码后回到这里更换。';

  it('last_error 非空：详情里能看到错误全文，且换行不被吃掉、超长串不撑破布局', () => {
    render(<Harness initial={makeAccount({ status: 'error', last_error: LONG_ERROR })} />);

    const alert = screen.getByText(LONG_ERROR);
    expect(alert).toBeTruthy();
    const rule = ruleTextOf(allStyleText(), alert.closest('.MuiAlert-root') as HTMLElement);
    // 列表行那套 nowrap + ellipsis 在这里是错的：详情页要摊开
    expect(rule).toContain('white-space:pre-wrap');
    expect(rule).toContain('overflow-wrap:anywhere');
  });

  it('last_error 为 null：不出现错误 Alert', () => {
    const { container } = render(<Harness initial={makeAccount({ last_error: null })} />);
    expect(container.querySelectorAll('.MuiAlert-standardError')).toHaveLength(0);
  });

  it('上次同步：从未同步显示「从未」，同步过显示相对时间', () => {
    render(<Harness initial={makeAccount({ last_sync_at: null })} />);
    expect(screen.getByText('上次同步：从未')).toBeTruthy();
    cleanup();

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    render(<Harness initial={makeAccount({ last_sync_at: twoHoursAgo })} />);
    expect(screen.getByText('上次同步：2 小时前')).toBeTruthy();
    expect(screen.queryByText('上次同步：从未')).toBeNull();
  });

  it('源码不含 <Divider：全站已改为靠间距与材质分层，不用硬横线切', () => {
    expect(accountDetailSource).not.toContain('<Divider');
  });

  it('保存名称提交中：文字仍在按钮上（宽度不跳），进度圈作为图标出现', async () => {
    let resolvePatch!: (a: AccountInfo) => void;
    api.patchAccountMock.mockReturnValue(
      new Promise<AccountInfo>((resolve) => {
        resolvePatch = resolve;
      }),
    );
    render(<Harness initial={makeAccount({ name: '旧名字' })} />);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '新名字' } });
    fireEvent.click(screen.getByRole('button', { name: /保存名称/ }));

    const button = screen.getByRole('button', { name: /保存名称/ });
    expect(button.textContent).toContain('保存名称');
    expect(button.querySelector('.MuiCircularProgress-root')).not.toBeNull();

    resolvePatch(makeAccount({ name: '新名字' }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /保存名称/ }).querySelector('.MuiCircularProgress-root'),
      ).toBeNull(),
    );
  });
});
