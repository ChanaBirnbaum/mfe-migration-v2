import React from 'react';
import { makeStyles } from '@material-ui/core/styles';
import { Dialog, Button, Table } from '@mui/material';

const useStyles = makeStyles((theme) => ({
  root: {
    padding: theme.spacing(2),
    marginTop: theme.spacing(1),
    borderRadius: 4,
  },
  paper: {
    backgroundColor: theme.palette.background.default,
    '&:hover': { opacity: 0.9 },
  },
  header: {
    display: 'flex',
    gap: theme.spacing(2),
    width: 1,
  },
  title: {
    fontWeight: 'bold',
  },
  unused: {},
}));

export function ReportDialog({ open }) {
  const classes = useStyles();
  return (
    <Dialog open={open} classes={{ paper: classes.paper, container: classes.root }}>
      <div className={classes.header}>
        <span className={classes.title}>Report</span>
      </div>
      <Table className={classes.root} />
      <Button>OK</Button>
    </Dialog>
  );
}
