'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const { run, main, STEPS } = require('../scripts/run');

const ALL = STEPS.map((s) => s.id);
const SKILL_ROOT = path.join(__dirname, '..');
const RUN_CMD = 'node ' + path.join(SKILL_ROOT, 'scripts', 'run.js').split(path.sep).join('/');

function repo(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-test-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: name || 'hasava-mfe' }));
  return root;
}

const stepIdOf = (script, args) => {
  if (script === 'commit') return 'commit-' + args[args.indexOf('--step') + 1];
  if (script === 'webpack-shared' && args.indexOf('--validate-only') !== -1) return 'webpack-validate';
  return script;
};

// Mock runner: `plan[stepId]` is a result object, an array (one per call), or a function(args)
function mock(plan) {
  const calls = [];
  const counters = {};
  const envs = [];
  const runStep = async (script, args, env) => {
    const id = stepIdOf(script, args);
    calls.push({ id: id, args: args });
    envs.push({ id: id, env: env });
    let r = plan[id];
    if (Array.isArray(r)) { counters[id] = (counters[id] || 0); r = r[Math.min(counters[id]++, r.length - 1)]; }
    if (typeof r === 'function') r = r(args);
    if (r && r.crash) return { exitCode: 1, stdout: '', stderr: 'TypeError: boom\n    at x.js:1:1' };
    const body = Object.assign({ script: script, result: 'OK', changes: [], manual: [], blockers: [], notes: [] }, r || {});
    return { exitCode: 0, stdout: JSON.stringify(body) };
  };
  return { runStep: runStep, calls: calls, envs: envs, ran: () => calls.filter((c) => c.args.indexOf('--dry-run') === -1 || c.id !== 'branch').map((c) => c.id) };
}

async function go(root, argv, m) {
  let out = '';
  const code = await main(argv, { cwd: root, runStep: m.runStep }, { stdout: (s) => { out += s; }, stderr: (s) => { throw new Error('stderr used: ' + s); } });
  assert.strictEqual(code, 0);
  return out;
}
const state = (root) => JSON.parse(fs.readFileSync(path.join(root, '.migration', 'state.json'), 'utf8'));
const last = (out) => out.trimEnd().split('\n').pop();

const BRANCH_PROBE = {
  branch: (args) => (args.indexOf('--dry-run') !== -1
    ? { sourceBranch: 'develop', previousBranch: 'develop', targetBranch: args.indexOf('--target') !== -1 ? args[args.indexOf('--target') + 1] : 'digital_V2' }
    : {}),
};

// ---- approval point ----

test('fresh run stops before branch: source (current branch) → digital_V2, asks to approve the source', async () => {
  const root = repo();
  const m = mock(BRANCH_PROBE);
  const out = await go(root, [], m);
  assert.deepStrictEqual(m.calls.map((c) => c.id), ['preflight', 'scan', 'branch']);
  assert.deepStrictEqual(m.calls[2].args, ['--json', '--dry-run']); // probe only
  assert.match(out, /\[ 1\/18] preflight\s+✓ OK/);
  assert.match(out, /\[ 3\/18] branch\s+⏸ PAUSE {5}Approval needed: create digital_V2 from develop \(current branch\)/);
  assert.match(out, /branch from: develop {3}→ {3}new branch: digital_V2/);
  assert.ok(out.indexOf('Next: ' + RUN_CMD + ' --resume --answer branch.source=develop') !== -1, out);
  assert.match(out, /--answer branch\.target=<name>/);
  assert.strictEqual(last(out), 'RESULT: PAUSE');
  const s = state(root);
  assert.deepStrictEqual(s.completed, ['preflight', 'scan']);
  assert.strictEqual(s.current, 'branch');
  assert.deepStrictEqual(s.results, { preflight: 'OK', scan: 'OK' });
  assert.strictEqual(s.service, 'hasava-mfe');
});

test('approval PAUSE shows probe blockers (digital_V2 already exists)', async () => {
  const root = repo();
  const m = mock({ branch: { sourceBranch: 'develop', targetBranch: 'digital_V2', blockers: [{ message: 'Target branch digital_V2 already exists on origin – the service was probably migrated already' }] } });
  const out = await go(root, [], m);
  assert.match(out, /⛔ Target branch digital_V2 already exists on origin/);
  assert.strictEqual(last(out), 'RESULT: PAUSE');
});

test('probe says adopt (digital_V2 exists, not created by the skill) → approval states it explicitly, no "create"', async () => {
  const root = repo();
  const m = mock({ branch: { targetMode: 'adopt', sourceBranch: null, previousBranch: 'develop', targetBranch: 'digital_V2', tag: 'migration-start-20261005-1407' } });
  const out = await go(root, [], m);
  assert.match(out, /\[ 3\/18] branch\s+⏸ PAUSE {5}Approval needed: run the migration on the EXISTING branch digital_V2/);
  assert.match(out, /⚠ Branch digital_V2 already exists and was NOT created by this skill/);
  assert.match(out, /⚠ The migration will run on top of it; steps already done manually will return NOOP/);
  assert.match(out, /⚠ Restore point: a new tag migration-start-20261005-1407 on the current tip of digital_V2/);
  assert.doesNotMatch(out, /create digital_V2 from/);
  assert.ok(out.indexOf('Next: ' + RUN_CMD + ' --resume --answer branch.source=develop') !== -1, out);
  const res = JSON.parse(await go(repo(), ['--json'], mock({ branch: { targetMode: 'adopt', previousBranch: 'develop', targetBranch: 'digital_V2' } })));
  assert.strictEqual(res.pause.targetMode, 'adopt');
  assert.strictEqual(res.pause.targetExisted, true);
});

test('probe says resume (digital_V2 exists with a start tag) → approval to continue the existing migration', async () => {
  const root = repo();
  const m = mock({ branch: { targetMode: 'resume', sourceBranch: null, previousBranch: 'main', targetBranch: 'digital_V2', tag: 'migration-start-20261001-0900' } });
  const out = await go(root, [], m);
  assert.match(out, /Approval needed: continue the existing migration on digital_V2 \(start tag migration-start-20261001-0900\)/);
  assert.match(out, /switch from: main {3}→ {3}existing branch: digital_V2/);
  assert.doesNotMatch(out, /NOT created by this skill/);
});

test('probe says NOOP (already on digital_V2) → no approval pause, branch runs and the pipeline continues', async () => {
  const root = repo();
  const m = mock({
    branch: (args) => ({ result: 'NOOP', targetBranch: 'digital_V2', previousBranch: 'digital_V2' }),
    'package-json': { result: 'BLOCKED', blockers: [{ message: 'x' }] },
  });
  const out = await go(root, [], m);
  assert.deepStrictEqual(m.calls.map((c) => c.id), ['preflight', 'scan', 'branch', 'branch', 'package-json']);
  assert.deepStrictEqual(m.calls[3].args, ['--json']);
  assert.doesNotMatch(out, /Approval needed/);
  assert.match(out, /\[ 3\/18] branch\s+✓ NOOP/);
});

test('--answer branch.target before approval → probe and the PAUSE use the other name', async () => {
  const root = repo();
  const m = mock(BRANCH_PROBE);
  const out = await go(root, ['--answer', 'branch.target=digital_V2-b'], m);
  assert.deepStrictEqual(m.calls[2].args, ['--json', '--dry-run', '--target', 'digital_V2-b']);
  assert.match(out, /create digital_V2-b from develop/);
  assert.ok(out.indexOf('--resume --answer branch.source=develop --answer branch.target=digital_V2-b') !== -1, out);
});

test('--resume --answer branch.target + branch.source → both passed to branch', async () => {
  const root = repo();
  await go(root, [], mock(BRANCH_PROBE));
  const m = mock({ 'package-json': { result: 'BLOCKED', blockers: [{ message: 'x' }] } });
  await go(root, ['--resume', '--answer', 'branch.source=release/1', '--answer', 'branch.target=gen2'], m);
  assert.deepStrictEqual(m.calls[0], { id: 'branch', args: ['--json', '--target', 'gen2', '--source', 'release/1'] });
});

test('--resume --answer branch.source passes the source to branch and continues', async () => {
  const root = repo();
  await go(root, [], mock(BRANCH_PROBE));
  const m = mock({ 'codemod-makestyles': { result: 'REVIEW', manual: [{ file: 'src/D.jsx', line: 4, reason: 'level C – box depends on props' }], notes: ['check visually'] } });
  const out = await go(root, ['--resume', '--answer', 'branch.source=develop'], m);
  assert.deepStrictEqual(m.calls[0], { id: 'branch', args: ['--json', '--source', 'develop'] });
  assert.deepStrictEqual(m.calls.map((c) => c.id), ['branch', 'package-json', 'codemod-mui-imports', 'codemod-react18', 'codemod-anti-patterns', 'commit-mechanical', 'codemod-makestyles']);
  assert.deepStrictEqual(m.calls[5].args, ['--json', '--step', 'mechanical']);
  // REVIEW prints the full content and pauses; the step itself is done
  assert.match(out, /\[ 9\/18] codemod-makestyles\s+⏸ REVIEW/);
  assert.match(out, /1\. src\/D\.jsx:4 – level C – box depends on props/);
  assert.match(out, /ℹ check visually/);
  assert.strictEqual(last(out), 'RESULT: PAUSE');
  const s = state(root);
  assert.strictEqual(s.answers['branch.source'], 'develop');
  assert.strictEqual(s.current, 'use-shared-state');
  assert.ok(s.completed.indexOf('codemod-makestyles') !== -1);
});

test('--yes skips the approval: branch runs with its defaults (current branch → digital_V2)', async () => {
  const root = repo();
  const m = mock({ 'codemod-mui-imports': { result: 'BLOCKED', blockers: [{ message: 'x' }] } });
  await go(root, ['--yes'], m);
  assert.deepStrictEqual(m.calls[2], { id: 'branch', args: ['--json'] });
});

// ---- BLOCKED / FAILED ----

test('BLOCKED → PAUSE with blockers; --resume reruns the same step', async () => {
  const root = repo();
  const m1 = mock({ install: { result: 'BLOCKED', blockers: [{ message: 'ERESOLVE – conflict', tree: 'peer react@"^17" from x' }] } });
  const out = await go(root, ['--yes'], m1);
  assert.match(out, /\[13\/18] install\s+⛔ BLOCKED/);
  assert.match(out, /⛔ ERESOLVE – conflict\n {5}\| peer react@"\^17" from x/);
  assert.strictEqual(last(out), 'RESULT: PAUSE');
  assert.strictEqual(state(root).current, 'install');
  assert.ok(state(root).completed.indexOf('install') === -1);

  const m2 = mock({ build: { result: 'BLOCKED', errorCount: 2, run: 1, diagnostics: [] } });
  await go(root, ['--resume'], m2);
  assert.strictEqual(m2.calls[0].id, 'install');
});

test('webpack-validate REVIEW → PAUSE before build, full error output printed; --resume continues at build', async () => {
  const root = repo();
  const output = 'Error: FederationConfigError: role\n    at buildSharedGen1 (index.js:3:9)\n    at Object.<anonymous> (webpack.config.js:12:5)';
  const m1 = mock({ 'webpack-validate': { result: 'REVIEW', manual: [{ file: 'webpack.config.js', line: null, reason: 'validation failed', output: output }] } });
  const out = await go(root, ['--yes'], m1);
  assert.match(out, /\[14\/18] webpack-validate\s+⏸ REVIEW/);
  assert.match(out, / {7}\| {5}at Object\.<anonymous> \(webpack\.config\.js:12:5\)/);
  assert.ok(m1.calls.every((c) => c.id !== 'build'));
  assert.strictEqual(last(out), 'RESULT: PAUSE');

  const m2 = mock({});
  await go(root, ['--resume'], m2);
  assert.strictEqual(m2.calls[0].id, 'build');
});

test('script crash (exit != 0) → FAILED with the stderr tail', async () => {
  const root = repo();
  const out = await go(root, ['--yes'], mock({ scan: { crash: true } }));
  assert.match(out, /\[ 2\/18] scan\s+💥 FAILED {4}exit 1/);
  assert.match(out, /\| TypeError: boom/);
  assert.strictEqual(last(out), 'RESULT: FAILED');
  assert.strictEqual(state(root).current, 'scan');
});

// ---- build fix loop ----

const failing = (n) => ({ result: 'BLOCKED', errorCount: n, run: 1, diagnostics: Array.from({ length: n }, (_, i) => ({ source: 'tsc', severity: 'error', file: 'src/A.tsx', line: i + 1, column: 1, code: 'TS2322', message: 'bad ' + i })) });

async function toBuild(root) {
  await go(root, ['--yes', '--from', 'build'], mock({ build: failing(5) }));
}

test('build failure → PAUSE_FOR_FIX with diagnostics; resume reruns build and compares', async () => {
  const root = repo();
  let out = '';
  const m = mock({ build: failing(5) });
  out = await go(root, ['--yes', '--from', 'build'], m);
  assert.match(out, /\[15\/18] build\s+🔧 PAUSE_FOR_FIX 5 errors \| round 1\/5/);
  assert.match(out, /⛔ \[tsc TS2322\] src\/A\.tsx:1:1 – bad 0/);
  assert.strictEqual(last(out), 'RESULT: PAUSE_FOR_FIX');
  out = await go(root, ['--resume'], mock({ build: failing(3) }));
  assert.match(out, /3 errors \(previous: 5\) \| round 2\/5/);
  assert.strictEqual(state(root).buildIterations, 2);
});

test('no progress for 2 rounds → PAUSE (not PAUSE_FOR_FIX)', async () => {
  const root = repo();
  await toBuild(root);                                                // 5
  await go(root, ['--resume'], mock({ build: failing(3) }));          // 3  progress
  await go(root, ['--resume'], mock({ build: failing(3) }));          // 3  stalled 1
  const out = await go(root, ['--resume'], mock({ build: failing(4) })); // 4  stalled 2
  assert.match(out, /No progress: the error count did not go down in 2 rounds \(5 → 3 → 3 → 4\)/);
  assert.strictEqual(last(out), 'RESULT: PAUSE');
  assert.strictEqual(state(root).current, 'build');
});

test('max 5 rounds → PAUSE even while improving; next resume starts a new window', async () => {
  const root = repo();
  await toBuild(root);
  for (const n of [4, 3, 2]) await go(root, ['--resume'], mock({ build: failing(n) }));
  const out = await go(root, ['--resume'], mock({ build: failing(1) }));
  assert.match(out, /Reached the maximum of 5 fix rounds \(5 → 4 → 3 → 2 → 1\)/);
  assert.strictEqual(last(out), 'RESULT: PAUSE');
  const again = await go(root, ['--resume'], mock({ build: failing(1) }));
  assert.match(again, /round 1\/5/);
});

test('build passes → pipeline continues to the end → OK, state finished', async () => {
  const root = repo();
  await toBuild(root);
  const m = mock({});
  const out = await go(root, ['--resume'], m);
  assert.deepStrictEqual(m.calls.map((c) => c.id), ['build', 'verify-runtime', 'commit-build-fixes', 'report']);
  assert.match(out, /✅ The pipeline is complete/);
  assert.strictEqual(last(out), 'RESULT: OK');
  const s = state(root);
  assert.strictEqual(s.current, null);
  assert.ok(s.finishedAt);
  assert.deepStrictEqual(s.buildWindow.history, []);
});

test('full happy run with --yes runs all 18 steps in order', async () => {
  const root = repo();
  const m = mock({});
  const out = await go(root, ['--yes'], m);
  assert.deepStrictEqual(m.calls.map((c) => c.id), ALL);
  assert.match(out, /\[18\/18] report\s+✓ OK/);
  // the edit runs before install, its validation right after install and before build
  const ids = m.calls.map((c) => c.id);
  assert.ok(ids.indexOf('webpack-shared') < ids.indexOf('install'));
  assert.strictEqual(ids.indexOf('webpack-validate'), ids.indexOf('install') + 1);
  assert.strictEqual(ids.indexOf('build'), ids.indexOf('webpack-validate') + 1);
  assert.deepStrictEqual(m.calls.find((c) => c.id === 'webpack-validate').args, ['--json', '--validate-only']);
  assert.strictEqual(last(out), 'RESULT: OK');
  // every step output except build is saved for report.js
  assert.ok(fs.existsSync(path.join(root, '.migration', 'commit-infra.json')));
  assert.ok(!fs.existsSync(path.join(root, '.migration', 'build.json')));
});

// ---- state guards ----

test('cwd inside the skill folder → PAUSE (skill-dir), nothing runs, no state written into the skill', async () => {
  for (const cwd of [SKILL_ROOT, path.join(SKILL_ROOT, 'scripts')]) {
    const m = mock({});
    let out = '';
    const code = await main(['--yes', '--json'], { cwd: cwd, runStep: m.runStep }, { stdout: (s) => { out += s; }, stderr: (s) => { throw new Error('stderr: ' + s); } });
    assert.strictEqual(code, 0);
    const res = JSON.parse(out);
    assert.strictEqual(res.result, 'PAUSE');
    assert.strictEqual(res.pause.kind, 'skill-dir');
    assert.deepStrictEqual(m.calls, []);
    assert.ok(!fs.existsSync(path.join(cwd, '.migration')), 'state written into the skill');
  }
});

test('printed next command points at the real run.js, so it works from the service root', async () => {
  const root = repo();
  let out = '';
  await main([], { cwd: root, runStep: mock(BRANCH_PROBE).runStep }, { stdout: (s) => { out += s; }, stderr: () => {} });
  const next = out.split('\n').find((l) => l.startsWith('Next: ')).slice('Next: '.length);
  const target = next.split(' ')[1];
  assert.ok(path.isAbsolute(target), target);
  assert.ok(fs.existsSync(target), target + ' does not exist');
  assert.ok(!fs.existsSync(path.join(root, 'scripts', 'run.js')), 'the service has no scripts/run.js – a relative "scripts/run.js" would fail');
});

test('--resume without state.json → PAUSE with a clear message', async () => {
  const out = await go(repo(), ['--resume'], mock({}));
  assert.match(out, /No run to resume: \.migration\/state\.json not found/);
  assert.strictEqual(last(out), 'RESULT: PAUSE');
});

test('state.json of another service → PAUSE, nothing runs', async () => {
  const root = repo('other-mfe');
  fs.mkdirSync(path.join(root, '.migration'));
  fs.writeFileSync(path.join(root, '.migration', 'state.json'), JSON.stringify({ service: 'hasava-mfe', current: 'install', completed: [], results: {}, answers: {} }));
  const m = mock({});
  const out = await go(root, ['--resume'], m);
  assert.match(out, /belongs to service "hasava-mfe", not "other-mfe"/);
  assert.strictEqual(m.calls.length, 0);
});

test('plain run while a previous run is unfinished → PAUSE pointing to --resume', async () => {
  const root = repo();
  await go(root, [], mock(BRANCH_PROBE));
  const m = mock({});
  const out = await go(root, [], m);
  assert.strictEqual(m.calls.length, 0);
  assert.match(out, /A previous run did not finish \(stopped at branch\)/);
});

// ---- --from / --only / --dry-run ----

test('--only runs exactly one step and does not move the cursor', async () => {
  const root = repo();
  await go(root, [], mock(BRANCH_PROBE));
  const m = mock({});
  await go(root, ['--only', 'scan'], m);
  assert.deepStrictEqual(m.calls.map((c) => c.id), ['scan']);
  assert.strictEqual(state(root).current, 'branch');
});

test('--from starts at the given step; unknown step → PAUSE with suggestions', async () => {
  const root = repo();
  const m = mock({ 'use-shared-state': { result: 'BLOCKED', blockers: [{ message: 'asset missing' }] } });
  await go(root, ['--from', 'webpack-shared'], m);
  assert.strictEqual(m.calls[0].id, 'webpack-shared');
  const out = await go(root, ['--from', 'commit'], mock({}));
  assert.match(out, /Unknown step: "commit" – did you mean commit-mechanical \/ commit-infra \/ commit-build-fixes\?/);
  assert.strictEqual(last(out), 'RESULT: PAUSE');
});

test('--dry-run: every step gets --dry-run, no pauses, nothing written', async () => {
  const root = repo();
  const m = mock({ 'codemod-makestyles': { result: 'REVIEW' }, install: { result: 'BLOCKED', blockers: [{ message: 'x' }] } });
  const out = await go(root, ['--dry-run'], m);
  assert.deepStrictEqual(m.calls.map((c) => c.id), ALL);
  assert.ok(m.calls.every((c) => c.args.indexOf('--dry-run') !== -1));
  assert.ok(!fs.existsSync(path.join(root, '.migration')));
  assert.strictEqual(last(out), 'RESULT: BLOCKED');
});

const DRY_PLAN = {
  scan: { result: 'BLOCKED', blockers: [{ message: 'deny-list: react-beautiful-dnd' }], notes: ['n1'] },
  'codemod-makestyles': { result: 'REVIEW', manual: [{ file: 'src/D.jsx', line: 4, reason: 'level C' }] },
};

test('--dry-run text: blockers and manual items are printed under their step, run does not stop', async () => {
  const m = mock(DRY_PLAN);
  const out = await go(repo(), ['--dry-run'], m);
  assert.deepStrictEqual(m.calls.map((c) => c.id), ALL);
  assert.match(out, /\[ 2\/18] scan\s+⛔ BLOCKED.*\n {2}⛔ deny-list: react-beautiful-dnd\n/);
  assert.match(out, /\[ 9\/18] codemod-makestyles\s+⏸ REVIEW.*\n {2}✋ src\/D\.jsx:4 – level C\n/);
  assert.strictEqual(last(out), 'RESULT: BLOCKED');
});

test('--dry-run --json: every step keeps blockers, manual and notes', async () => {
  const res = JSON.parse(await go(repo(), ['--dry-run', '--json'], mock(DRY_PLAN)));
  const scan = res.steps.find((s) => s.id === 'scan');
  assert.deepStrictEqual(scan.blockers, [{ message: 'deny-list: react-beautiful-dnd' }]);
  assert.deepStrictEqual(scan.notes, ['n1']);
  assert.deepStrictEqual(res.steps.find((s) => s.id === 'codemod-makestyles').manual, [{ file: 'src/D.jsx', line: 4, reason: 'level C' }]);
  const ok = res.steps.find((s) => s.id === 'preflight');
  assert.deepStrictEqual([ok.blockers, ok.manual, ok.notes], [[], [], []]);
});

test('normal run --json: step entries carry blockers too', async () => {
  const res = JSON.parse(await go(repo(), ['--yes', '--json'], mock({ install: { result: 'BLOCKED', blockers: [{ message: 'ERESOLVE' }] } })));
  assert.deepStrictEqual(res.steps.find((s) => s.id === 'install').blockers, [{ message: 'ERESOLVE' }]);
});

test('--json: steps, pause and next command', async () => {
  const root = repo();
  const out = await go(root, ['--json'], mock(BRANCH_PROBE));
  const res = JSON.parse(out);
  assert.strictEqual(res.result, 'PAUSE');
  assert.strictEqual(res.pause.kind, 'approval');
  assert.strictEqual(res.pause.key, 'branch.source');
  assert.strictEqual(res.pause.source, 'develop');
  assert.strictEqual(res.pause.target, 'digital_V2');
  assert.strictEqual(res.pause.suggestion, 'develop');
  assert.match(res.next, /--answer branch\.source=develop$/);
  assert.deepStrictEqual(res.steps.map((s) => s.id), ['preflight', 'scan', 'branch']);
});

// ---- real git + real scripts ----

test('.migration/ is added to .git/info/exclude so scan output never dirties the tree for branch', async () => {
  const root = repo();
  childProcess.execFileSync('git', ['init', '-q'], { cwd: root });
  await go(root, ['--only', 'scan'], mock({}));
  const exclude = fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8');
  assert.match(exclude, /^\.migration\/$/m);
  const status = childProcess.execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  assert.ok(status.indexOf('.migration') === -1, status);
  await go(root, ['--only', 'scan'], mock({}));
  assert.strictEqual(fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8').match(/\.migration\//g).length, 1);
});

test('real child process: --only scan runs scripts/scan.js and stores its result', async () => {
  const root = repo();
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'App.jsx'), "import { Button } from '@material-ui/core';\nexport default () => <Button />;\n");
  let out = '';
  await main(['--only', 'scan'], { cwd: root }, { stdout: (s) => { out += s; }, stderr: () => {} });
  assert.match(out, /\[ 2\/18] scan\s+✓ OK/);
  const saved = JSON.parse(fs.readFileSync(path.join(root, '.migration', 'scan.json'), 'utf8'));
  assert.strictEqual(saved.inventory.muiFiles[0].file, 'src/App.jsx');
  assert.ok(fs.existsSync(path.join(root, '.migration', 'inventory.json')));
});

// ---- stub mode: preflight reports, run.js decides with approval ----

const STUB_PKG = '@ips/mfe-shared-deps';
const PREFLIGHT_STUB = { stubCandidates: [STUB_PKG], environment: { registryUrl: 'https://registry.npmjs.org/' } };
const stubEnvOf = (m, id) => (m.envs.find((e) => e.id === id) || {}).env;
const COMMITS = ['commit-mechanical', 'commit-infra', 'commit-build-fixes'];

test('stub candidates → PAUSE stub-mode before scan: which package, which registry, mechanics only, no commits', async () => {
  const root = repo();
  const m = mock({ preflight: PREFLIGHT_STUB });
  const out = await go(root, [], m);
  assert.deepStrictEqual(m.calls.map((c) => c.id), ['preflight']);
  assert.match(out, /\[ 2\/18] scan\s+⏸ PAUSE {5}Approval needed: continue with a local stub for @ips\/mfe-shared-deps/);
  assert.match(out, /⚠ Internal package\(s\) not found in https:\/\/registry\.npmjs\.org\/: @ips\/mfe-shared-deps/);
  assert.match(out, /continue with a local test stub instead: test-fixtures\/ips-mfe-shared-deps/);
  assert.match(out, /validates the pipeline mechanics only – NOT the shared configuration against the real package/);
  assert.match(out, /No commits are made in such a run/);
  assert.ok(out.indexOf('Next: ' + RUN_CMD + ' --resume --answer stub.mode=yes') !== -1, out);
  assert.strictEqual(last(out), 'RESULT: PAUSE');
  const s = state(root);
  assert.deepStrictEqual(s.completed, ['preflight']);
  assert.strictEqual(s.current, 'scan');
  assert.deepStrictEqual(s.stubCandidates, [STUB_PKG]);
  assert.strictEqual(s.stubMode, undefined);

  const res = JSON.parse(await go(repo(), ['--json'], mock({ preflight: PREFLIGHT_STUB })));
  assert.deepStrictEqual(res.pause, { kind: 'stub-mode', step: 'scan', key: 'stub.mode', packages: [STUB_PKG], registry: 'https://registry.npmjs.org/' });
  assert.strictEqual(res.stubMode, undefined, 'not approved yet');
});

test('--resume --answer stub.mode=yes → saved in state.stubMode, every step gets the stub env, the next resume does not ask again', async () => {
  const root = repo();
  await go(root, [], mock({ preflight: PREFLIGHT_STUB }));
  const m = mock(BRANCH_PROBE);
  const out = await go(root, ['--resume', '--answer', 'stub.mode=yes'], m);
  assert.match(out, /⚠ STUB MODE approved/);
  assert.deepStrictEqual(m.calls.map((c) => c.id), ['scan', 'branch']);
  m.envs.forEach((e) => assert.deepStrictEqual(e.env, { MFE_MIGRATION_STUB: STUB_PKG }, e.id));
  assert.match(out, /\[ 2\/18] scan\s+✓ OK.*\n {3}⚠ STUB MODE – @ips\/mfe-shared-deps is a local test stub/);
  const s = state(root);
  assert.strictEqual(s.stubMode.approved, true);
  assert.deepStrictEqual(s.stubMode.packages, [STUB_PKG]);
  assert.strictEqual(s.stubMode.approvedBy, 'answer');

  const m2 = mock({ 'package-json': { result: 'BLOCKED', blockers: [{ message: 'x' }] } });
  const out2 = await go(root, ['--resume', '--answer', 'branch.source=develop'], m2);
  assert.doesNotMatch(out2, /Approval needed: continue with a local stub/);
  assert.deepStrictEqual(m2.calls.map((c) => c.id), ['branch', 'package-json']);
  assert.deepStrictEqual(stubEnvOf(m2, 'package-json'), { MFE_MIGRATION_STUB: STUB_PKG });
});

test('--yes with stub candidates: approved automatically, warnings kept, commit steps never run, stub summary at the end', async () => {
  const root = repo();
  const m = mock({ preflight: PREFLIGHT_STUB });
  let out = '';
  await main(['--yes'], { cwd: root, runStep: m.runStep }, { stdout: (s) => { out += s; }, stderr: (s) => { throw new Error(s); } });
  assert.match(out, /⚠ STUB MODE approved automatically \(--yes\)/);
  assert.match(out, /validates the pipeline mechanics only/);
  // the three commit steps are skipped entirely – commit.js is never spawned
  assert.deepStrictEqual(m.calls.map((c) => c.id), ALL.filter((id) => COMMITS.indexOf(id) === -1));
  COMMITS.forEach((id) => {
    assert.match(out, new RegExp(id + '\\s+✓ NOOP'));
    const saved = JSON.parse(fs.readFileSync(path.join(root, '.migration', id + '.json'), 'utf8'));
    assert.strictEqual(saved.result, 'NOOP');
    assert.strictEqual(saved.stubMode, true);
    assert.match(saved.notes.join(' '), /Skipped – stub mode/);
  });
  // a warning line under every step after preflight (preflight ran before the decision)
  assert.strictEqual((out.match(/^ {3}⚠ STUB MODE – /mg) || []).length, ALL.length - 1);
  assert.doesNotMatch(out, /✅ The pipeline is complete/);
  assert.match(out, /⚠ The pipeline completed IN STUB MODE/);
  assert.match(out, /NOT the shared configuration against the real package/);
  assert.match(out, /Nothing was committed: the working tree is left with uncommitted changes/);
  assert.match(out, /Re-run on the internal network before any real use/);
  assert.match(out, /⚠ STUB MODE \(@ips\/mfe-shared-deps\) – pipeline mechanics only, NOT a validated migration; nothing committed.*\nRESULT: OK\n$/);
  assert.strictEqual(state(root).stubMode.approvedBy, '--yes');
});

test('--json of a stub run: stubMode: true at the top level', async () => {
  const res = JSON.parse(await go(repo(), ['--yes', '--json'], mock({ preflight: PREFLIGHT_STUB })));
  assert.strictEqual(res.result, 'OK');
  assert.strictEqual(res.stubMode, true);
  assert.deepStrictEqual(res.stubPackages, [STUB_PKG]);
  assert.deepStrictEqual(res.steps.filter((s) => COMMITS.indexOf(s.id) !== -1).map((s) => s.result), ['NOOP', 'NOOP', 'NOOP']);
});

test('--answer stub.mode=no → stops like a preflight blocker; --resume re-runs preflight', async () => {
  const root = repo();
  await go(root, [], mock({ preflight: PREFLIGHT_STUB }));
  const m = mock({});
  const out = await go(root, ['--resume', '--answer', 'stub.mode=no'], m);
  assert.deepStrictEqual(m.calls, []);
  assert.match(out, /preflight\s+⛔ BLOCKED   stub mode not approved/);
  assert.match(out, /⛔ @ips\/mfe-shared-deps: package not found in https:\/\/registry\.npmjs\.org\//);
  const s = state(root);
  assert.strictEqual(s.current, 'preflight');
  assert.strictEqual(s.answers['stub.mode'], undefined);
  const res = JSON.parse(await go(repo(), ['--json', '--answer', 'stub.mode=no'], mock({ preflight: PREFLIGHT_STUB })));
  assert.strictEqual(res.pause.kind, 'blocked');
  assert.strictEqual(res.pause.step, 'preflight');
});

test('no stub candidates → no question, and every step gets an explicitly empty stub env', async () => {
  const root = repo();
  const m = mock({});
  const out = await go(root, ['--yes'], m);
  assert.doesNotMatch(out, /STUB/);
  m.envs.forEach((e) => assert.deepStrictEqual(e.env, { MFE_MIGRATION_STUB: '' }, e.id));
  COMMITS.forEach((id) => assert.ok(m.calls.some((c) => c.id === id)));
  assert.strictEqual(state(root).stubMode, undefined);
});

test('preflight finds the package again → an earlier stub approval is dropped (never stub what the registry has)', async () => {
  const root = repo();
  await go(root, ['--yes', '--only', 'preflight'], mock({ preflight: PREFLIGHT_STUB }));
  const s0 = state(root);
  s0.stubMode = { approved: true, packages: [STUB_PKG] };
  fs.writeFileSync(path.join(root, '.migration', 'state.json'), JSON.stringify(s0));
  const m = mock({ scan: { result: 'BLOCKED', blockers: [{ message: 'x' }] } });
  await go(root, ['--from', 'preflight'], m);
  assert.deepStrictEqual(stubEnvOf(m, 'scan'), { MFE_MIGRATION_STUB: '' });
  assert.strictEqual(state(root).stubMode, undefined);
});

test('a non-internal package in stubCandidates is ignored – no stub mode', async () => {
  const m = mock({ preflight: { stubCandidates: ['react'] } });
  const out = await go(repo(), ['--yes'], m);
  assert.doesNotMatch(out, /STUB/);
  assert.ok(m.calls.some((c) => c.id === 'commit-mechanical'));
});

test('--dry-run with stub candidates: no pause, simulated with the warning, stub env passed, nothing written', async () => {
  const root = repo();
  const m = mock({ preflight: PREFLIGHT_STUB });
  const out = await go(root, ['--dry-run'], m);
  assert.match(out, /⚠ STUB MODE \[dry-run: simulated – a real run asks first]/);
  assert.deepStrictEqual(stubEnvOf(m, 'scan'), { MFE_MIGRATION_STUB: STUB_PKG });
  assert.ok(!m.calls.some((c) => COMMITS.indexOf(c.id) !== -1));
  assert.ok(!fs.existsSync(path.join(root, '.migration')));
});

test('--from a later step keeps an approved stub decision', async () => {
  const root = repo();
  await go(root, ['--yes'], mock({ preflight: PREFLIGHT_STUB }));
  const m = mock({ 'package-json': { result: 'BLOCKED', blockers: [{ message: 'x' }] } });
  await go(root, ['--from', 'package-json'], m);
  assert.deepStrictEqual(stubEnvOf(m, 'package-json'), { MFE_MIGRATION_STUB: STUB_PKG });
});
