import React, { FC } from 'react';
import { type SxProps, Box } from '@mui/material';
import { Item as RowItem } from './types';

interface Props {
  rows: RowItem[];
  sx?: SxProps;
}

const Table: FC<Props> = ({ rows, sx }) => <Box sx={sx}>{rows.length}</Box>;

export default Table;
