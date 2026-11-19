import React from 'react';
import { ThemeProvider } from '@mui/material/styles';
import { DateTimePicker } from '@mui/x-date-pickers/DateTimePicker';

export const Meeting = ({ value, onChange }) => (
    <ThemeProvider theme={(t) => ({ ...t, direction: 'rtl' })}>
        <DateTimePicker
            value={value}
            onChange={onChange}
            slotProps={{ textField: { size: 'small', sx: [{ width: 200 }, { mt: 1 }] } }}
        />
    </ThemeProvider>
);
