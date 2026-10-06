import React from 'react';
import { withStyles, createStyles, StylesProvider } from '@material-ui/core';
import { Button } from '@mui/material';
import withStylesDeep from '@material-ui/core/styles/withStyles';
import { withStyles as ws } from '@material-ui/styles';
// import { withStyles } from '@material-ui/core';

const Styled = withStyles({ root: {} })(Button);
const Deep = withStylesDeep({})(Button);
const Other = ws({})(Button);
const s = createStyles({ root: {} });

export const J = () => <StylesProvider injectFirst><Styled /><Deep /><Other />{s.root.color}</StylesProvider>;
