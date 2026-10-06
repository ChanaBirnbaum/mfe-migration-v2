'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { runPreflight, main, formatText, targetSpecs, loadTargets, exactVersion } = require('../scripts/preflight');

const CWD = path.resolve('/repo/hasava-mfe');
const PKG_PATH = path.join(CWD, 'package.json');
const HANG = Symbol('hang');

const ok = (stdout) => ({ stdout: stdout || '' });
const fail = (code, stderr) => ({ err: Object.assign(new Error('Command failed'), { code: code }), stderr: stderr || '' });

const SPECS = targetSpecs(loadTargets());
const viewKey = (s) => 'npm view ' + (s.version ? s.name + '@' + s.version : s.name) + ' version';

function baseResponses() {
  const r = {
    'git rev-parse --is-inside-work-tree': ok('true\n'),
    'git symbolic-ref --short -q HEAD': ok('feature/migrate\n'),
    'git rev-parse --short HEAD': ok('abc1234\n'),
    'git status --porcelain': ok(''),
    'git ls-remote --heads origin digital_V2': ok('deadbeef\trefs/heads/digital_V2\n'),
    'npm --version': ok('10.8.2\n'),
    'npm config get registry': ok('https://nexus.internal/repository/npm/\n'),
    'npm ping': ok(''),
  };
  SPECS.forEach((s) => { r[viewKey(s)] = ok((s.version || '1.4.0') + '\n'); });
  return r;
}

const BASE_PKG = {
  name: 'hasava-mfe',
  version: '0.1.1',
  dependencies: { react: '^17.0.2', 'react-dom': '^17.0.2' },
  devDependencies: { react: '^17.0.2' },
};

function setup(opts) {
  opts = opts || {};
  const responses = Object.assign(baseResponses(), opts.responses || {});
  const calls = [];
  const killed = [];
  const writes = [];

  const execFile = (cmd, args, options, cb) => {
    const key = [cmd].concat(args).join(' ');
    calls.push(key);
    const child = { kill: () => killed.push(key) };
    const r = responses[key];
    if (r === HANG) return child;
    setImmediate(() => {
      if (r === undefined) return cb(Object.assign(new Error('unexpected command: ' + key), { code: 127 }), '', '');
      if (r.err) return cb(r.err, r.stdout || '', r.stderr || '');
      cb(null, r.stdout, '');
    });
    return child;
  };

  const files = {};
  if (opts.pkg !== null) files[PKG_PATH] = typeof opts.pkg === 'string' ? opts.pkg : JSON.stringify(opts.pkg || BASE_PKG);
  const fs = {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => {
      if (!(p in files)) throw Object.assign(new Error('ENOENT: ' + p), { code: 'ENOENT' });
      return files[p];
    },
    writeFileSync: (p) => writes.push(p),
    mkdirSync: (p) => writes.push(p),
    unlinkSync: (p) => writes.push(p),
  };

  const deps = {
    execFile: execFile,
    fs: fs,
    cwd: CWD,
    env: {},
    platform: 'linux',
    nodeVersion: opts.nodeVersion || '18.20.4',
    networkTimeoutMs: 40,
    localTimeoutMs: 40,
  };
  return { deps: deps, calls: calls, killed: killed, writes: writes };
}

const blockerIds = (res) => res.blockers.map((b) => b.check);
const checkById = (res, id) => res.checks.find((c) => c.id === id);

test('clean environment → OK, no blockers, nothing written', async () => {
  const s = setup();
  const res = await runPreflight({}, s.deps);
  assert.strictEqual(res.result, 'OK');
  assert.deepStrictEqual(res.blockers, []);
  assert.deepStrictEqual(s.writes, []);
  assert.deepStrictEqual(res.checks.map((c) => c.status), Array(res.checks.length).fill('ok'));
  assert.deepStrictEqual(res.checks.map((c) => c.id),
    ['git-repo', 'git-branch', 'git-clean', 'package-json', 'node', 'npm-ping', 'target-versions', 'remote-branch']);
});

test('only read-only commands are executed', async () => {
  const s = setup();
  await runPreflight({}, s.deps);
  const allowed = /^(git (rev-parse|symbolic-ref|status --porcelain|ls-remote)|npm (--version|config get|ping|view))/;
  s.calls.forEach((c) => assert.match(c, allowed, 'unexpected command ' + c));
});

test('all target versions are queried with the exact version', async () => {
  const s = setup();
  await runPreflight({}, s.deps);
  [
    'npm view react@18.3.1 version',
    'npm view react-dom@18.3.1 version',
    'npm view react-router-dom@6.30.1 version',
    'npm view @mui/material@7.3.11 version',
    'npm view @mui/icons-material@7.3.11 version',
    'npm view @mui/x-date-pickers@9.3.0 version',
    'npm view @emotion/react@11.14.0 version',
    'npm view @emotion/styled@11.11.0 version',
    'npm view @ips/mfe-shared-deps version',
  ].forEach((k) => assert.ok(s.calls.indexOf(k) !== -1, 'missing ' + k));
});

test('environment fields in --json output', async () => {
  const s = setup();
  let out = '';
  const code = await main(['--json'], s.deps, { stdout: (x) => { out += x; }, stderr: () => {} });
  assert.strictEqual(code, 0);
  const res = JSON.parse(out);
  assert.deepStrictEqual(res.environment, {
    nodeVersion: '18.20.4',
    npmVersion: '10.8.2',
    registryUrl: 'https://nexus.internal/repository/npm/',
    currentBranch: 'feature/migrate',
    serviceName: 'hasava-mfe',
  });
  assert.deepStrictEqual(Object.keys(res).slice(0, 6), ['script', 'result', 'changes', 'manual', 'blockers', 'notes']);
});

// ---- each blocker in isolation ----

test('not a git repo → git-repo blocker only, dependent git checks skipped', async () => {
  const s = setup({ responses: { 'git rev-parse --is-inside-work-tree': fail(128, 'fatal: not a git repository') } });
  const res = await runPreflight({}, s.deps);
  assert.strictEqual(res.result, 'BLOCKED');
  assert.deepStrictEqual(blockerIds(res), ['git-repo']);
  ['git-branch', 'git-clean', 'remote-branch'].forEach((id) => {
    assert.strictEqual(checkById(res, id).status, 'warn');
    assert.strictEqual(checkById(res, id).skipped, true);
  });
});

test('git not installed → git-repo blocker with clear message', async () => {
  const s = setup({ responses: { 'git rev-parse --is-inside-work-tree': { err: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) } } });
  const res = await runPreflight({}, s.deps);
  assert.deepStrictEqual(blockerIds(res), ['git-repo']);
  assert.match(res.blockers[0].message, /PATH/);
});

test('detached HEAD → git-branch blocker', async () => {
  const s = setup({ responses: { 'git symbolic-ref --short -q HEAD': fail(1) } });
  const res = await runPreflight({}, s.deps);
  assert.deepStrictEqual(blockerIds(res), ['git-branch']);
  assert.strictEqual(res.blockers[0].detached, true);
  assert.match(res.blockers[0].message, /detached.*abc1234/);
  assert.strictEqual(res.environment.currentBranch, null);
});

test('dirty working tree → git-clean blocker listing every file', async () => {
  const porcelain = ' M src/App.jsx\nM  package.json\n?? notes.txt\n';
  const s = setup({ responses: { 'git status --porcelain': ok(porcelain) } });
  const res = await runPreflight({}, s.deps);
  assert.deepStrictEqual(blockerIds(res), ['git-clean']);
  // leading space of the status code must be preserved
  assert.deepStrictEqual(res.blockers[0].files, [' M src/App.jsx', 'M  package.json', '?? notes.txt']);
});

test('package.json missing → package-json blocker', async () => {
  const s = setup({ pkg: null });
  const res = await runPreflight({}, s.deps);
  assert.deepStrictEqual(blockerIds(res), ['package-json']);
  assert.strictEqual(res.environment.serviceName, null);
});

test('package.json invalid JSON → package-json blocker', async () => {
  const s = setup({ pkg: '{ "name": "x", ' });
  const res = await runPreflight({}, s.deps);
  assert.deepStrictEqual(blockerIds(res), ['package-json']);
  assert.match(res.blockers[0].message, /JSON/);
});

test('react only in devDependencies → package-json blocker', async () => {
  const s = setup({ pkg: { name: 'svc', dependencies: { rxjs: '^7' }, devDependencies: { react: '^17.0.2' } } });
  const res = await runPreflight({}, s.deps);
  assert.deepStrictEqual(blockerIds(res), ['package-json']);
  assert.match(res.blockers[0].message, /devDependencies/);
  assert.strictEqual(res.environment.serviceName, 'svc');
});

test('react already 18 → warning, not a blocker', async () => {
  const s = setup({ pkg: { name: 'svc', dependencies: { react: '^18.3.1' } } });
  const res = await runPreflight({}, s.deps);
  assert.strictEqual(res.result, 'OK');
  assert.strictEqual(checkById(res, 'package-json').status, 'warn');
  assert.strictEqual(res.notes.length, 1);
});

test('Node < 18 → node blocker', async () => {
  const s = setup({ nodeVersion: '16.20.2' });
  const res = await runPreflight({}, s.deps);
  assert.deepStrictEqual(blockerIds(res), ['node']);
});

test('npm ping fails → npm-ping blocker, versions skipped', async () => {
  const s = setup({ responses: { 'npm ping': fail(1, 'npm ERR! code ECONNREFUSED') } });
  const res = await runPreflight({}, s.deps);
  assert.deepStrictEqual(blockerIds(res), ['npm-ping']);
  assert.match(res.blockers[0].message, /ECONNREFUSED/);
  assert.strictEqual(checkById(res, 'target-versions').skipped, true);
  assert.ok(!s.calls.some((c) => c.indexOf('npm view') === 0));
});

test('npm ping timeout → npm-ping blocker flagged as timeout, process killed', async () => {
  const s = setup({ responses: { 'npm ping': HANG } });
  const res = await runPreflight({}, s.deps);
  assert.deepStrictEqual(blockerIds(res), ['npm-ping']);
  assert.strictEqual(res.blockers[0].timeout, true);
  assert.match(res.blockers[0].message, /לא הגיב תוך/);
  assert.deepStrictEqual(s.killed, ['npm ping']);
});

test('missing exact version (npm view prints nothing) → one blocker for that package', async () => {
  const s = setup({ responses: { 'npm view @mui/material@7.3.11 version': ok('') } });
  const res = await runPreflight({}, s.deps);
  assert.deepStrictEqual(blockerIds(res), ['target-versions']);
  assert.strictEqual(res.blockers[0].package, '@mui/material');
  assert.strictEqual(res.blockers[0].version, '7.3.11');
});

test('package not in registry (E404) → blocker per package', async () => {
  const s = setup({
    responses: {
      'npm view @ips/mfe-shared-deps version': fail(1, 'npm ERR! code E404\nnpm ERR! 404 Not Found'),
      'npm view @emotion/styled@11.11.0 version': fail(1, 'npm ERR! code E404'),
    },
  });
  const res = await runPreflight({}, s.deps);
  assert.deepStrictEqual(res.blockers.map((b) => b.package).sort(), ['@emotion/styled', '@ips/mfe-shared-deps']);
  res.blockers.forEach((b) => assert.match(b.message, /לא נמצאה/));
});

test('npm view timeout → blocker flagged as timeout', async () => {
  const s = setup({ responses: { 'npm view react-dom@18.3.1 version': HANG } });
  const res = await runPreflight({}, s.deps);
  assert.deepStrictEqual(blockerIds(res), ['target-versions']);
  assert.strictEqual(res.blockers[0].package, 'react-dom');
  assert.strictEqual(res.blockers[0].timeout, true);
});

test('digital_V2 missing on origin → remote-branch blocker', async () => {
  const s = setup({ responses: { 'git ls-remote --heads origin digital_V2': ok('') } });
  const res = await runPreflight({}, s.deps);
  assert.deepStrictEqual(blockerIds(res), ['remote-branch']);
});

test('only a suffix match (refs/heads/old/digital_V2) → remote-branch blocker', async () => {
  const s = setup({ responses: { 'git ls-remote --heads origin digital_V2': ok('aaa\trefs/heads/old/digital_V2\n') } });
  const res = await runPreflight({}, s.deps);
  assert.deepStrictEqual(blockerIds(res), ['remote-branch']);
});

test('no origin remote → remote-branch blocker', async () => {
  const s = setup({ responses: { 'git ls-remote --heads origin digital_V2': fail(128, "fatal: 'origin' does not appear to be a git repository") } });
  const res = await runPreflight({}, s.deps);
  assert.deepStrictEqual(blockerIds(res), ['remote-branch']);
  assert.match(res.blockers[0].message, /origin/);
});

test('git ls-remote timeout → remote-branch blocker flagged as timeout', async () => {
  const s = setup({ responses: { 'git ls-remote --heads origin digital_V2': HANG } });
  const res = await runPreflight({}, s.deps);
  assert.deepStrictEqual(blockerIds(res), ['remote-branch']);
  assert.strictEqual(res.blockers[0].timeout, true);
});

// ---- aggregation and contract ----

test('multiple failures are all reported together', async () => {
  const s = setup({
    nodeVersion: '16.0.0',
    pkg: null,
    responses: {
      'git symbolic-ref --short -q HEAD': fail(1),
      'git status --porcelain': ok(' M a.js\n'),
      'npm view react@18.3.1 version': ok(''),
      'git ls-remote --heads origin digital_V2': ok(''),
    },
  });
  const res = await runPreflight({}, s.deps);
  assert.deepStrictEqual(blockerIds(res),
    ['git-branch', 'git-clean', 'package-json', 'node', 'target-versions', 'remote-branch']);
});

test('text output: one symbol line per check, RESULT is last line', async () => {
  const s = setup({ responses: { 'git status --porcelain': ok('?? x\n') } });
  let out = '';
  const code = await main([], s.deps, { stdout: (x) => { out += x; }, stderr: () => {} });
  assert.strictEqual(code, 0);
  const lines = out.trimEnd().split('\n');
  assert.strictEqual(lines[lines.length - 1], 'RESULT: BLOCKED');
  assert.match(out, /^⛔ עץ עבודה נקי/m);
  assert.match(out, /^✓ git repo/m);
});

test('BLOCKED still exits 0; --dry-run is accepted and noted', async () => {
  const s = setup({ nodeVersion: '14.0.0' });
  let out = '';
  const code = await main(['--dry-run'], s.deps, { stdout: (x) => { out += x; }, stderr: () => {} });
  assert.strictEqual(code, 0);
  assert.match(out, /RESULT: BLOCKED\n$/);
  assert.match(out, /dry-run/);
});

test('unexpected crash → exit 1 and message on stderr only', async () => {
  const s = setup();
  s.deps.fs = null;
  let out = '';
  let err = '';
  const code = await main([], s.deps, { stdout: (x) => { out += x; }, stderr: (x) => { err += x; } });
  assert.strictEqual(code, 1);
  assert.strictEqual(out, '');
  assert.match(err, /preflight crashed/);
});

test('exactVersion strips range operators', () => {
  assert.strictEqual(exactVersion('^18.3.1'), '18.3.1');
  assert.strictEqual(exactVersion('~11.11.0'), '11.11.0');
  assert.strictEqual(exactVersion('*'), null);
});

test('formatText survives skipped checks', async () => {
  const s = setup({ responses: { 'git rev-parse --is-inside-work-tree': fail(128) } });
  const res = await runPreflight({}, s.deps);
  assert.match(formatText(res), /^⚠ /m);
});
