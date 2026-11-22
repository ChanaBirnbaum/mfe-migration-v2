import React from 'react';
import moment from 'moment';
import { Button, DialogActions, FormControl } from '@mui/material';
import { DesktopDatePicker } from '@mui/x-date-pickers/DesktopDatePicker';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterMoment } from '@mui/x-date-pickers/AdapterMoment';
import EventIcon from '@mui/icons-material/Event';
import IpsTextField from '../IpsTextField/IpsTextField';
import { usePickerActionsContext } from '@mui/x-date-pickers/hooks';

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

const OpenPickerIcon = () => <EventIcon fontSize="small" />;

const IpsDatePicker = ({ label, value, onChange, error, helperText, disabled, minDate, maxDate, ...otherProps }) => {
    const handleChange = (dateValue) => {
        onChange(dateValue?.isValid() ? dateValue.toDate() : null);
    };

    // MIGRATION-TODO: C4 slot component defined inside render: uses closure (disabled)
    const ActionBar = (params) => {
        const { clearValue, setValueToToday } = usePickerActionsContext();
        return (
            <DialogActions className={params.className}>
                <Button onClick={clearValue} disabled={disabled}>נקה</Button>
                {/* MIGRATION-TODO: C5 replaced custom today logic: verify */}
                <Button onClick={() => setValueToToday()}>היום</Button>
            </DialogActions>
        );
    };

    return (
        <FormControl size="small" fullWidth>
            <LocalizationProvider dateAdapter={AdapterMoment} adapterLocale="he">
                <DesktopDatePicker
                    label={label}
                    value={value ? moment(value) : null}
                    minDate={minDate ? moment(minDate) : undefined}
                    maxDate={maxDate ? moment(maxDate) : undefined}
                    format="DD/MM/YYYY"
                    onChange={handleChange}
                    disabled={disabled}
                    // MIGRATION-TODO: M2 leftover value
                    helperText="test"
                    slots={{
                        openPickerIcon: OpenPickerIcon,
                        actionBar: ActionBar,
                        // MIGRATION-TODO: D1 spread may contain old prop names
                        ...otherProps.components,
                    }}
                    // MIGRATION-TODO: C1 custom text field: v9 accepts only PickersTextField-compatible components. Move its props to slotProps.textField and its styles to slotProps.textField.sx
                    renderInput={(params) => (
                        <IpsTextField {...params} error={params.error || error} helperText={helperText} />
                    )}
                    slotProps={{
                        desktopPaper: {
                            sx: {
                                '& .MuiDateCalendar-root': { backgroundColor: '#fff' },
                            },
                        },
                        mobilePaper: {
                            sx: {
                                '& .MuiDateCalendar-root': { backgroundColor: '#fff' },
                            },
                        },
                        openPickerButton: disabled ? { style: { display: 'none' } } : undefined,
                        textField: {
                            slotProps: {
                                formHelperText: { sx: { color: '#d32f2f', textAlign: 'right', marginRight: '2%' } },
                            },
                            helperText: helperText,
                            size: "small",
                            sx: pickersRtlSxSmall,
                        },
                    }}
                />
            </LocalizationProvider>
        </FormControl>
    );
};

export default IpsDatePicker;
