import React from 'react';
import FormControl from '@mui/material/FormControl';
import FormHelperText from '@mui/material/FormHelperText';
import { MobileDatePicker } from '@mui/x-date-pickers/MobileDatePicker';

export function Due({ value, onChange, message }) {
    return (
        <FormControl>
            <MobileDatePicker
                value={value}
                onChange={onChange}
                slotProps={{ textField: { helperText: message, sx: { width: 1 } } }}
            />
            <FormHelperText id="due-help">{message}</FormHelperText>
        </FormControl>
    );
}
