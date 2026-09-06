// 设置页：账户状态 / 外观 / 账户 / 关于 四个纵向分区（原 StatusPage 逻辑迁入账户状态区）。

import { useCallback, useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import RefreshIcon from '@mui/icons-material/Refresh';
import Skeleton from '@mui/material/Skeleton';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import {
  caldavTarget,
  calendarUrls,
  fetchCaldavInfo,
  fetchCalendarToken,
  fetchStatus,
  generateCaldavPassword,
  rotateCalendarToken,
} from '../lib/api';
import { copyText } from '../lib/clipboard';
import { API_BASE_URL, PHAINON_API_BASE } from '../lib/env';
import { enterSx, usePrefersReducedMotion } from '../lib/motion';
import { logout, startLogin } from '../lib/phainon';
import { checkForUpdate } from '../lib/pwa-update';
import { useSession } from '../lib/session';
import { useThemeMode } from '../lib/theme-mode';
import { timeAgo } from '../lib/time';
import { compressWallpaper, setWallpaper, useWallpaper } from '../lib/wallpaper';
import type { CaldavInfo, StatusResponse } from '../types';

export default function SettingsPage() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 日历订阅：令牌 + 订阅链接，加载失败降级为 Alert
  const [token, setToken] = useState<string | null>(null);
  const [calLoading, setCalLoading] = useState(true);
  const [calError, setCalError] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [snack, setSnack] = useState<string | null>(null);
  // 提醒事项同步（CalDAV）：连接信息 + 一次性同步密码（仅存内存，不持久化）
  const [dav, setDav] = useState<CaldavInfo | null>(null);
  const [davLoading, setDavLoading] = useState(true);
  const [davError, setDavError] = useState(false);
  const [davPassword, setDavPassword] = useState<string | null>(null);
  const [davRotateOpen, setDavRotateOpen] = useState(false);
  const [davGenerating, setDavGenerating] = useState(false);
  const { mode, setMode } = useThemeMode();
  const me = useSession();
  const reduced = usePrefersReducedMotion();
  // 壁纸：订阅模块级状态（同 useThemeMode 之外的 list-cache 模式），无壁纸为 null
  const wallpaper = useWallpaper();
  // 「选择图片」按钮触发的是隐藏的 file input
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** 选中图片：先压缩再持久化。压缩失败与写入失败（超配额）分开提示——后者说明
   *  压完的图还是塞不进 localStorage，需要换更小的图。 */
  const handleWallpaperFile = async (file: File) => {
    let dataUrl: string;
    try {
      dataUrl = await compressWallpaper(file);
    } catch {
      setSnack('图片处理失败');
      return;
    }
    try {
      setWallpaper(dataUrl);
    } catch {
      setSnack('图片太大，换一张小一点的');
    }
  };

  const load = useCallback(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetchStatus()
      .then((s) => {
        if (alive) setStatus(s);
      })
      .catch(() => {
        if (alive) setError('加载状态失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => load(), [load]);

  // 挂载时取日历订阅令牌（服务端尚无则生成后返回）
  useEffect(() => {
    let alive = true;
    fetchCalendarToken()
      .then((t) => {
        if (alive) setToken(t);
      })
      .catch(() => {
        if (alive) setCalError(true);
      })
      .finally(() => {
        if (alive) setCalLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // 挂载时取提醒事项同步配置（与日历令牌请求并列、互不影响）
  useEffect(() => {
    let alive = true;
    fetchCaldavInfo()
      .then((info) => {
        if (alive) setDav(info);
      })
      .catch(() => {
        if (alive) setDavError(true);
      })
      .finally(() => {
        if (alive) setDavLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const urls = token ? calendarUrls(token) : null;

  const handleCopyLink = () => {
    if (!urls) return;
    copyText(() => Promise.resolve(urls.https))
      .then(() => setSnack('已复制'))
      .catch(() => setSnack('复制失败'));
  };

  /** 重新生成：旧令牌立即作废，已订阅的日历需要重新添加 */
  const handleRotate = () => {
    setRotating(true);
    rotateCalendarToken()
      .then((t) => {
        setToken(t);
        setRotateOpen(false);
        setSnack('已重新生成');
      })
      .catch(() => {
        setRotateOpen(false);
        setSnack('重新生成失败');
      })
      .finally(() => setRotating(false));
  };

  const davTarget = dav ? caldavTarget(dav.path) : null;

  const handleCopyServer = () => {
    if (!davTarget) return;
    copyText(() => Promise.resolve(davTarget.host))
      .then(() => setSnack('已复制'))
      .catch(() => setSnack('复制失败'));
  };

  const handleCopyUsername = () => {
    if (!dav) return;
    copyText(() => Promise.resolve(dav.username))
      .then(() => setSnack('已复制'))
      .catch(() => setSnack('复制失败'));
  };

  const handleCopyPassword = () => {
    if (!davPassword) return;
    copyText(() => Promise.resolve(davPassword))
      .then(() => setSnack('已复制'))
      .catch(() => setSnack('复制失败'));
  };

  /** 生成（或重新生成）同步密码：成功后只展示一次；后端保证旧密码立即失效 */
  const handleGenerateDavPassword = () => {
    setDavGenerating(true);
    generateCaldavPassword()
      .then((pw) => {
        setDavPassword(pw);
        setDav((d) => (d ? { ...d, configured: true } : d));
        setDavRotateOpen(false);
        setSnack('已生成');
      })
      .catch(() => {
        setDavRotateOpen(false);
        setSnack('生成失败');
      })
      .finally(() => setDavGenerating(false));
  };

  const displayName = me ? (me.user.name ?? me.user.email ?? me.user.sub) : '未知用户';

  const handleLogout = async () => {
    await logout();
    startLogin();
  };

  // 手动检查新版：SW 尚未注册（环境不支持）时给对应提示
  const handleCheckUpdate = () => {
    checkForUpdate().then((started) => {
      setSnack(started ? '已检查，若有新版本会自动重载' : '当前环境不支持自动更新');
    });
  };

  return (
    <Box>
      {/* 账户状态：原 StatusPage 全部展示逻辑，key 用后端补回的 a.id */}
      <Box sx={{ px: 2, pt: 2 }}>
        <Stack direction="row" alignItems="center" sx={{ mb: 1 }}>
          <Typography variant="overline" sx={{ flexGrow: 1 }}>
            账户状态
          </Typography>
          <IconButton size="small" aria-label="刷新" onClick={load} disabled={loading}>
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Stack>
        {loading && !status ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        ) : error && !status ? (
          <Alert severity="error">{error}</Alert>
        ) : status ? (
          <Stack spacing={1.5}>
            {status.accounts.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', py: 2 }}>
                还没有配置邮箱账户。请联系管理员在服务器上用命令行添加。
              </Typography>
            ) : (
              <>
                <Alert severity="info" icon={false} sx={{ py: 0.5 }}>
                  LLM 待处理邮件：{status.pending_llm} 封
                </Alert>
                {status.accounts.map((a, index) => (
                  <Card
                    key={a.id}
                    variant="outlined"
                    // 变暗用 filter 而非 opacity：入场动画 animation-fill-mode: both
                    // 会把关键帧终态 opacity: 1 保持在元素上（动画值优先级高于普通声明），
                    // 静态 opacity 会被压掉；filter 与动画互不干扰，动画期间/结束后都有效。
                    sx={{ ...enterSx(index, reduced), filter: a.enabled === false ? 'opacity(0.6)' : 'none' }}
                  >
                    <CardContent>
                      <Stack direction="row" spacing={1.5} alignItems="center">
                        <Avatar>{a.kind === 'gmail' ? 'G' : 'O'}</Avatar>
                        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                          <Typography variant="subtitle1" noWrap>
                            {a.name}
                          </Typography>
                          <Typography variant="body2" color="text.secondary" noWrap>
                            {a.email}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            上次同步：
                            {a.last_sync_at ? timeAgo(a.last_sync_at) : '从未'}
                          </Typography>
                        </Box>
                        {a.enabled === false ? (
                          <Chip label="已停用" size="small" color="default" variant="outlined" />
                        ) : (
                          <Chip
                            label={a.status === 'ok' ? '正常' : a.status === 'error' ? '异常' : '同步中'}
                            size="small"
                            color={a.status === 'ok' ? 'success' : a.status === 'error' ? 'error' : 'warning'}
                            variant="outlined"
                          />
                        )}
                      </Stack>
                      {a.status === 'error' && a.last_error && (
                        <Typography
                          variant="body2"
                          color="error"
                          sx={{ mt: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        >
                          {a.last_error}
                        </Typography>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </>
            )}
          </Stack>
        ) : null}
      </Box>

      <Divider sx={{ my: 2 }} />

      {/* 外观：深浅色三态，读写 useThemeMode */}
      <Box sx={{ px: 2 }}>
        <Typography variant="overline">外观</Typography>
        <ToggleButtonGroup
          exclusive
          fullWidth
          size="small"
          value={mode}
          onChange={(_e, v) => {
            if (v === 'system' || v === 'light' || v === 'dark') setMode(v);
          }}
        >
          <ToggleButton value="system">跟随系统</ToggleButton>
          <ToggleButton value="light">浅色</ToggleButton>
          <ToggleButton value="dark">深色</ToggleButton>
        </ToggleButtonGroup>
      </Box>

      <Divider sx={{ my: 2 }} />

      {/* 壁纸：本机背景图，localStorage 持久化（不传后端） */}
      <Box sx={{ px: 2 }}>
        <Typography variant="overline">壁纸</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          壁纸只存在本机浏览器里，换设备需要重新设置。
        </Typography>
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
          <Button variant="outlined" onClick={() => fileInputRef.current?.click()}>
            选择图片
          </Button>
          {wallpaper && (
            <Button variant="outlined" color="warning" onClick={() => setWallpaper(null)}>
              移除壁纸
            </Button>
          )}
        </Stack>
        {wallpaper && (
          <Box
            role="img"
            aria-label="壁纸预览"
            sx={{
              height: 96,
              borderRadius: (theme) => theme.shape.borderRadius,
              backgroundImage: `url("${wallpaper}")`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
            }}
          />
        )}
        {/* 隐藏的 file input：「选择图片」按钮触发它的 click；值每次清空，
            同一文件才能再次触发 change */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleWallpaperFile(file);
            e.target.value = '';
          }}
        />
      </Box>

      <Divider sx={{ my: 2 }} />

      {/* 日历订阅：只读订阅链接（iCal 公开端点）+ 订阅 / 复制 / 重新生成 */}
      <Box sx={{ px: 2 }}>
        <Typography variant="overline">日历订阅</Typography>
        {calLoading ? (
          <Skeleton variant="text" />
        ) : calError ? (
          <Alert severity="error">加载订阅链接失败</Alert>
        ) : token && urls ? (
          <>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              有截止日的未完成任务会出现在日历里，完成后自动消失；提醒时间为截止日当天
              10:00。iPhone 上订阅日历的刷新频率由系统「获取新数据」设置决定。
            </Typography>
            <TextField
              fullWidth
              size="small"
              value={urls.https}
              InputProps={{ readOnly: true }}
              inputProps={{ 'aria-label': '订阅链接' }}
            />
            <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap' }}>
              <Button variant="contained" component="a" href={urls.webcal}>
                在 iPhone 上订阅
              </Button>
              <Button variant="outlined" onClick={handleCopyLink}>
                复制链接
              </Button>
              <Button variant="outlined" color="warning" onClick={() => setRotateOpen(true)}>
                重新生成
              </Button>
            </Stack>
          </>
        ) : null}
      </Box>

      <Divider sx={{ my: 2 }} />

      {/* 提醒事项同步：iPhone「提醒事项」经 CalDAV 同步的开通入口（服务器/用户名 + 一次性密码） */}
      <Box sx={{ px: 2 }}>
        <Typography variant="overline">提醒事项同步</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          把任务同步到 iPhone「提醒事项」App：在手机上勾选、新建、修改都会回到这里。手机上新建的任务归入「个人」分类。
        </Typography>
        {davLoading ? (
          <Skeleton variant="text" />
        ) : davError ? (
          <Alert severity="error">加载提醒事项同步配置失败</Alert>
        ) : dav && davTarget ? (
          <>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
              <TextField
                fullWidth
                size="small"
                value={davTarget.host}
                InputProps={{ readOnly: true }}
                inputProps={{ 'aria-label': '服务器' }}
              />
              <IconButton size="small" aria-label="复制服务器" onClick={handleCopyServer}>
                <ContentCopyIcon fontSize="small" />
              </IconButton>
            </Stack>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
              <TextField
                fullWidth
                size="small"
                value={dav.username}
                InputProps={{ readOnly: true }}
                inputProps={{ 'aria-label': '用户名' }}
              />
              <IconButton size="small" aria-label="复制用户名" onClick={handleCopyUsername}>
                <ContentCopyIcon fontSize="small" />
              </IconButton>
            </Stack>
            {dav.configured ? (
              <Button variant="outlined" color="warning" onClick={() => setDavRotateOpen(true)}>
                重新生成密码
              </Button>
            ) : !davPassword ? (
              <Button variant="contained" onClick={handleGenerateDavPassword}>
                生成同步密码
              </Button>
            ) : null}
            {davPassword && (
              <>
                <Alert severity="warning" sx={{ mt: 1 }}>
                  此密码只显示一次，离开本页后无法再查看；遗失请重新生成。
                </Alert>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1 }}>
                  <TextField
                    fullWidth
                    size="small"
                    value={davPassword}
                    InputProps={{ readOnly: true }}
                    inputProps={{ 'aria-label': '同步密码' }}
                  />
                  <IconButton size="small" aria-label="复制密码" onClick={handleCopyPassword}>
                    <ContentCopyIcon fontSize="small" />
                  </IconButton>
                </Stack>
              </>
            )}
            <List dense sx={{ mt: 1 }}>
              <ListItem sx={{ px: 0 }}>
                <ListItemText primary="1. 打开 iPhone「设置」→「应用」→「提醒事项」→「提醒事项账户」→「添加账户」→「其他」→「添加 CalDAV 账户」" />
              </ListItem>
              <ListItem sx={{ px: 0 }}>
                <ListItemText primary="2. 服务器填上面的「服务器」，用户名、密码填上面的值，描述随意，点「下一步」并存储。" />
              </ListItem>
              <ListItem sx={{ px: 0 }}>
                <ListItemText primary="3. 打开「提醒事项」App，会出现名为「RakkoTasks」的列表。同步频率由系统「获取新数据」设置决定。" />
              </ListItem>
            </List>
          </>
        ) : null}
      </Box>

      <Divider sx={{ my: 2 }} />

      {/* 账户：显示登录者 + 退出登录（回到登录流程） */}
      <Box sx={{ px: 2 }}>
        <Typography variant="overline">账户</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {displayName}
        </Typography>
        <Button variant="outlined" color="error" onClick={handleLogout}>
          退出登录
        </Button>
      </Box>

      <Divider sx={{ my: 2 }} />

      {/* 关于：构建注入的版本号与后端地址 */}
      <Box sx={{ px: 2, pb: 2 }}>
        <Typography variant="overline">关于</Typography>
        <List dense>
          <ListItem>
            <ListItemText primary="版本" secondary={__APP_VERSION__} />
          </ListItem>
          <ListItem>
            <Button variant="outlined" size="small" onClick={handleCheckUpdate}>
              检查更新
            </Button>
          </ListItem>
          <ListItem>
            <ListItemText primary="后端地址" secondary={API_BASE_URL || '同源'} />
          </ListItem>
          <ListItem>
            <ListItemText primary="鉴权服务" secondary={PHAINON_API_BASE} />
          </ListItem>
        </List>
      </Box>

      {/* 重新生成确认：旧链接立即失效，已订阅的日历需重新添加 */}
      <Dialog open={rotateOpen} onClose={rotating ? undefined : () => setRotateOpen(false)}>
        <DialogTitle>重新生成订阅链接</DialogTitle>
        <DialogContent>
          <DialogContentText>
            重新生成后，旧链接立即失效，已订阅的日历需要重新添加。
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRotateOpen(false)} disabled={rotating}>
            取消
          </Button>
          <Button color="error" onClick={handleRotate} disabled={rotating}>
            确认
          </Button>
        </DialogActions>
      </Dialog>
      {/* 重新生成同步密码确认：旧密码立即失效，已配置的 iPhone 需要重新填写 */}
      <Dialog
        open={davRotateOpen}
        onClose={davGenerating ? undefined : () => setDavRotateOpen(false)}
      >
        <DialogTitle>重新生成同步密码</DialogTitle>
        <DialogContent>
          <DialogContentText>
            重新生成后旧密码立即失效，已配置的 iPhone 需要重新填写密码。
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDavRotateOpen(false)} disabled={davGenerating}>
            取消
          </Button>
          <Button color="error" onClick={handleGenerateDavPassword} disabled={davGenerating}>
            确认
          </Button>
        </DialogActions>
      </Dialog>
      <Snackbar
        open={snack !== null}
        autoHideDuration={3000}
        onClose={() => setSnack(null)}
        message={snack}
      />
    </Box>
  );
}
