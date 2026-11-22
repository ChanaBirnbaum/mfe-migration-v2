import React from 'react';
import FormControl from '@mui/material/FormControl';
import FormHelperText from '@mui/material/FormHelperText';
import { MobileDatePicker } from '@mui/x-date-pickers/MobileDatePicker';

// עיצוב ויישור RTL לשדות של @mui/x-date-pickers v9 שלא תלויים ב-theme.
// עובד בלי direction:'rtl' ב-theme, איתו, ועם stylis-plugin-rtl.
//
// לשינוי העיצוב בכל השדות: לעדכן את הערכים ב-pickersFieldDesign.
// לשינוי בשדה אחד: להוסיף אחרי הקבוע (מה שבא אחרון במערך גובר), למשל
//   sx: [pickersRtlSxSmall, pickersFieldSx({ ...pickersFieldDesign, borderRadius: '4px' })]

// ערכי העיצוב
const pickersFieldDesign = {
    fontFamily: 'Heebo-Regular',
    borderRadius: '7px',
    textColor: '#0c3058', // טקסט התאריך
    labelColor: '#8596af',
    borderColor: '#8596af',
    focusColor: '#0c3058', // מסגרת ו-label בפוקוס (כשאין שגיאה)
    disabledTextColor: 'rgba(0, 0, 0, 0.38)',
};

// הסגנונות שנבנים מהערכים. hover, שגיאה ו-disabled של המסגרת וה-label נשארים כמו ב-MUI
const pickersFieldSx = (d) => ({
    // פונט
    '& .MuiPickersInputBase-root, & .MuiInputLabel-root, & .MuiFormHelperText-root': { fontFamily: d.fontFamily },
    // פינות המסגרת
    '& .MuiPickersOutlinedInput-root': { borderRadius: d.borderRadius },
    // צבע הטקסט
    '& .MuiPickersInputBase-root:not(.Mui-disabled)': { color: d.textColor },
    '& .MuiPickersInputBase-root.Mui-disabled': { color: d.disabledTextColor },
    // צבע המסגרת: רגיל ובפוקוס
    '& .MuiPickersInputBase-root:not(:hover):not(.Mui-focused):not(.Mui-error):not(.Mui-disabled) .MuiPickersOutlinedInput-notchedOutline': {
        borderColor: d.borderColor,
    },
    '& .MuiPickersInputBase-root.Mui-focused:not(.Mui-error) .MuiPickersOutlinedInput-notchedOutline': {
        borderColor: d.focusColor,
    },
    // צבע ה-label: רגיל ובפוקוס
    '& .MuiInputLabel-root:not(.Mui-focused):not(.Mui-error):not(.Mui-disabled)': { color: d.labelColor },
    '& .MuiInputLabel-root.Mui-focused:not(.Mui-error)': { color: d.focusColor },
});

// יישור RTL
const base = {
    ...pickersFieldSx(pickersFieldDesign),
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

export function Due({ value, onChange, message }) {
    return (
        <FormControl>
            <MobileDatePicker
                // MIGRATION-TODO: C2 dateAdapter not found: if it is AdapterMoment, wrap value with moment()
                value={value}
                onChange={onChange}
                slotProps={{ textField: { helperText: message, sx: [pickersRtlSxMedium, { width: 1 }] } }}
            />
            {/* MIGRATION-TODO: C6 duplicate helperText */}
            <FormHelperText id="due-help">{message}</FormHelperText>
        </FormControl>
    );
}
