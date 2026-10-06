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
  assert.deepStrictEqual(res.manual.map((m) => m.line + ' ' + m.reason.split(':')[0]), ['4 makeStyles']);
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
  assert.ok(manual.some((r) => /^makeStyles:/.test(r)));
  assert.ok(manual.some((r) => /Hidden/.test(r)));
  assert.ok(manual.some((r) => /@material-ui\/styles/.test(r)));
  const reviews = res.changes.filter((c) => c.confidence === 'review').map((c) => c.detail);
  assert.ok(reviews.some((d) => /→ @mui\/x-date-pickers$/.test(d)));
  assert.ok(reviews.some((d) => /→ @mui\/lab$/.test(d)));
  assert.ok(!reviews.some((d) => /→ @mui\/material$/.test(d)), 'moved lab components are auto');
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
