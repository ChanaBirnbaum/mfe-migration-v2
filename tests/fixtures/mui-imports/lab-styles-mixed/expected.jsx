import React from 'react';
// keep: legacy import below
// import { Rating } from '@material-ui/lab';
import { Autocomplete, Alert } from '@mui/material';
import { TreeView } from '@mui/lab';
import { makeStyles } from '@material-ui/core/styles';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { KeyboardDatePicker } from '@mui/x-date-pickers';
import Hidden from '@material-ui/core/Hidden';
import { useStyles } from '@material-ui/styles';

const theme = createTheme({ palette: { mode: 'light' } });

export const F = () => (
  <ThemeProvider theme={theme}>
    <Hidden smDown><Alert>hi</Alert></Hidden>
    <Autocomplete options={[]} renderInput={() => null} />
    <TreeView />
    <KeyboardDatePicker />
  </ThemeProvider>
);
