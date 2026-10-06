import * as React from 'react';
import TextField from '@mui/material/TextField';
import Autocomplete from '@mui/material/Autocomplete';
import Paper from '@mui/material/Paper';
import { makeStyles } from '@material-ui/core'     // ← v4 נשאר

const useStyles = makeStyles({
  paper: { direction: 'rtl', width: '160px', right: '0px', position: 'absolute' },
  option: {
    // borderBottom: '1px solid gray',              // ← ריק, הכל מוער
  }
});

export const SearchReport = ({ data, placeholder, onChange }) => {
  const classes = useStyles();
  return (
    <Autocomplete
      freeSolo
      options={data}
      classes={{ paper: classes.paper, option: classes.option }}
      renderInput={(params) => (
        <div ref={params.InputProps.ref}>
          <input {...params.inputProps} placeholder={placeholder}/>
        </div>
      )}
    />
  );
}
