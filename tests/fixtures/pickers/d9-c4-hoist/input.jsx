import React from 'react';
import { Button, DialogActions } from '@mui/material';
import { TimePicker } from '@mui/x-date-pickers/TimePicker';

export const ShiftTime = ({ value, onChange }) => {
    function ActionBar(params) {
        return (
            <DialogActions>
                <Button onClick={params.onCancel}>ביטול</Button>
                <Button onClick={params.onAccept}>אישור</Button>
            </DialogActions>
        );
    }

    return <TimePicker value={value} onChange={onChange} slots={{ actionBar: ActionBar }} />;
};
