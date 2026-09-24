// 设置页：邮箱账户 / 外观 / 日历订阅 / 提醒事项同步 / 账户 / 关于 纵向分区。
// 账户分区的全部展示逻辑（fetchStatus、卡片、Chip、空态）迁去了
// components/accounts/AccountsSection.tsx，本页只负责放行与其余分区。

import { useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import Skeleton from '@mui/material/Skeleton';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import AccountsSection from '../components/accounts/AccountsSection';
import WallpaperCropDialog from '../components/WallpaperCropDialog';
import {
  caldavTarget,
  calendarUrls,
  fetchCaldavInfo,
  fetchCalendarToken,
  generateCaldavPassword,
  rotateCalendarToken,
} from '../lib/api';
import { copyText } from '../lib/clipboard';
import { API_BASE_URL, PHAINON_API_BASE } from '../lib/env';
import { PAGE_SX, PANEL_SX } from '../lib/layout';
import { logout, startLogin } from '../lib/phainon';
import { checkForUpdate } from '../lib/pwa-update';
import { useSession } from '../lib/session';
import { hitSlopSx, ROW_GAP_PX } from '../lib/surface';
import { useThemeMode } from '../lib/theme-mode';
import { loadWallpaperSource, renderWallpaper, setWallpaper, useWallpaper } from '../lib/wallpaper';
import type { WallpaperArea, WallpaperSource } from '../lib/wallpaper';
import type { CaldavInfo } from '../types';

export default function SettingsPage() {
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
  // 壁纸：订阅模块级状态（同 useThemeMode 之外的 list-cache 模式），无壁纸为 null
  const wallpaper = useWallpaper();
  // 裁剪中的来源与比例。与 cropOpen 分开：退场期间还要靠 source 把上一张图显示完
  const [crop, setCrop] = useState<{ source: WallpaperSource; aspect: number } | null>(null);
  const [cropOpen, setCropOpen] = useState(false);
  // 「选择图片」按钮触发的是隐藏的 file input
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** 选中图片 → 解码拿来源 → 按当前视口比例进裁剪。比例取视口是因为壁纸承载层是
   *  position: fixed; inset: 0 + cover——用户取的就是最终看到的景，所见即所得。 */
  const openCrop = async (file: File) => {
    let source: WallpaperSource;
    try {
      source = await loadWallpaperSource(file);
    } catch {
      setSnack('图片处理失败');
      return;
    }
    setCrop({ source, aspect: window.innerWidth / window.innerHeight });
    setCropOpen(true);
  };

  /** 关窗：清空来源与 revoke 都在退场跑完（界面层的 onExited）之后做，退场那段时间图
   *  还得在。cropOpen 兜一层——退场途中重复点按钮不再重复触发。 */
  const closeCrop = () => {
    if (!cropOpen) return;
    setCropOpen(false);
  };

  /** 确认裁剪：先渲染裁剪区域，再持久化。渲染失败与写入失败分开提示；写入失败再按错误
   *  类型分流——超配额才是「图太大」，隐私模式等存储不可用的场景提示换小图是误导。
   *  无论成败都关窗，失败提示交给 Snackbar。 */
  const handleCropConfirm = (area: WallpaperArea) => {
    if (crop === null) return;
    let dataUrl: string;
    try {
      dataUrl = renderWallpaper(crop.source.image, area);
    } catch {
      setSnack('图片处理失败');
      closeCrop();
      return;
    }
    try {
      setWallpaper(dataUrl);
    } catch (error) {
      // NS_ERROR_DOM_QUOTA_REACHED 是 Firefox 的配额错误名，两个都认
      const quota =
        error instanceof DOMException &&
        (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED');
      setSnack(quota ? '图片太大，换一张小一点的' : '无法保存壁纸，浏览器存储不可用');
    }
    closeCrop();
  };

  /** 退场结束才释放 object URL：裁剪面板与退场动画都得靠它 */
  const handleCropExited = () => {
    if (crop !== null) URL.revokeObjectURL(crop.source.url);
    setCrop(null);
  };

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
    // 页面外壳：各分区是 data-glass="panel" 玻璃卡片，卡间竖向间距与列表行一致
    // （ROW_GAP_PX），不再用 Divider 硬切；顶部留白与底部给固定底栏的让位取自
    // lib/layout 的 PAGE_SX。
    <Box
      sx={{
        ...PAGE_SX,
        display: 'flex',
        flexDirection: 'column',
        gap: `${ROW_GAP_PX}px`,
      }}
    >
      {/* 邮箱账户：账户列表 + 添加向导 / 详情 / 移除（AccountsSection 内部按断点分流
          Dialog 或路由页）。分区玻璃由本页统一给，AccountsSection 只管内容。 */}
      <Box data-glass="panel" sx={PANEL_SX}>
        <AccountsSection />
      </Box>

      {/* 外观：深浅色三态，读写 useThemeMode */}
      <Box data-glass="panel" sx={PANEL_SX}>
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

      {/* 壁纸：本机背景图，localStorage 持久化（不传后端） */}
      <Box data-glass="panel" sx={PANEL_SX}>
        <Typography variant="overline">壁纸</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          壁纸只存在本机浏览器里，换设备需要重新设置。
        </Typography>
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
          <Button variant="outlined" onClick={() => fileInputRef.current?.click()}>
            选择图片
          </Button>
          {wallpaper && (
            <Button variant="outlined" onClick={() => setWallpaper(null)}>
              移除壁纸
            </Button>
          )}
        </Stack>
        {/* 隐藏的 file input：「选择图片」按钮触发它的 click；值每次清空，
            同一文件才能再次触发 change */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void openCrop(file);
            e.target.value = '';
          }}
        />
      </Box>

      {/* 日历订阅：只读订阅链接（iCal 公开端点）+ 订阅 / 复制 / 重新生成 */}
      <Box data-glass="panel" sx={PANEL_SX}>
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
              <Button variant="outlined" onClick={() => setRotateOpen(true)}>
                重新生成
              </Button>
            </Stack>
          </>
        ) : null}
      </Box>

      {/* 提醒事项同步：iPhone「提醒事项」经 CalDAV 同步的开通入口（服务器/用户名 + 一次性密码） */}
      <Box data-glass="panel" sx={PANEL_SX}>
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
              <IconButton
                size="small"
                aria-label="复制服务器"
                onClick={handleCopyServer}
                // 命中区补齐到 44×44：按钮自身 30×30，伪元素每边外扩 7px，小于
                // Stack spacing={1} 的 8px 间隔，不侵入左侧 TextField。
                sx={hitSlopSx()}
              >
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
              <IconButton
                size="small"
                aria-label="复制用户名"
                onClick={handleCopyUsername}
                sx={hitSlopSx()}
              >
                <ContentCopyIcon fontSize="small" />
              </IconButton>
            </Stack>
            {dav.configured ? (
              // 破坏性操作（旧密码立即失效）靠下方确认对话框保护，按钮本身不靠 warning 色喊
              <Button variant="outlined" onClick={() => setDavRotateOpen(true)}>
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
                  <IconButton
                    size="small"
                    aria-label="复制密码"
                    onClick={handleCopyPassword}
                    sx={hitSlopSx()}
                  >
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

      {/* 账户：显示登录者 + 退出登录（回到登录流程） */}
      <Box data-glass="panel" sx={PANEL_SX}>
        <Typography variant="overline">账户</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {displayName}
        </Typography>
        <Button variant="outlined" color="error" onClick={handleLogout}>
          退出登录
        </Button>
      </Box>

      {/* 关于：构建注入的版本号与后端地址 */}
      <Box data-glass="panel" sx={PANEL_SX}>
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
      {/* 壁纸裁剪：常驻挂载，入退场由它自己按 open 跑；来源在 onExited 里才释放 */}
      <WallpaperCropDialog
        open={cropOpen}
        source={crop?.source ?? null}
        aspect={crop?.aspect ?? 1}
        onCancel={closeCrop}
        onConfirm={handleCropConfirm}
        onExited={handleCropExited}
      />
      <Snackbar
        open={snack !== null}
        autoHideDuration={3000}
        onClose={() => setSnack(null)}
        message={snack}
      />
    </Box>
  );
}
