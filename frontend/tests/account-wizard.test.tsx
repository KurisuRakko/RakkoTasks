// AccountWizard 测试：添加向导两条路径与错误映射。
// Gmail：选类型 → 填表 → createAccount 收到正确 body → 直接进完成页；
// 微软：建账户后进入授权引导 → 生成链接 → 粘贴完整地址 → submitMsAuthCode → 完成页；
// auth_failed declined 显示对应文案并可重新生成链接；account_exists 显示对应文案并留在原步。
// api 全部 mock ../src/lib/api；渲染包 ThemeModeProvider + MemoryRouter（向导不用路由，
// 与既有测试同一套包裹约定保持一致）。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { MemoryRouter } from 'react-router-dom';
import AccountWizard from '../src/components/accounts/AccountWizard';
import { ThemeModeProvider } from '../src/lib/theme-mode';
import type { AccountInfo } from '../src/types';
import { allStyleText, ruleTextOf } from './glass-text-contrast.test-utils';

const api = vi.hoisted(() => ({
  createAccountMock: vi.fn(),
  requestMsAuthUrlMock: vi.fn(),
  submitMsAuthCodeMock: vi.fn(),
}));

vi.mock('../src/lib/api', () => ({
  createAccount: api.createAccountMock,
  requestMsAuthUrl: api.requestMsAuthUrlMock,
  submitMsAuthCode: api.submitMsAuthCodeMock,
}));

function makeAccount(partial: Partial<AccountInfo>): AccountInfo {
  return {
    id: 1,
    name: 'Gmail',
    kind: 'gmail',
    email: 'you@gmail.com',
    status: 'pending',
    enabled: true,
    has_credentials: false,
    ms_client_id: null,
    last_sync_at: null,
    last_error: null,
    ...partial,
  };
}

function renderWizard(onDone = vi.fn()) {
  return render(
    <ThemeModeProvider>
      <ThemeProvider theme={createTheme()}>
        <MemoryRouter useTransitions={false}>
          <AccountWizard onDone={onDone} onCancel={vi.fn()} />
        </MemoryRouter>
      </ThemeProvider>
    </ThemeModeProvider>,
  );
}

/** Gmail 路径共用步骤：选类型 → 下一步 → 填名称邮箱密码 → 下一步（创建） */
async function fillGmailForm() {
  fireEvent.click(screen.getByRole('button', { name: 'Gmail' }));
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  const name = screen.getByLabelText('名称') as HTMLInputElement;
  expect(name.value).toBe('Gmail'); // 类型选好后名称默认填好
  fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'you@gmail.com' } });
  fireEvent.change(screen.getByLabelText('应用专用密码'), {
    target: { value: 'abcd efgh ijkl mnop' },
  });
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AccountWizard Gmail 路径', () => {
  it('选类型→填表→createAccount 收到正确 body，成功后直接到完成页并回调 onDone', async () => {
    const created = makeAccount({ has_credentials: true, status: 'ok' });
    api.createAccountMock.mockResolvedValue(created);
    const onDone = vi.fn();
    renderWizard(onDone);

    await fillGmailForm();

    await waitFor(() => expect(api.createAccountMock).toHaveBeenCalledTimes(1));
    expect(api.createAccountMock).toHaveBeenCalledWith({
      name: 'Gmail',
      kind: 'gmail',
      email: 'you@gmail.com',
      app_password: 'abcd efgh ijkl mnop',
    });

    // Gmail 建好即进完成页。回补天数由后端 INITIAL_BACKFILL_DAYS 决定，前端不复述具体数字
    expect(await screen.findByText(/已接入 Gmail。/)).toBeTruthy();
    expect(screen.getByText(/开始拉取近期邮件/)).toBeTruthy();
    expect(screen.queryByText(/7 天/)).toBeNull();
    // 完成页不再有创建请求按钮
    expect(screen.queryByRole('button', { name: '下一步' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    expect(onDone).toHaveBeenCalledWith(created);
  });

  it('createAccount 返回 account_exists：显示「这个邮箱已经添加过了」并留在基本信息步', async () => {
    api.createAccountMock.mockRejectedValue(Object.assign(new Error('HTTP 409'), { code: 'account_exists' }));
    renderWizard();

    await fillGmailForm();

    expect(await screen.findByText('这个邮箱已经添加过了')).toBeTruthy();
    // 没有跳完成页，下一步按钮还在
    expect(screen.getByRole('button', { name: '下一步' })).toBeTruthy();
  });

  it('Gmail 未填应用专用密码：「下一步」disabled 且有「请填写应用专用密码」提示', async () => {
    renderWizard();

    fireEvent.click(screen.getByRole('button', { name: 'Gmail' }));
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    // 名称邮箱填好也不放行——客户端就拦空密码，不靠后端绕一圈
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '我的 Gmail' } });
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'me@gmail.com' } });
    const next = screen.getByRole('button', { name: '下一步' }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    // 红字只在字段被碰过之后才出现（不再一进门就满屏红），失焦一次即算碰过
    fireEvent.blur(screen.getByLabelText('应用专用密码'));
    expect(screen.getByText('请填写应用专用密码')).toBeTruthy();

    // 填上密码后放行
    fireEvent.change(screen.getByLabelText('应用专用密码'), {
      target: { value: 'abcd efgh ijkl mnop' },
    });
    expect((screen.getByRole('button', { name: '下一步' }) as HTMLButtonElement).disabled).toBe(false);
    expect(api.createAccountMock).not.toHaveBeenCalled();
  });
});

describe('AccountWizard 微软路径', () => {
  const MS_ACCOUNT = makeAccount({
    id: 2,
    name: 'Outlook',
    kind: 'microsoft',
    email: 'you@outlook.com',
  });

  async function fillMsForm() {
    fireEvent.click(screen.getByRole('button', { name: 'Outlook · Microsoft 365' }));
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    const name = screen.getByLabelText('名称') as HTMLInputElement;
    expect(name.value).toBe('Outlook');
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'you@outlook.com' } });
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  }

  it('建账户 → 生成授权链接 → 粘贴完整地址 → submitMsAuthCode → 完成页', async () => {
    api.createAccountMock.mockResolvedValue(MS_ACCOUNT);
    const authUri = 'https://login.microsoftonline.com/common/oauth2/nativeclient?code=abc&x=1';
    api.requestMsAuthUrlMock.mockResolvedValue(authUri);
    const authorized = makeAccount({ ...MS_ACCOUNT, status: 'ok', has_credentials: true });
    api.submitMsAuthCodeMock.mockResolvedValue(authorized);
    const onDone = vi.fn();
    renderWizard(onDone);

    await fillMsForm();
    await waitFor(() =>
      expect(api.createAccountMock).toHaveBeenCalledWith({
        name: 'Outlook',
        kind: 'microsoft',
        email: 'you@outlook.com',
      }),
    );

    // 微软建账户后停在授权引导步：先「生成授权链接」
    const generate = await screen.findByRole('button', { name: '生成授权链接' });
    fireEvent.click(generate);
    await waitFor(() => expect(api.requestMsAuthUrlMock).toHaveBeenCalledWith(2));

    // 链接拿到后出现「新标签打开」与「复制」（全站唯一的复制零件），并出现粘贴框与完成按钮
    expect(screen.getByRole('button', { name: '在新标签页打开微软登录' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy();
    const paste = screen.getByLabelText('把地址栏的完整地址粘贴到这里') as HTMLInputElement;
    fireEvent.change(paste, { target: { value: `  ${authUri}  ` } });
    fireEvent.click(screen.getByRole('button', { name: '完成授权' }));

    // 粘贴内容提交前 trim 过
    await waitFor(() => expect(api.submitMsAuthCodeMock).toHaveBeenCalledWith(2, authUri));
    expect(await screen.findByText(/已接入 Outlook。/)).toBeTruthy();
    expect(screen.getByText(/开始拉取近期邮件/)).toBeTruthy();
    expect(screen.queryByText(/7 天/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    expect(onDone).toHaveBeenCalledWith(authorized);
  });

  it('auth_failed declined：显示中文文案并可重新生成链接', async () => {
    api.createAccountMock.mockResolvedValue(MS_ACCOUNT);
    api.requestMsAuthUrlMock.mockResolvedValue('https://login.microsoftonline.com/oauth2/authorize');
    api.submitMsAuthCodeMock.mockRejectedValue(
      Object.assign(new Error('HTTP 400'), {
        code: 'auth_failed',
        kind: 'declined',
        detail: 'declined by user',
      }),
    );
    renderWizard();

    await fillMsForm();
    fireEvent.click(await screen.findByRole('button', { name: '生成授权链接' }));
    await waitFor(() => expect(api.requestMsAuthUrlMock).toHaveBeenCalledTimes(1));

    const paste = screen.getByLabelText('把地址栏的完整地址粘贴到这里') as HTMLInputElement;
    fireEvent.change(paste, { target: { value: 'microsoftauth://complete?code=zz' } });
    fireEvent.click(screen.getByRole('button', { name: '完成授权' }));

    expect(await screen.findByText('你在微软页面上拒绝了授权，可重新生成链接再试')).toBeTruthy();
    // 拒绝后回到第一步：可以重新生成链接
    expect(screen.getByRole('button', { name: '生成授权链接' })).toBeTruthy();
  });

  it('微软授权步可「稍后再授权」：账户未授权也直接回调 onDone', async () => {
    api.createAccountMock.mockResolvedValue(MS_ACCOUNT);
    const onDone = vi.fn();
    renderWizard(onDone);

    await fillMsForm();
    fireEvent.click(await screen.findByRole('button', { name: '稍后再授权' }));

    expect(onDone).toHaveBeenCalledWith(MS_ACCOUNT);
    expect(api.requestMsAuthUrlMock).not.toHaveBeenCalled();
  });
});

describe('AccountWizard 基本信息步的表单体验', () => {
  it('刚进第 2 步不显示任何红字：邮箱/密码为空是必然的，无条件报错等于一进门就满屏红', () => {
    renderWizard();

    fireEvent.click(screen.getByRole('button', { name: 'Gmail' }));
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));

    expect(screen.getByLabelText('邮箱')).toBeTruthy();
    expect(screen.queryByText('请填写正确的邮箱地址')).toBeNull();
    expect(screen.queryByText('请填写应用专用密码')).toBeNull();
    // 但按钮该灰还是灰——不显示红字不等于放行
    expect((screen.getByRole('button', { name: '下一步' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('邮箱框失焦一次后才显示红字，改对之后红字消失', () => {
    renderWizard();

    fireEvent.click(screen.getByRole('button', { name: 'Gmail' }));
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));

    fireEvent.blur(screen.getByLabelText('邮箱'));
    expect(screen.getByText('请填写正确的邮箱地址')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'me@gmail.com' } });
    expect(screen.queryByText('请填写正确的邮箱地址')).toBeNull();
  });

  it('邮箱轻校验：a@b（域名没有点）判非法，a@b.c 判合法', () => {
    renderWizard();

    fireEvent.click(screen.getByRole('button', { name: 'Gmail' }));
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '我的 Gmail' } });
    fireEvent.change(screen.getByLabelText('应用专用密码'), { target: { value: 'abcd efgh' } });

    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'a@b' } });
    expect((screen.getByRole('button', { name: '下一步' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'a@b.c' } });
    expect((screen.getByRole('button', { name: '下一步' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('第 2 步可以「上一步」回类型选择，回去再来时已填的邮箱还在', () => {
    renderWizard();

    fireEvent.click(screen.getByRole('button', { name: 'Gmail' }));
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'me@gmail.com' } });

    fireEvent.click(screen.getByRole('button', { name: '上一步' }));
    // 回到类型选择：两张类型卡片重新出现，「上一步」自己消失（第 1 步没有上一步）
    expect(screen.getByRole('button', { name: 'Outlook · Microsoft 365' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '上一步' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    expect((screen.getByLabelText('邮箱') as HTMLInputElement).value).toBe('me@gmail.com');
    expect(api.createAccountMock).not.toHaveBeenCalled();
  });

  it('上一步换成微软后不再要求应用专用密码，表单跟着换', () => {
    renderWizard();

    fireEvent.click(screen.getByRole('button', { name: 'Gmail' }));
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    expect(screen.getByLabelText('应用专用密码')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '上一步' }));
    fireEvent.click(screen.getByRole('button', { name: 'Outlook · Microsoft 365' }));
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));

    expect(screen.queryByLabelText('应用专用密码')).toBeNull();
    expect(screen.getByRole('button', { name: /高级/ })).toBeTruthy();
  });
});

describe('AccountWizard 新错误码映射', () => {
  it.each([
    ['too_many_accounts', '已达到邮箱账户数量上限，先移除一个再添加'],
    ['rate_limited', '操作太频繁，请稍后再试'],
  ])('createAccount 抛 %s → Alert 文案「%s」', async (code, message) => {
    api.createAccountMock.mockRejectedValue({ code });
    renderWizard();

    fireEvent.click(screen.getByRole('button', { name: 'Gmail' }));
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '我的 Gmail' } });
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'me@gmail.com' } });
    fireEvent.change(screen.getByLabelText('应用专用密码'), { target: { value: 'abcd efgh' } });
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));

    expect(await screen.findByText(message)).toBeTruthy();
    // 留在原步，用户能直接改
    expect(screen.getByLabelText('邮箱')).toBeTruthy();
  });
});

describe('AccountWizard 按钮层级', () => {
  it('取消只有一种变体：text + inherit；「下一步」是主操作 contained', async () => {
    renderWizard();

    const cancel = screen.getByRole('button', { name: '取消' });
    expect(cancel.className).toMatch(/MuiButton-text/);
    expect(cancel.className).toMatch(/MuiButton-colorInherit/);
    expect(cancel.className).not.toMatch(/MuiButton-outlined/);

    const next = screen.getByRole('button', { name: '下一步' });
    expect(next.className).toMatch(/MuiButton-contained/);
  });

  it('折叠入口（高级）是三级动作：text + inherit', async () => {
    renderWizard();

    fireEvent.click(screen.getByRole('button', { name: 'Gmail' }));
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    fireEvent.click(screen.getByRole('button', { name: '上一步' }));
    fireEvent.click(screen.getByRole('button', { name: 'Outlook · Microsoft 365' }));
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));

    const advanced = screen.getByRole('button', { name: /高级/ });
    expect(advanced.className).toMatch(/MuiButton-text/);
    expect(advanced.className).toMatch(/MuiButton-colorInherit/);
  });
});

describe('AccountWizard 类型卡片不铺纸', () => {
  it('未选中的类型卡背景是 transparent：移动端它坐在玻璃面板上，铺纸会把玻璃闷掉', () => {
    renderWizard();

    const card = screen
      .getByText('Outlook · Microsoft 365')
      .closest('.MuiCard-root') as HTMLElement;
    expect(card).not.toBeNull();
    expect(ruleTextOf(allStyleText(), card)).toContain('background-color:transparent');
  });
});
