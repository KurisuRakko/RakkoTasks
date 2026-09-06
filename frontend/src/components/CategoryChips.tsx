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
    // display: inline-block 让雾盒收缩到 chips 的实际内容宽度，而不是撑满整个内容列——
    // 撑满时雾会变成一条横贯版面的带子，喧宾夺主。
    // bleed 取 10px（比分组标题的 14px 更小）：chips 行本身带 py 内边距，盒子已经比
    // 纯文字标签高，雾再往外扩会盖到下面的列表。
    // 形态 veil 的理由同 TasksPage（一页一种形态，不混 cloud/veil）。
    <Box data-glass="haze" data-haze="veil" sx={{ px: 2, py: 1, display: 'inline-block', '--glass-haze-bleed': '10px' }}>
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
