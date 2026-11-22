'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { run, main, interpretOfficial, RTL_SX_SOURCE } = require('../scripts/codemod-pickers');

const FIX = path.join(__dirname, 'fixtures', 'pickers');

function fixture(name) {
  const dir = path.join(FIX, name);
  const input = fs.readdirSync(dir).find((f) => f.startsWith('input.'));
  const ext = path.extname(input);
  return {
    ext: ext,
    input: fs.readFileSync(path.join(dir, input), 'utf8'),
    expected: fs.readFileSync(path.join(dir, 'expected' + ext), 'utf8'),
  };
}

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickers-test-'));
  Object.keys(files).forEach((rel) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), files[rel]);
  });
  return root;
}
const readIn = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (root, rel) => fs.existsSync(path.join(root, rel));
const report = (root) => JSON.parse(readIn(root, 'migration-report.json'));

// A stand-in for npx @mui/x-codemod: records the calls, changes nothing, reports 0 errors
function okRunner() {
  const calls = [];
  const fn = (version, files) => { calls.push({ version: version, files: files }); return { status: 0, output: 'Results:\n0 errors\n' + files.length + ' unmodified\n0 skipped\n0 ok\n' }; };
  fn.calls = calls;
  return fn;
}

// Runs a fixture as `rel`, checks the golden output and that a second run changes nothing
function golden(name, rel, extra) {
  const f = fixture(name);
  rel = rel || 'src/components/' + name + f.ext;
  const root = repo(Object.assign({ [rel]: f.input }, extra || {}));
  const res = run([], { cwd: root, runOfficial: okRunner() });
  assert.strictEqual(readIn(root, rel), f.expected, name);
  const again = run([], { cwd: root, runOfficial: okRunner() });
  assert.deepStrictEqual(again.changes, [], name + ': second run produced changes');
  assert.strictEqual(again.result, 'NOOP', name + ': second run is not NOOP');
  assert.strictEqual(readIn(root, rel), f.expected);
  return { res: res, again: again, root: root, rel: rel };
}
const rules = (res) => Array.from(new Set(res.changes.map((c) => c.rule)));
const todoRules = (res) => res.manual.map((m) => m.reason.split(' ')[0]);

// ---- the mandatory fixture: the original IpsDatePicker ----

test('golden: IpsDatePicker – all D rules, R1 inline Small, C3 "null", C6 moved, TODOs for C1 / C4 / C5 / M2 / spread', () => {
  const { res, root, rel } = golden('ips-date-picker', 'src/components/IpsDatePicker/IpsDatePicker.jsx');
  assert.strictEqual(res.result, 'REVIEW');
  assert.deepStrictEqual(rules(res), ['D1', 'D2', 'D3', 'D4', 'D8', 'D9', 'C2', 'C3', 'C5', 'C6', 'R1']);
  assert.deepStrictEqual(todoRules(res).sort(), ['C1', 'C4', 'C5', 'D1', 'M2']);
  assert.match(res.manual.find((m) => m.reason.startsWith('C4')).reason, /uses closure \(disabled\)/);
  assert.match(res.manual.find((m) => m.reason.startsWith('C1')).reason, /custom text field: v9 accepts only PickersTextField-compatible components/);
  assert.match(res.manual.find((m) => m.reason.startsWith('D1')).reason, /spread may contain old prop names/);

  const r = report(root);
  assert.deepStrictEqual(r.config, { rtlSxPlacement: 'auto', rtlSxPlacementResolved: 'inline', rtlSxSharedPath: 'src/utils/pickersRtlSx.js', invalidDateBehavior: 'null' });
  assert.strictEqual(r.files.length, 1);
  const f = r.files[0];
  assert.strictEqual(f.file, rel);
  assert.deepStrictEqual(f.codemod, { v6: 'ok', v7: 'ok', v8: 'ok', v9: 'ok' });
  assert.strictEqual(f.status, 'needs-review');
  assert.deepStrictEqual(f.applied, rules(res));
  // every TODO line points at the code line under its comment
  const lines = readIn(root, rel).split('\n');
  f.todos.forEach((t) => {
    assert.ok(/MIGRATION-TODO/.test(lines[t.line - 2]), t.rule + ' comment is right above line ' + t.line);
    assert.ok(!/MIGRATION-TODO/.test(lines[t.line - 1]));
  });
  assert.ok(!exists(root, 'src/utils/pickersRtlSx.js'), 'inline mode creates no shared file');
  // the inline constants are the exact R1.1 content without export
  assert.ok(readIn(root, rel).indexOf(RTL_SX_SOURCE.replace(/^export /gm, '')) !== -1);
});

// ---- one golden per rule group ----

test('golden: renderInput with MUI TextField → slotProps.textField (C1), Input*Props → textField.slotProps (D5), D1 / D2 / D6 / D7', () => {
  const { res } = golden('c1-text-field');
  assert.strictEqual(res.result, 'OK');
  assert.deepStrictEqual(rules(res), ['D1', 'D2', 'D5', 'D6', 'D7', 'C1', 'R1']);
});

test('golden: action bar without closure – D9 hook + className, C4 moves it to module level', () => {
  const { res } = golden('d9-c4-hoist');
  assert.deepStrictEqual(rules(res), ['D9', 'C4', 'R1']);
  // no LocalizationProvider anywhere → the adapter is unknown, C2 only marks
  assert.deepStrictEqual(todoRules(res), ['C2']);
});

test('golden: local RTL ThemeProvider removed (R1.3), existing sx array gets the constant first', () => {
  const { res, root, rel } = golden('r13-theme-provider');
  assert.deepStrictEqual(rules(res), ['R1', 'R1.3']);
  assert.ok(todoRules(res).indexOf('R1.3') !== -1);
  assert.doesNotMatch(readIn(root, rel), /ThemeProvider\b(?! RTL)/);
});

test('golden: marks only – M2, M3, M4 (@mui/lab), dynamic size, non-literal components / renderInput', () => {
  const { res } = golden('m-marks');
  assert.deepStrictEqual(rules(res), ['D1', 'D3', 'D8']);
  assert.deepStrictEqual(todoRules(res), ['M4', 'R1', 'C2', 'D1', 'C1', 'M2', 'M3', 'M3', 'M3', 'M3']);
});

test('golden: FormHelperText with another prop → C6 TODO, nothing deleted; existing sx object → [constant, sx]', () => {
  const { res } = golden('c6-duplicate');
  assert.deepStrictEqual(rules(res), ['R1']);
  assert.deepStrictEqual(todoRules(res), ['C2', 'C6']);
});

test('golden: AdapterMoment – C2 wraps value / minDate, marks an expression; C3 inline onChange; size on the picker', () => {
  const { res } = golden('c2-c3-moment');
  assert.deepStrictEqual(rules(res), ['C2', 'C3', 'R1']);
  assert.deepStrictEqual(todoRules(res), ['C2']);
});

// ---- R1.1 shared mode ----

const PICKER_A = [
  "import { DatePicker } from '@mui/x-date-pickers/DatePicker';",
  '',
  'export const A = (p) => <DatePicker value={p.v} onChange={p.c} slotProps={{ textField: { sx: { width: 1 } } }} />;',
  '',
].join('\n');
const PICKER_B = [
  "import React from 'react';",
  "import { FormControl } from '@mui/material';",
  "import { TimePicker } from '@mui/x-date-pickers';",
  '',
  'export function B({ v, c, fieldSx }) {',
  '    return (',
  '        <FormControl size="small">',
  '            <TimePicker value={v} onChange={c} slotProps={{ textField: { sx: fieldSx } }} />',
  '        </FormControl>',
  '    );',
  '}',
  '',
].join('\n');
const APP = [
  "import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';",
  "import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';",
  '',
  'export const App = ({ children }) => <LocalizationProvider dateAdapter={AdapterDayjs}>{children}</LocalizationProvider>;',
  '',
].join('\n');

test('R1.1 auto with more than one picker file → shared file + relative imports; second run NOOP', () => {
  const root = repo({ 'src/a/A.jsx': PICKER_A, 'src/b/deep/B.jsx': PICKER_B, 'src/App.jsx': APP });
  const res = run([], { cwd: root, runOfficial: okRunner() });
  assert.strictEqual(res.result, 'OK', JSON.stringify(res.manual));
  assert.strictEqual(readIn(root, 'src/utils/pickersRtlSx.js'), RTL_SX_SOURCE + '\n');
  assert.strictEqual(readIn(root, 'src/a/A.jsx'), [
    "import { DatePicker } from '@mui/x-date-pickers/DatePicker';",
    "import { pickersRtlSxMedium } from '../utils/pickersRtlSx';",
    '',
    'export const A = (p) => <DatePicker value={p.v} onChange={p.c} slotProps={{ textField: { sx: [pickersRtlSxMedium, { width: 1 }] } }} />;',
    '',
  ].join('\n'));
  assert.match(readIn(root, 'src/b/deep/B.jsx'), /import \{ pickersRtlSxSmall \} from '\.\.\/\.\.\/utils\/pickersRtlSx';\n/);
  assert.match(readIn(root, 'src/b/deep/B.jsx'), /slotProps=\{\{ textField: \{ sx: \[pickersRtlSxSmall, fieldSx\], size: "small" \} \}\}/);
  const r = report(root);
  assert.strictEqual(r.config.rtlSxPlacementResolved, 'shared');
  assert.ok(res.filesChanged.indexOf('src/utils/pickersRtlSx.js') !== -1);

  const before = ['src/a/A.jsx', 'src/b/deep/B.jsx', 'src/utils/pickersRtlSx.js'].map((f) => readIn(root, f));
  const again = run([], { cwd: root, runOfficial: okRunner() });
  assert.strictEqual(again.result, 'NOOP');
  assert.deepStrictEqual(['src/a/A.jsx', 'src/b/deep/B.jsx', 'src/utils/pickersRtlSx.js'].map((f) => readIn(root, f)), before);
});

test('R1.1 rtlSxPlacement "inline" from the config wins over the file count; custom shared path is not created', () => {
  const root = repo({
    'src/a/A.jsx': PICKER_A, 'src/b/deep/B.jsx': PICKER_B, 'src/App.jsx': APP,
    'pickers-migration.config.json': JSON.stringify({ rtlSxPlacement: 'inline', rtlSxSharedPath: 'src/x/rtl.js' }),
  });
  run([], { cwd: root, runOfficial: okRunner() });
  assert.ok(!exists(root, 'src/x/rtl.js'));
  assert.match(readIn(root, 'src/a/A.jsx'), /^const pickersRtlSxMedium = \{$/m);
  assert.doesNotMatch(readIn(root, 'src/a/A.jsx'), /export const pickersRtl/);
  assert.deepStrictEqual(report(root).config, { rtlSxPlacement: 'inline', rtlSxPlacementResolved: 'inline', rtlSxSharedPath: 'src/x/rtl.js', invalidDateBehavior: 'null' });
});

test('R1 inline: a module-level "base" in the file → the constants use pickersRtlSxBase', () => {
  const root = repo({ 'src/A.jsx': "import { DatePicker } from '@mui/x-date-pickers';\n\nconst base = 1;\nexport const A = () => <DatePicker />;\n" });
  run([], { cwd: root, runOfficial: okRunner() });
  const out = readIn(root, 'src/A.jsx');
  assert.match(out, /const pickersRtlSxBase = \{/);
  assert.match(out, /\.\.\.pickersRtlSxBase\['& \.MuiInputLabel-root'\]/);
  assert.match(out, /<DatePicker slotProps=\{\{ textField: \{ sx: pickersRtlSxMedium \} \}\} \/>/);
});

test('R1: slotProps that is a variable → TODO, no change', () => {
  const root = repo({ 'src/A.jsx': "import { DatePicker } from '@mui/x-date-pickers';\n\nexport const A = ({ sp }) => <DatePicker slotProps={sp} />;\n" });
  const res = run([], { cwd: root, runOfficial: okRunner() });
  assert.match(readIn(root, 'src/A.jsx'), /\/\/ MIGRATION-TODO: R1 slotProps is not an object literal: add sx: pickersRtlSxMedium to slotProps.textField manually\nexport const A/);
  assert.doesNotMatch(readIn(root, 'src/A.jsx'), /const base/);
  assert.strictEqual(res.result, 'REVIEW');
});

test('R1: a JSX spread on the picker → new slotProps goes before the spread + TODO', () => {
  const root = repo({ 'src/A.jsx': "import { DatePicker } from '@mui/x-date-pickers';\n\nexport const A = (props) => (\n    <DatePicker\n        {...props}\n    />\n);\n" });
  run([], { cwd: root, runOfficial: okRunner() });
  assert.match(readIn(root, 'src/A.jsx'), /<DatePicker\n {8}slotProps=\{\{\n {12}textField: \{ sx: pickersRtlSxMedium \},\n {8}\}\}\n {8}\/\/ MIGRATION-TODO: D1 spread may contain old prop names\n {8}\{\.\.\.props\}\n/);
});

test('R1 size: size on the picker → slotProps.textField.size, removed from the picker; second run NOOP', () => {
  const root = repo({ 'src/A.jsx': "import { DatePicker } from '@mui/x-date-pickers';\n\nexport const A = ({ s }) => <DatePicker size={s} />;\n" });
  run([], { cwd: root, runOfficial: okRunner() });
  const out = readIn(root, 'src/A.jsx');
  assert.match(out, /<DatePicker slotProps=\{\{ textField: \{ size: s \} \}\} \/>/);
  assert.match(out, /MIGRATION-TODO: R1 dynamic size/);
  assert.strictEqual(run([], { cwd: root, runOfficial: okRunner() }).result, 'NOOP');
});

test('R1 size: slotProps.textField.size already set → the dead size on the picker is removed', () => {
  const root = repo({ 'src/A.jsx': "import { DatePicker } from '@mui/x-date-pickers';\n\nexport const A = () => <DatePicker size=\"medium\" slotProps={{ textField: { size: 'small' } }} />;\n" });
  run([], { cwd: root, runOfficial: okRunner() });
  assert.match(readIn(root, 'src/A.jsx'), /<DatePicker slotProps=\{\{ textField: \{ size: 'small', sx: pickersRtlSxSmall \} \}\} \/>/);
});

test('R1 size: FormControl size="medium" (the default) → no size added', () => {
  const root = repo({ 'src/A.jsx': "import { FormControl } from '@mui/material';\nimport { DatePicker } from '@mui/x-date-pickers';\n\nexport const A = () => <FormControl size=\"medium\"><DatePicker /></FormControl>;\n" });
  run([], { cwd: root, runOfficial: okRunner() });
  assert.match(readIn(root, 'src/A.jsx'), /<FormControl size="medium"><DatePicker slotProps=\{\{ textField: \{ sx: pickersRtlSxMedium \} \}\} \/><\/FormControl>/);
});

// ---- output of the official codemods (seen in a real run) ----

test('D1: v5-case keys left in an existing slotProps are lowercased; a removed `renderInput … )} />` joins the previous line', () => {
  const src = [
    "import TextField from '@mui/material/TextField';",
    "import { DatePicker } from '@mui/x-date-pickers';",
    '',
    'export const A = () => (',
    '    <DatePicker',
    '        slotProps={{',
    "            ActionBar: { actions: ['clear'] },",
    '        }}',
    '        renderInput={(params) => (',
    '            <TextField {...params} fullWidth />',
    '        )} />',
    ');',
    '',
  ].join('\n');
  const root = repo({ 'src/A.jsx': src });
  run([], { cwd: root, runOfficial: okRunner() });
  assert.match(readIn(root, 'src/A.jsx'), / {8}slotProps=\{\{\n {12}actionBar: \{ actions: \['clear'\] \},\n {12}textField: \{ fullWidth: true, sx: pickersRtlSxMedium \},\n {8}\}\} \/>\n\);\n/);
});

// ---- C3 / config ----

test('C3 with invalidDateBehavior "keep" → onChange unchanged', () => {
  const f = fixture('c2-c3-moment');
  const root = repo({ 'src/S.jsx': f.input, 'pickers-migration.config.json': '{ "invalidDateBehavior": "keep" }' });
  const res = run([], { cwd: root, runOfficial: okRunner() });
  assert.match(readIn(root, 'src/S.jsx'), /onChange=\{\(d\) => setForm\(\{ \.\.\.form, start: d\?\.toDate\(\) \|\| null \}\)\}/);
  assert.ok(rules(res).indexOf('C3') === -1);
  assert.strictEqual(report(root).config.invalidDateBehavior, 'keep');
});

test('C3: onChange that returns something else is not changed', () => {
  const src = "import { DatePicker } from '@mui/x-date-pickers';\n\nexport const A = ({ set }) => <DatePicker onChange={(d) => set(d?.format('YYYY') || null)} />;\n";
  const root = repo({ 'src/A.jsx': src });
  const res = run([], { cwd: root, runOfficial: okRunner() });
  assert.ok(rules(res).indexOf('C3') === -1);
  assert.match(readIn(root, 'src/A.jsx'), /set\(d\?\.format\('YYYY'\) \|\| null\)/);
});

test('config: invalid value → BLOCKED before anything runs or is written', () => {
  const root = repo({ 'src/A.jsx': PICKER_A, 'pickers-migration.config.json': '{ "rtlSxPlacement": "everywhere" }' });
  const runner = okRunner();
  const res = run([], { cwd: root, runOfficial: runner });
  assert.strictEqual(res.result, 'BLOCKED');
  assert.match(res.blockers[0].message, /invalid rtlSxPlacement "everywhere" – expected one of "auto" \| "inline" \| "shared"/);
  assert.strictEqual(runner.calls.length, 0);
  assert.strictEqual(readIn(root, 'src/A.jsx'), PICKER_A);
  assert.ok(!exists(root, 'migration-report.json'));
});

test('config: unknown key, bad JSON, bad shared path, missing --config file → BLOCKED', () => {
  const cases = [
    ['{ "rtlSxPlacment": "inline" }', /unknown key "rtlSxPlacment"/],
    ['{ nope', /is not valid JSON/],
    ['{ "rtlSxSharedPath": "../outside.js" }', /invalid rtlSxSharedPath/],
    ['{ "rtlSxSharedPath": "src/utils/rtl.css" }', /invalid rtlSxSharedPath/],
    ['{ "invalidDateBehavior": null }', /invalid invalidDateBehavior null/],
  ];
  cases.forEach(([cfg, re]) => {
    const root = repo({ 'src/A.jsx': PICKER_A, 'pickers-migration.config.json': cfg });
    const res = run([], { cwd: root, runOfficial: okRunner() });
    assert.strictEqual(res.result, 'BLOCKED', cfg);
    assert.match(res.blockers[0].message, re);
  });
  const root = repo({ 'src/A.jsx': PICKER_A });
  assert.match(run(['--config', 'conf/p.json'], { cwd: root }).blockers[0].message, /Config file not found: conf\/p\.json/);
});

test('config: --config <path> is read instead of the default file', () => {
  const root = repo({ 'src/A.jsx': PICKER_A, 'conf/p.json': '{ "rtlSxPlacement": "shared" }' });
  run(['--config', 'conf/p.json'], { cwd: root, runOfficial: okRunner() });
  assert.ok(exists(root, 'src/utils/pickersRtlSx.js'));
  assert.strictEqual(report(root).configSource, 'conf/p.json');
});

// ---- step 1: the official codemods ----

test('step 1: v6…v9 in order on every file that imports @mui/x-date-pickers or @mui/lab', () => {
  const lab = "import LoadingButton from '@mui/lab/LoadingButton';\nexport const L = () => <LoadingButton />;\n";
  const root = repo({ 'src/a/A.jsx': PICKER_A, 'src/L.jsx': lab, 'src/Plain.jsx': 'export const P = 1;\n' });
  const runner = okRunner();
  run([], { cwd: root, runOfficial: runner });
  assert.deepStrictEqual(runner.calls.map((c) => c.version), ['v6', 'v7', 'v8', 'v9']);
  assert.deepStrictEqual(runner.calls[0].files.map((f) => path.relative(root, f).split(path.sep).join('/')), ['src/L.jsx', 'src/a/A.jsx']);
});

test('step 1: a crash on one file ("1 errors" + ERR line) → codemod-failed for it, step 2 still runs, needs-review', () => {
  const root = repo({ 'src/a/A.jsx': PICKER_A, 'src/b/deep/B.jsx': PICKER_B, 'src/App.jsx': APP });
  const a = path.join(root, 'src', 'a', 'A.jsx');
  const runner = (version, files) => (version === 'v6'
    ? { status: 0, output: ' ERR ' + a + ' Transformation error (Cannot read properties of undefined)\nResults:\n1 errors\n1 unmodified\n0 skipped\n0 ok\n' }
    : { status: 0, output: 'Results:\n0 errors\n' + files.length + ' unmodified\n' });
  const res = run([], { cwd: root, runOfficial: runner });
  const r = report(root);
  const fa = r.files.find((f) => f.file === 'src/a/A.jsx');
  const fb = r.files.find((f) => f.file === 'src/b/deep/B.jsx');
  assert.deepStrictEqual(fa.codemod, { v6: 'failed', v7: 'ok', v8: 'ok', v9: 'ok' });
  assert.deepStrictEqual(fb.codemod, { v6: 'ok', v7: 'ok', v8: 'ok', v9: 'ok' });
  assert.strictEqual(fa.status, 'needs-review');
  assert.deepStrictEqual(fa.todos, []);
  assert.strictEqual(fb.status, 'done');
  assert.ok(fa.applied.indexOf('R1') !== -1, 'step 2 ran on the failed file');
  assert.ok(res.manual.some((m) => m.file === 'src/a/A.jsx' && /^codemod-failed: v6/.test(m.reason)));
  assert.strictEqual(res.result, 'REVIEW');
});

test('step 1: errors that cannot be attributed to a file → each file is run again on its own', () => {
  const root = repo({ 'src/a/A.jsx': PICKER_A, 'src/b/deep/B.jsx': PICKER_B });
  const calls = [];
  const runner = (version, files) => {
    calls.push(version + ':' + files.length);
    if (version === 'v7' && files.length > 1) return { status: 0, output: 'Results:\n1 errors\n' };
    if (version === 'v7' && /B\.jsx$/.test(files[0])) return { status: 0, output: 'Results:\n1 errors\n' };
    return { status: 0, output: 'Results:\n0 errors\n' };
  };
  run([], { cwd: root, runOfficial: runner });
  assert.deepStrictEqual(calls, ['v6:2', 'v7:2', 'v7:1', 'v7:1', 'v8:2', 'v9:2']);
  const r = report(root);
  assert.strictEqual(r.files.find((f) => f.file === 'src/b/deep/B.jsx').codemod.v7, 'failed');
  assert.strictEqual(r.files.find((f) => f.file === 'src/a/A.jsx').codemod.v7, 'ok');
});

test('interpretOfficial: no "errors" summary → failed with the last output line', () => {
  assert.deepStrictEqual(interpretOfficial({ output: 'npm ERR! 404 Not Found - @mui/x-codemod\n' }, ['/a.js']),
    { all: 'failed', reason: 'the codemod did not run: npm ERR! 404 Not Found - @mui/x-codemod' });
  assert.deepStrictEqual(interpretOfficial({ output: 'Results:\n0 errors\n' }, ['/a.js']), { all: 'ok' });
});

test('--skip-official-codemods / --dry-run: the runner is not called; dry-run writes nothing', () => {
  const root = repo({ 'src/a/A.jsx': PICKER_A, 'src/App.jsx': APP });
  const runner = okRunner();
  const dry = run(['--dry-run'], { cwd: root, runOfficial: runner });
  assert.strictEqual(runner.calls.length, 0);
  assert.strictEqual(dry.result, 'OK');
  assert.deepStrictEqual(dry.filesChanged, ['src/a/A.jsx']);
  assert.ok(dry.notes.some((n) => /Official codemods skipped \(--dry-run\)/.test(n)));
  assert.strictEqual(readIn(root, 'src/a/A.jsx'), PICKER_A);
  assert.ok(!exists(root, 'migration-report.json'));
  run(['--skip-official-codemods'], { cwd: root, runOfficial: runner });
  assert.strictEqual(runner.calls.length, 0);
  assert.deepStrictEqual(report(root).files.find((x) => x.file === 'src/a/A.jsx').codemod, { v6: 'skipped', v7: 'skipped', v8: 'skipped', v9: 'skipped' });
});

// ---- theme files: D8 + M5 ----

test('theme file: D8 key + CSS strings (styled template too), M5 on field overrides', () => {
  const theme = [
    "import { createTheme, styled } from '@mui/material/styles';",
    '',
    'export const theme = createTheme({',
    '  components: {',
    '    MuiPickersDay: { styleOverrides: { root: { fontWeight: 600 } } },',
    "    MuiTextField: { defaultProps: { size: 'small' } },",
    "    MuiButton: { styleOverrides: { root: { textTransform: 'none' } } },",
    '  },',
    '});',
    '',
    'export const Box = styled.div`',
    '  & .MuiCalendarPicker-root { width: ${(p) => p.w}px; }',
    '`;',
    '',
  ].join('\n');
  const root = repo({ 'src/theme.js': theme, 'src/a/A.jsx': PICKER_A });
  const res = run([], { cwd: root, runOfficial: okRunner() });
  const out = readIn(root, 'src/theme.js');
  assert.match(out, /^ {4}MuiPickerDay: \{ styleOverrides/m);
  assert.match(out, /& \.MuiDateCalendar-root \{ width/);
  assert.match(out, / {4}\/\/ MIGRATION-TODO: M5 theme overrides no longer apply to the pickers field; duplicate under MuiPickersTextField .*\n {4}MuiTextField:/);
  assert.doesNotMatch(out, /MIGRATION-TODO: M5[^\n]*\n {4}MuiButton/);
  const f = report(root).files.find((x) => x.file === 'src/theme.js');
  assert.deepStrictEqual(f.applied, ['D8']);
  assert.deepStrictEqual(f.codemod, { v6: 'skipped', v7: 'skipped', v8: 'skipped', v9: 'skipped' });
  assert.strictEqual(f.status, 'needs-review');
  assert.ok(res.manual.some((m) => m.file === 'src/theme.js' && /^M5 /.test(m.reason)));
});

test('a theme without pickers in the project is not marked (M5 only matters with pickers)', () => {
  const theme = "import { createTheme } from '@mui/material/styles';\nexport const t = createTheme({ components: { MuiTextField: { defaultProps: { size: 'small' } } } });\n";
  const root = repo({ 'src/theme.js': theme });
  const res = run([], { cwd: root, runOfficial: okRunner() });
  assert.strictEqual(res.result, 'NOOP');
  assert.strictEqual(readIn(root, 'src/theme.js'), theme);
  assert.ok(!exists(root, 'migration-report.json'));
});

// ---- formatting ----

test('CRLF files stay CRLF, a BOM is kept', () => {
  const f = fixture('c2-c3-moment');
  const root = repo({ 'src/S.jsx': '﻿' + f.input.replace(/\n/g, '\r\n') });
  run([], { cwd: root, runOfficial: okRunner() });
  const out = readIn(root, 'src/S.jsx');
  assert.strictEqual(out.charCodeAt(0), 0xfeff);
  assert.doesNotMatch(out.replace(/\r\n/g, ''), /\n/);
  assert.strictEqual(out.slice(1).replace(/\r\n/g, '\n'), f.expected);
});

test('lines that no rule touched are byte-for-byte identical', () => {
  const f = fixture('ips-date-picker');
  const root = repo({ 'src/I.jsx': f.input });
  run([], { cwd: root, runOfficial: okRunner() });
  const out = readIn(root, 'src/I.jsx').split('\n');
  ['    const handleChange = (dateValue) => {', '            <LocalizationProvider dateAdapter={AdapterMoment} adapterLocale="he">',
    "import EventIcon from '@mui/icons-material/Event';", 'export default IpsDatePicker;'].forEach((l) => assert.ok(out.indexOf(l) !== -1, l));
});

// ---- contract ----

test('no pickers in the project → NOOP, nothing written', () => {
  const root = repo({ 'src/A.jsx': 'export const A = 1;\n' });
  const res = run([], { cwd: root, runOfficial: okRunner() });
  assert.strictEqual(res.result, 'NOOP');
  assert.ok(!exists(root, 'migration-report.json'));
});

test('no src/ → BLOCKED; unknown argument → BLOCKED', () => {
  const root = repo({ 'x.txt': '' });
  assert.match(run([], { cwd: root }).blockers[0].message, /No src\/ folder/);
  assert.match(run(['--bogus'], { cwd: root }).blockers[0].message, /Unknown argument: --bogus/);
});

test('main: --json contract and a RESULT line in text mode', () => {
  const root = repo({ 'src/a/A.jsx': PICKER_A });
  let out = '';
  const code = main(['--json'], { cwd: root, runOfficial: okRunner(), env: {} }, { stdout: (s) => { out += s; }, stderr: () => {} });
  assert.strictEqual(code, 0);
  const j = JSON.parse(out);
  assert.strictEqual(j.script, 'codemod-pickers');
  assert.ok(Array.isArray(j.changes) && Array.isArray(j.manual) && Array.isArray(j.blockers) && Array.isArray(j.notes));
  assert.strictEqual(j.reportData, undefined);
  out = '';
  main([], { cwd: root, runOfficial: okRunner(), env: {} }, { stdout: (s) => { out += s; }, stderr: () => {} });
  assert.match(out, /\nRESULT: NOOP\n$/);
});
