import React from 'react';
import TextField from '@mui/material/TextField';
import { DatePicker, LocalizationProvider } from '@mui/x-date-pickers';
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns';

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

export default function BirthDate({ value, onChange, error, label }) {
  const fieldRef = React.useRef(null);
  return (
    <LocalizationProvider dateAdapter={AdapterDateFns}>
      <DatePicker
        label={label}
        value={value}
        onChange={onChange}
        format="dd/MM/yyyy"
        fieldRef={fieldRef}
        slotProps={{
          actionBar: { actions: ['clear'] },
          textField: {
            fullWidth: true,
            size: "small",
            error: error,
            slotProps: { htmlInput: { 'aria-label': label }, inputLabel: { shrink: true } },
            sx: pickersRtlSxSmall,
          },
        }}
      />
    </LocalizationProvider>
  );
}
