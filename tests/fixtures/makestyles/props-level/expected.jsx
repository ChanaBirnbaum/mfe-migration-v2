import { makeStyles } from '@material-ui/core';
import Paper from '@mui/material/Paper';

const useStyles = makeStyles({
  box: { width: (props) => props.w },
  plain: { margin: 0 },
});

export const Dynamic = (props) => {
  const classes = useStyles(props);
  return <Paper className={classes.box} />;
};
