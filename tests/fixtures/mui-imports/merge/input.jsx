import * as React from 'react';
import TextField from '@mui/material/TextField';
import { Paper } from '@mui/material';
import { Popper, makeStyles, fade } from '@material-ui/core'

const useStyles = makeStyles((theme) => ({
  root: { background: fade(theme.palette.primary.main, 0.2) },
}));

export const D = () => {
  const classes = useStyles();
  return <Paper className={classes.root}><Popper open /><TextField /></Paper>;
};
