import React from 'react';
import { DesktopDatePicker } from '@mui/x-date-pickers';
// MIGRATION-TODO: M4 unmigrated v5 API: picker imported from @mui/lab – import it from @mui/x-date-pickers
import { CalendarPicker } from '@mui/lab';
import { pickerComponents, renderField } from './pickerParts';

export const Range = ({ from, onFrom, size }) => (
    <>
        {/* MIGRATION-TODO: R1 dynamic size, pick Small/Medium manually */}
        <DesktopDatePicker
            // MIGRATION-TODO: C2 dateAdapter not found: if it is AdapterMoment, wrap value with moment()
            value={from}
            onChange={onFrom}
            // MIGRATION-TODO: D1 slots is not an object literal: lowercase the first letter of each key
            slots={pickerComponents}
            // MIGRATION-TODO: C1 renderInput is not a single <TextField {...params} /> element: move its props to slotProps.textField
            renderInput={renderField}
            // MIGRATION-TODO: M2 leftover value
            label="TODO"
            slotProps={{
                textField: { size },
                desktopPaper: {
                    sx: {
                        // MIGRATION-TODO: M3 check if theme direction rtl makes this redundant
                        '& .MuiDateCalendar-root': { direction: 'rtl' },
                        // MIGRATION-TODO: M3 check if theme direction rtl makes this redundant
                        '& .MuiPickersArrowSwitcher-button': {
                            transform: 'rotate(180deg)',
                        },
                    },
                },
                mobilePaper: {
                    sx: {
                        // MIGRATION-TODO: M3 check if theme direction rtl makes this redundant
                        '& .MuiDateCalendar-root': { direction: 'rtl' },
                        // MIGRATION-TODO: M3 check if theme direction rtl makes this redundant
                        '& .MuiPickersArrowSwitcher-button': {
                            transform: 'rotate(180deg)',
                        },
                    },
                },
            }}
        />
        <CalendarPicker date={from} onChange={onFrom} />
    </>
);
