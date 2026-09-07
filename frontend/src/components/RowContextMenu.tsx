// 行上下文菜单（右键 / 长按弹出的操作列表）。
//
// 选型依据（上游契约）：references/components.md 的选择规则里，操作列表、单选或
// 多选项用 DropdownMenu——正是本场景（对一行任务给出 完成/编辑/删除 操作）；
// references/glass.md 把 Menu 列为按需挂载浮层面板的代表，材质取 data-glass="panel"
// 档（58% 纸底 + 左上透镜渐变 + 1px 内高光 + whisper 阴影，全部由 rakko-glass.css
// 的配方提供）。
//
// 组件与配方的分工照 glass.md 的契约：「Radius, size, and enter/exit motion stay
// with the component; data-glass supplies only the surface」——圆角 / 尺寸 / 定位 /
// 入退场归本组件（圆角取 RADIUS.card，定位用 anchorReference="anchorPosition" 按
// 坐标弹出，入退场是 MUI Menu 自带的），材质只经 data-glass 从配方取，slotProps 里
// 不下发任何 background / backgroundImage / border / boxShadow——写了反而会盖掉配方
// （同 MuiAppBar 让位的道理，见 theme.ts）。
//
// Menu 经 Portal 挂到 document.body：菜单与列表行只是视觉重叠、不是 DOM 后代，
// 不构成嵌套玻璃（glass.md 明说 portal 到 body 的浮层不算 nesting）。菜单一次只开
// 一个、按需挂载（anchor 为 null 时不渲染），符合 panel 档「按需挂载」的定位。

import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import { RADIUS } from '../rakko-tokens';

// 菜单纸面的 panel 材质 props：'data-glass' 取配方，sx 只补配方不管的圆角，任何
// background / border / boxShadow 都不许出现在这里。提成模块级常量（同 AppShell
// 的 NAV_DRAWER_PAPER_PROPS 做法）：MUI 的 slotProps 类型对行内字面量做 excess
// property check，data-* 属性不在其类型里，常量赋值可绕过该检查。
const MENU_PAPER_PROPS = {
  'data-glass': 'panel',
  sx: { borderRadius: `${RADIUS.card}px` },
};

export interface RowContextMenuAction {
  key: string;
  label: string;
  onSelect: () => void;
  /** 危险操作（删除）：文字用 error 色提示 */
  danger?: boolean;
}

interface Props {
  /** 弹出位置（视口坐标）；null = 菜单关闭 */
  anchor: { x: number; y: number } | null;
  actions: RowContextMenuAction[];
  onClose: () => void;
}

export default function RowContextMenu({ anchor, actions, onClose }: Props) {
  return (
    <Menu
      open={anchor !== null}
      onClose={onClose}
      // 右键 / 长按都是按坐标弹出、不锚在某个元素上：给 anchorPosition 视口坐标
      anchorReference="anchorPosition"
      anchorPosition={anchor ? { top: anchor.y, left: anchor.x } : { top: 0, left: 0 }}
      slotProps={{ paper: MENU_PAPER_PROPS }}
    >
      {actions.map((action) => (
        <MenuItem
          key={action.key}
          // 先关菜单再执行动作：动作里的操作（如行离场）以菜单已关闭为预期前提
          onClick={() => {
            onClose();
            action.onSelect();
          }}
          sx={action.danger ? { color: 'error.main' } : undefined}
        >
          {action.label}
        </MenuItem>
      ))}
    </Menu>
  );
}
