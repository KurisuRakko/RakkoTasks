// 横向滚动、单选的分类筛选 Chip 行（null = 全部）。

import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import type { Category } from '../types';

const CATEGORIES: Category[] = ['学业', '工作', '个人', '账单', '其他'];

interface Props {
  value: Category | null;
  onChange: (value: Category | null) => void;
}

export default function CategoryChips({ value, onChange }: Props) {
  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{ px: 2, py: 1, overflowX: 'auto', scrollbarWidth: 'none' }}
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
  );
}
