import React, { useState } from 'react';
import Button from '@material-ui/core/Button';
import {
  Grid,
  Paper,
} from '@material-ui/core';
import { helper } from './helpers';
import './styles.css';
import "./Screen.module.scss";
import { format } from 'date-fns';

// Typography is mentioned here only in a comment
export default function Screen({ items }) {
  const [open, setOpen] = useState(false);
  return (
    <Paper>
      <Grid container>
        <Button onClick={() => setOpen(!open)}>{helper(items)}</Button>
      </Grid>
    </Paper>
  );
}

export { format };
