'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { run, main } = require('../scripts/codemod-makestyles');

const FIX = path.join(__dirname, 'fixtures', 'makestyles');
const SLOTS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'reference', 'mui-slots.json'), 'utf8'));
const fixture = (name) => ({
  input: fs.readFileSync(path.join(FIX, name, 'input.jsx'), 'utf8'),
  expected: fs.readFileSync(path.join(FIX, name, 'expected.jsx'), 'utf8'),
});

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'makestyles-test-'));
  Object.keys(files).forEach((rel) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), files[rel]);
  });
  return root;
}
const readIn = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function golden(name, rel) {
  const f = fixture(name);
  rel = rel || 'src/' + name + '.jsx';
  const root = repo({ [rel]: f.input });
  const res = run([], { cwd: root });
  assert.strictEqual(readIn(root, rel), f.expected, name);
  const again = run([], { cwd: root });
  assert.deepStrictEqual(again.changes, [], name + ': second run produced changes');
  assert.strictEqual(readIn(root, rel), f.expected);
  return { res: res, again: again };
}

function convert(src, deps) {
  const root = repo({ 'src/C.jsx': src });
  const res = run([], Object.assign({ cwd: root }, deps || {}));
  return { res: res, out: readIn(root, 'src/C.jsx') };
}

// ---- golden files ----

test('golden: SearchReport (SPEC) – mixed imports, static, real slot (paper), empty class hook (option)', () => {
  const { res, again } = golden('search-report', 'src/SearchReport.jsx');
  assert.strictEqual(res.result, 'OK');
  assert.deepStrictEqual(res.manual, []);
  const rules = res.changes.map((c) => c.rule).sort();
  assert.deepStrictEqual(rules, ['MS.EMPTY', 'MS.SLOT', 'MS.STATIC']);
  assert.strictEqual(again.result, 'NOOP');
});

test('golden: level B (theme) – spacing → shorthand, numbers → px, Box for HTML, theme only where still needed', () => {
  const { res } = golden('theme-level');
  assert.strictEqual(res.result, 'OK');
  const level = res.changes.find((c) => c.rule === 'MS.THEME');
  assert.match(level.detail, /3 × theme\.spacing → sx/);
  assert.match(level.detail, /unused/);
});

test('golden: level C (props) → manual with exact reason, file unchanged', () => {
  const { res } = golden('props-level');
  assert.strictEqual(res.result, 'REVIEW');
  assert.strictEqual(res.manual.length, 1);
  assert.match(res.manual[0].reason, /רמה C – המפתחות box תלויים ב-props/);
  assert.strictEqual(res.manual[0].line, 4);
});

// ---- call-site rules ----

test('mixed slots + hooks: portaled hook goes to the slot that contains it, root hook to sx', () => {
  const { res, out } = convert([
    "import { makeStyles } from '@material-ui/core';",
    "import { Autocomplete } from '@mui/material';",
    'const useStyles = makeStyles({',
    "  paper: { direction: 'rtl' },",
    "  option: { borderBottom: '1px solid gray' },",
    '  input: { fontSize: 12 },',
    '});',
    'export const A = () => {',
    '  const classes = useStyles();',
    '  return <Autocomplete options={[]} classes={{ paper: classes.paper, option: classes.option, inputRoot: classes.input }} />;',
    '};',
    '',
  ].join('\n'));
  assert.ok(out.indexOf("<Autocomplete options={[]} slotProps={{ paper: { sx: styles.paper }, listbox: { sx: { '& .MuiAutocomplete-option': styles.option } } }} " +
    "sx={{ '& .MuiAutocomplete-inputRoot': styles.input }} />") !== -1, out);
  assert.strictEqual(res.result, 'REVIEW'); // option host is inferred
  assert.ok(res.changes.some((c) => c.confidence === 'review' && /option/.test(c.reason)));
});

test('Popper with classes.paper → manual (Popper has no paper slot), file unchanged', () => {
  const src = [
    "import { makeStyles } from '@material-ui/core';",
    "import Popper from '@mui/material/Popper';",
    'const useStyles = makeStyles({ paper: { zIndex: 10 } });',
    'export const P = () => {',
    '  const classes = useStyles();',
    '  return <Popper open classes={{ paper: classes.paper }} />;',
    '};',
    '',
  ].join('\n');
  const { res, out } = convert(src);
  assert.strictEqual(out, src);
  assert.match(res.manual[0].reason, /ל-Popper אין slot בשם paper/);
});

test('classes passed as a whole object → manual, nothing deleted', () => {
  const src = [
    "import { makeStyles } from '@material-ui/core';",
    'const useStyles = makeStyles({ root: { color: "red" } });',
    'export const P = () => {',
    '  const classes = useStyles();',
    '  return <Child classes={classes} />;',
    '};',
    '',
  ].join('\n');
  const { res, out } = convert(src);
  assert.strictEqual(out, src);
  assert.match(res.manual[0].reason, /אובייקט שלם/);
});

test('className on a non-MUI component → manual', () => {
  const src = [
    "import { makeStyles } from '@material-ui/core';",
    "import { MyCard } from './MyCard';",
    'const useStyles = makeStyles({ root: { color: "red" } });',
    'export const P = () => {',
    '  const classes = useStyles();',
    '  return <MyCard className={classes.root} />;',
    '};',
    '',
  ].join('\n');
  const { res, out } = convert(src);
  assert.strictEqual(out, src);
  assert.match(res.manual[0].reason, /שאינו רכיב MUI/);
});

test('JSS-only syntax ($ref) and fallback arrays → manual', () => {
  const ref = convert("import { makeStyles } from '@material-ui/core';\nconst useStyles = makeStyles({ a: { '&:hover $b': { color: 'red' } }, b: {} });\nexport const P = () => { const classes = useStyles(); return <div className={classes.a} />; };\n");
  assert.match(ref.res.manual[0].reason, /JSS/);
  const arr = convert("import { makeStyles } from '@material-ui/core';\nconst useStyles = makeStyles({ a: { margin: [0, 'auto'] } });\nexport const P = () => { const classes = useStyles(); return <div className={classes.a} />; };\n");
  assert.match(arr.res.manual[0].reason, /רספונסיבי/);
});

test('destructured classes + className on MUI component + makeStyles kept when another instance remains', () => {
  const { res, out } = convert([
    "import { makeStyles } from '@material-ui/core';",
    "import { Paper } from '@mui/material';",
    'const useA = makeStyles({ box: { margin: 8 } });',
    'const useB = makeStyles({ dyn: { width: (p) => p.w } });',
    'export const P = (props) => {',
    '  const { box } = useA();',
    '  const b = useB(props);',
    '  return <Paper className={box}><div className={b.dyn} /></Paper>;',
    '};',
    '',
  ].join('\n'));
  assert.match(out, /^import \{ makeStyles \} from '@material-ui\/core';/); // still needed by useB
  assert.match(out, /const a = \{ box: \{ margin: '8px' \} \};/);
  assert.match(out, /<Paper sx=\{a\.box\}>/);
  assert.ok(out.indexOf('const { box } = useA();') === -1);
  assert.strictEqual(res.manual.length, 1);
});

test('validation: a generated syntax error leaves the file untouched and reports manual', () => {
  const table = JSON.parse(JSON.stringify(SLOTS));
  table.components.Menu.slots.paper = 'not-an-identifier'; // → slotProps={{ not-an-identifier: ... }}
  const src = [
    "import { makeStyles } from '@material-ui/core';",
    "import { Menu } from '@mui/material';",
    'const useStyles = makeStyles({ paper: { padding: 4 } });',
    'export const M = () => {',
    '  const classes = useStyles();',
    '  return <Menu open classes={{ paper: classes.paper }} />;',
    '};',
    '',
  ].join('\n');
  const { res, out } = convert(src, { table: table });
  assert.strictEqual(out, src);
  assert.match(res.manual[0].reason, /ולידציה נכשלה/);
  assert.deepStrictEqual(res.changes, []);
});

test('commented makeStyles is ignored → NOOP', () => {
  const { res } = convert("// import { makeStyles } from '@material-ui/core';\n/* const useStyles = makeStyles({ a: {} }); */\nexport const x = 1;\n");
  assert.strictEqual(res.result, 'NOOP');
});

test('--dry-run writes nothing; --json contract; missing src → BLOCKED', () => {
  const f = fixture('search-report');
  const root = repo({ 'src/SearchReport.jsx': f.input });
  let out = '';
  assert.strictEqual(main(['--dry-run', '--json'], { cwd: root }, { stdout: (s) => { out += s; }, stderr: () => {} }), 0);
  const res = JSON.parse(out);
  assert.deepStrictEqual(Object.keys(res).slice(0, 6), ['script', 'result', 'changes', 'manual', 'blockers', 'notes']);
  assert.deepStrictEqual(res.filesChanged, ['src/SearchReport.jsx']);
  assert.strictEqual(readIn(root, 'src/SearchReport.jsx'), f.input);

  out = '';
  main([], { cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'makestyles-test-')) }, { stdout: (s) => { out += s; }, stderr: () => {} });
  assert.match(out, /RESULT: BLOCKED\n$/);
});

test('mui-slots.json covers the required components; Popper has no paper slot', () => {
  ['Autocomplete', 'Dialog', 'Menu', 'Popper', 'Tooltip', 'Drawer', 'TextField', 'Select', 'Table', 'Card', 'Accordion', 'Tabs', 'Snackbar']
    .forEach((c) => assert.ok(SLOTS.components[c], c));
  assert.strictEqual(SLOTS.components.Popper.slots.paper, undefined);
});
