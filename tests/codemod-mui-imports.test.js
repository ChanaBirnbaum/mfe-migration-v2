'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { run, main } = require('../scripts/codemod-mui-imports');

const FIX = path.join(__dirname, 'fixtures', 'mui-imports');

function caseFiles(name) {
  const dir = path.join(FIX, name);
  const input = fs.readdirSync(dir).find((f) => f.startsWith('input.'));
  const ext = path.extname(input);
  return {
    file: 'src/' + name + ext,
    input: fs.readFileSync(path.join(dir, input), 'utf8'),
    expected: fs.readFileSync(path.join(dir, 'expected' + ext), 'utf8'),
  };
}

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mui-imports-test-'));
  Object.keys(files).forEach((rel) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), files[rel]);
  });
  return root;
}

const readIn = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

async function golden(name) {
  const c = caseFiles(name);
  const root = repo({ [c.file]: c.input });
  const res = await run([], { cwd: root });
  assert.strictEqual(readIn(root, c.file), c.expected, name + ': output differs from golden file');
  // idempotent: second run changes nothing
  const again = await run([], { cwd: root });
  assert.deepStrictEqual(again.changes, [], name + ': second run produced changes');
  assert.strictEqual(readIn(root, c.file), c.expected);
  return { res: res, again: again };
}

// ---- the four import patterns ----

test('golden: named import from package root', async () => {
  const { res, again } = await golden('named-root');
  assert.strictEqual(res.result, 'OK');
  assert.strictEqual(again.result, 'NOOP');
});

test('golden: default import from component path (+ GridList → ImageList in JSX)', async () => {
  const { res, again } = await golden('default-subpath');
  assert.strictEqual(res.result, 'OK');
  assert.strictEqual(again.result, 'NOOP');
  assert.ok(res.changes.some((c) => c.rule === 'MUI.RENAME' && /GridList → ImageList/.test(c.detail)));
});

test('golden: icons (default path + named root with alias)', async () => {
  const { res } = await golden('icons');
  assert.strictEqual(res.result, 'OK');
});

test('golden: require() destructuring + property access + createMuiTheme/palette.type', async () => {
  const { res, again } = await golden('require');
  assert.strictEqual(res.result, 'OK');
  assert.strictEqual(again.result, 'NOOP');
});

// ---- mixed files ----

test('golden: merges into an existing @mui/material import, makeStyles stays (manual)', async () => {
  const { res, again } = await golden('merge');
  assert.strictEqual(res.result, 'REVIEW');
  assert.deepStrictEqual(res.manual.map((m) => m.line + ' ' + m.reason.split(' ')[0]), ['4 makeStyles']);
  // makeStyles still from @material-ui → not NOOP, but no further changes
  assert.strictEqual(again.result, 'REVIEW');
});

test('golden: commented imports / requires / palette.type are never touched', async () => {
  const c = caseFiles('commented');
  const root = repo({ [c.file]: c.input });
  const res = await run([], { cwd: root });
  assert.strictEqual(res.result, 'NOOP');
  assert.deepStrictEqual(res.changes, []);
  assert.strictEqual(readIn(root, c.file), c.expected);
});

test('golden: lab split, styles subpath split, pickers review, Hidden + @material-ui/styles manual', async () => {
  const { res } = await golden('lab-styles-mixed');
  assert.strictEqual(res.result, 'REVIEW');
  const manual = res.manual.map((m) => m.reason);
  assert.ok(manual.some((r) => /^makeStyles /.test(r)));
  assert.ok(manual.some((r) => /Hidden/.test(r)));
  assert.ok(manual.some((r) => /@material-ui\/styles/.test(r)));
  const reviews = res.changes.filter((c) => c.confidence === 'review').map((c) => c.detail);
  assert.ok(reviews.some((d) => /→ @mui\/x-date-pickers$/.test(d)));
  assert.ok(reviews.some((d) => /→ @mui\/lab$/.test(d)));
  assert.ok(!reviews.some((d) => /→ @mui\/material$/.test(d)), 'moved lab components are auto');
});

test('golden: withStyles / createStyles / StylesProvider stay, each manual with file + line + exact message', async () => {
  const { res, again } = await golden('jss-apis');
  const file = 'src/jss-apis.jsx';
  assert.strictEqual(res.result, 'REVIEW');
  assert.strictEqual(again.result, 'REVIEW');
  const WITH_STYLES = 'withStyles אינו נתמך ב-MUI v7. נדרשת המרה ידנית ל-styled() או sx';
  assert.deepStrictEqual(res.manual.map((m) => [m.file, m.line, m.reason.split(' ')[0]]), [
    [file, 2, 'withStyles'], [file, 2, 'createStyles'], [file, 2, 'StylesProvider'],
    // lines are in the rewritten file: `import { Button } from '@mui/material'` was added at line 3
    [file, 4, 'withStyles'], // deep path @material-ui/core/styles/withStyles
    [file, 5, 'withStyles'], // @material-ui/styles – per name, not the package message
  ]);
  res.manual.filter((m) => m.reason.startsWith('withStyles')).forEach((m) => assert.strictEqual(m.reason, WITH_STYLES));
  assert.ok(!res.manual.some((m) => /מטופל ב-codemod-makestyles/.test(m.reason)), 'no message may claim makestyles handles these');
});

test('a file whose only @material-ui import is withStyles → REVIEW, not OK/NOOP', async () => {
  const root = repo({ 'src/w.jsx': "import { withStyles } from '@material-ui/core';\nexport default withStyles({})(() => null);\n" });
  const res = await run([], { cwd: root });
  assert.strictEqual(res.result, 'REVIEW');
  assert.deepStrictEqual(res.manual.map((m) => [m.file, m.line]), [['src/w.jsx', 1]]);
  assert.deepStrictEqual(res.changes, []);
});

// ---- behaviour ----

test('rename conflict: alpha already bound → `alpha as fade`, usages untouched', async () => {
  const input = [
    "import { alpha } from './my-colors';",
    "import { fade } from '@material-ui/core/styles';",
    'export const x = [fade("#000", 0.1), alpha];',
    '',
  ].join('\n');
  const root = repo({ 'src/x.js': input });
  await run([], { cwd: root });
  assert.strictEqual(readIn(root, 'src/x.js'), [
    "import { alpha } from './my-colors';",
    "import { alpha as fade } from '@mui/material/styles';",
    'export const x = [fade("#000", 0.1), alpha];',
    '',
  ].join('\n'));
});

test('shorthand property keeps its key when the binding is renamed', async () => {
  const root = repo({ 'src/t.js': "import { createMuiTheme } from '@material-ui/core';\nexport default { createMuiTheme };\n" });
  await run([], { cwd: root });
  assert.strictEqual(readIn(root, 'src/t.js'), "import { createTheme } from '@mui/material';\nexport default { createMuiTheme: createTheme };\n");
});

test('CRLF and double quotes are preserved in generated imports', async () => {
  const input = 'import { Autocomplete, TreeView } from "@material-ui/lab";\r\nexport const a = [Autocomplete, TreeView];\r\n';
  const root = repo({ 'src/a.js': input });
  await run([], { cwd: root });
  assert.strictEqual(readIn(root, 'src/a.js'),
    'import { Autocomplete } from "@mui/material";\r\nimport { TreeView } from "@mui/lab";\r\nexport const a = [Autocomplete, TreeView];\r\n');
});

test('require split: manual name stays, others move', async () => {
  const root = repo({ 'src/r.js': "const { Button, makeStyles } = require('@material-ui/core');\nmodule.exports = { Button, makeStyles };\n" });
  const res = await run([], { cwd: root });
  assert.strictEqual(readIn(root, 'src/r.js'),
    "const { makeStyles } = require('@material-ui/core');\nconst { Button } = require('@mui/material');\nmodule.exports = { Button, makeStyles };\n");
  assert.strictEqual(res.result, 'REVIEW');
});

test('--dry-run reports, writes nothing; node_modules/build/dist skipped', async () => {
  const c = caseFiles('named-root');
  const root = repo({ [c.file]: c.input, 'src/node_modules/x.js': c.input, 'src/build/y.js': c.input, 'src/dist/z.js': c.input });
  const res = await run(['--dry-run'], { cwd: root });
  assert.strictEqual(res.result, 'OK');
  assert.deepStrictEqual(res.filesChanged, [c.file]);
  assert.strictEqual(readIn(root, c.file), c.input);
});

test('missing src/ → BLOCKED, exit 0', async () => {
  let out = '';
  const code = await main([], { cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'mui-imports-test-')) }, { stdout: (s) => { out += s; }, stderr: () => {} });
  assert.strictEqual(code, 0);
  assert.match(out, /RESULT: BLOCKED\n$/);
});

test('--json contract', async () => {
  const c = caseFiles('lab-styles-mixed');
  let out = '';
  await main(['--json', '--dry-run'], { cwd: repo({ [c.file]: c.input }) }, { stdout: (s) => { out += s; }, stderr: () => {} });
  const res = JSON.parse(out);
  assert.deepStrictEqual(Object.keys(res).slice(0, 6), ['script', 'result', 'changes', 'manual', 'blockers', 'notes']);
  assert.ok(res.manual.every((m) => m.file && m.line && m.reason));
});

// ---- expected failures → BLOCKED, exit 0 ----

test('prettier.format throws → BLOCKED with the file and the prettier error, exit 0; import changes kept', async () => {
  const c = caseFiles('named-root');
  const root = repo({
    [c.file]: c.input,
    'node_modules/prettier/index.js': [
      'exports.resolveConfig = async () => ({ singleQuote: true });',
      "exports.format = async () => { throw new Error('SyntaxError: Unexpected token (3:5)\\n  1 | import x'); };",
    ].join('\n'),
  });
  let out = '';
  const code = await main([], { cwd: root }, { stdout: (s) => { out += s; }, stderr: (s) => { throw new Error('stderr: ' + s); } });
  assert.strictEqual(code, 0);
  assert.match(out, /⛔ src\/named-root\.jsx: prettier נכשל – SyntaxError: Unexpected token \(3:5\)\. שינויי הייבוא נכתבו לקובץ, אך הוא לא עוצב/);
  assert.match(out, /✏️ 1 קבצים שונו/);
  assert.match(out, /RESULT: BLOCKED\n$/);
  assert.strictEqual(readIn(root, c.file), c.expected); // the codemod output itself was written
});
