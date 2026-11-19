import React from 'react';
import moment from 'moment';
import { Button, DialogActions, FormControl, FormHelperText } from '@mui/material';
import { DesktopDatePicker } from '@mui/x-date-pickers/DesktopDatePicker';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterMoment } from '@mui/x-date-pickers/AdapterMoment';
import EventIcon from '@mui/icons-material/Event';
import IpsTextField from '../IpsTextField/IpsTextField';

const OpenPickerIcon = () => <EventIcon fontSize="small" />;

const IpsDatePicker = ({ label, value, onChange, error, helperText, disabled, minDate, maxDate, ...otherProps }) => {
    const handleChange = (dateValue) => {
        onChange(dateValue?.toDate() || null);
    };

    const ActionBar = (params) => (
        <DialogActions>
            <Button onClick={params.onClear} disabled={disabled}>נקה</Button>
            <Button onClick={() => handleChange(moment())}>היום</Button>
        </DialogActions>
    );

    return (
        <FormControl size="small" fullWidth>
            <LocalizationProvider dateAdapter={AdapterMoment} adapterLocale="he">
                <DesktopDatePicker
                    label={label}
                    value={value ? value : null}
                    minDate={minDate}
                    maxDate={maxDate}
                    inputFormat="DD/MM/YYYY"
                    onChange={handleChange}
                    disabled={disabled}
                    helperText="test"
                    components={{
                        OpenPickerIcon,
                        ActionBar,
                        ...otherProps.components,
                    }}
                    PaperProps={{
                        sx: {
                            '& .MuiCalendarPicker-root': { backgroundColor: '#fff' },
                        },
                    }}
                    OpenPickerButtonProps={disabled ? { style: { display: 'none' } } : undefined}
                    renderInput={(params) => (
                        <IpsTextField {...params} error={params.error || error} helperText={helperText} />
                    )}
                />
            </LocalizationProvider>
            <FormHelperText style={{ color: '#d32f2f', textAlign: 'right', marginRight: '2%' }}>{helperText}</FormHelperText>
        </FormControl>
    );
};

export default IpsDatePicker;
