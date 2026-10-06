import * as React from 'react';
import TextField from '@mui/material/TextField';
import Autocomplete from '@mui/material/Autocomplete';
import Paper from '@mui/material/Paper';

const styles = {
  paper: { direction: 'rtl', width: '160px', right: '0px', position: 'absolute' }
};

export const SearchReport = ({ data, placeholder, onChange }) => {
  return (
    <Autocomplete
      freeSolo
      options={data}
      slotProps={{ paper: { sx: styles.paper } }}
      renderInput={(params) => (
        <div ref={params.InputProps.ref}>
          <input {...params.inputProps} placeholder={placeholder}/>
        </div>
      )}
    />
  );
}
