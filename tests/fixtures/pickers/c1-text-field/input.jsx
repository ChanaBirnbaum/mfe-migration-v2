import React from 'react';
import TextField from '@mui/material/TextField';
import { DatePicker, LocalizationProvider } from '@mui/x-date-pickers';
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns';

export default function BirthDate({ value, onChange, error, label }) {
  const fieldRef = React.useRef(null);
  return (
    <LocalizationProvider dateAdapter={AdapterDateFns}>
      <DatePicker
        label={label}
        value={value}
        onChange={onChange}
        inputFormat="dd/MM/yyyy"
        unstableFieldRef={fieldRef}
        enableAccessibleFieldDOMStructure={false}
        componentsProps={{ ActionBar: { actions: ['clear'] } }}
        renderInput={(params) => (
          <TextField
            {...params}
            fullWidth
            size="small"
            error={params.error || error}
            InputLabelProps={{ shrink: true }}
            inputProps={{ 'aria-label': label }}
          />
        )}
      />
    </LocalizationProvider>
  );
}
