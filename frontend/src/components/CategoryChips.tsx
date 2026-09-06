// 横向滚动、单选的分类筛选 Chip 行（null = 全部）。

import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import { CATEGORIES } from '../types';
import type { Category } from '../types';

interface Props {
  value: Category | null;
  onChange: (value: Category | null) => void;
}

export default function CategoryChips({ value, onChange }: Props) {
  return (
    // 雾必须挂在这层滚动容器外面：Stack 的 overflowX: auto 不是 visible，会把 haze
    // 伪元素负 inset 溢出的雾裁成硬边方块，所以 px/py 留给外层雾盒、滚动留在内层 Stack。
    <Box data-glass="haze" sx={{ px: 2, py: 1, '--glass-haze-bleed': '14px' }}>
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
        color="primary"
        onClick={() => onChange(null)}
      />
      {CATEGORIES.map((c) => (
        <Chip
          key={c}
          label={c}
          size="small"
          variant={value === c ? 'filled' : 'outlined'}
          color="primary"
          onClick={() => onChange(c)}
        />
      ))}
      </Stack>
    </Box>
  );
}
