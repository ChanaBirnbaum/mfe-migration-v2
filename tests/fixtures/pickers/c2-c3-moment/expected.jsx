import React from 'react';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterMoment } from '@mui/x-date-pickers/AdapterMoment';
import moment from 'moment';

// יישור RTL לשדות של @mui/x-date-pickers v9 שלא תלוי ב-theme.
// עובד בלי direction:'rtl' ב-theme, איתו, ועם stylis-plugin-rtl.
const base = {
    // כיוון השדה
    '& .MuiPickersInputBase-root': { direction: 'rtl /*! @noflip */' },
    // טקסט התאריך: מיושר לימין
    '& .MuiPickersInputBase-sectionsContainer, & .MuiPickersSectionList-root': {
        justifyContent: 'flex-end',
    },
    // אייקון התאריכון: רווח מהטקסט, בלי לעלות עליו
    '& .MuiInputAdornment-positionEnd': { margin: 0, marginInlineStart: '8px' },
    '& .MuiIconButton-edgeEnd': { margin: 0, marginInlineEnd: '-12px' },
    // label בצד ימין
    '& .MuiInputLabel-root': {
        left: 'auto /*! @noflip */',
        right: '0 /*! @noflip */',
        transformOrigin: 'top right /*! @noflip */',
    },
    '& .MuiInputLabel-root.MuiInputLabel-shrink': {
        transform: 'translate(-14px, -9px) scale(0.75)',
    },
    // הרווח במסגרת עבור ה-label: בצד ימין
    '& .MuiPickersOutlinedInput-notchedOutline': {
        textAlign: 'right /*! @noflip */',
    },
    '& .MuiPickersOutlinedInput-notchedOutline > legend': {
        marginLeft: 'auto /*! @noflip */',
        marginRight: '0 /*! @noflip */',
    },
    // טקסט השגיאה מתחת לשדה: מיושר לימין
    '& .MuiFormHelperText-root': {
        textAlign: 'right /*! @noflip */',
    },
};

const pickersRtlSxSmall = {
    ...base,
    '& .MuiInputLabel-root': {
        ...base['& .MuiInputLabel-root'],
        transform: 'translate(-14px, 9px) scale(1)',
    },
};

const pickersRtlSxMedium = {
    ...base,
    '& .MuiInputLabel-root': {
        ...base['& .MuiInputLabel-root'],
        transform: 'translate(-14px, 16px) scale(1)',
    },
};

export const Start = ({ form, setForm, min }) => (
    <LocalizationProvider dateAdapter={AdapterMoment}>
        <DatePicker
            value={form.start ? moment(form.start) : null}
            minDate={min ? moment(min) : undefined}
            // MIGRATION-TODO: C2 maxDate is an expression: wrap it with moment() manually
            maxDate={getMax(form)}
            onChange={(d) => setForm({ ...form, start: d?.isValid() ? d.toDate() : null })}
            slotProps={{
                textField: { size: "small", sx: pickersRtlSxSmall },
            }}
        />
    </LocalizationProvider>
);
