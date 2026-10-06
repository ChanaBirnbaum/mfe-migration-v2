const React = require('react');
const { Paper, createTheme } = require('@mui/material');
const Button = require('@mui/material/Button').default;

const theme = createTheme({ palette: { mode: 'dark' } });
module.exports = { Paper, Button, theme, isDark: theme.palette.mode === 'dark' };
