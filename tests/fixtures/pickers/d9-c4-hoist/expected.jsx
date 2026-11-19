import React from 'react';
import { Button, DialogActions } from '@mui/material';
import { TimePicker } from '@mui/x-date-pickers/TimePicker';
import { usePickerActionsContext } from '@mui/x-date-pickers/hooks';

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

function ActionBar(params) {
    const { acceptValueChanges, cancelValueChanges } = usePickerActionsContext();
    return (
        <DialogActions className={params.className}>
            <Button onClick={cancelValueChanges}>ביטול</Button>
            <Button onClick={acceptValueChanges}>אישור</Button>
        </DialogActions>
    );
}

export const ShiftTime = ({ value, onChange }) => {
    // MIGRATION-TODO: C2 dateAdapter not found: if it is AdapterMoment, wrap value with moment()
    return <TimePicker value={value} onChange={onChange} slots={{ actionBar: ActionBar }} slotProps={{ textField: { sx: pickersRtlSxMedium } }} />;
};
