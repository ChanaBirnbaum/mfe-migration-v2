const React = require('react');
const { Paper, createMuiTheme } = require('@material-ui/core');
const Button = require('@material-ui/core/Button').default;

const theme = createMuiTheme({ palette: { type: 'dark' } });
module.exports = { Paper, Button, theme, isDark: theme.palette.type === 'dark' };
