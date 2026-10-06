'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { run, main } = require('../scripts/webpack-shared');

const FIX = path.join(__dirname, 'fixtures', 'webpack-shared');
const fixture = (name) => ({
  input: fs.readFileSync(path.join(FIX, name, 'input.js'), 'utf8'),
  expected: fs.readFileSync(path.join(FIX, name, 'expected.js'), 'utf8'),
});

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webpack-shared-test-'));
  Object.keys(files).forEach((rel) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), files[rel]);
  });
  return root;
}
const cfg = (root) => fs.readFileSync(path.join(root, 'webpack.config.js'), 'utf8');

// Minimal node_modules so the config can really be required and executed.
const FAKE_MODULES = {
  'package.json': '{ "name": "michsot-sheten", "dependencies": { "react": "^18.3.1" } }',
  'node_modules/webpack/lib/container/ModuleFederationPlugin.js': 'module.exports = class MFP { constructor(o) { this.o = o; } };',
  'node_modules/html-webpack-plugin/index.js': 'module.exports = class Html { constructor(o) { this.o = o; } };',
  'node_modules/@ips/mfe-shared-deps/index.js': [
    'exports.buildSharedGen1 = ({ pkg, require, role }) => {',
    "  if (['host', 'remote', 'standalone'].indexOf(role) === -1) throw new Error('FederationConfigError: role ' + role);",
    "  if (!pkg || !pkg.name || typeof require !== 'function') throw new Error('FederationConfigError: bad args');",
    '  return {};',
    '};',
  ].join('\n'),
};

// ---- golden files ----

test('golden: ({ sviva }) => {...} function config, remote', () => {
  const f = fixture('sviva-function');
  const root = repo({ 'webpack.config.js': f.input });
  const res = run([], { cwd: root });
  assert.strictEqual(res.result, 'OK');
  assert.strictEqual(res.role, 'remote');
  assert.strictEqual(cfg(root), f.expected);
  assert.ok(res.notes.some((n) => /prod.*publicPath: 'auto'/.test(n)), res.notes.join('\n'));
  assert.ok(res.notes.some((n) => /node_modules חסר/.test(n)));
  assert.deepStrictEqual(res.validation, { ran: false, reason: 'node_modules חסר' });
});

test('golden: plain object config, host; deps still used → kept, pkg added next to it', () => {
  const f = fixture('object-host');
  const root = repo({ 'webpack.config.js': f.input });
  const res = run([], { cwd: root });
  assert.strictEqual(res.result, 'OK');
  assert.strictEqual(res.role, 'host');
  assert.strictEqual(cfg(root), f.expected);
  assert.ok(res.notes.some((n) => /deps בשימוש במקום נוסף/.test(n)));
});

test('golden: hybrid → REVIEW with paste code, file unchanged', () => {
  const f = fixture('hybrid');
  const root = repo({ 'webpack.config.js': f.input });
  const res = run([], { cwd: root });
  assert.strictEqual(res.result, 'REVIEW');
  assert.strictEqual(res.role, 'hybrid');
  assert.strictEqual(cfg(root), f.expected);
  assert.match(res.manual[0].reason, /היברידי/);
  assert.match(res.manual[0].code, /buildSharedGen1\(\{ pkg, require, role: /);
});

test('golden: already converted → NOOP', () => {
  const f = fixture('sviva-function');
  const root = repo({ 'webpack.config.js': f.expected });
  const res = run([], { cwd: root });
  assert.strictEqual(res.result, 'NOOP');
  assert.strictEqual(cfg(root), f.expected);
});

// ---- other shapes ----

test('unrecognised module.exports → REVIEW with exact paste code, file untouched', () => {
  const src = [
    "const { merge } = require('webpack-merge');",
    "const ModuleFederationPlugin = require('webpack/lib/container/ModuleFederationPlugin');",
    "module.exports = merge(require('./webpack.common'), { plugins: [new ModuleFederationPlugin({ exposes: { './A': './src/A' }, shared: {} })] });",
    '',
  ].join('\n');
  const root = repo({ 'webpack.config.js': src });
  let out = '';
  main([], { cwd: root }, { stdout: (s) => { out += s; }, stderr: () => {} });
  assert.strictEqual(cfg(root), src);
  assert.match(out, /אינו פונקציה ואינו אובייקט מזוהה/);
  assert.match(out, /\| const pkg = require\('\.\/package\.json'\);/);
  assert.match(out, /RESULT: REVIEW\n$/);
});

test('no ModuleFederationPlugin → standalone, NOOP', () => {
  const root = repo({ 'webpack.config.js': 'module.exports = { mode: "production" };\n' });
  const res = run([], { cwd: root });
  assert.strictEqual(res.role, 'standalone');
  assert.strictEqual(res.result, 'NOOP');
});

test('no shared property → added; no deps line → requires inserted after the last require', () => {
  const root = repo({
    'webpack.config.js': [
      'const ModuleFederationPlugin = require("webpack/lib/container/ModuleFederationPlugin");',
      'module.exports = () => ({',
      '  plugins: [',
      '    new ModuleFederationPlugin({',
      '      name: "A",',
      '      exposes: { "./A": "./src/A.jsx" },',
      '    }),',
      '  ],',
      '});',
      '',
    ].join('\n'),
  });
  run([], { cwd: root });
  assert.strictEqual(cfg(root), [
    'const ModuleFederationPlugin = require("webpack/lib/container/ModuleFederationPlugin");',
    'const pkg = require("./package.json");',
    'const { buildSharedGen1 } = require("@ips/mfe-shared-deps");',
    'module.exports = () => ({',
    '  plugins: [',
    '    new ModuleFederationPlugin({',
    '      name: "A",',
    '      exposes: { "./A": "./src/A.jsx" },',
    "      shared: buildSharedGen1({ pkg, require, role: 'remote' }),",
    '    }),',
    '  ],',
    '});',
    '',
  ].join('\n'));
});

// ---- validation ----

test('validation: node_modules present → config required and executed with sviva=dev', () => {
  const f = fixture('sviva-function');
  const root = repo(Object.assign({ 'webpack.config.js': f.input }, FAKE_MODULES));
  const res = run([], { cwd: root });
  assert.strictEqual(res.result, 'OK', JSON.stringify(res.manual));
  assert.deepStrictEqual(res.validation, { ran: true, ok: true, env: 'dev' });
  assert.strictEqual(cfg(root), f.expected);
});

test('validation failure → file restored, REVIEW with the error', () => {
  const f = fixture('sviva-function');
  const files = Object.assign({ 'webpack.config.js': f.input }, FAKE_MODULES, {
    'node_modules/@ips/mfe-shared-deps/index.js': "exports.buildSharedGen1 = () => { throw new Error('FederationConfigError: boom'); };",
  });
  const root = repo(files);
  const res = run([], { cwd: root });
  assert.strictEqual(res.result, 'REVIEW');
  assert.strictEqual(res.validation.ok, false);
  assert.match(res.validation.error, /FederationConfigError: boom/);
  assert.strictEqual(cfg(root), f.input);
  assert.deepStrictEqual(res.changes, []);
});

test('node_modules without @ips/mfe-shared-deps → validation skipped with note', () => {
  const f = fixture('sviva-function');
  const files = Object.assign({ 'webpack.config.js': f.input }, FAKE_MODULES);
  delete files['node_modules/@ips/mfe-shared-deps/index.js'];
  const res = run([], { cwd: repo(files) });
  assert.strictEqual(res.result, 'OK');
  assert.strictEqual(res.validation.ran, false);
  assert.ok(res.notes.some((n) => /לא מותקן – הוולידציה דולגה.*--validate-only/.test(n)));
});

// ---- --validate-only ----

const validateOnly = (root, extra) => run(['--validate-only'].concat(extra || []), { cwd: root });
const mtime = (root) => fs.statSync(path.join(root, 'webpack.config.js')).mtimeMs;

test('--validate-only: migrated config + node_modules → OK, file not touched', () => {
  const f = fixture('sviva-function');
  const root = repo(Object.assign({ 'webpack.config.js': f.expected }, FAKE_MODULES));
  const before = mtime(root);
  const res = validateOnly(root);
  assert.strictEqual(res.result, 'OK', JSON.stringify(res.manual));
  assert.deepStrictEqual(res.validation, { ran: true, ok: true, env: 'dev' });
  assert.deepStrictEqual(res.changes, []);
  assert.strictEqual(cfg(root), f.expected);
  assert.strictEqual(mtime(root), before);
});

test('--validate-only: failure → REVIEW with the full error output, file not touched', () => {
  const f = fixture('sviva-function');
  const root = repo(Object.assign({ 'webpack.config.js': f.expected }, FAKE_MODULES, {
    // the message is built at run time, so "line5" never appears in the source line node echoes back
    'node_modules/@ips/mfe-shared-deps/index.js': "exports.buildSharedGen1 = () => { throw new Error(['FederationConfigError: boom', 2, 3, 4, 5].map((x, i) => (i ? 'line' + x : x)).join('\\n')); };",
  }));
  const before = mtime(root);
  let out = '';
  main(['--validate-only'], { cwd: root }, { stdout: (s) => { out += s; }, stderr: () => {} });
  const res = validateOnly(root);
  assert.strictEqual(res.result, 'REVIEW');
  assert.strictEqual(res.validation.ok, false);
  assert.strictEqual(res.manual.length, 1);
  assert.strictEqual(res.manual[0].file, 'webpack.config.js');
  // the summary is cut, the output is not: the 5th message line and the stack trace are there
  assert.doesNotMatch(res.validation.error, /line5/);
  assert.match(res.manual[0].output, /FederationConfigError: boom[\s\S]*line5[\s\S]*\n\s+at /);
  assert.match(out, /פלט השגיאה המלא:[\s\S]*\| line5/);
  assert.match(out, /RESULT: REVIEW\n$/);
  assert.strictEqual(cfg(root), f.expected);
  assert.strictEqual(mtime(root), before);
});

test('--validate-only: before install (no node_modules / package missing) → BLOCKED pointing to install.js', () => {
  const f = fixture('sviva-function');
  const noModules = validateOnly(repo({ 'webpack.config.js': f.expected }));
  assert.strictEqual(noModules.result, 'BLOCKED');
  assert.match(noModules.blockers[0].message, /node_modules חסר.*install\.js/);

  const files = Object.assign({ 'webpack.config.js': f.expected }, FAKE_MODULES);
  delete files['node_modules/@ips/mfe-shared-deps/index.js'];
  const noPkg = validateOnly(repo(files));
  assert.strictEqual(noPkg.result, 'BLOCKED');
  assert.match(noPkg.blockers[0].message, /@ips\/mfe-shared-deps לא מותקן/);
});

test('--validate-only: shared not converted yet → REVIEW, file not touched', () => {
  const f = fixture('sviva-function');
  const root = repo(Object.assign({ 'webpack.config.js': f.input }, FAKE_MODULES));
  const res = validateOnly(root);
  assert.strictEqual(res.result, 'REVIEW');
  assert.match(res.manual[0].reason, /עדיין לא הומר ל-buildSharedGen1/);
  assert.strictEqual(cfg(root), f.input);
});

test('--validate-only: standalone (no ModuleFederationPlugin) → NOOP', () => {
  const res = validateOnly(repo({ 'webpack.config.js': 'module.exports = { mode: "production" };\n' }));
  assert.strictEqual(res.result, 'NOOP');
});

test('--validate-only --dry-run: same path (validation is read-only)', () => {
  const f = fixture('sviva-function');
  const root = repo(Object.assign({ 'webpack.config.js': f.expected }, FAKE_MODULES));
  const res = validateOnly(root, ['--dry-run']);
  assert.strictEqual(res.result, 'OK');
  assert.strictEqual(res.validation.ok, true);
});

test('--dry-run writes nothing; --json contract; missing config → BLOCKED', () => {
  const f = fixture('sviva-function');
  const root = repo({ 'webpack.config.js': f.input });
  let out = '';
  assert.strictEqual(main(['--dry-run', '--json'], { cwd: root }, { stdout: (s) => { out += s; }, stderr: () => {} }), 0);
  const res = JSON.parse(out);
  assert.deepStrictEqual(Object.keys(res).slice(0, 6), ['script', 'result', 'changes', 'manual', 'blockers', 'notes']);
  assert.strictEqual(res.role, 'remote');
  assert.strictEqual(res.changes.length, 2);
  assert.strictEqual(cfg(root), f.input);

  out = '';
  main([], { cwd: repo({}) }, { stdout: (s) => { out += s; }, stderr: () => {} });
  assert.match(out, /RESULT: BLOCKED\n$/);
});

// ---- expected failures → BLOCKED, exit 0 ----

test('overlapping edits → BLOCKED with file:line + paste code, exit 0, file untouched', () => {
  const { applyEdits } = require('../scripts/webpack-shared');
  // Two identical edits make the real applyEdits detect an overlap – a script bug no input triggers on purpose.
  const overlapping = (text, edits) => {
    const p = edits[0].start;
    return applyEdits(text, edits.concat([{ start: p, end: p + 1, text: 'X' }, { start: p, end: p + 1, text: 'Y' }]));
  };
  const f = fixture('sviva-function');
  const root = repo({ 'webpack.config.js': f.input });
  let out = '';
  const code = main([], { cwd: root, applyEdits: overlapping }, { stdout: (s) => { out += s; }, stderr: (s) => { throw new Error('stderr: ' + s); } });
  assert.strictEqual(code, 0);
  assert.match(out, /⛔ webpack\.config\.js:\d+ – webpack-shared יצר שתי עריכות חופפות באותו מקום \(באג בסקריפט\)\. הקובץ לא שונה/);
  assert.match(out, /\| shared: buildSharedGen1\(\{ pkg, require, role: 'remote' \}\),/);
  assert.match(out, /RESULT: BLOCKED\n$/);
  assert.strictEqual(cfg(root), f.input);
});
