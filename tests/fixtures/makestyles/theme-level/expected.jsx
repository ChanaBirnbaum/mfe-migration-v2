import React from 'react';
import { Dialog, Button, Table, Box } from '@mui/material';

const styles = {
  root: {
    p: 2,
    mt: 1,
    borderRadius: '4px',
  },
  paper: (theme) => ({
    backgroundColor: theme.palette.background.default,
    '&:hover': { opacity: 0.9 },
  }),
  header: {
    display: 'flex',
    gap: 2,
    width: '1px',
  },
  title: {
    fontWeight: 'bold',
  },
};

export function ReportDialog({ open }) {
  return (
    <Dialog open={open} slotProps={{ paper: { sx: styles.paper }, container: { sx: styles.root } }}>
      <Box sx={styles.header}>
        <Box component="span" sx={styles.title}>Report</Box>
      </Box>
      <Table sx={styles.root} />
      <Button>OK</Button>
    </Dialog>
  );
}
