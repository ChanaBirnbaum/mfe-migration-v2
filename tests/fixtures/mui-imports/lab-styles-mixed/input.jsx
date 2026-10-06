import React from 'react';
// keep: legacy import below
// import { Rating } from '@material-ui/lab';
import { Autocomplete, TreeView, Alert } from '@material-ui/lab';
import { createMuiTheme, MuiThemeProvider, makeStyles } from '@material-ui/core/styles';
import { KeyboardDatePicker } from '@material-ui/pickers';
import Hidden from '@material-ui/core/Hidden';
import { useStyles } from '@material-ui/styles';

const theme = createMuiTheme({ palette: { type: 'light' } });

export const F = () => (
  <MuiThemeProvider theme={theme}>
    <Hidden smDown><Alert>hi</Alert></Hidden>
    <Autocomplete options={[]} renderInput={() => null} />
    <TreeView />
    <KeyboardDatePicker />
  </MuiThemeProvider>
);
