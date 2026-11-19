import React from 'react';
import { DesktopDatePicker } from '@mui/x-date-pickers';
import { CalendarPicker } from '@mui/lab';
import { pickerComponents, renderField } from './pickerParts';

export const Range = ({ from, onFrom, size }) => (
    <>
        <DesktopDatePicker
            value={from}
            onChange={onFrom}
            components={pickerComponents}
            renderInput={renderField}
            label="TODO"
            PaperProps={{
                sx: {
                    '& .MuiCalendarPicker-root': { direction: 'rtl' },
                    '& button.MuiButtonBase-root.MuiIconButton-root.MuiIconButton-sizeSmall.MuiPickersArrowSwitcher-button': {
                        transform: 'rotate(180deg)',
                    },
                },
            }}
            slotProps={{ textField: { size } }}
        />
        <CalendarPicker date={from} onChange={onFrom} />
    </>
);
