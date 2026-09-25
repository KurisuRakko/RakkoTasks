// MicrosoftAuthGuide 测试：授权引导两步（生成链接 → 粘贴回地址）与复制反馈。
// requestMsAuthUrl / submitMsAuthCode / copyText 全部 mock。
// 复制零件已全站收敛成「IconButton + ContentCopy + Tooltip『复制』」，反馈走 Snackbar
// （文案「已复制」/「复制失败」，自动关闭时长由主题默认给），不再有按钮下面的行内提示。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import MicrosoftAuthGuide from '../src/components/accounts/MicrosoftAuthGuide';
import guideSource from '../src/components/accounts/MicrosoftAuthGuide.tsx?raw';
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
  await screen.findByRole('button', { name: '复制' });
  return onAuthorized;
}

/** 复制按钮全站一种可访问名：aria-label 与 Tooltip 都是「复制」 */
function copyButton(): HTMLElement {
  return screen.getByRole('button', { name: '复制' });
}

describe('MicrosoftAuthGuide 复制反馈', () => {
  it('复制按钮是全站唯一那一种零件：IconButton + ContentCopy 图标，可访问名为「复制」', async () => {
    await intoLinkStep();

    const button = copyButton();
    expect(button.className).toMatch(/MuiIconButton-root/);
    expect(button.querySelector('svg[data-testid="ContentCopyIcon"]')).not.toBeNull();
    // 旧的「复制链接」文字按钮与行内提示都已删除
    expect(screen.queryByRole('button', { name: '复制链接' })).toBeNull();
  });

  it('复制成功：反馈走 Snackbar，文案「已复制」；Snackbar 不再自己写死自动关闭时长', async () => {
    api.copyTextMock.mockResolvedValue(undefined);
    await intoLinkStep();

    fireEvent.click(copyButton());

    // 反馈是 Snackbar（MuiSnackbar-root），由主题统一给 4 秒，组件不再传 autoHideDuration
    expect(await screen.findByText('已复制')).toBeTruthy();
    expect(document.querySelector('.MuiSnackbar-root')).not.toBeNull();
    expect(guideSource).not.toContain('autoHideDuration');
  });

  it('复制失败给出失败提示，不谎报成功', async () => {
    api.copyTextMock.mockRejectedValue(new Error('denied'));
    await intoLinkStep();

    fireEvent.click(copyButton());

    expect(await screen.findByText('复制失败')).toBeTruthy();
    expect(screen.queryByText('已复制')).toBeNull();
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
