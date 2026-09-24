// WallpaperCropDialog：壁纸上传的裁剪步骤（移动端全屏、桌面端限宽对话框），由设置页在
// 选中图片后打开。裁剪框锁定为当前视口比例——壁纸承载层是 position: fixed; inset: 0 +
// background-size: cover，取景即最终所见。手机上双指缩放 / 拖动，桌面用下方缩放条。
//
// 入退场固定用 SlideUp，两个方向都由 MUI 自己跑。**不要**用 dialogTransitionProps()：它只给
// 由容器变换长出来的对话框用，普通对话框用它会在 Chromium 上开关都没动效。组件常驻挂载、
// open 来自 props：退场期间还要把上一张图显示完，调用方在 onExited 里才 revoke object URL
// 并清空来源。

import { useState } from 'react';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import IconButton from '@mui/material/IconButton';
import Slider from '@mui/material/Slider';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import CloseIcon from '@mui/icons-material/Close';
import Cropper from 'react-easy-crop';
import { MOTION } from '../rakko-tokens';
import { SCRIM_COLOR } from '../lib/glass';
import { DIALOG_BODY_SX, mainAreaDialogSx } from '../lib/layout';
import { usePrefersReducedMotion } from '../lib/motion';
import type { WallpaperArea, WallpaperSource } from '../lib/wallpaper';
import { SlideUp } from './DialogTransition';

interface Props {
  open: boolean;
  /** 常驻挂载：关闭后退场期间仍需显示上一张图，调用方在 onExited 里才清空 */
  source: WallpaperSource | null;
  /** 裁剪框宽高比（宽/高），由调用方在打开时按视口取 */
  aspect: number;
  onCancel: () => void;
  onConfirm: (area: WallpaperArea) => void;
  onExited: () => void;
}

interface CropPanelProps {
  source: WallpaperSource;
  /** 裁剪框宽高比（宽/高） */
  aspect: number;
  /** 全屏时舞台要占满 AppBar 之外的剩余高度，非全屏给固定高 */
  fullScreen: boolean;
  /** 裁剪区域变化时上报像素；父级按 url 判断这份值属于哪张图 */
  onArea: (area: WallpaperArea) => void;
}

/** 一次裁剪会话：crop / zoom 两个状态都归这里。调用方按 source.url 换 key，换一张图就
 *  整棵重建、状态回到初始值——不需要用 effect 把新来源同步进 state。 */
function CropPanel({ source, aspect, fullScreen, onArea }: CropPanelProps) {
  const theme = useTheme();
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);

  return (
    <>
      <Box
        sx={{
          position: 'relative',
          ...(fullScreen ? { flex: 1, minHeight: 0 } : { height: '60vh' }),
        }}
      >
        <Cropper
          image={source.url}
          crop={crop}
          zoom={zoom}
          aspect={aspect}
          minZoom={1}
          maxZoom={3}
          showGrid={false}
          onCropChange={setCrop}
          onZoomChange={setZoom}
          onCropComplete={(_croppedArea, pixels) => onArea(pixels)}
          style={{
            cropAreaStyle: {
              // 框外遮罩：react-easy-crop 靠边框盒的 box-shadow: 0 0 0 9999em 画它，且不给
              // 颜色（见它的 CSS），于是取 currentColor——与 Dialog 遮罩共用同一个色。
              color: SCRIM_COLOR,
              border: `1px solid ${theme.palette.common.white}`,
            },
          }}
        />
      </Box>
      {/* 缩放条：双指手势之外的缩放入口（没有触控板 / 滚轮的指针设备）。这一行的内边距
          复用 DIALOG_BODY_SX，底部安全区随之生效。 */}
      <Box sx={DIALOG_BODY_SX}>
        <Slider
          aria-label="缩放"
          min={1}
          max={3}
          step={0.01}
          value={zoom}
          // 单滑块的取值一定是 number；MUI 为兼容多滑块把它类型成 number | number[]
          onChange={(_event, value) => setZoom(value as number)}
        />
      </Box>
    </>
  );
}

export default function WallpaperCropDialog({
  open,
  source,
  aspect,
  onCancel,
  onConfirm,
  onExited,
}: Props) {
  const theme = useTheme();
  // 移动端全屏、桌面端限宽对话框（与 AiAddDialog 同款判断）
  const fullScreen = useMediaQuery(theme.breakpoints.down('md'));
  const reduced = usePrefersReducedMotion();

  // 就绪的裁剪像素与它所属的来源 url 一起存：面板按 url 换 key 重建，父组件这份 state
  // 不跟着重置，所以换图后 url 对不上的旧值一律算未就绪（「设为壁纸」随之禁用）。
  const [ready, setReady] = useState<{ url: string; area: WallpaperArea } | null>(null);
  const area = ready !== null && ready.url === source?.url ? ready.area : null;

  const handleConfirm = () => {
    if (area !== null) onConfirm(area);
  };

  return (
    <Dialog
      fullScreen={fullScreen}
      maxWidth="md"
      fullWidth
      sx={mainAreaDialogSx}
      TransitionComponent={SlideUp}
      // 入退场时长刻意不等（MD2 惯例：出场比入场快一档），但两个方向都真的跑。
      // reduced 下整段取消，状态瞬时切换。
      transitionDuration={reduced ? 0 : { enter: MOTION.large, exit: MOTION.largeExit }}
      TransitionProps={{ onExited }}
      open={open}
      onClose={onCancel}
    >
      <AppBar position="static" elevation={0}>
        <Toolbar>
          <IconButton edge="start" color="inherit" onClick={onCancel} aria-label="取消">
            <CloseIcon />
          </IconButton>
          <Typography variant="h6" sx={{ ml: 1, flexGrow: 1 }} noWrap>
            裁剪壁纸
          </Typography>
          <Button color="inherit" onClick={handleConfirm} disabled={area === null}>
            设为壁纸
          </Button>
        </Toolbar>
      </AppBar>
      {source !== null && (
        <CropPanel
          key={source.url}
          source={source}
          aspect={aspect}
          fullScreen={fullScreen}
          onArea={(pixels) => setReady({ url: source.url, area: pixels })}
        />
      )}
    </Dialog>
  );
}
