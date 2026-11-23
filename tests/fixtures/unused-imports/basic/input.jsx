import React, { useState, useEffect } from 'react';
import { unstable_createMuiStrictModeTheme } from '@material-ui/core/styles';
import Button from '@material-ui/core/Button';
import {
  Grid,
  Typography,
  Divider,
  Paper,
} from '@material-ui/core';
import * as utils from './utils';
import Default, { helper } from './helpers';
import './styles.css';
import classes from "./Screen.module.scss";
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
