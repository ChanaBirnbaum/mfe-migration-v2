'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const { run, main } = require('../scripts/branch');

const NOW = new Date(2026, 9, 5, 14, 7); // 2026-10-05 14:07 local
const SOURCE = 'develop';
const TARGET = 'digital_V2';
const TAG = 'migration-start-20261005-1407';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const TARGET_TIP = '89abcdef0123456789abcdef0123456789abcdef';

// ---------------------------------------------------------------------------
// Unit tests – mocked execFileSync

const fail = (status, stderr) => ({ fail: true, status: status, stderr: stderr || '' });

function setup(opts) {
  opts = opts || {};
  const calls = [];
  const localBranches = new Set(opts.localBranches || ['main', SOURCE]);
  // refs: { 'refs/tags/x': sha, 'refs/heads/develop': sha, HEAD: sha } → answers rev-parse --verify -q <ref>^{commit}
  const refs = opts.refs || {};
  const responses = Object.assign({
    'rev-parse --is-inside-work-tree': 'true\n',
    'symbolic-ref --short -q HEAD': SOURCE + '\n',
    'rev-parse --verify -q HEAD': SHA + '\n',
    'status --porcelain': '',
    'config --get remote.origin.url': 'git@git.internal:svc/hasava-mfe.git\n',
    'ls-remote --heads origin': 'aaa\trefs/heads/' + SOURCE + '\nbbb\trefs/heads/main\n',
    ['rev-parse --abbrev-ref --symbolic-full-name ' + SOURCE + '@{upstream}']: 'origin/' + SOURCE + '\n',
    'rev-parse --abbrev-ref --symbolic-full-name main@{upstream}': 'origin/main\n',
    'fetch origin --prune': '',
    'checkout main': '',
    ['checkout ' + SOURCE]: '',
    'pull --ff-only --no-rebase': '',
    'rev-list --count @{upstream}..HEAD': '0\n',
    ['checkout -b ' + TARGET]: '',
    ['tag ' + TAG]: '',
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
      r = localBranches.has(args[3].replace(/^refs\/heads\//, '')) ? '' : fail(1);
    }
    if (r === undefined && args[0] === 'rev-parse' && args[1] === '--verify' && /\^\{commit\}$/.test(args[3] || '')) {
      const ref = args[3].replace(/\^\{commit\}$/, '');
      r = refs[ref] ? refs[ref] + '\n' : fail(1);
    }
    if (r === undefined) r = fail(99, 'unexpected command in test: ' + key);
    if (typeof r === 'object' && r.fail) {
      throw Object.assign(new Error('Command failed: git ' + key), {
        status: r.status === undefined ? 1 : r.status, stderr: r.stderr, stdout: '', code: r.code,
      });
    }
    return r;
  };

  const deps = { execFileSync: execFileSync, cwd: '/repo', env: {}, now: NOW };
  if (opts.config) deps.config = opts.config;
  return { deps: deps, calls: calls };
}

const MUTATING = /^(fetch|checkout|pull|tag|branch|merge|rebase|stash|reset|commit|push)\b/;
const mutating = (calls) => calls.map((a) => a.join(' ')).filter((c) => MUTATING.test(c) && !/^tag --list\b/.test(c));
const checks = (res) => res.blockers.map((b) => b.check);

test('happy path: current branch → digital_V2, json fields', () => {
  const s = setup();
  const res = run([], s.deps);
  assert.strictEqual(res.result, 'OK');
  assert.deepStrictEqual(mutating(s.calls), [
    'fetch origin --prune',
    'pull --ff-only --no-rebase',
    'checkout -b ' + TARGET,
    'tag ' + TAG,
  ]);
  assert.strictEqual(res.sourceBranch, SOURCE);
  assert.strictEqual(res.targetBranch, TARGET);
  assert.strictEqual(res.upstream, 'origin/' + SOURCE);
  assert.strictEqual(res.tag, TAG);
  assert.strictEqual(res.previousHead, SHA);
  assert.strictEqual(res.previousBranch, SOURCE);
  assert.match(res.notes.join(' '), /Already on develop – skipping checkout/);
});

test('defaults come from reference/commit-steps.json', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'reference', 'commit-steps.json'), 'utf8'));
  assert.strictEqual(cfg.defaultTarget, 'digital_V2');
  assert.strictEqual(cfg.defaultSource, null);
  assert.ok(cfg.protectedBranches.indexOf('digital_V2') === -1);

  const s = setup({ config: { defaultTarget: 'gen2', defaultSource: 'main' }, responses: { 'checkout -b gen2': '' } });
  const res = run([], s.deps);
  assert.strictEqual(res.result, 'OK', JSON.stringify(res.blockers));
  assert.strictEqual(res.sourceBranch, 'main');
  assert.strictEqual(res.targetBranch, 'gen2');
  assert.deepStrictEqual(mutating(s.calls), ['fetch origin --prune', 'checkout main', 'pull --ff-only --no-rebase', 'checkout -b gen2', 'tag ' + TAG]);
});

test('config without defaultTarget and no --target → BLOCKED', () => {
  const s = setup({ config: { defaultTarget: null, defaultSource: null } });
  const res = run([], s.deps);
  assert.deepStrictEqual(checks(res), ['target-name']);
  assert.deepStrictEqual(s.calls, []);
});

test('--source: checkout the source, pull, then branch off it', () => {
  const s = setup({ responses: { 'symbolic-ref --short -q HEAD': 'main\n' } });
  const res = run(['--source', SOURCE], s.deps);
  assert.strictEqual(res.result, 'OK');
  assert.deepStrictEqual(mutating(s.calls), [
    'fetch origin --prune',
    'checkout ' + SOURCE,
    'pull --ff-only --no-rebase',
    'checkout -b ' + TARGET,
    'tag ' + TAG,
  ]);
  assert.strictEqual(res.previousBranch, 'main');
});

test('source not local but on origin → checkout -b --track from origin', () => {
  const s = setup({
    localBranches: ['main'],
    responses: {
      'symbolic-ref --short -q HEAD': 'main\n',
      ['checkout -b ' + SOURCE + ' --track origin/' + SOURCE]: '',
    },
  });
  const res = run(['--source', SOURCE], s.deps);
  assert.strictEqual(res.result, 'OK');
  assert.strictEqual(res.upstream, 'origin/' + SOURCE);
  assert.ok(mutating(s.calls).includes('checkout -b ' + SOURCE + ' --track origin/' + SOURCE));
});

test('source without upstream → pull skipped with a note, still OK', () => {
  const s = setup({ responses: { ['rev-parse --abbrev-ref --symbolic-full-name ' + SOURCE + '@{upstream}']: fail(128, 'fatal: no upstream configured for branch \'develop\'') } });
  const res = run([], s.deps);
  assert.strictEqual(res.result, 'OK');
  assert.strictEqual(res.upstream, null);
  assert.deepStrictEqual(mutating(s.calls), ['fetch origin --prune', 'checkout -b ' + TARGET, 'tag ' + TAG]);
  assert.match(res.notes.join(' '), /has no upstream – skipping git pull/);
});

test('no origin at all → fetch and pull skipped with a note, target created locally → OK', () => {
  const s = setup({
    responses: {
      'config --get remote.origin.url': fail(1),
      'ls-remote --heads origin': fail(128, "fatal: 'origin' does not appear to be a git repository"),
    },
  });
  const res = run([], s.deps);
  assert.strictEqual(res.result, 'OK', JSON.stringify(res.blockers));
  assert.deepStrictEqual(mutating(s.calls), ['checkout -b ' + TARGET, 'tag ' + TAG]);
  assert.ok(!s.calls.some((a) => a[0] === 'ls-remote'), 'no network call without origin');
  assert.match(res.notes.join(' '), /No remote named origin – skipping fetch and pull/);
});

test('no origin + digital_V2 exists locally without a tag, HEAD elsewhere → adopt: checkout + tag, no fetch', () => {
  const s = setup({
    localBranches: ['main', SOURCE, TARGET],
    responses: {
      'config --get remote.origin.url': fail(1),
      ['checkout ' + TARGET]: '',
      'tag --list migration-start-* --merged HEAD': '',
      ['tag ' + TAG + ' HEAD']: '',
    },
    refs: { HEAD: TARGET_TIP },
  });
  const res = run([], s.deps);
  assert.strictEqual(res.result, 'OK', JSON.stringify(res.blockers));
  assert.strictEqual(res.targetMode, 'adopt');
  assert.deepStrictEqual(mutating(s.calls), ['checkout ' + TARGET, 'tag ' + TAG + ' HEAD']);
});

test('no origin + missing source → BLOCKED suggesting --source', () => {
  const s = setup({ responses: { 'symbolic-ref --short -q HEAD': 'main\n', 'config --get remote.origin.url': fail(1) } });
  const res = run(['--source', 'nope'], s.deps);
  assert.deepStrictEqual(checks(res), ['source-missing']);
  assert.match(res.blockers[0].message, /--source/);
});

// ---- tag name already taken (same minute) ----

test('tag exists and points at the source tip → reused with a note, not recreated → OK', () => {
  const s = setup({ refs: { ['refs/tags/' + TAG]: SHA, ['refs/heads/' + SOURCE]: SHA, HEAD: SHA } });
  const res = run([], s.deps);
  assert.strictEqual(res.result, 'OK', JSON.stringify(res.blockers));
  assert.deepStrictEqual(mutating(s.calls), ['fetch origin --prune', 'pull --ff-only --no-rebase', 'checkout -b ' + TARGET]);
  assert.strictEqual(res.tag, TAG);
  assert.match(res.notes.join(' '), /already exists and points to the same commit .* reusing it/);
});

test('tag exists and points elsewhere → BLOCKED "wait a minute", nothing runs', () => {
  const s = setup({ refs: { ['refs/tags/' + TAG]: 'f'.repeat(40), ['refs/heads/' + SOURCE]: SHA } });
  const res = run([], s.deps);
  assert.deepStrictEqual(checks(res), ['tag-exists']);
  assert.match(res.blockers[0].message, /wait a minute/);
  assert.deepStrictEqual(mutating(s.calls), []);
});

test('tag matched before pull but pull moved the source → BLOCKED before creating the branch, back to previous', () => {
  const s = setup({
    responses: { 'symbolic-ref --short -q HEAD': 'main\n' },
    refs: { ['refs/tags/' + TAG]: SHA, ['refs/heads/' + SOURCE]: SHA, HEAD: 'e'.repeat(40) },
  });
  const res = run(['--source', SOURCE], s.deps);
  assert.deepStrictEqual(checks(res), ['tag-exists']);
  assert.deepStrictEqual(mutating(s.calls), ['fetch origin --prune', 'checkout ' + SOURCE, 'pull --ff-only --no-rebase', 'checkout main']);
});

test('--target / --source are passed as single array elements', () => {
  const s = setup({
    responses: {
      'ls-remote --heads origin': 'aaa\trefs/heads/release/1\n',
      'rev-parse --abbrev-ref --symbolic-full-name release/1@{upstream}': 'origin/release/1\n',
      'config --get branch.release/1.remote': 'origin\n',
      'checkout release/1': '',
      'checkout -b my/work': '',
    },
    localBranches: ['main', 'release/1'],
  });
  const res = run(['--source', 'release/1', '--target', 'my/work'], s.deps);
  assert.strictEqual(res.result, 'OK', JSON.stringify(res.blockers));
  assert.ok(s.calls.some((a) => a.length === 3 && a[0] === 'checkout' && a[1] === '-b' && a[2] === 'my/work'));
  assert.ok(s.calls.some((a) => a.length === 2 && a[0] === 'checkout' && a[1] === 'release/1'));
});

test('dry-run: read-only checks only, prints source → target and planned sequence', () => {
  const s = setup();
  let out = '';
  const code = main(['--dry-run'], s.deps, { stdout: (x) => { out += x; }, stderr: () => {} });
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(mutating(s.calls), []);
  assert.match(out, /source: develop \(upstream: origin\/develop\) → target: digital_V2/);
  assert.match(out, /→ git fetch origin --prune/);
  assert.match(out, /→ git pull --ff-only --no-rebase/);
  assert.match(out, /→ git checkout -b digital_V2/);
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

test('hostile --source is rejected, never executed', () => {
  const s = setup();
  const res = run(['--source', '-x;rm'], s.deps);
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

// ---- target exists, HEAD elsewhere: resume (has a start tag) / adopt (no tag) – never BLOCKED ----

const existingTarget = (tagList, extra, opts) => setup(Object.assign({
  localBranches: ['main', SOURCE, TARGET],
  responses: Object.assign({
    ['checkout ' + TARGET]: '',
    ['tag --list migration-start-* --merged refs/heads/' + TARGET]: tagList,
    'tag --list migration-start-* --merged HEAD': tagList,
    ['tag ' + TAG + ' HEAD']: '',
  }, extra || {}),
  // HEAD after the checkout = the target tip
  refs: { ['refs/heads/' + TARGET]: TARGET_TIP, HEAD: TARGET_TIP },
}, opts || {}));

test('golden: digital_V2 exists with a start tag, HEAD elsewhere → resume: fetch + checkout, no new tag → OK', () => {
  const s = existingTarget('migration-start-20261001-0900\nmigration-start-20261003-1000\n');
  const res = run([], s.deps);
  assert.strictEqual(res.result, 'OK', JSON.stringify(res.blockers));
  assert.strictEqual(res.targetMode, 'resume');
  assert.strictEqual(res.tag, 'migration-start-20261003-1000');
  assert.strictEqual(res.sourceBranch, null);
  assert.strictEqual(res.previousBranch, SOURCE);
  assert.strictEqual(res.previousHead, SHA);
  assert.deepStrictEqual(mutating(s.calls), ['fetch origin --prune', 'checkout ' + TARGET]);
  assert.deepStrictEqual(res.changes, []);
  assert.match(res.notes.join(' '), /already exists locally with start tag migration-start-20261003-1000 – continuing an existing migration/);
  assert.ok(!s.calls.some((a) => a[0] === 'pull'), 'the existing target is never pulled');
});

test('golden: digital_V2 exists without a start tag, HEAD elsewhere → adopt: checkout, tag its current tip → OK + warning', () => {
  const s = existingTarget('');
  const res = run([], s.deps);
  assert.strictEqual(res.result, 'OK', JSON.stringify(res.blockers));
  assert.strictEqual(res.targetMode, 'adopt');
  assert.strictEqual(res.tag, TAG);
  assert.strictEqual(res.previousHead, SHA);
  // the tag is created after the checkout, on HEAD = the target tip – never on the source / previous HEAD
  assert.deepStrictEqual(mutating(s.calls), ['fetch origin --prune', 'checkout ' + TARGET, 'tag ' + TAG + ' HEAD']);
  assert.deepStrictEqual(res.changes.map((c) => c.rule), ['BRANCH.TAG']);
  const notes = res.notes.join(' ');
  assert.match(notes, /already exists locally but was NOT created by this skill/);
  assert.match(notes, /steps already done manually will return NOOP/);
  assert.match(notes, new RegExp('Tagged the current tip of digital_V2 \\(' + TARGET_TIP.slice(0, 12) + '\\) as ' + TAG));
});

test('adopt --dry-run: classified from refs/heads/<target>, tag planned after checkout, nothing runs', () => {
  const s = existingTarget('');
  const res = run(['--dry-run'], s.deps);
  assert.strictEqual(res.result, 'OK');
  assert.strictEqual(res.targetMode, 'adopt');
  assert.deepStrictEqual(mutating(s.calls), []);
  assert.deepStrictEqual(res.commands.map((c) => c.command), ['git fetch origin --prune', 'git checkout ' + TARGET, 'git tag ' + TAG + ' HEAD']);
});

test('resume --dry-run: no tag planned', () => {
  const s = existingTarget('migration-start-20261001-0900\n');
  const res = run(['--dry-run'], s.deps);
  assert.strictEqual(res.targetMode, 'resume');
  assert.deepStrictEqual(res.commands.map((c) => c.command), ['git fetch origin --prune', 'git checkout ' + TARGET]);
});

test('digital_V2 exists on origin only → checkout --track from origin, then classified', () => {
  const s = existingTarget('', {
    'ls-remote --heads origin': 'a\trefs/heads/' + SOURCE + '\nb\trefs/heads/' + TARGET + '\n',
    ['checkout -b ' + TARGET + ' --track origin/' + TARGET]: '',
  }, { localBranches: ['main', SOURCE] });
  const res = run([], s.deps);
  assert.strictEqual(res.result, 'OK', JSON.stringify(res.blockers));
  assert.strictEqual(res.targetMode, 'adopt');
  assert.deepStrictEqual(mutating(s.calls), ['fetch origin --prune', 'checkout -b ' + TARGET + ' --track origin/' + TARGET, 'tag ' + TAG + ' HEAD']);
  assert.match(res.notes.join(' '), /already exists on origin but was NOT created/);
});

test('origin-only target not fetched yet, --dry-run → adopt assumed with a note', () => {
  const s = existingTarget('', { 'ls-remote --heads origin': 'b\trefs/heads/' + TARGET + '\n' }, { localBranches: ['main', SOURCE], refs: {} });
  const res = run(['--dry-run'], s.deps);
  assert.strictEqual(res.targetMode, 'adopt');
  assert.match(res.notes.join(' '), /not fetched yet/);
});

test('existing target with a dirty tree → BLOCKED git-clean, nothing runs', () => {
  const s = existingTarget('', { 'status --porcelain': ' M src/App.jsx\n' });
  const res = run([], s.deps);
  assert.deepStrictEqual(checks(res), ['git-clean']);
  assert.deepStrictEqual(mutating(s.calls), []);
});

test('adopt: tag name taken by another commit → BLOCKED, back to the previous branch', () => {
  const s = existingTarget('', { 'checkout develop': '' }, {
    refs: { ['refs/heads/' + TARGET]: TARGET_TIP, HEAD: TARGET_TIP, ['refs/tags/' + TAG]: 'f'.repeat(40) },
  });
  const res = run([], s.deps);
  assert.deepStrictEqual(checks(res), ['tag-exists']);
  assert.deepStrictEqual(mutating(s.calls), ['fetch origin --prune', 'checkout ' + TARGET, 'checkout ' + SOURCE]);
});

test('adopt: creating the tag fails → BLOCKED tag, back to the previous branch', () => {
  const s = existingTarget('', { ['tag ' + TAG + ' HEAD']: fail(128, 'fatal: cannot lock ref') });
  const res = run([], s.deps);
  assert.deepStrictEqual(checks(res), ['tag']);
  assert.deepStrictEqual(mutating(s.calls).slice(-1), ['checkout ' + SOURCE]);
});

test('existing target: --source is ignored with a note', () => {
  const s = existingTarget('migration-start-20261001-0900\n');
  const res = run(['--source', 'whatever'], s.deps);
  assert.strictEqual(res.result, 'OK', JSON.stringify(res.blockers));
  assert.match(res.notes.join(' '), /--source whatever is not used/);
});

const onTarget = (tagList, extra) => setup({
  localBranches: ['main', SOURCE, TARGET],
  responses: Object.assign({
    'symbolic-ref --short -q HEAD': TARGET + '\n',
    'tag --list migration-start-* --merged HEAD': tagList,
    ['tag ' + TAG + ' HEAD']: '',
  }, extra || {}),
});

test('on digital_V2 with a start tag → NOOP, nothing runs', () => {
  const s = onTarget('migration-start-20261001-0900\nmigration-start-20261003-1000\n');
  const res = run([], s.deps);
  assert.strictEqual(res.result, 'NOOP');
  assert.deepStrictEqual(res.blockers, []);
  assert.strictEqual(res.tag, 'migration-start-20261003-1000');
  assert.match(res.notes.join(' '), /this step is already done/);
  assert.deepStrictEqual(mutating(s.calls), []);
  assert.ok(!s.calls.some((a) => a[0] === 'ls-remote'), 'no network on the NOOP path');
});

test('on digital_V2 without a start tag (tag failed earlier) → tag created on HEAD, NOOP', () => {
  const s = onTarget('');
  const res = run([], s.deps);
  assert.strictEqual(res.result, 'NOOP', JSON.stringify(res.blockers));
  assert.deepStrictEqual(mutating(s.calls), ['tag ' + TAG + ' HEAD']);
  assert.strictEqual(res.tag, TAG);
  assert.deepStrictEqual(res.changes.map((c) => c.rule), ['BRANCH.TAG']);
  assert.match(res.notes.join(' '), /was missing – created migration-start-20261005-1407/);
});

test('on digital_V2 without a start tag, --dry-run → tag only planned', () => {
  const s = onTarget('');
  const res = run(['--dry-run'], s.deps);
  assert.strictEqual(res.result, 'NOOP');
  assert.deepStrictEqual(mutating(s.calls), []);
  assert.deepStrictEqual(res.commands, [{ command: 'git tag ' + TAG + ' HEAD', status: 'planned' }]);
});

test('on digital_V2, creating the missing tag fails → BLOCKED tag', () => {
  const s = onTarget('', { ['tag ' + TAG + ' HEAD']: fail(128, 'fatal: cannot lock ref') });
  const res = run([], s.deps);
  assert.deepStrictEqual(checks(res), ['tag']);
});

test('on digital_V2 with a dirty tree → BLOCKED git-clean (the clean-tree check applies in every target state)', () => {
  const s = onTarget('migration-start-20261001-0900\n', { 'status --porcelain': ' M src/App.jsx\n' });
  const res = run([], s.deps);
  assert.deepStrictEqual(checks(res), ['git-clean']);
  assert.deepStrictEqual(mutating(s.calls), []);
});

test('--target other name when digital_V2 already exists → OK', () => {
  const s = setup({ localBranches: ['main', SOURCE, TARGET], responses: { 'checkout -b digital_V2-b': '' } });
  const res = run(['--target', 'digital_V2-b'], s.deps);
  assert.strictEqual(res.result, 'OK', JSON.stringify(res.blockers));
  assert.ok(mutating(s.calls).includes('checkout -b digital_V2-b'));
});

test('--source equal to target → BLOCKED', () => {
  const s = setup({ responses: { 'symbolic-ref --short -q HEAD': 'main\n' } });
  const res = run(['--source', 'x', '--target', 'x'], s.deps);
  assert.ok(checks(res).includes('branch-name'));
});

test('source missing locally and on origin → BLOCKED', () => {
  const s = setup({ responses: { 'symbolic-ref --short -q HEAD': 'main\n' } });
  const res = run(['--source', 'nope'], s.deps);
  assert.deepStrictEqual(checks(res), ['source-missing']);
});

test('detached HEAD → BLOCKED, nothing to branch from', () => {
  const s = setup({ responses: { 'symbolic-ref --short -q HEAD': fail(1) } });
  const res = run([], s.deps);
  assert.deepStrictEqual(checks(res), ['detached-head']);
  assert.match(res.blockers[0].message, /nothing to branch from/);
  assert.strictEqual(res.previousHead, SHA);
  assert.deepStrictEqual(mutating(s.calls), []);
});

test('detached HEAD with --source → still BLOCKED', () => {
  const s = setup({ responses: { 'symbolic-ref --short -q HEAD': fail(1) } });
  assert.deepStrictEqual(checks(run(['--source', SOURCE], s.deps)), ['detached-head']);
});

test('auth failure on ls-remote → BLOCKED kind auth', () => {
  const s = setup({ responses: { 'ls-remote --heads origin': fail(128, "fatal: Authentication failed for 'https://git.internal/x.git/'") } });
  const res = run([], s.deps);
  assert.deepStrictEqual(checks(res), ['origin']);
  assert.strictEqual(res.blockers[0].kind, 'auth');
  assert.match(res.blockers[0].message, /Authentication to origin failed/);
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
  const s = setup({
    responses: {
      'symbolic-ref --short -q HEAD': 'main\n',
      'pull --ff-only --no-rebase': fail(128, 'hint: Diverging branches can\'t be fast-forwarded\nfatal: Not possible to fast-forward, aborting.'),
    },
  });
  const res = run(['--source', SOURCE], s.deps);
  assert.deepStrictEqual(checks(res), ['diverged']);
  assert.match(res.blockers[0].message, /origin\/develop have diverged/);
  assert.deepStrictEqual(mutating(s.calls), [
    'fetch origin --prune',
    'checkout ' + SOURCE,
    'pull --ff-only --no-rebase',
    'checkout main',
  ]);
});

test('local source ahead of upstream → OK with a note (result is only OK|NOOP|BLOCKED)', () => {
  const s = setup({ responses: { 'rev-list --count @{upstream}..HEAD': '2\n' } });
  const res = run([], s.deps);
  assert.strictEqual(res.result, 'OK');
  assert.match(res.notes.join(' '), /2 commits/);
});

test('not a git repo → BLOCKED', () => {
  const s = setup({ responses: { 'rev-parse --is-inside-work-tree': fail(128, 'fatal: not a git repository') } });
  assert.deepStrictEqual(checks(run([], s.deps)), ['git-repo']);
});

test('several problems are reported together', () => {
  const s = setup({
    localBranches: ['main', SOURCE, TARGET],
    responses: {
      'symbolic-ref --short -q HEAD': fail(1),
      'status --porcelain': '?? a\n',
    },
  });
  assert.deepStrictEqual(checks(run([], s.deps)).sort(), ['detached-head', 'git-clean']);
});

test('crash → exit 1, stderr only', () => {
  let err = '';
  let out = '';
  const code = main([], { execFileSync: null, cwd: '/x' }, { stdout: (x) => { out += x; }, stderr: (x) => { err += x; } });
  assert.strictEqual(code, 1);
  assert.strictEqual(out, '');
  assert.match(err, /branch crashed/);
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

// origin has main + develop; the work clone is on main
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
  g(seed, ['push', '-q', 'origin', 'HEAD:' + SOURCE]);
  g(base, ['clone', '-q', origin, work]);
  return { base: base, origin: origin, seed: seed, work: work };
}

function pushUpstreamCommit(r, branch, file) {
  g(r.seed, ['checkout', '-q', '-B', branch, 'origin/' + branch]);
  fs.writeFileSync(path.join(r.seed, file), file);
  g(r.seed, ['add', '.']);
  g(r.seed, ['commit', '-q', '-m', file]);
  g(r.seed, ['push', '-q', 'origin', branch]);
  return g(r.seed, ['rev-parse', 'HEAD']);
}

const realDeps = (cwd) => ({ cwd: cwd, now: NOW, env: Object.assign({}, GIT_ENV, { GIT_TERMINAL_PROMPT: '0' }) });

test('integration: creates digital_V2 from the up-to-date current branch + tag', { skip: !hasGit }, () => {
  const r = makeRemoteAndClone();
  const upstreamSha = pushUpstreamCommit(r, 'main', 'new.txt');
  const before = g(r.work, ['rev-parse', 'HEAD']);

  const res = run([], realDeps(r.work));
  assert.strictEqual(res.result, 'OK', JSON.stringify(res.blockers));
  assert.strictEqual(res.sourceBranch, 'main');
  assert.strictEqual(res.previousHead, before);
  assert.strictEqual(g(r.work, ['symbolic-ref', '--short', 'HEAD']), TARGET);
  assert.strictEqual(g(r.work, ['rev-parse', 'HEAD']), upstreamSha);
  assert.strictEqual(g(r.work, ['rev-parse', TAG + '^{commit}']), upstreamSha);

  // second run while on digital_V2 → NOOP, nothing new
  const refs = g(r.work, ['show-ref']);
  const again = run([], Object.assign(realDeps(r.work), { now: new Date(NOW.getTime() + 60000) }));
  assert.strictEqual(again.result, 'NOOP', JSON.stringify(again.blockers));
  assert.strictEqual(again.tag, TAG);
  assert.strictEqual(g(r.work, ['show-ref']), refs);

  // digital_V2 exists (with its start tag) but HEAD is elsewhere → resume: back on it, no new tag
  g(r.work, ['checkout', '-q', 'main']);
  const elsewhere = run([], Object.assign(realDeps(r.work), { now: new Date(NOW.getTime() + 120000) }));
  assert.strictEqual(elsewhere.result, 'OK', JSON.stringify(elsewhere.blockers));
  assert.strictEqual(elsewhere.targetMode, 'resume');
  assert.strictEqual(elsewhere.tag, TAG);
  assert.strictEqual(g(r.work, ['symbolic-ref', '--short', 'HEAD']), TARGET);
  assert.strictEqual(g(r.work, ['tag', '--list', 'migration-start-*']), TAG);
});

test('integration: branch created but tag missing → resume creates the tag, NOOP', { skip: !hasGit }, () => {
  const r = makeRemoteAndClone();
  g(r.work, ['checkout', '-q', '-b', TARGET]); // as if the tag step failed after create-branch
  const head = g(r.work, ['rev-parse', 'HEAD']);
  const res = run([], realDeps(r.work));
  assert.strictEqual(res.result, 'NOOP', JSON.stringify(res.blockers));
  assert.strictEqual(g(r.work, ['rev-parse', TAG + '^{commit}']), head);
  assert.strictEqual(g(r.work, ['symbolic-ref', '--short', 'HEAD']), TARGET);
});

test('integration: --source from origin only (no local branch)', { skip: !hasGit }, () => {
  const r = makeRemoteAndClone();
  const upstreamSha = pushUpstreamCommit(r, SOURCE, 'dev.txt');
  const res = run(['--source', SOURCE], realDeps(r.work));
  assert.strictEqual(res.result, 'OK', JSON.stringify(res.blockers));
  assert.strictEqual(g(r.work, ['symbolic-ref', '--short', 'HEAD']), TARGET);
  assert.strictEqual(g(r.work, ['rev-parse', 'HEAD']), upstreamSha);
});

test('integration: local branch without upstream → OK, pull skipped', { skip: !hasGit }, () => {
  const r = makeRemoteAndClone();
  g(r.work, ['checkout', '-q', '-b', 'local-only']);
  fs.writeFileSync(path.join(r.work, 'l.txt'), 'l');
  g(r.work, ['add', '.']);
  g(r.work, ['commit', '-q', '-m', 'local']);
  const localSha = g(r.work, ['rev-parse', 'HEAD']);

  const res = run([], realDeps(r.work));
  assert.strictEqual(res.result, 'OK', JSON.stringify(res.blockers));
  assert.strictEqual(res.upstream, null);
  assert.match(res.notes.join(' '), /no upstream/);
  assert.strictEqual(g(r.work, ['symbolic-ref', '--short', 'HEAD']), TARGET);
  assert.strictEqual(g(r.work, ['rev-parse', 'HEAD']), localSha);
});

test('integration: diverged source → BLOCKED, back on previous branch, nothing created', { skip: !hasGit }, () => {
  const r = makeRemoteAndClone();
  g(r.work, ['checkout', '-q', SOURCE]);
  fs.writeFileSync(path.join(r.work, 'local.txt'), 'l');
  g(r.work, ['add', '.']);
  g(r.work, ['commit', '-q', '-m', 'local']);
  g(r.work, ['checkout', '-q', 'main']);
  pushUpstreamCommit(r, SOURCE, 'remote.txt');

  const res = run(['--source', SOURCE], realDeps(r.work));
  assert.strictEqual(res.result, 'BLOCKED');
  assert.deepStrictEqual(res.blockers.map((b) => b.check), ['diverged']);
  assert.strictEqual(g(r.work, ['symbolic-ref', '--short', 'HEAD']), 'main');
  assert.strictEqual(g(r.work, ['branch', '--list', TARGET]), '');
  assert.strictEqual(g(r.work, ['tag', '--list', TAG]), '');
});

test('integration golden: manual digital_V2 (no tag), HEAD elsewhere → adopt, tag on the target tip, then NOOP', { skip: !hasGit }, () => {
  const r = makeRemoteAndClone();
  // developer started by hand: created digital_V2, did some work, went back to main
  g(r.work, ['checkout', '-q', '-b', TARGET]);
  fs.writeFileSync(path.join(r.work, 'manual.txt'), 'm');
  g(r.work, ['add', '.']);
  g(r.work, ['commit', '-q', '-m', 'manual migration work']);
  const manualTip = g(r.work, ['rev-parse', 'HEAD']);
  g(r.work, ['checkout', '-q', 'main']);
  const mainTip = g(r.work, ['rev-parse', 'HEAD']);

  const refsBefore = g(r.work, ['show-ref']);
  const dry = run(['--dry-run'], realDeps(r.work));
  assert.strictEqual(dry.targetMode, 'adopt');
  assert.strictEqual(g(r.work, ['show-ref']), refsBefore);

  const res = run([], realDeps(r.work));
  assert.strictEqual(res.result, 'OK', JSON.stringify(res.blockers));
  assert.strictEqual(res.targetMode, 'adopt');
  assert.strictEqual(res.previousHead, mainTip);
  assert.strictEqual(g(r.work, ['symbolic-ref', '--short', 'HEAD']), TARGET);
  // restore point = the target as it was, not main (which digital_V2 was never branched from by the skill)
  assert.strictEqual(g(r.work, ['rev-parse', TAG + '^{commit}']), manualTip);
  assert.match(res.notes.join(' '), /NOT created by this skill/);

  const again = run([], Object.assign(realDeps(r.work), { now: new Date(NOW.getTime() + 60000) }));
  assert.strictEqual(again.result, 'NOOP', JSON.stringify(again.blockers));
  assert.strictEqual(again.tag, TAG);
});

test('integration: digital_V2 on origin only (no tag) → tracked checkout + tag; --target other name still creates', { skip: !hasGit }, () => {
  const r = makeRemoteAndClone();
  g(r.seed, ['push', '-q', 'origin', 'HEAD:' + TARGET]);
  const originTip = g(r.seed, ['rev-parse', 'HEAD']);

  const refsBefore = g(r.work, ['show-ref']);
  const dry = run(['--dry-run', '--target', 'digital_V2-retry'], realDeps(r.work));
  assert.strictEqual(dry.result, 'OK', JSON.stringify(dry.blockers));
  assert.strictEqual(dry.targetMode, 'create');
  assert.strictEqual(dry.commands.length, 4);
  assert.strictEqual(g(r.work, ['show-ref']), refsBefore);

  const res = run([], realDeps(r.work));
  assert.strictEqual(res.result, 'OK', JSON.stringify(res.blockers));
  assert.strictEqual(res.targetMode, 'adopt');
  assert.strictEqual(g(r.work, ['symbolic-ref', '--short', 'HEAD']), TARGET);
  assert.strictEqual(g(r.work, ['rev-parse', '--abbrev-ref', TARGET + '@{upstream}']), 'origin/' + TARGET);
  assert.strictEqual(g(r.work, ['rev-parse', TAG + '^{commit}']), originTip);
});

test('integration: repo without origin → digital_V2 created locally with tag, then NOOP', { skip: !hasGit }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-test-'));
  g(base, ['init', '-q', '-b', 'try-skill', '.']);
  fs.writeFileSync(path.join(base, 'a.txt'), 'a');
  g(base, ['add', '.']);
  g(base, ['commit', '-q', '-m', 'init']);
  const sha = g(base, ['rev-parse', 'HEAD']);

  const res = run([], realDeps(base));
  assert.strictEqual(res.result, 'OK', JSON.stringify(res.blockers));
  assert.strictEqual(res.sourceBranch, 'try-skill');
  assert.strictEqual(res.previousHead, sha);
  assert.match(res.notes.join(' '), /No remote named origin/);
  assert.strictEqual(g(base, ['symbolic-ref', '--short', 'HEAD']), TARGET);
  assert.strictEqual(g(base, ['rev-parse', TAG + '^{commit}']), sha);
  assert.strictEqual(run([], realDeps(base)).result, 'NOOP');
});

test('integration: missing source → BLOCKED', { skip: !hasGit }, () => {
  const r = makeRemoteAndClone();
  const res = run(['--source', 'nope'], realDeps(r.work));
  assert.deepStrictEqual(res.blockers.map((b) => b.check), ['source-missing']);
});
