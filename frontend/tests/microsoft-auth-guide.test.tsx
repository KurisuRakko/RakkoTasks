// MicrosoftAuthGuide 测试：授权引导两步（生成链接 → 粘贴回地址）与复制反馈的生命周期。
// requestMsAuthUrl / submitMsAuthCode / copyText 全部 mock。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import MicrosoftAuthGuide from '../src/components/accounts/MicrosoftAuthGuide';
import type { AccountInfo } from '../src/types';

const api = vi.hoisted(() => ({
  requestMsAuthUrlMock: vi.fn(),
  submitMsAuthCodeMock: vi.fn(),
  copyTextMock: vi.fn(),
}));

vi.mock('../src/lib/api', () => ({
  requestMsAuthUrl: api.requestMsAuthUrlMock,
  submitMsAuthCode: api.submitMsAuthCodeMock,
}));
vi.mock('../src/lib/clipboard', () => ({ copyText: api.copyTextMock }));

const AUTH_URI = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x';

const ACCOUNT: AccountInfo = {
  id: 3,
  name: 'Outlook',
  kind: 'microsoft',
  email: 'you@outlook.com',
  status: 'ok',
  enabled: true,
  has_credentials: true,
  ms_client_id: null,
  last_sync_at: null,
  last_error: null,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** 走到第 ② 步：生成链接后界面切成「打开 / 复制 / 粘贴地址」 */
async function intoLinkStep(onAuthorized = vi.fn()) {
  api.requestMsAuthUrlMock.mockResolvedValue(AUTH_URI);
  render(<MicrosoftAuthGuide accountId={ACCOUNT.id} onAuthorized={onAuthorized} />);
  fireEvent.click(screen.getByRole('button', { name: '生成授权链接' }));
  await screen.findByRole('button', { name: '复制链接' });
  return onAuthorized;
}

describe('MicrosoftAuthGuide 复制反馈', () => {
  it('复制成功的提示 3 秒后自撤，不会一直挂在按钮下面', async () => {
    // 自撤计时器在复制那一刻就排好了，假时钟必须先于点击安装，否则排的是真定时器
    vi.useFakeTimers();
    try {
      api.copyTextMock.mockResolvedValue(undefined);
      api.requestMsAuthUrlMock.mockResolvedValue(AUTH_URI);
      render(<MicrosoftAuthGuide accountId={ACCOUNT.id} onAuthorized={vi.fn()} />);

      fireEvent.click(screen.getByRole('button', { name: '生成授权链接' }));
      await act(async () => {});
      fireEvent.click(screen.getByRole('button', { name: '复制链接' }));
      await act(async () => {});
      expect(screen.getByText('已复制链接')).toBeTruthy();

      await act(async () => {
        vi.advanceTimersByTime(3100);
      });
      expect(screen.queryByText('已复制链接')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('重新生成链接时清掉上一次的复制提示，不把旧话带过去', async () => {
    api.copyTextMock.mockResolvedValue(undefined);
    await intoLinkStep();

    fireEvent.click(screen.getByRole('button', { name: '复制链接' }));
    await screen.findByText('已复制链接');

    // 流程失效走回第 ① 步：提交一个 no_pending_flow
    api.submitMsAuthCodeMock.mockRejectedValue({ code: 'no_pending_flow' });
    fireEvent.change(screen.getByLabelText('把地址栏的完整地址粘贴到这里'), {
      target: { value: 'https://example.invalid/?code=abc' },
    });
    fireEvent.click(screen.getByRole('button', { name: '完成授权' }));
    await screen.findByText('授权流程已失效，请重新生成链接');

    fireEvent.click(screen.getByRole('button', { name: '生成授权链接' }));
    await screen.findByRole('button', { name: '复制链接' });
    expect(screen.queryByText('已复制链接')).toBeNull();
  });

  it('复制失败给出失败提示，不谎报成功', async () => {
    api.copyTextMock.mockRejectedValue(new Error('denied'));
    await intoLinkStep();

    fireEvent.click(screen.getByRole('button', { name: '复制链接' }));
    expect(await screen.findByText('复制失败')).toBeTruthy();
    expect(screen.queryByText('已复制链接')).toBeNull();
  });
});

describe('MicrosoftAuthGuide 授权提交', () => {
  it('粘贴回地址 → submitMsAuthCode 收到去空白后的原文，成功后回调最新账户', async () => {
    const onAuthorized = vi.fn();
    await intoLinkStep(onAuthorized);
    api.submitMsAuthCodeMock.mockResolvedValue({ ...ACCOUNT, status: 'ok' });

    fireEvent.change(screen.getByLabelText('把地址栏的完整地址粘贴到这里'), {
      target: { value: '  https://example.invalid/?code=abc  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: '完成授权' }));

    await waitFor(() =>
      expect(api.submitMsAuthCodeMock).toHaveBeenCalledWith(
        ACCOUNT.id,
        'https://example.invalid/?code=abc',
      ),
    );
    expect(onAuthorized).toHaveBeenCalledWith({ ...ACCOUNT, status: 'ok' });
  });

  it('地址框为空时「完成授权」禁用', async () => {
    await intoLinkStep();
    expect((screen.getByRole('button', { name: '完成授权' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
