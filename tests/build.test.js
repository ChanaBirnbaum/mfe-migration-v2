'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { run, main, parseOutput } = require('../scripts/build');

// Real outputs captured from webpack 5.111.1 (babel-loader 9, eslint-webpack-plugin 5) and tsc 5.9.3
// on a deliberately broken project; the project path was replaced with C:\work\hasava-mfe.
const FIX = path.join(__dirname, 'fixtures', 'build');
const WEBPACK = fs.readFileSync(path.join(FIX, 'webpack5-errors.txt'), 'utf8');
const TSC = fs.readFileSync(path.join(FIX, 'tsc-errors.txt'), 'utf8');
const CWD = 'C:\\work\\hasava-mfe';

const pick = (d) => [d.source, d.severity, d.file, d.line, d.column, d.code, d.message];

// ---- parser: real webpack 5 output ----

test('webpack 5: every block parsed with file, 1-based line/column, code', () => {
  const { diagnostics, reported, blocks } = parseOutput(WEBPACK, CWD);
  assert.deepStrictEqual(diagnostics.map(pick), [
    ['webpack', 'warning', 'src/index.jsx', 7, 66, 'EXPORT_NOT_FOUND', "export 'nope' (imported as 'nope') was not found in './util'"],
    ['babel', 'error', 'src/Broken.jsx', 3, 10, 'BABEL_SYNTAX', 'Unexpected token'],
    ['webpack', 'error', 'src/index.jsx', 3, 1, 'MODULE_NOT_FOUND', "Can't resolve './components/Missing'"],
    ['eslint', 'error', 'src/Broken.jsx', 3, 10, null, 'Parsing error: Unexpected token ,'],
    ['eslint', 'error', 'src/index.jsx', 1, 8, 'no-unused-vars', "'React' is defined but never used"],
    ['eslint', 'error', 'src/index.jsx', 3, 8, 'no-unused-vars', "'Missing' is defined but never used"],
    ['eslint', 'error', 'src/index.jsx', 4, 8, 'no-unused-vars', "'Broken' is defined but never used"],
    ['eslint', 'error', 'src/index.jsx', 7, 9, 'no-unused-vars', "'unused' is assigned a value but never used"],
  ]);
  // webpack counts blocks: the eslint block is one "error"
  assert.deepStrictEqual(reported, { errors: 3, warnings: 1 });
  assert.deepStrictEqual(blocks, { errors: 3, warnings: 1 });
});

test('webpack 5: Babel column (0-based in the message) agrees with ESLint (1-based) after conversion', () => {
  const d = parseOutput(WEBPACK, CWD).diagnostics;
  const babel = d.find((x) => x.source === 'babel');
  const eslint = d.find((x) => x.source === 'eslint' && x.file === 'src/Broken.jsx');
  assert.deepStrictEqual([babel.line, babel.column], [eslint.line, eslint.column]);
});

test('webpack 5: raw keeps the full original block (code frame + stack)', () => {
  const babel = parseOutput(WEBPACK, CWD).diagnostics.find((x) => x.source === 'babel');
  assert.match(babel.raw, /^ERROR in \.\/src\/Broken\.jsx\nModule build failed/);
  assert.match(babel.raw, /> 3 \| {5}a: 1,,/);
  assert.match(babel.raw, / @ \.\/src\/index\.jsx 4:0-30/);
  assert.ok(babel.raw.indexOf('1 error has detailed information') === -1, 'block must end before the summary');
});

// ---- parser: real tsc output ----

test('tsc: errors incl. a multi-line message', () => {
  assert.deepStrictEqual(parseOutput(TSC, CWD).diagnostics.map(pick), [
    ['tsc', 'error', 'src/Typed.tsx', 7, 9, 'TS2322', "Type 'string' is not assignable to type 'number'."],
    ['tsc', 'error', 'src/Typed.tsx', 8, 22, 'TS2304', "Cannot find name 'missingName'."],
    ['tsc', 'error', 'src/Typed.tsx', 11, 27, 'TS2345',
      "Argument of type '{ title: string; }' is not assignable to parameter of type 'Props'. Property 'count' is missing in type '{ title: string; }' but required in type 'Props'."],
  ]);
  assert.match(parseOutput(TSC, CWD).diagnostics[2].raw, /\n {2}Property 'count' is missing/);
});

test('tsc --pretty format and ANSI colours', () => {
  const d = parseOutput('\u001b[96msrc/A.tsx\u001b[0m:\u001b[93m4\u001b[0m:\u001b[93m2\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS2339: \u001b[0mProperty \'x\' does not exist.\n', CWD).diagnostics;
  assert.deepStrictEqual(d.map(pick), [['tsc', 'error', 'src/A.tsx', 4, 2, 'TS2339', "Property 'x' does not exist."]]);
});

test('babel CLI SyntaxError outside webpack', () => {
  const d = parseOutput('SyntaxError: C:\\work\\hasava-mfe\\src\\X.jsx: Unexpected token, expected "," (12:4)\n', CWD).diagnostics;
  assert.deepStrictEqual(d.map(pick), [['babel', 'error', 'src/X.jsx', 12, 5, 'BABEL_SYNTAX', 'Unexpected token, expected ","']]);
});

test('unknown webpack error keeps raw and the first message line', () => {
  const d = parseOutput('ERROR in main\nModule not found: something odd\n\nwebpack 5.1.0 compiled with 1 error in 3 ms\n', CWD).diagnostics;
  assert.strictEqual(d[0].file, null);
  assert.strictEqual(d[0].raw, 'ERROR in main\nModule not found: something odd');
});

// ---- runner ----

function repo(scripts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-test-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'svc', scripts: scripts || { 'build:dev': 'webpack --mode production --env sviva=dev' } }));
  return root;
}

function fakeCp(output, code) {
  const calls = [];
  return {
    calls: calls,
    cp: {
      spawnSync: () => ({}),
      spawn: (cmd, args, options) => {
        calls.push({ cmd: cmd, options: options });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        setImmediate(() => { child.stdout.emit('data', Buffer.from(output)); child.emit('close', code); });
        return child;
      },
    },
  };
}

test('default command is npm run build:dev; errors → BLOCKED; report written to .migration/build-1.json', async () => {
  const root = repo();
  const f = fakeCp(WEBPACK.split(CWD).join(root), 1);
  let out = '';
  assert.strictEqual(await main([], { cwd: root, cp: f.cp }, { stdout: (s) => { out += s; }, stderr: () => {} }), 0);
  assert.strictEqual(f.calls[0].cmd, 'npm run build:dev');
  assert.match(out, /webpack 5\.111\.1 compiled with 3 errors/); // streamed
  assert.match(out, /RESULT: BLOCKED\n$/);
  const report = JSON.parse(fs.readFileSync(path.join(root, '.migration', 'build-1.json'), 'utf8'));
  assert.strictEqual(report.errorCount, 7);
  assert.strictEqual(report.warningCount, 1);
  assert.strictEqual(report.buildCommand, 'npm run build:dev');
  assert.strictEqual(report.diagnostics[2].file, 'src/index.jsx');
});

test('run number increases and the previous error count is compared', async () => {
  const root = repo();
  await run([], { cwd: root, cp: fakeCp(WEBPACK.split(CWD).join(root), 1).cp });
  const second = await run([], { cwd: root, cp: fakeCp(TSC, 2).cp });
  assert.strictEqual(second.run, 2);
  assert.deepStrictEqual(second.previous, { run: 1, errorCount: 7, warningCount: 1 });
  assert.ok(fs.existsSync(path.join(root, '.migration', 'build-2.json')));
});

test('warnings only + exit 0 → OK', async () => {
  const root = repo();
  const res = await run([], { cwd: root, cp: fakeCp("WARNING in ./src/a.js 1:0-5\nexport 'x' (imported as 'x') was not found in './b'\n\nwebpack 5.1.0 compiled with 1 warning in 5 ms\n", 0).cp });
  assert.strictEqual(res.result, 'OK');
  assert.strictEqual(res.errorCount, 0);
  assert.strictEqual(res.warningCount, 1);
});

test('non-zero exit with nothing parsable → BLOCKED with an UNPARSED_FAILURE diagnostic holding the raw tail', async () => {
  const root = repo();
  const res = await run([], { cwd: root, cp: fakeCp('TypeError: Cannot read properties of undefined (reading \'output\')\n    at module.exports (webpack.config.js:12:29)\n', 1).cp });
  assert.strictEqual(res.result, 'BLOCKED');
  assert.strictEqual(res.diagnostics[0].code, 'UNPARSED_FAILURE');
  assert.match(res.diagnostics[0].raw, /reading 'output'/);
});

test('--command overrides; no build:dev script → BLOCKED with the available scripts', async () => {
  const root = repo({ build: 'webpack --env sviva=prod', 'build:test': 'webpack --env sviva=test' });
  const res = await run([], { cwd: root, cp: fakeCp('', 0).cp });
  assert.strictEqual(res.result, 'BLOCKED');
  assert.match(res.blockers[0].message, /build, build:test/);

  const f = fakeCp('webpack 5.1.0 compiled successfully in 5 ms\n', 0);
  const ok = await run(['--command', 'npm run build:test'], { cwd: root, cp: f.cp });
  assert.strictEqual(f.calls[0].cmd, 'npm run build:test');
  assert.strictEqual(ok.result, 'OK');
});

test('--dry-run runs nothing and writes nothing; --json contract', async () => {
  const root = repo();
  const f = fakeCp('', 0);
  let out = '';
  await main(['--dry-run', '--json'], { cwd: root, cp: f.cp }, { stdout: (s) => { out += s; }, stderr: () => {} });
  const res = JSON.parse(out);
  assert.strictEqual(f.calls.length, 0);
  assert.ok(!fs.existsSync(path.join(root, '.migration')));
  ['diagnostics', 'errorCount', 'warningCount', 'durationMs', 'buildCommand'].forEach((k) => assert.ok(k in res, k));
});
