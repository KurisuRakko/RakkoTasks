// 邮箱账户的移动端独立路由页（桌面端用 Dialog，这些页面在桌面访问一律重定向回 /settings）：
// /settings/accounts/new        添加向导（AccountWizard 页面形态）
// /settings/accounts/:id        账户详情（AccountDetail 页面形态）
// /settings/accounts/:id/remove 移除二选一（RemoveAccountChoice 页面形态）
// 三页都挂载时 fetchAccounts 找账户；找不到即重定向回 /settings（越权/已删账户是后端 404
// 语义，前端不猜）。页面容器与设置页同款：内容坐在 data-glass="panel" 玻璃面板上、
// 底部给固定底栏让出空间。返回靠 AppShell 的返回箭头。

import { useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import { Navigate, useParams } from 'react-router-dom';
import type { ReactNode } from 'react';
import AccountDetail from '../components/accounts/AccountDetail';
import AccountRemoveChoice from '../components/accounts/RemoveAccountChoice';
import AccountWizard from '../components/accounts/AccountWizard';
import { fetchAccounts } from '../lib/api';
import { EMPTY_STATE_BOX_SX, PAGE_SX, PANEL_SX } from '../lib/layout';
import { useNavigateTo } from '../lib/nav';
import type { AccountInfo } from '../types';

type LoadState =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'missing' }
  | { state: 'ready'; account: AccountInfo };

/** 三页共用的页面容器：外壳留白 + 一块玻璃面板，内容一律坐在面板上 */
function AccountPageShell({ children }: { children: ReactNode }) {
  return (
    <Box sx={PAGE_SX}>
      <Box data-glass="panel" sx={PANEL_SX}>
        {children}
      </Box>
    </Box>
  );
}

/** 挂载时 fetchAccounts 并按 id 找账户；找不到 → missing（渲染层据此重定向） */
function useAccountLoader(accountId: number): [LoadState, (account: AccountInfo) => void] {
  const [load, setLoad] = useState<LoadState>({ state: 'loading' });

  useEffect(() => {
    // 路径段不是数字时连请求都不该发（/settings/accounts/abc）
    if (Number.isNaN(accountId)) {
      setLoad({ state: 'missing' });
      return;
    }
    let alive = true;
    fetchAccounts()
      .then((accounts) => {
        if (!alive) return;
        const found = accounts.find((a) => a.id === accountId);
        setLoad(found ? { state: 'ready', account: found } : { state: 'missing' });
      })
      .catch(() => {
        if (alive) setLoad({ state: 'error' });
      });
    return () => {
      alive = false;
    };
  }, [accountId]);

  // 页面内保存成功（重命名/启用/授权）后把最新账户放回状态，避免与后端不一致
  const setAccount = useCallback((account: AccountInfo) => {
    setLoad({ state: 'ready', account });
  }, []);

  return [load, setAccount];
}

/** 桌面端一律用 Dialog：这三个路由页只在移动端可见（md 起重定向回 /settings） */
function useDesktopOnlyRedirect(): boolean {
  const theme = useTheme();
  return useMediaQuery(theme.breakpoints.up('md'));
}

function LoadingPage() {
  return (
    <AccountPageShell>
      <Box sx={EMPTY_STATE_BOX_SX}>
        <CircularProgress />
      </Box>
    </AccountPageShell>
  );
}

function ErrorPage() {
  return (
    <AccountPageShell>
      <Alert severity="error">加载账户失败</Alert>
    </AccountPageShell>
  );
}

/** 添加向导页：完成或取消都回设置列表（账户已建后回列表刷新即可看到） */
export function AccountNewPage() {
  const go = useNavigateTo();
  const desktop = useDesktopOnlyRedirect();
  if (desktop) return <Navigate to="/settings" replace />;
  return (
    <AccountPageShell>
      <Typography variant="h6" gutterBottom>
        添加邮箱账户
      </Typography>
      <AccountWizard onDone={() => go('/settings')} onCancel={() => go('/settings')} />
    </AccountPageShell>
  );
}

/** 账户详情页 */
export function AccountDetailPage() {
  const { id } = useParams();
  const go = useNavigateTo();
  const desktop = useDesktopOnlyRedirect();
  const accountId = Number(id);
  const [load, setAccount] = useAccountLoader(accountId);

  if (desktop) return <Navigate to="/settings" replace />;
  if (load.state === 'loading') return <LoadingPage />;
  if (load.state === 'missing') return <Navigate to="/settings" replace />;
  if (load.state === 'error') return <ErrorPage />;
  const account = load.account;
  return (
    <AccountPageShell>
      <AccountDetail
        account={account}
        onChanged={(a) => setAccount(a)}
        onRemove={() => go(`/settings/accounts/${account.id}/remove`)}
      />
    </AccountPageShell>
  );
}

/** 移除二选一页：停用/彻底删除后回设置列表，取消回详情 */
export function AccountRemovePage() {
  const { id } = useParams();
  const go = useNavigateTo();
  const desktop = useDesktopOnlyRedirect();
  const accountId = Number(id);
  const [load] = useAccountLoader(accountId);

  if (desktop) return <Navigate to="/settings" replace />;
  if (load.state === 'loading') return <LoadingPage />;
  if (load.state === 'missing') return <Navigate to="/settings" replace />;
  if (load.state === 'error') return <ErrorPage />;
  const account = load.account;
  return (
    <AccountPageShell>
      <Typography variant="h6" gutterBottom>
        移除账户
      </Typography>
      <AccountRemoveChoice
        account={account}
        onDisabled={() => go('/settings')}
        onDeleted={() => go('/settings')}
        onCancel={() => go(`/settings/accounts/${account.id}`)}
      />
    </AccountPageShell>
  );
}
