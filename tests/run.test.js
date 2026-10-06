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
  const runStep = async (script, args) => {
    const id = stepIdOf(script, args);
    calls.push({ id: id, args: args });
    let r = plan[id];
    if (Array.isArray(r)) { counters[id] = (counters[id] || 0); r = r[Math.min(counters[id]++, r.length - 1)]; }
    if (typeof r === 'function') r = r(args);
    if (r && r.crash) return { exitCode: 1, stdout: '', stderr: 'TypeError: boom\n    at x.js:1:1' };
    const body = Object.assign({ script: script, result: 'OK', changes: [], manual: [], blockers: [], notes: [] }, r || {});
    return { exitCode: 0, stdout: JSON.stringify(body) };
  };
  return { runStep: runStep, calls: calls, ran: () => calls.filter((c) => c.args.indexOf('--dry-run') === -1 || c.id !== 'branch').map((c) => c.id) };
}

async function go(root, argv, m) {
  let out = '';
  const code = await main(argv, { cwd: root, runStep: m.runStep }, { stdout: (s) => { out += s; }, stderr: (s) => { throw new Error('stderr used: ' + s); } });
  assert.strictEqual(code, 0);
  return out;
}
const state = (root) => JSON.parse(fs.readFileSync(path.join(root, '.migration', 'state.json'), 'utf8'));
const last = (out) => out.trimEnd().split('\n').pop();

const BRANCH_PROBE = { branch: (args) => (args.indexOf('--dry-run') !== -1 ? { targetBranch: 'feature/migration-v2-hasava-mfe-20261006' } : {}) };

// ---- approval point ----

test('fresh run stops before branch and suggests the derived name', async () => {
  const root = repo();
  const m = mock(BRANCH_PROBE);
  const out = await go(root, [], m);
  assert.deepStrictEqual(m.calls.map((c) => c.id), ['preflight', 'scan', 'branch']);
  assert.deepStrictEqual(m.calls[2].args, ['--json', '--dry-run']); // probe only
  assert.match(out, /\[ 1\/18] preflight\s+✓ OK/);
  assert.match(out, /\[ 3\/18] branch\s+⏸ PAUSE {5}נדרש אישור שם בראנץ'/);
  assert.ok(out.indexOf('להמשך: ' + RUN_CMD + ' --resume --answer branch.target=feature/migration-v2-hasava-mfe-20261006') !== -1, out);
  assert.strictEqual(last(out), 'RESULT: PAUSE');
  const s = state(root);
  assert.deepStrictEqual(s.completed, ['preflight', 'scan']);
  assert.strictEqual(s.current, 'branch');
  assert.deepStrictEqual(s.results, { preflight: 'OK', scan: 'OK' });
  assert.strictEqual(s.service, 'hasava-mfe');
});

test('--resume --answer passes the name to branch and continues', async () => {
  const root = repo();
  await go(root, [], mock(BRANCH_PROBE));
  const m = mock({ 'codemod-makestyles': { result: 'REVIEW', manual: [{ file: 'src/D.jsx', line: 4, reason: 'רמה C – box תלוי ב-props' }], notes: ['בדוק ויזואלית'] } });
  const out = await go(root, ['--resume', '--answer', 'branch.target=feature/x'], m);
  assert.deepStrictEqual(m.calls[0], { id: 'branch', args: ['--json', '--target', 'feature/x'] });
  assert.deepStrictEqual(m.calls.map((c) => c.id), ['branch', 'package-json', 'codemod-mui-imports', 'codemod-react18', 'codemod-anti-patterns', 'commit-mechanical', 'codemod-makestyles']);
  assert.deepStrictEqual(m.calls[5].args, ['--json', '--step', 'mechanical']);
  // REVIEW prints the full content and pauses; the step itself is done
  assert.match(out, /\[ 9\/18] codemod-makestyles\s+⏸ REVIEW/);
  assert.match(out, /1\. src\/D\.jsx:4 – רמה C – box תלוי ב-props/);
  assert.match(out, /ℹ בדוק ויזואלית/);
  assert.strictEqual(last(out), 'RESULT: PAUSE');
  const s = state(root);
  assert.strictEqual(s.answers['branch.target'], 'feature/x');
  assert.strictEqual(s.current, 'use-shared-state');
  assert.ok(s.completed.indexOf('codemod-makestyles') !== -1);
});

test('--yes skips the approval: branch runs with its derived name', async () => {
  const root = repo();
  const m = mock({ 'codemod-mui-imports': { result: 'BLOCKED', blockers: [{ message: 'x' }] } });
  await go(root, ['--yes'], m);
  assert.deepStrictEqual(m.calls[2], { id: 'branch', args: ['--json'] });
});

// ---- BLOCKED / FAILED ----

test('BLOCKED → PAUSE with blockers; --resume reruns the same step', async () => {
  const root = repo();
  const m1 = mock({ install: { result: 'BLOCKED', blockers: [{ message: 'ERESOLVE – קונפליקט', tree: 'peer react@"^17" from x' }] } });
  const out = await go(root, ['--yes'], m1);
  assert.match(out, /\[13\/18] install\s+⛔ BLOCKED/);
  assert.match(out, /⛔ ERESOLVE – קונפליקט\n {5}\| peer react@"\^17" from x/);
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
  const m1 = mock({ 'webpack-validate': { result: 'REVIEW', manual: [{ file: 'webpack.config.js', line: null, reason: 'הוולידציה נכשלה', output: output }] } });
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
  assert.match(out, /\[15\/18] build\s+🔧 PAUSE_FOR_FIX 5 שגיאות \| סבב 1\/5/);
  assert.match(out, /⛔ \[tsc TS2322\] src\/A\.tsx:1:1 – bad 0/);
  assert.strictEqual(last(out), 'RESULT: PAUSE_FOR_FIX');
  out = await go(root, ['--resume'], mock({ build: failing(3) }));
  assert.match(out, /3 שגיאות \(קודם: 5\) \| סבב 2\/5/);
  assert.strictEqual(state(root).buildIterations, 2);
});

test('no progress for 2 rounds → PAUSE (not PAUSE_FOR_FIX)', async () => {
  const root = repo();
  await toBuild(root);                                                // 5
  await go(root, ['--resume'], mock({ build: failing(3) }));          // 3  progress
  await go(root, ['--resume'], mock({ build: failing(3) }));          // 3  stalled 1
  const out = await go(root, ['--resume'], mock({ build: failing(4) })); // 4  stalled 2
  assert.match(out, /אין התקדמות: מספר השגיאות לא ירד ב-2 סבבים \(5 → 3 → 3 → 4\)/);
  assert.strictEqual(last(out), 'RESULT: PAUSE');
  assert.strictEqual(state(root).current, 'build');
});

test('max 5 rounds → PAUSE even while improving; next resume starts a new window', async () => {
  const root = repo();
  await toBuild(root);
  for (const n of [4, 3, 2]) await go(root, ['--resume'], mock({ build: failing(n) }));
  const out = await go(root, ['--resume'], mock({ build: failing(1) }));
  assert.match(out, /הגעה למקסימום 5 סבבי תיקון \(5 → 4 → 3 → 2 → 1\)/);
  assert.strictEqual(last(out), 'RESULT: PAUSE');
  const again = await go(root, ['--resume'], mock({ build: failing(1) }));
  assert.match(again, /סבב 1\/5/);
});

test('build passes → pipeline continues to the end → OK, state finished', async () => {
  const root = repo();
  await toBuild(root);
  const m = mock({});
  const out = await go(root, ['--resume'], m);
  assert.deepStrictEqual(m.calls.map((c) => c.id), ['build', 'verify-runtime', 'commit-build-fixes', 'report']);
  assert.match(out, /✅ הצינור הושלם/);
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
  const next = out.split('\n').find((l) => l.startsWith('להמשך: ')).slice('להמשך: '.length);
  const target = next.split(' ')[1];
  assert.ok(path.isAbsolute(target), target);
  assert.ok(fs.existsSync(target), target + ' does not exist');
  assert.ok(!fs.existsSync(path.join(root, 'scripts', 'run.js')), 'the service has no scripts/run.js – a relative "scripts/run.js" would fail');
});

test('--resume without state.json → PAUSE with a clear message', async () => {
  const out = await go(repo(), ['--resume'], mock({}));
  assert.match(out, /אין ריצה להמשיך: \.migration\/state\.json לא נמצא/);
  assert.strictEqual(last(out), 'RESULT: PAUSE');
});

test('state.json of another service → PAUSE, nothing runs', async () => {
  const root = repo('other-mfe');
  fs.mkdirSync(path.join(root, '.migration'));
  fs.writeFileSync(path.join(root, '.migration', 'state.json'), JSON.stringify({ service: 'hasava-mfe', current: 'install', completed: [], results: {}, answers: {} }));
  const m = mock({});
  const out = await go(root, ['--resume'], m);
  assert.match(out, /שייך לשירות "hasava-mfe" ולא ל-"other-mfe"/);
  assert.strictEqual(m.calls.length, 0);
});

test('plain run while a previous run is unfinished → PAUSE pointing to --resume', async () => {
  const root = repo();
  await go(root, [], mock(BRANCH_PROBE));
  const m = mock({});
  const out = await go(root, [], m);
  assert.strictEqual(m.calls.length, 0);
  assert.match(out, /קיימת ריצה שלא הסתיימה \(עצרה ב-branch\)/);
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
  const m = mock({ 'use-shared-state': { result: 'BLOCKED', blockers: [{ message: 'asset חסר' }] } });
  await go(root, ['--from', 'webpack-shared'], m);
  assert.strictEqual(m.calls[0].id, 'webpack-shared');
  const out = await go(root, ['--from', 'commit'], mock({}));
  assert.match(out, /שלב לא מוכר: "commit" – התכוונת ל-commit-mechanical \/ commit-infra \/ commit-build-fixes\?/);
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

test('--json: steps, pause and next command', async () => {
  const root = repo();
  const out = await go(root, ['--json'], mock(BRANCH_PROBE));
  const res = JSON.parse(out);
  assert.strictEqual(res.result, 'PAUSE');
  assert.strictEqual(res.pause.kind, 'approval');
  assert.strictEqual(res.pause.suggestion, 'feature/migration-v2-hasava-mfe-20261006');
  assert.match(res.next, /--answer branch\.target=/);
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
