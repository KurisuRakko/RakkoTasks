// 设置页：邮箱账户 / 外观 / 壁纸 / 日历订阅 / 提醒事项同步 / 账户 / 同步 / 关于 纵向分区。
// 账户分区的全部展示逻辑（fetchStatus、卡片、Chip、空态）迁去了
// components/accounts/AccountsSection.tsx，本页只负责放行与其余分区。
//
// 结构：页外壳 + 8 块 data-glass="panel" 玻璃面板（分区数量与顺序不动），每个面板内是
// 「一个分区标题 + 若干设置行」。行零件在 components/accounts/SettingsRow.tsx：统一最小
// 高度、统一左右内边距、相邻行之间的 inset 发丝线，本页不再各分区自己写 sx。
// 玻璃上的文字一律 text.primary（n9），层级靠字阶（标签 13px / 说明 12px）拉开。

import { useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import Skeleton from '@mui/material/Skeleton';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AccountsSection from '../components/accounts/AccountsSection';
import CopyButton from '../components/accounts/CopyButton';
import SettingsRow, { HINT_SX } from '../components/accounts/SettingsRow';
import WallpaperCropDialog from '../components/WallpaperCropDialog';
import {
  caldavTarget,
  calendarUrls,
  fetchCaldavInfo,
  fetchCalendarToken,
  generateCaldavPassword,
  rotateCalendarToken,
} from '../lib/api';
import { API_BASE_URL, PHAINON_API_BASE } from '../lib/env';
import { PAGE_SX, PANEL_SX } from '../lib/layout';
import { useNavigateTo } from '../lib/nav';
import { logout, startLogin } from '../lib/phainon';
import { checkForUpdate } from '../lib/pwa-update';
import { useSession } from '../lib/session';
import { ROW_GAP_PX } from '../lib/surface';
import { MOTION, RADIUS } from '../rakko-tokens';
import { syncLastSummary, useSyncStatus } from '../lib/sync-status';
import { useThemeMode } from '../lib/theme-mode';
import { loadWallpaperSource, renderWallpaper, setWallpaper, useWallpaper } from '../lib/wallpaper';
import type { WallpaperArea, WallpaperSource } from '../lib/wallpaper';
import type { ThemeMode } from '../lib/theme-mode';
import type { KeyboardEvent } from 'react';
import type { CaldavInfo } from '../types';

/** 分区标题：全站只有这一种（theme 的 overline 字阶），位置固定在面板内顶部。
 *  color 取 inherit —— overline 的容器是 TextField 的 legend，它自带 n7 那档次级色；
 *  玻璃上的次级文字 n7 对比度只有 2.4–2.6，标题必须回到正文色 n9。 */
const SECTION_TITLE_SX = { color: 'inherit', display: 'block', mb: 0.5 } as const;

/** 分段控件与分组按钮组的最小高度：48 与设置行同档（HIG 的 44pt 之上留一档余量） */
const CONTROL_MIN_HEIGHT_SX = { minHeight: '48px' } as const;

const MODE_OPTIONS: readonly { value: ThemeMode; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

/** 外观三态的一个选项 */
interface ModeOption {
  value: ThemeMode;
  label: string;
}

/**
 * 互斥分段控件（外观三态）。
 *
 * 为什么不用 MUI 的 ToggleButtonGroup：契约要求互斥分段选择保留 radiogroup / radio 语义，
 * 而 ToggleButton 出的是 role="group" + aria-pressed，且不给方向键；只往上加属性治不了
 * 组件内部写死的 aria-pressed，也会造出 role 与属性自相矛盾的控件。所以这里用 ButtonBase
 * 自绘：语义、方向键与视觉都在一处，也不必再去和 ToggleButtonGroup 的 group-first /
 * group-last 样式竞争。
 *
 * 键盘行为按 ARIA APG 的 radio group：一组里只有一个 tab 停点（选中项 tabIndex 0、
 * 其余 -1），← / → 与 ↑ / ↓ 切换并同时移动焦点，Home / End 到首尾。
 *
 * 视觉是 Apple 分段控件：一条中性浅填充轨道 + 一块抬起的滑块（纸色 + whisper 阴影，
 * 选中项同时加粗到 600），不画外框也不画段间竖线。颜色与阴影全部取自 theme.palette /
 * theme.shadows，不在组件里写新的色值字面量。
 */
function ModeSegmentedControl({
  value,
  options,
  onChange,
}: {
  value: ThemeMode;
  options: readonly ModeOption[];
  onChange: (value: ThemeMode) => void;
}) {
  // 方向键切换后要把焦点移到新选中项；点击不移动（浏览器已把焦点给被点到的按钮）
  const [focusPending, setFocusPending] = useState(false);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (!focusPending) return;
    const index = options.findIndex((o) => o.value === value);
    refs.current[index]?.focus();
    setFocusPending(false);
  }, [focusPending, options, value]);

  const move = (from: number, delta: number) => {
    const next = (from + delta + options.length) % options.length;
    setFocusPending(true);
    onChange(options[next].value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        move(index, 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        move(index, -1);
        break;
      case 'Home':
        event.preventDefault();
        setFocusPending(true);
        onChange(options[0].value);
        break;
      case 'End':
        event.preventDefault();
        setFocusPending(true);
        onChange(options[options.length - 1].value);
        break;
      default:
        break;
    }
  };

  return (
    <Box
      role="radiogroup"
      aria-label="外观"
      // Apple 分段控件的做法：一条无边框的中性浅填充轨道，选中项是一块抬起的滑块。
      // 不画组外框、不画段间竖线——「外框 + 竖线 + 选中项再描一圈」就是框里套框。
      // 底色用 action.hover（主题层已按深浅两套给好的中性浅填充）；选区由滑块本身
      // 的纸色 + whisper 阴影表达，因此这里也不做 overflow: hidden（聚焦圈会被裁）。
      sx={(theme) => ({
        display: 'flex',
        boxSizing: 'border-box',
        height: '36px',
        padding: '2px',
        borderRadius: `${RADIUS.card}px`,
        backgroundColor: theme.palette.action.hover,
      })}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <ButtonBase
            key={option.value}
            ref={(el: HTMLButtonElement | null) => {
              refs.current[index] = el;
            }}
            role="radio"
            aria-checked={selected}
            // 单选组里只有选中项进 tab 顺序（APG 的 roving tabindex）
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            sx={(theme) => ({
              flexGrow: 1,
              flexBasis: 0,
              minWidth: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              px: 1.5,
              // 段圆角比组小 2px（= 组的内边距），滑块才不会顶到轨道圆角外
              borderRadius: `${RADIUS.card - 2}px`,
              // 段自身不描边、不画竖线：层次全部由滑块（纸色 + 阴影）表达。
              // 选中与未选中的文字都是正文色，字重 600/500 拉开层级（主题已禁 700）。
              color: theme.palette.text.primary,
              backgroundColor: selected ? theme.palette.background.paper : 'transparent',
              // 抬起的滑块：whisper 一档阴影（rakko-tokens 的 WHISPER_SHADOW，
              // 也就是本主题 shadows[1]），不是新的数值
              boxShadow: selected ? theme.shadows[1] : 'none',
              transition: `background-color ${MOTION.state}ms ${MOTION.easeStandard}, box-shadow ${MOTION.state}ms ${MOTION.easeStandard}`,
            })}
          >
            <Typography variant="body2" sx={{ fontWeight: selected ? 600 : 500 }}>
              {option.label}
            </Typography>
          </ButtonBase>
        );
      })}
    </Box>
  );
}

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
  const go = useNavigateTo();
  // 同步状态（顶栏刷新按钮与状态页共用同一份轮询结果）：这里只读上一轮的摘要
  const { status } = useSyncStatus();
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
   *  还得在。cropOpen 兜一层：重复点「取消」或点遮罩不会重复置位。 */
  const closeCrop = () => {
    if (!cropOpen) return;
    setCropOpen(false);
  };

  /** 确认裁剪：先渲染裁剪区域，再持久化。渲染失败与写入失败分开提示；写入失败再按错误
   *  类型分流——超配额才是「图太大」，隐私模式等存储不可用的场景提示换小图是误导。
   *  无论成败都关窗，失败提示交给 Snackbar。
   *  cropOpen 这一半挡的是重复确认：点过一次后按钮还在退场动画里可点，第二次不许再渲染
   *  一次、再写一遍 localStorage、再弹一次提示。 */
  const handleCropConfirm = (area: WallpaperArea) => {
    if (crop === null || !cropOpen) return;
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

  /** 复制反馈一律走这一条 Snackbar（全站唯一的复制提示文案） */
  const reportCopy = (ok: boolean) => setSnack(ok ? '已复制' : '复制失败');

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

      {/* 外观：深浅色三态，读写 useThemeMode。三态是互斥选择，用 radiogroup 语义的分段
          控件（方向键切换并移动焦点） */}
      <Box data-glass="panel" sx={PANEL_SX}>
        <Typography variant="overline" component="h2" sx={SECTION_TITLE_SX}>
          外观
        </Typography>
        {/* 控件坐在一条设置行里：外层行仍保证 ≥48px 的行高与统一内边距，
            组自身是 36px 高的分段控件（Apple 的分段控件不是通栏满高的控件） */}
        <SettingsRow
          label={<Typography variant="body2">主题</Typography>}
          value={<ModeSegmentedControl value={mode} options={MODE_OPTIONS} onChange={setMode} />}
        />
      </Box>

      {/* 壁纸：本机背景图，localStorage 持久化（不传后端） */}
      <Box data-glass="panel" sx={PANEL_SX}>
        <Typography variant="overline" component="h2" sx={SECTION_TITLE_SX}>
          壁纸
        </Typography>
        <SettingsRow
          label={
            <>
              <Typography variant="body2">当前壁纸</Typography>
              <Typography variant="caption" sx={HINT_SX}>
                {wallpaper ? '已设置为本机图片，换设备需要重新设置' : '默认壁纸'}
              </Typography>
            </>
          }
          value={
            <Stack direction="row" spacing={1}>
              <Button
                variant="outlined"
                size="small"
                sx={CONTROL_MIN_HEIGHT_SX}
                onClick={() => fileInputRef.current?.click()}
              >
                选择图片
              </Button>
              {wallpaper && (
                <Button
                  variant="outlined"
                  size="small"
                  sx={CONTROL_MIN_HEIGHT_SX}
                  onClick={() => setWallpaper(null)}
                >
                  恢复默认壁纸
                </Button>
              )}
            </Stack>
          }
        />
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
        <Typography variant="overline" component="h2" sx={SECTION_TITLE_SX}>
          日历订阅
        </Typography>
        {calLoading ? (
          <Skeleton variant="text" />
        ) : calError ? (
          <Alert severity="error">加载订阅链接失败</Alert>
        ) : token && urls ? (
          <>
            <SettingsRow
              label={
                <Typography variant="caption" sx={{ display: 'block' }}>
                  有截止日的未完成任务会出现在日历里，完成后自动消失；提醒时间为截止日当天
                  10:00。iPhone 上订阅日历的刷新频率由系统「获取新数据」设置决定。
                </Typography>
              }
            />
            <SettingsRow
              label={
                <TextField
                  fullWidth
                  size="small"
                  value={urls.https}
                  InputProps={{ readOnly: true }}
                  inputProps={{ 'aria-label': '订阅链接' }}
                />
              }
              value={<CopyButton getText={() => urls.https} onFeedback={reportCopy} />}
            />
            <SettingsRow
              value={
                <Stack direction="row" spacing={1} sx={{ width: '100%' }}>
                  <Button
                    variant="contained"
                    sx={{ ...CONTROL_MIN_HEIGHT_SX, flexGrow: 1 }}
                    component="a"
                    href={urls.webcal}
                  >
                    在 iPhone 上订阅
                  </Button>
                  {/* 重新生成 = 进入破坏性流程（旧链接立即失效），入口用 text error，
                      最终确认在对话框里才是 contained error */}
                  <Button
                    variant="text"
                    color="error"
                    sx={CONTROL_MIN_HEIGHT_SX}
                    onClick={() => setRotateOpen(true)}
                  >
                    重新生成
                  </Button>
                </Stack>
              }
            />
          </>
        ) : null}
      </Box>

      {/* 提醒事项同步：iPhone「提醒事项」经 CalDAV 同步的开通入口（服务器/用户名 + 一次性密码） */}
      <Box data-glass="panel" sx={PANEL_SX}>
        <Typography variant="overline" component="h2" sx={SECTION_TITLE_SX}>
          提醒事项同步
        </Typography>
        {davLoading ? (
          <Skeleton variant="text" />
        ) : davError ? (
          <Alert severity="error">加载提醒事项同步配置失败</Alert>
        ) : dav && davTarget ? (
          <>
            <SettingsRow
              label={
                <Typography variant="caption" sx={{ display: 'block' }}>
                  把任务同步到 iPhone「提醒事项」App：在手机上勾选、新建、修改都会回到这里。
                  手机上新建的任务归入「个人」分类。
                </Typography>
              }
            />
            <SettingsRow
              label={<Typography variant="body2">服务器</Typography>}
              value={
                <Stack direction="row" spacing={1} alignItems="center">
                  <TextField
                    size="small"
                    value={davTarget.host}
                    InputProps={{ readOnly: true }}
                    inputProps={{ 'aria-label': '服务器' }}
                    sx={{ width: { xs: 200, sm: 260 } }}
                  />
                  <CopyButton getText={() => davTarget.host} onFeedback={reportCopy} />
                </Stack>
              }
            />
            <SettingsRow
              label={<Typography variant="body2">用户名</Typography>}
              value={
                <Stack direction="row" spacing={1} alignItems="center">
                  <TextField
                    size="small"
                    value={dav.username}
                    InputProps={{ readOnly: true }}
                    inputProps={{ 'aria-label': '用户名' }}
                    sx={{ width: { xs: 200, sm: 260 } }}
                  />
                  <CopyButton getText={() => dav.username} onFeedback={reportCopy} />
                </Stack>
              }
            />
            <SettingsRow
              value={
                dav.configured ? (
                  // 破坏性操作（旧密码立即失效）靠确认对话框保护，入口用 text error
                  <Button
                    variant="text"
                    color="error"
                    onClick={() => setDavRotateOpen(true)}
                  >
                    重新生成密码
                  </Button>
                ) : (
                  <Button variant="contained" onClick={handleGenerateDavPassword}>
                    生成同步密码
                  </Button>
                )
              }
            />
            {davPassword && (
              <>
                <Alert severity="warning" sx={{ my: 1 }}>
                  此密码只显示一次，离开本页后无法再查看；遗失请重新生成。
                </Alert>
                <SettingsRow
                  label={<Typography variant="body2">同步密码</Typography>}
                  value={
                    <Stack direction="row" spacing={1} alignItems="center">
                      <TextField
                        size="small"
                        value={davPassword}
                        InputProps={{ readOnly: true }}
                        inputProps={{ 'aria-label': '同步密码' }}
                        sx={{ width: { xs: 200, sm: 260 } }}
                      />
                      <CopyButton
                        getText={() => davPassword}
                        onFeedback={reportCopy}
                      />
                    </Stack>
                  }
                />
              </>
            )}
            {/* 三步说明：结构与其它设置行一致，只有一点不同——行与行之间不画分隔线
                （三句是同一段连续引导，切三段线会把一段话读成三件事） */}
            <Stack
              sx={{
                '& [data-setting-row] + [data-setting-row]': {
                  borderTop: 'none',
                  paddingLeft: 0,
                },
              }}
            >
              <SettingsRow
                label={<Typography variant="caption">1. 打开 iPhone「设置」→「应用」→「提醒事项」→「提醒事项账户」→「添加账户」→「其他」→「添加 CalDAV 账户」</Typography>}
              />
              <SettingsRow
                label={<Typography variant="caption">2. 服务器填上面的「服务器」，用户名、密码填上面的值，描述随意，点「下一步」并存储。</Typography>}
              />
              <SettingsRow
                label={<Typography variant="caption">3. 打开「提醒事项」App，会出现名为「RakkoTasks」的列表。同步频率由系统「获取新数据」设置决定。</Typography>}
              />
            </Stack>
          </>
        ) : null}
      </Box>

      {/* 账户：显示登录者 + 退出登录（回到登录流程）。退出登录是危险入口 → text error */}
      <Box data-glass="panel" sx={PANEL_SX}>
        <Typography variant="overline" component="h2" sx={SECTION_TITLE_SX}>
          账户
        </Typography>
        <SettingsRow
          label={<Typography variant="body2">当前登录</Typography>}
          value={displayName}
        />
        <SettingsRow
          value={
            <Button variant="text" color="error" onClick={handleLogout}>
              退出登录
            </Button>
          }
        />
      </Box>

      {/* 同步状态：进 /sync 看这一轮同步的阶段与按邮箱进度；值报上一轮的结果 */}
      <Box data-glass="panel" sx={PANEL_SX}>
        <Typography variant="overline" component="h2" sx={SECTION_TITLE_SX}>
          同步
        </Typography>
        <SettingsRow
          onClick={() => go('/sync')}
          label={<Typography variant="body2">同步状态</Typography>}
          value={
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="caption" sx={{ textAlign: 'right' }}>
                {syncLastSummary(status === null ? null : status.last)}
              </Typography>
              <ChevronRightIcon fontSize="small" />
            </Stack>
          }
        />
      </Box>

      {/* 关于：构建注入的版本号与后端地址 */}
      <Box data-glass="panel" sx={PANEL_SX}>
        <Typography variant="overline" component="h2" sx={SECTION_TITLE_SX}>
          关于
        </Typography>
        <SettingsRow label={<Typography variant="body2">版本</Typography>} value={__APP_VERSION__} />
        <SettingsRow
          value={
            <Button variant="outlined" size="small" onClick={handleCheckUpdate}>
              检查更新
            </Button>
          }
        />
        <SettingsRow
          label={<Typography variant="body2">后端地址</Typography>}
          value={API_BASE_URL || '同源'}
        />
        <SettingsRow
          label={<Typography variant="body2">鉴权服务</Typography>}
          value={PHAINON_API_BASE}
        />
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
          <Button variant="text" color="inherit" onClick={() => setRotateOpen(false)} disabled={rotating}>
            取消
          </Button>
          <Button variant="contained" color="error" onClick={handleRotate} disabled={rotating}>
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
          <Button
            variant="text"
            color="inherit"
            onClick={() => setDavRotateOpen(false)}
            disabled={davGenerating}
          >
            取消
          </Button>
          <Button variant="contained" color="error" onClick={handleGenerateDavPassword} disabled={davGenerating}>
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
      {/* 自动关闭时长由主题的 MuiSnackbar.defaultProps 统一给（4 秒），这里不再写死 */}
      <Snackbar open={snack !== null} onClose={() => setSnack(null)} message={snack} />
    </Box>
  );
}
