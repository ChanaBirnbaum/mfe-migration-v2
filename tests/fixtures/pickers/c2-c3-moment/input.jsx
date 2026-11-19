import React from 'react';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterMoment } from '@mui/x-date-pickers/AdapterMoment';

export const Start = ({ form, setForm, min }) => (
    <LocalizationProvider dateAdapter={AdapterMoment}>
        <DatePicker
            value={form.start ? form.start : null}
            minDate={min}
            maxDate={getMax(form)}
            onChange={(d) => setForm({ ...form, start: d?.toDate() || null })}
            size="small"
        />
    </LocalizationProvider>
);
