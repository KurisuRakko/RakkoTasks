// 横向滚动、单选的分类筛选 Chip 行（null = 全部）。

import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import { GLASS, TYPE_SCALE } from '../rakko-tokens';
import { CATEGORIES } from '../types';
import type { Category } from '../types';

interface Props {
  value: Category | null;
  onChange: (value: Category | null) => void;
}

/** 筛选 chip 的度量：字号锁在契约字阶的 label-12（12px），与全站 chip 同一字号。
 *  高度与圆角不在这里覆盖（归字号推出的行高与主题层的 MuiChip.root）。 */
const FILTER_CHIP_SX = { fontSize: `${TYPE_SCALE['label-12'].size}px` } as const;

export default function CategoryChips({ value, onChange }: Props) {
  return (
    // 雾必须挂在这层滚动容器外面：Stack 的 overflowX: auto 不是 visible，会把 haze
    // 伪元素负 inset 溢出的雾裁成硬边方块，所以 px/py 留给外层雾盒、滚动留在内层 Stack。
    // 形态用上游默认的 cloud——默认不写 data-haze，只有切 veil 才写该属性。
    // 宽度照搬上游 showcase 的 .glass-review__intro 组合（width: max-content 且
    // max-width: 100%）：内容少时雾盒收缩贴合 chips；内容多到超出容器时不再外扩——
    // 只写 max-content 的话，窄屏上雾盒会被撑出容器、把整页顶出横向滚动条。内层
    // Stack 的 overflowX: auto 照常横向滚动。bleed 取上游小标签档（0.3 ×
    // GLASS.hazeBleed = 8.4px，不写死数值，上游改 token 时这里跟着变）。
    <Box
      data-glass="haze"
      sx={{
        px: 2,
        py: 1,
        minWidth: 0,
        width: 'max-content',
        maxWidth: '100%',
        '--glass-haze-bleed': `calc(0.3 * ${GLASS.hazeBleed})`,
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{
          overflowX: 'auto',
          scrollbarWidth: 'none',
          // 桌面宽屏换行左对齐，不横向拉伸
          flexWrap: { md: 'wrap' },
        }}
      >
      <Chip
        label="全部"
        size="small"
        variant={value === null ? 'filled' : 'outlined'}
        // 选中 = filled primary，未选中 = outlined 中性色：未选中的那几枚不是待点的主操作，
        // 描 primary 边框会让整行看着像一排主按钮（与 ItemFieldsForm 的单选 chip 同一口径）
        color={value === null ? 'primary' : 'default'}
        sx={FILTER_CHIP_SX}
        onClick={() => onChange(null)}
      />
      {CATEGORIES.map((c) => (
        <Chip
          key={c}
          label={c}
          size="small"
          variant={value === c ? 'filled' : 'outlined'}
          color={value === c ? 'primary' : 'default'}
          sx={FILTER_CHIP_SX}
          onClick={() => onChange(c)}
        />
      ))}
      </Stack>
    </Box>
  );
}
