'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const childProcess = require('child_process');

const { run, main, diagnose } = require('../scripts/install');

const GIT_ENV = Object.assign({}, process.env, {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1',
});
const g = (cwd, args) => childProcess.execFileSync('git', args, { cwd: cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function repo(opts) {
  opts = opts || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-test-'));
  fs.writeFileSync(path.join(root, 'package.json'), '{ "name": "svc" }\n');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{ "lockfileVersion": 3, "packages": { "": {} } }\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
  fs.mkdirSync(path.join(root, 'node_modules', 'react'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'react', 'index.js'), '');
  if (opts.git !== false) {
    g(root, ['init', '-q']);
    if (opts.commit !== false) { g(root, ['add', '.']); g(root, ['commit', '-q', '-m', 'init']); }
  }
  return root;
}

// fake npm: emits the given chunks (stdout/stderr) then exits with `code`; `hang` never exits
function fakeCp(script) {
  const calls = { spawn: [], killed: 0 };
  return {
    calls: calls,
    cp: {
      execFileSync: childProcess.execFileSync,
      spawnSync: () => { calls.killed++; return {}; },
      spawn: (cmd, args, options) => {
        calls.spawn.push({ cmd: cmd, args: args, options: options, cwd: options.cwd });
        if (script.before) script.before(options.cwd);
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.pid = 4242;
        child.kill = () => { calls.killed++; };
        if (!script.hang) {
          setImmediate(() => {
            (script.out || []).forEach((c) => child[c[0]].emit('data', Buffer.from(c[1])));
            child.emit('close', script.code === undefined ? 0 : script.code);
          });
        }
        return child;
      },
    },
  };
}

const deps = (root, f, extra) => Object.assign({ cwd: root, cp: f.cp, platform: 'linux', env: GIT_ENV }, extra || {});

const SUCCESS = [
  ['stderr', 'npm warn deprecated inflight@1.0.6: This module is not supported\n'],
  ['stderr', 'npm warn ERESOLVE overriding peer dependency\n'],
  ['stdout', '\nadded 1234 packages in 45s\n'],
];

// ---- happy path ----

test('rm node_modules + lock, then npm install without --force / --legacy-peer-deps', async () => {
  const root = repo();
  let seenBeforeInstall = null;
  const f = fakeCp({ out: SUCCESS, before: (cwd) => { seenBeforeInstall = [fs.existsSync(path.join(cwd, 'node_modules')), fs.existsSync(path.join(cwd, 'package-lock.json'))]; } });
  const res = await run([], deps(root, f));
  assert.strictEqual(res.result, 'OK');
  assert.deepStrictEqual(seenBeforeInstall, [false, false]);
  assert.strictEqual(f.calls.spawn.length, 1);
  assert.strictEqual(f.calls.spawn[0].cmd, 'npm');
  assert.deepStrictEqual(f.calls.spawn[0].args, ['install', '--no-audit', '--no-fund']);
  const all = JSON.stringify(f.calls.spawn);
  assert.ok(all.indexOf('--force') === -1 && all.indexOf('--legacy-peer-deps') === -1);
  assert.strictEqual(res.installedPackages, 1234);
  assert.ok(typeof res.durationMs === 'number');
  assert.deepStrictEqual(res.warnings, ['deprecated inflight@1.0.6: This module is not supported', 'ERESOLVE overriding peer dependency']);
  assert.ok(res.notes.some((n) => /peer dependencies/.test(n)));
});

test('output is streamed to stdout before the summary; nothing on stderr', async () => {
  const root = repo();
  const f = fakeCp({ out: SUCCESS });
  const chunks = [];
  let err = '';
  const code = await main([], deps(root, f), { stdout: (s) => chunks.push(s), stderr: (s) => { err += s; } });
  assert.strictEqual(code, 0);
  assert.strictEqual(err, '');
  assert.match(chunks[0], /npm warn deprecated/);
  assert.match(chunks[2], /added 1234 packages/);
  assert.match(chunks[chunks.length - 1], /📦 1234 חבילות[\s\S]*RESULT: OK\n$/);
});

test('--json: no streaming, installedPackages / durationMs / warnings', async () => {
  const root = repo();
  const f = fakeCp({ out: SUCCESS });
  let out = '';
  await main(['--json'], deps(root, f), { stdout: (s) => { out += s; }, stderr: () => {} });
  const res = JSON.parse(out);
  assert.strictEqual(res.installedPackages, 1234);
  assert.ok(res.durationMs >= 0);
  assert.strictEqual(res.warnings.length, 2);
});

test('--dry-run prints the commands, deletes nothing, runs nothing', async () => {
  const root = repo();
  const f = fakeCp({ out: SUCCESS });
  let out = '';
  await main(['--dry-run'], deps(root, f), { stdout: (s) => { out += s; }, stderr: () => {} });
  assert.match(out, /→ rm -rf node_modules\n→ rm -f package-lock\.json\n→ npm install --no-audit --no-fund/);
  assert.strictEqual(f.calls.spawn.length, 0);
  assert.ok(fs.existsSync(path.join(root, 'node_modules', 'react')));
  assert.ok(fs.existsSync(path.join(root, 'package-lock.json')));
});

test('installed count falls back to the new lockfile when npm prints no "added N"', async () => {
  const root = repo();
  const f = fakeCp({
    out: [['stdout', 'up to date in 2s\n']],
    before: (cwd) => fs.writeFileSync(path.join(cwd, 'package-lock.json'), JSON.stringify({ packages: { '': {}, 'node_modules/a': {}, 'node_modules/b': {} } })),
  });
  assert.strictEqual((await run([], deps(root, f))).installedPackages, 2);
});

// ---- precondition ----

test('modified package-lock.json is backed up before deletion – nothing is lost', async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{ "changed": true }\n');
  const res = await run([], deps(root, fakeCp({ out: SUCCESS })));
  assert.strictEqual(res.result, 'OK');
  const backup = res.changes.find((c) => c.rule === 'INSTALL.LOCK_BACKUP').file;
  assert.match(backup, /^\.migration\/backup\/package-lock\.json\.[0-9a-f]{12}\.bak$/);
  assert.strictEqual(fs.readFileSync(path.join(root, backup), 'utf8'), '{ "changed": true }\n');
});

test('rerun after a failed install (lock already deleted) is not blocked', async () => {
  const root = repo();
  const failed = await run([], deps(root, fakeCp({ out: [['stderr', 'npm error code ENOSPC\n']], code: 1 })));
  assert.strictEqual(failed.result, 'BLOCKED');
  assert.ok(!fs.existsSync(path.join(root, 'package-lock.json')));
  const again = await run([], deps(root, fakeCp({ out: SUCCESS })));
  assert.strictEqual(again.result, 'OK');
  assert.ok(!again.changes.some((c) => c.rule === 'INSTALL.LOCK_BACKUP'));
});

test('rerun after a successful install (new untracked lock) is not blocked', async () => {
  const root = repo();
  g(root, ['rm', '-q', '--cached', 'package-lock.json']);
  g(root, ['commit', '-q', '-m', 'untrack lock']);
  const res = await run([], deps(root, fakeCp({ out: SUCCESS })));
  assert.strictEqual(res.result, 'OK');
  assert.ok(res.changes.some((c) => c.rule === 'INSTALL.LOCK_BACKUP'));
});

test('no commits and a dirty tree → BLOCKED', async () => {
  const root = repo({ commit: false });
  const res = await run([], deps(root, fakeCp({ out: SUCCESS })));
  assert.match(res.blockers[0].message, /אין אף commit/);
});

test('not a git repo → BLOCKED', async () => {
  const root = repo({ git: false });
  const res = await run([], deps(root, fakeCp({ out: SUCCESS })));
  assert.match(res.blockers[0].message, /git repo/);
});

test('node_modules tracked by git → BLOCKED', async () => {
  const root = repo({ commit: false });
  fs.writeFileSync(path.join(root, '.gitignore'), '');
  g(root, ['add', '.']);
  g(root, ['commit', '-q', '-m', 'oops']);
  const res = await run([], deps(root, fakeCp({ out: SUCCESS })));
  assert.match(res.blockers[0].message, /node_modules נמצא במעקב git/);
});

test('other uncommitted changes with a last commit → proceeds, with a note', async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'package.json'), '{ "name": "svc", "version": "2.0.0" }\n');
  const res = await run([], deps(root, fakeCp({ out: SUCCESS })));
  assert.strictEqual(res.result, 'OK');
  assert.ok(res.notes.some((n) => /שינויים פתוחים/.test(n)));
});

test('--force / --legacy-peer-deps are rejected as arguments', async () => {
  const root = repo();
  for (const flag of ['--force', '--legacy-peer-deps']) {
    const res = await run([flag], deps(root, fakeCp({ out: SUCCESS })));
    assert.strictEqual(res.result, 'BLOCKED');
    assert.match(res.blockers[0].message, /החלטת אדם/);
  }
});

// ---- failures ----

const ERESOLVE_OUT = (reportPath) => [
  'npm error code ERESOLVE',
  'npm error ERESOLVE unable to resolve dependency tree',
  'npm error',
  'npm error While resolving: hasava-mfe@2.0.0',
  'npm error Found: react@18.3.1',
  'npm error node_modules/react',
  'npm error   react@"^18.3.1" from the root project',
  'npm error',
  'npm error Could not resolve dependency:',
  'npm error peer react@"^16.8.0 || ^17.0.0" from @material-ui/core@4.12.4',
  'npm error node_modules/@material-ui/core',
  'npm error   @material-ui/core@"^4.12.3" from the root project',
  'npm error',
  'npm error Fix the upstream dependency conflict, or retry',
  'npm error this command with --force or --legacy-peer-deps',
  'npm error to accept an incorrect (and potentially broken) dependency resolution.',
  'npm error',
  'npm error For a full report see:',
  'npm error ' + reportPath,
  'npm error A complete log of this run can be found in: /tmp/x-debug-0.log',
  '',
].join('\n');

test('ERESOLVE → BLOCKED with the full conflict tree from eresolve-report.txt, no retry with flags', async () => {
  const root = repo();
  const report = path.join(root, 'x-eresolve-report.txt');
  fs.writeFileSync(report, '# npm resolution error report\n\nWhile resolving: hasava-mfe@2.0.0\nFound: react@18.3.1\n...full tree...\n');
  const f = fakeCp({ out: [['stderr', ERESOLVE_OUT(report)]], code: 1 });
  let out = '';
  await main([], deps(root, f), { stdout: (s) => { out += s; }, stderr: () => {} });
  assert.strictEqual(f.calls.spawn.length, 1);
  assert.match(out, /⛔ ERESOLVE/);
  assert.match(out, /\| \.\.\.full tree\.\.\./);
  assert.match(out, /RESULT: BLOCKED\n$/);
});

test('ERESOLVE without a report file → tree taken from the log lines', () => {
  const d = diagnose(ERESOLVE_OUT('/nope/eresolve-report.txt'), fs);
  assert.strictEqual(d.kind, 'ERESOLVE');
  assert.match(d.tree, /peer react@"\^16\.8\.0 \|\| \^17\.0\.0" from @material-ui\/core@4\.12\.4/);
  assert.match(d.tree, /While resolving: hasava-mfe@2\.0\.0/);
  assert.ok(d.tree.indexOf('--force') === -1);
});

test('real npm 10 ERESOLVE output (captured) → full tree from the log', () => {
  const real = fs.readFileSync(path.join(__dirname, 'fixtures', 'build', 'npm10-eresolve.txt'), 'utf8');
  const d = diagnose(real, { readFileSync: () => { throw new Error('report gone'); } });
  assert.strictEqual(d.kind, 'ERESOLVE');
  assert.match(d.tree, /Found: @babel\/core@8\.0\.6/);
  assert.match(d.tree, /peer @babel\/core@"\^7\.12\.0" from babel-loader@9\.2\.1/);
  assert.match(d.reportPath, /eresolve-report\.txt$/);
});

test('E404 → BLOCKED with the package name', () => {
  const d = diagnose([
    'npm error code E404',
    'npm error 404 Not Found - GET https://nexus.internal/repository/npm/@ips%2fmfe-shared-deps - Not found',
    'npm error 404',
    "npm error 404  '@ips/mfe-shared-deps@^1.4.0' is not in this registry.",
  ].join('\n'), fs);
  assert.strictEqual(d.kind, 'E404');
  assert.strictEqual(d.package, '@ips/mfe-shared-deps@^1.4.0');
  assert.match(d.message, /https:\/\/nexus\.internal/);
});

test('EACCES / ENOSPC (old "npm ERR!" prefix too) → clear messages', () => {
  assert.match(diagnose('npm ERR! code EACCES\nnpm ERR! syscall mkdir\nnpm ERR! path /repo/node_modules/.cache\n', fs).message, /הרשאות.*\/repo\/node_modules\/\.cache/);
  assert.match(diagnose('npm error code ENOSPC\nnpm error syscall write\n', fs).message, /מקום פנוי בדיסק/);
});

test('timeout → process killed, BLOCKED', async () => {
  const root = repo();
  const f = fakeCp({ hang: true });
  const res = await run(['--timeout', '50ms'], deps(root, f));
  assert.strictEqual(res.result, 'BLOCKED');
  assert.strictEqual(res.blockers[0].kind, 'timeout');
  assert.strictEqual(f.calls.killed, 1);
});

test('invalid --timeout → BLOCKED', async () => {
  const res = await run(['--timeout', 'soon'], deps(repo(), fakeCp({})));
  assert.match(res.blockers[0].message, /--timeout/);
});
