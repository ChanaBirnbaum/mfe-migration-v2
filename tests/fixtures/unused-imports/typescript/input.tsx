import React, { FC, ReactNode, useMemo } from 'react';
import type { Theme } from '@mui/material';
import { type SxProps, Box } from '@mui/material';
import { Item as RowItem, Other } from './types';

interface Props {
  rows: RowItem[];
  sx?: SxProps;
}

const Table: FC<Props> = ({ rows, sx }) => <Box sx={sx}>{rows.length}</Box>;

export default Table;
