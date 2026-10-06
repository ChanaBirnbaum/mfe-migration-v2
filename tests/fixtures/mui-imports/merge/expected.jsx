import * as React from 'react';
import TextField from '@mui/material/TextField';
import { Paper, Popper, alpha } from '@mui/material';
import { makeStyles } from '@material-ui/core'

const useStyles = makeStyles((theme) => ({
  root: { background: alpha(theme.palette.primary.main, 0.2) },
}));

export const D = () => {
  const classes = useStyles();
  return <Paper className={classes.root}><Popper open /><TextField /></Paper>;
};
