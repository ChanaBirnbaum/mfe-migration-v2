'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const { run, main, slugify } = require('../scripts/branch');

const NOW = new Date(2026, 9, 5, 14, 7); // 2026-10-05 14:07 local
const TARGET = 'feature/migration-v2-hasava-mfe-20261005';
const TAG = 'migration-start-20261005-1407';
const SHA = '0123456789abcdef0123456789abcdef01234567';

// ---------------------------------------------------------------------------
// Unit tests – mocked execFileSync

const fail = (status, stderr) => ({ fail: true, status: status, stderr: stderr || '' });

function setup(opts) {
  opts = opts || {};
  const calls = [];
  const localBranches = new Set(opts.localBranches || ['main', 'digital_V2']);
  const tags = new Set(opts.tags || []);
  const responses = Object.assign({
    'rev-parse --is-inside-work-tree': 'true\n',
    'symbolic-ref --short -q HEAD': 'main\n',
    'rev-parse --verify -q HEAD': SHA + '\n',
    'status --porcelain': '',
    'ls-remote --heads origin': 'aaa\trefs/heads/digital_V2\nbbb\trefs/heads/main\n',
    'fetch origin --prune': '',
    'checkout digital_V2': '',
    'pull --ff-only --no-rebase origin digital_V2': '',
    'rev-list --count origin/digital_V2..HEAD': '0\n',
    ['checkout -b ' + TARGET]: '',
    ['tag ' + TAG]: '',
    'checkout main': '',
  }, opts.responses || {});

  const execFileSync = (cmd, args, options) => {
    assert.strictEqual(cmd, 'git');
    assert.ok(Array.isArray(args), 'args must be an array');
    assert.ok(!options.shell, 'shell must not be used');
    calls.push(args);
    const key = args.join(' ');
    let r = responses[key];
    if (r === undefined && args[0] === 'check-ref-format') {
      r = /\s|;|\.\.|^-|~|\^|:/.test(args[2]) ? fail(1) : args[2] + '\n';
    }
    if (r === undefined && args[0] === 'show-ref') {
      const ref = args[3];
      const exists = ref.startsWith('refs/heads/') ? localBranches.has(ref.slice(11)) : tags.has(ref.slice(10));
      r = exists ? '' : fail(1);
    }
    if (r === undefined) r = fail(99, 'unexpected command in test: ' + key);
    if (typeof r === 'object' && r.fail) {
      throw Object.assign(new Error('Command failed: git ' + key), {
        status: r.status === undefined ? 1 : r.status, stderr: r.stderr, stdout: '', code: r.code,
      });
    }
    return r;
  };

  const files = { 'package.json': JSON.stringify({ name: opts.pkgName === undefined ? 'hasava-mfe' : opts.pkgName }) };
  const fsMock = {
    readFileSync: (p) => {
      const base = path.basename(p);
      if (opts.noPkg || !(base in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files[base];
    },
  };
  return { deps: { execFileSync: execFileSync, fs: fsMock, cwd: '/repo', env: {}, now: NOW }, calls: calls };
}

const MUTATING = /^(fetch|checkout|pull|tag|branch|merge|rebase|stash|reset|commit|push)\b/;
const mutating = (calls) => calls.map((a) => a.join(' ')).filter((c) => MUTATING.test(c));
const checks = (res) => res.blockers.map((b) => b.check);

test('happy path: full sequence, derived target, json fields', () => {
  const s = setup();
  const res = run([], s.deps);
  assert.strictEqual(res.result, 'OK');
  assert.deepStrictEqual(mutating(s.calls), [
    'fetch origin --prune',
    'checkout digital_V2',
    'pull --ff-only --no-rebase origin digital_V2',
    'checkout -b ' + TARGET,
    'tag ' + TAG,
  ]);
  assert.strictEqual(res.sourceBranch, 'digital_V2');
  assert.strictEqual(res.targetBranch, TARGET);
  assert.strictEqual(res.tag, TAG);
  assert.strictEqual(res.previousHead, SHA);
  assert.strictEqual(res.previousBranch, 'main');
});

test('already on source → checkout skipped', () => {
  const s = setup({ responses: { 'symbolic-ref --short -q HEAD': 'digital_V2\n' } });
  const res = run([], s.deps);
  assert.strictEqual(res.result, 'OK');
  assert.ok(!mutating(s.calls).includes('checkout digital_V2'));
});

test('source not local → checkout -b --track from origin', () => {
  const s = setup({
    localBranches: ['main'],
    responses: { 'checkout -b digital_V2 --track origin/digital_V2': '' },
  });
  const res = run([], s.deps);
  assert.strictEqual(res.result, 'OK');
  assert.ok(mutating(s.calls).includes('checkout -b digital_V2 --track origin/digital_V2'));
});

test('--source / --target are passed as single array elements', () => {
  const s = setup({
    responses: {
      'ls-remote --heads origin': 'aaa\trefs/heads/release/1\n',
      'checkout release/1': '',
      'pull --ff-only --no-rebase origin release/1': '',
      'rev-list --count origin/release/1..HEAD': '0',
      'checkout -b my/work': '',
    },
    localBranches: ['main', 'release/1'],
  });
  const res = run(['--source', 'release/1', '--target', 'my/work'], s.deps);
  assert.strictEqual(res.result, 'OK');
  assert.ok(s.calls.some((a) => a.length === 3 && a[0] === 'checkout' && a[1] === '-b' && a[2] === 'my/work'));
});

test('dry-run: read-only checks only, prints planned sequence', () => {
  const s = setup();
  let out = '';
  const code = main(['--dry-run'], s.deps, { stdout: (x) => { out += x; }, stderr: () => {} });
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(mutating(s.calls), []);
  assert.match(out, /→ git fetch origin --prune/);
  assert.match(out, /→ git pull --ff-only --no-rebase origin digital_V2/);
  assert.match(out, new RegExp('→ git tag ' + TAG));
  assert.strictEqual(out.trimEnd().split('\n').pop(), 'RESULT: OK');
});

test('hostile --target is rejected, never executed', () => {
  const s = setup();
  const res = run(['--target', 'x; rm -rf /'], s.deps);
  assert.strictEqual(res.result, 'BLOCKED');
  assert.deepStrictEqual(checks(res), ['branch-name']);
  assert.deepStrictEqual(mutating(s.calls), []);
});

// ---- each blocker in isolation ----

test('dirty tree → BLOCKED with files, no stash', () => {
  const s = setup({ responses: { 'status --porcelain': ' M src/App.jsx\n?? x.txt\n' } });
  const res = run([], s.deps);
  assert.deepStrictEqual(checks(res), ['git-clean']);
  assert.deepStrictEqual(res.blockers[0].files, [' M src/App.jsx', '?? x.txt']);
  assert.deepStrictEqual(mutating(s.calls), []);
});

test('target exists locally → BLOCKED with -2 suggestion', () => {
  const s = setup({ localBranches: ['main', 'digital_V2', TARGET] });
  const res = run([], s.deps);
  assert.deepStrictEqual(checks(res), ['target-exists']);
  assert.strictEqual(res.blockers[0].suggestion, TARGET + '-2');
  assert.match(res.blockers[0].message, /--target feature\/migration-v2-hasava-mfe-20261005-2/);
});

test('target and -2 exist → suggestion -3', () => {
  const s = setup({ localBranches: ['main', 'digital_V2', TARGET, TARGET + '-2'] });
  assert.strictEqual(run([], s.deps).blockers[0].suggestion, TARGET + '-3');
});

test('target exists on origin only → BLOCKED', () => {
  const s = setup({ responses: { 'ls-remote --heads origin': 'a\trefs/heads/digital_V2\nb\trefs/heads/' + TARGET + '\n' } });
  const res = run([], s.deps);
  assert.deepStrictEqual(checks(res), ['target-exists']);
  assert.match(res.blockers[0].message, /ב-origin/);
});

test('source missing on origin → BLOCKED', () => {
  const s = setup({ responses: { 'ls-remote --heads origin': 'b\trefs/heads/main\n' } });
  const res = run([], s.deps);
  assert.deepStrictEqual(checks(res), ['source-missing']);
});

test('detached HEAD → BLOCKED', () => {
  const s = setup({ responses: { 'symbolic-ref --short -q HEAD': fail(1) } });
  const res = run([], s.deps);
  assert.deepStrictEqual(checks(res), ['detached-head']);
  assert.strictEqual(res.previousHead, SHA);
});

test('auth failure on ls-remote → BLOCKED kind auth', () => {
  const s = setup({ responses: { 'ls-remote --heads origin': fail(128, "fatal: Authentication failed for 'https://git.internal/x.git/'") } });
  const res = run([], s.deps);
  assert.deepStrictEqual(checks(res), ['origin']);
  assert.strictEqual(res.blockers[0].kind, 'auth');
  assert.match(res.blockers[0].message, /כשל אימות/);
});

test('auth failure on fetch → BLOCKED, nothing else runs', () => {
  const s = setup({ responses: { 'fetch origin --prune': fail(128, 'fatal: could not read Username for \'https://x\': terminal prompts disabled') } });
  const res = run([], s.deps);
  assert.deepStrictEqual(checks(res), ['fetch']);
  assert.strictEqual(res.blockers[0].kind, 'auth');
  assert.deepStrictEqual(mutating(s.calls), ['fetch origin --prune']);
});

test('ls-remote timeout → BLOCKED kind timeout', () => {
  const s = setup({ responses: { 'ls-remote --heads origin': Object.assign(fail(null), { code: 'ETIMEDOUT' }) } });
  const res = run([], s.deps);
  assert.strictEqual(res.blockers[0].kind, 'timeout');
});

test('diverged pull → BLOCKED, no merge/rebase, back to previous branch', () => {
  const s = setup({ responses: { 'pull --ff-only --no-rebase origin digital_V2': fail(128, 'hint: Diverging branches can\'t be fast-forwarded\nfatal: Not possible to fast-forward, aborting.') } });
  const res = run([], s.deps);
  assert.deepStrictEqual(checks(res), ['diverged']);
  assert.deepStrictEqual(mutating(s.calls), [
    'fetch origin --prune',
    'checkout digital_V2',
    'pull --ff-only --no-rebase origin digital_V2',
    'checkout main',
  ]);
});

test('local source ahead of origin → REVIEW', () => {
  const s = setup({ responses: { 'rev-list --count origin/digital_V2..HEAD': '2\n' } });
  const res = run([], s.deps);
  assert.strictEqual(res.result, 'REVIEW');
  assert.match(res.notes.join(' '), /2 קומיטים/);
});

test('not a git repo → BLOCKED', () => {
  const s = setup({ responses: { 'rev-parse --is-inside-work-tree': fail(128, 'fatal: not a git repository') } });
  assert.deepStrictEqual(checks(run([], s.deps)), ['git-repo']);
});

test('no package.json name and no --target → BLOCKED', () => {
  const s = setup({ noPkg: true });
  assert.deepStrictEqual(checks(run([], s.deps)), ['target-name']);
});

test('several problems are reported together', () => {
  const s = setup({
    localBranches: ['main', 'digital_V2', TARGET],
    responses: {
      'symbolic-ref --short -q HEAD': fail(1),
      'status --porcelain': '?? a\n',
      'ls-remote --heads origin': 'b\trefs/heads/main\n',
    },
  });
  assert.deepStrictEqual(checks(run([], s.deps)).sort(), ['detached-head', 'git-clean', 'source-missing', 'target-exists']);
});

test('already on the work branch → NOOP', () => {
  const s = setup({ responses: { 'symbolic-ref --short -q HEAD': TARGET + '\n' } });
  const res = run([], s.deps);
  assert.strictEqual(res.result, 'NOOP');
  assert.deepStrictEqual(mutating(s.calls), []);
});

test('on a derived work branch from an earlier day → NOOP', () => {
  const s = setup({ responses: { 'symbolic-ref --short -q HEAD': 'feature/migration-v2-hasava-mfe-20261001\n' } });
  assert.strictEqual(run([], s.deps).result, 'NOOP');
});

test('crash → exit 1, stderr only', () => {
  let err = '';
  let out = '';
  const code = main([], { execFileSync: null, cwd: '/x' }, { stdout: (x) => { out += x; }, stderr: (x) => { err += x; } });
  assert.strictEqual(code, 1);
  assert.strictEqual(out, '');
  assert.match(err, /branch crashed/);
});

test('slugify', () => {
  assert.strictEqual(slugify('@ips/hasava-mfe'), 'hasava-mfe');
  assert.strictEqual(slugify('My Service!'), 'My-Service');
});

// ---------------------------------------------------------------------------
// Integration tests – real git, local bare "origin"

let hasGit = true;
try { childProcess.execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch (_) { hasGit = false; }

const GIT_ENV = Object.assign({}, process.env, {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C',
});

function g(cwd, args) {
  return childProcess.execFileSync('git', args, { cwd: cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRemoteAndClone() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-test-'));
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const work = path.join(base, 'work');
  g(base, ['init', '--bare', '-b', 'main', origin]);
  g(base, ['clone', '-q', origin, seed]);
  fs.writeFileSync(path.join(seed, 'package.json'), JSON.stringify({ name: '@ips/hasava-mfe' }));
  g(seed, ['add', '.']);
  g(seed, ['commit', '-q', '-m', 'init']);
  g(seed, ['push', '-q', 'origin', 'HEAD:main']);
  g(seed, ['push', '-q', 'origin', 'HEAD:digital_V2']);
  g(base, ['clone', '-q', origin, work]);
  return { base: base, origin: origin, seed: seed, work: work };
}

const realDeps = (cwd) => ({ cwd: cwd, now: NOW, env: Object.assign({}, GIT_ENV, { GIT_TERMINAL_PROMPT: '0' }) });

test('integration: creates branch from up-to-date source + tag', { skip: !hasGit }, () => {
  const r = makeRemoteAndClone();
  // new commit on origin/digital_V2 that the work clone does not have yet
  g(r.seed, ['checkout', '-q', '-b', 'digital_V2']);
  fs.writeFileSync(path.join(r.seed, 'new.txt'), 'x');
  g(r.seed, ['add', '.']);
  g(r.seed, ['commit', '-q', '-m', 'upstream']);
  g(r.seed, ['push', '-q', 'origin', 'digital_V2']);
  const upstreamSha = g(r.seed, ['rev-parse', 'HEAD']);
  const before = g(r.work, ['rev-parse', 'HEAD']);

  const res = run([], realDeps(r.work));
  assert.strictEqual(res.result, 'OK', JSON.stringify(res.blockers));
  assert.strictEqual(res.previousHead, before);
  assert.strictEqual(g(r.work, ['symbolic-ref', '--short', 'HEAD']), TARGET);
  assert.strictEqual(g(r.work, ['rev-parse', 'HEAD']), upstreamSha);
  assert.strictEqual(g(r.work, ['rev-parse', TAG + '^{commit}']), upstreamSha);

  // second run → NOOP
  assert.strictEqual(run([], realDeps(r.work)).result, 'NOOP');
});

test('integration: diverged source → BLOCKED, back on previous branch, nothing created', { skip: !hasGit }, () => {
  const r = makeRemoteAndClone();
  g(r.work, ['checkout', '-q', 'digital_V2']);
  fs.writeFileSync(path.join(r.work, 'local.txt'), 'l');
  g(r.work, ['add', '.']);
  g(r.work, ['commit', '-q', '-m', 'local']);
  g(r.work, ['checkout', '-q', 'main']);

  g(r.seed, ['checkout', '-q', '-b', 'digital_V2']);
  fs.writeFileSync(path.join(r.seed, 'remote.txt'), 'r');
  g(r.seed, ['add', '.']);
  g(r.seed, ['commit', '-q', '-m', 'remote']);
  g(r.seed, ['push', '-q', 'origin', 'digital_V2']);

  const res = run([], realDeps(r.work));
  assert.strictEqual(res.result, 'BLOCKED');
  assert.deepStrictEqual(res.blockers.map((b) => b.check), ['diverged']);
  assert.strictEqual(g(r.work, ['symbolic-ref', '--short', 'HEAD']), 'main');
  assert.strictEqual(g(r.work, ['branch', '--list', TARGET]), '');
  assert.strictEqual(g(r.work, ['tag', '--list', TAG]), '');
});

test('integration: existing local target → BLOCKED with suggestion, dry-run changes nothing', { skip: !hasGit }, () => {
  const r = makeRemoteAndClone();
  g(r.work, ['branch', TARGET]);
  const res = run([], realDeps(r.work));
  assert.deepStrictEqual(res.blockers.map((b) => b.check), ['target-exists']);
  assert.strictEqual(res.blockers[0].suggestion, TARGET + '-2');

  const refsBefore = g(r.work, ['show-ref']);
  const dry = run(['--dry-run', '--target', TARGET + '-2'], realDeps(r.work));
  assert.strictEqual(dry.result, 'OK');
  assert.strictEqual(dry.commands.length, 5);
  assert.strictEqual(g(r.work, ['show-ref']), refsBefore);
  assert.strictEqual(g(r.work, ['symbolic-ref', '--short', 'HEAD']), 'main');
});

test('integration: missing source on origin → BLOCKED', { skip: !hasGit }, () => {
  const r = makeRemoteAndClone();
  const res = run(['--source', 'nope'], realDeps(r.work));
  assert.deepStrictEqual(res.blockers.map((b) => b.check), ['source-missing']);
});
