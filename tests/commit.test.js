'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const { run, main } = require('../scripts/commit');

const GIT_ENV = Object.assign({}, process.env, {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C',
});

function g(cwd, args) {
  return childProcess.execFileSync('git', args, { cwd: cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(root, rel, text) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

// Repo with a bare origin, on a work branch, with one initial commit.
function makeRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-test-'));
  const origin = path.join(base, 'origin.git');
  const work = path.join(base, 'work');
  g(base, ['init', '--bare', '-q', '-b', 'digital_V2', origin]);
  g(base, ['init', '-q', '-b', 'digital_V2', work]);
  g(work, ['remote', 'add', 'origin', origin]);
  write(work, 'package.json', '{ "name": "svc" }\n');
  write(work, 'src/App.jsx', 'export default 1;\n');
  g(work, ['add', '.']);
  g(work, ['commit', '-q', '-m', 'init']);
  g(work, ['push', '-q', 'origin', 'digital_V2']);
  g(work, ['checkout', '-q', '-b', 'feature/migration-v2-svc-20261005']);
  return { work: work, origin: origin };
}

function deps(cwd, calls) {
  return {
    cwd: cwd,
    env: GIT_ENV,
    execFileSync: (cmd, args, options) => {
      assert.strictEqual(cmd, 'git');
      assert.ok(Array.isArray(args));
      assert.ok(!options.shell);
      if (calls) calls.push(args.join(' '));
      return childProcess.execFileSync(cmd, args, options);
    },
  };
}

const lastMessage = (cwd) => g(cwd, ['log', '-1', '--format=%s']);
const commitCount = (cwd) => Number(g(cwd, ['rev-list', '--count', 'HEAD']));

test('commits all changes with the step message and real file count', () => {
  const r = makeRepo();
  write(r.work, 'package.json', '{ "name": "svc", "version": "2.0.0" }\n');
  write(r.work, 'src/App.jsx', 'export default 2;\n');
  write(r.work, 'src/new/Thing.jsx', 'export const t = 1;\n'); // untracked in a new dir
  fs.unlinkSync(path.join(r.work, 'src/App.jsx'));
  write(r.work, 'src/App.jsx', 'export default 3;\n');

  const res = run(['--step', 'mechanical'], deps(r.work));
  assert.strictEqual(res.result, 'OK', JSON.stringify(res.blockers));
  assert.strictEqual(res.filesChanged, 3);
  assert.strictEqual(res.message, 'migration-v2(mechanical): package.json, MUI imports, React 18 (3 files)');
  assert.strictEqual(lastMessage(r.work), res.message);
  assert.strictEqual(res.sha, g(r.work, ['rev-parse', 'HEAD']));
  assert.strictEqual(g(r.work, ['status', '--porcelain']), '');
  assert.deepStrictEqual(res.changes.map((c) => c.file).sort(), ['package.json', 'src/App.jsx', 'src/new/Thing.jsx']);
});

test('each step has its own description', () => {
  const r = makeRepo();
  write(r.work, 'webpack.config.js', 'module.exports = {};\n');
  assert.strictEqual(run(['--step', 'infra'], deps(r.work)).message,
    'migration-v2(infra): styles, useSharedState, webpack federation (1 files)');
  write(r.work, 'src/fix.js', 'x\n');
  assert.strictEqual(run(['--step=build-fixes'], deps(r.work)).message,
    'migration-v2(build-fixes): build error fixes (1 files)');
});

test('deleted and renamed files are counted', () => {
  const r = makeRepo();
  g(r.work, ['mv', 'src/App.jsx', 'src/Main.jsx']);
  fs.unlinkSync(path.join(r.work, 'package.json'));
  const res = run(['--step', 'mechanical'], deps(r.work));
  assert.strictEqual(res.result, 'OK');
  assert.strictEqual(res.filesChanged, Number(g(r.work, ['diff', '--name-only', 'HEAD~1', 'HEAD']).split('\n').length));
});

test('no changes → NOOP, no commit; second run after a commit → NOOP', () => {
  const r = makeRepo();
  const before = commitCount(r.work);
  let out = '';
  const code = main(['--step', 'mechanical'], deps(r.work), { stdout: (s) => { out += s; }, stderr: () => {} });
  assert.strictEqual(code, 0);
  assert.strictEqual(out.trimEnd().split('\n').pop(), 'RESULT: NOOP');
  assert.strictEqual(commitCount(r.work), before);

  write(r.work, 'a.txt', 'a');
  assert.strictEqual(run(['--step', 'mechanical'], deps(r.work)).result, 'OK');
  assert.strictEqual(run(['--step', 'mechanical'], deps(r.work)).result, 'NOOP');
});

test('.migration/ is never committed', () => {
  const r = makeRepo();
  write(r.work, '.migration/inventory.json', '{}');
  assert.strictEqual(run(['--step', 'mechanical'], deps(r.work)).result, 'NOOP');
  write(r.work, 'src/x.js', 'x');
  const res = run(['--step', 'mechanical'], deps(r.work));
  assert.strictEqual(res.filesChanged, 1);
  assert.strictEqual(g(r.work, ['ls-files', '.migration']), '');
});

test('--dry-run: correct count and message, index and HEAD untouched', () => {
  const r = makeRepo();
  write(r.work, 'src/App.jsx', 'changed\n');
  write(r.work, 'src/B.jsx', 'new\n');
  g(r.work, ['add', 'src/App.jsx']); // partially staged state must survive
  const statusBefore = g(r.work, ['status', '--porcelain']);
  const headBefore = g(r.work, ['rev-parse', 'HEAD']);

  const res = run(['--step', 'mechanical', '--dry-run'], deps(r.work));
  assert.strictEqual(res.result, 'OK');
  assert.strictEqual(res.filesChanged, 2);
  assert.strictEqual(res.sha, null);
  assert.match(res.message, /\(2 files\)$/);
  assert.strictEqual(g(r.work, ['status', '--porcelain']), statusBefore);
  assert.strictEqual(g(r.work, ['rev-parse', 'HEAD']), headBefore);
});

test('never pushes; origin unchanged', () => {
  const r = makeRepo();
  const originBefore = g(r.origin, ['show-ref']);
  write(r.work, 'src/x.js', 'x');
  const calls = [];
  run(['--step', 'mechanical'], deps(r.work, calls));
  assert.ok(calls.length > 0);
  assert.ok(!calls.some((c) => /^push\b/.test(c)), calls.join('\n'));
  assert.strictEqual(g(r.origin, ['show-ref']), originBefore);
});

test('--json returns sha, step, filesChanged, message', () => {
  const r = makeRepo();
  write(r.work, 'src/x.js', 'x');
  let out = '';
  main(['--step', 'infra', '--json'], deps(r.work), { stdout: (s) => { out += s; }, stderr: () => {} });
  const res = JSON.parse(out);
  assert.strictEqual(res.step, 'infra');
  assert.strictEqual(res.filesChanged, 1);
  assert.match(res.sha, /^[0-9a-f]{40}$/);
  assert.match(res.message, /^migration-v2\(infra\)/);
});

// ---- blockers ----

const check = (res) => res.blockers.map((b) => b.check);

test('missing / invalid --step → BLOCKED', () => {
  const r = makeRepo();
  assert.deepStrictEqual(check(run([], deps(r.work))), ['step']);
  assert.deepStrictEqual(check(run(['--step', 'all'], deps(r.work))), ['step']);
});

test('protected branch → BLOCKED', () => {
  const r = makeRepo();
  g(r.work, ['checkout', '-q', 'digital_V2']);
  write(r.work, 'src/x.js', 'x');
  assert.deepStrictEqual(check(run(['--step', 'mechanical'], deps(r.work))), ['protected-branch']);
  assert.notStrictEqual(g(r.work, ['status', '--porcelain']), '');
});

test('detached HEAD → BLOCKED', () => {
  const r = makeRepo();
  g(r.work, ['checkout', '-q', '--detach']);
  write(r.work, 'src/x.js', 'x');
  assert.deepStrictEqual(check(run(['--step', 'mechanical'], deps(r.work))), ['detached-head']);
});

test('unresolved conflict → BLOCKED, conflict not staged as resolved', () => {
  const r = makeRepo();
  g(r.work, ['checkout', '-q', '-b', 'other']);
  write(r.work, 'src/App.jsx', 'other\n');
  g(r.work, ['commit', '-q', '-am', 'other']);
  g(r.work, ['checkout', '-q', 'feature/migration-v2-svc-20261005']);
  write(r.work, 'src/App.jsx', 'mine\n');
  g(r.work, ['commit', '-q', '-am', 'mine']);
  try { g(r.work, ['merge', 'other']); } catch (_) { /* conflict expected */ }

  const res = run(['--step', 'mechanical'], deps(r.work));
  assert.deepStrictEqual(check(res).sort(), ['conflicts', 'operation-in-progress']);
  assert.deepStrictEqual(res.blockers.find((b) => b.check === 'conflicts').files, ['src/App.jsx']);
  assert.match(g(r.work, ['status', '--porcelain']), /^UU src\/App\.jsx/m);
});

test('failing pre-commit hook → BLOCKED, changes stay staged', () => {
  const r = makeRepo();
  write(r.work, '.git/hooks/pre-commit', '#!/bin/sh\necho "lint failed" >&2\nexit 1\n');
  fs.chmodSync(path.join(r.work, '.git/hooks/pre-commit'), 0o755);
  write(r.work, 'src/x.js', 'x');
  const before = commitCount(r.work);
  const res = run(['--step', 'mechanical'], deps(r.work));
  assert.deepStrictEqual(check(res), ['commit']);
  assert.match(res.blockers[0].message, /lint failed/);
  assert.strictEqual(commitCount(r.work), before);
  assert.match(g(r.work, ['status', '--porcelain']), /^A  src\/x\.js/m);
});

test('not a git repo → BLOCKED', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-test-'));
  assert.deepStrictEqual(check(run(['--step', 'mechanical'], deps(dir))), ['git-repo']);
});

test('crash → exit 1, stderr only', () => {
  let out = '';
  let err = '';
  const code = main(['--step', 'mechanical'], { execFileSync: null }, { stdout: (s) => { out += s; }, stderr: (s) => { err += s; } });
  assert.strictEqual(code, 1);
  assert.strictEqual(out, '');
  assert.match(err, /commit crashed/);
});
