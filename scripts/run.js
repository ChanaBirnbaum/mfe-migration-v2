#!/usr/bin/env node
'use strict';

// run: the whole migration pipeline in order – stops at decision points, resumable from .migration/state.json.
// Run from the service repo root (cwd = the service). Every step runs as `node <skill>/scripts/<script>.js --json …`;
// its JSON result decides what happens next.
// Exit code 0 for every expected outcome (incl. PAUSE / FAILED step); 1 only if run.js itself crashes.

const path = require('path');
const stubMode = require('./stub-mode');

const SCRIPT = 'run';
const STATE_FILE = '.migration/state.json';
const SKILL_ROOT = path.join(__dirname, '..');
// run.js runs with cwd = the service repo, so "node scripts/run.js" would not exist there.
// The printed next-step command points at this file wherever the skill is installed.
const RUN_PATH = __filename.split(path.sep).join('/');
const RUN_CMD = 'node ' + (/\s/.test(RUN_PATH) ? '"' + RUN_PATH + '"' : RUN_PATH);
const BUILD_MAX_ROUNDS = 5;
const BUILD_NO_PROGRESS_ROUNDS = 2;
const DIAG_PRINT_LIMIT = 40;

const STEPS = [
  { id: 'preflight' },
  { id: 'scan' },
  // approval: which branch to branch off (default: the current one). branch.target (default digital_V2) is optional
  { id: 'branch', approval: 'branch.source' },
  { id: 'package-json' },
  { id: 'codemod-mui-imports' },
  { id: 'codemod-react18' },
  { id: 'codemod-anti-patterns' },
  { id: 'commit-mechanical', script: 'commit', args: ['--step', 'mechanical'] },
  { id: 'codemod-makestyles' },
  { id: 'use-shared-state' },
  { id: 'webpack-shared' },
  { id: 'commit-infra', script: 'commit', args: ['--step', 'infra'] },
  { id: 'install' },
  // העריכה (webpack-shared) רצה לפני install; האימות דורש node_modules ולכן רץ כאן
  { id: 'webpack-validate', script: 'webpack-shared', args: ['--validate-only'] },
  { id: 'build', fixLoop: true },
  { id: 'verify-runtime' },
  { id: 'commit-build-fixes', script: 'commit', args: ['--step', 'build-fixes'] },
  { id: 'report' },
];
const STEP_IDS = STEPS.map((s) => s.id);
// build writes its own build-<n>.json; everything else is saved for report.js
const SAVE_OUTPUT = (id) => id !== 'build';

function parseArgs(argv) {
  const opts = { resume: false, answers: {}, from: null, only: null, dryRun: false, yes: false, json: false, errors: [] };
  const stepArg = (flag, v) => {
    if (!v) { opts.errors.push(flag + ' requires a step name'); return null; }
    if (STEP_IDS.indexOf(v) === -1) {
      const close = STEP_IDS.filter((id) => id.indexOf(v) !== -1);
      opts.errors.push('Unknown step: "' + v + '"' + (close.length ? ' – did you mean ' + close.join(' / ') + '?' : '') + '. Steps: ' + STEP_IDS.join(', '));
      return null;
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--resume') opts.resume = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--yes') opts.yes = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--answer') {
      const v = argv[++i] || '';
      const eq = v.indexOf('=');
      if (eq <= 0) opts.errors.push('--answer must be in the form key=value (got "' + v + '")');
      else opts.answers[v.slice(0, eq)] = v.slice(eq + 1);
    } else if (a === '--from') opts.from = stepArg('--from', argv[++i]);
    else if (a === '--only') opts.only = stepArg('--only', argv[++i]);
    else opts.errors.push('Unknown argument: ' + a);
  }
  if (opts.from && opts.only) opts.errors.push('--from and --only cannot be combined');
  return opts;
}

// ---------------------------------------------------------------------------
// Default step runner: node scripts/<script>.js --json …  (no shell, array args)

function defaultRunStep(cwd, env) {
  const cp = require('child_process');
  return (script, args, extraEnv) => new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = cp.spawn(process.execPath, [path.join(__dirname, script + '.js')].concat(args), { cwd: cwd, env: Object.assign({}, env, extraEnv || {}), windowsHide: true });
    } catch (err) {
      resolve({ exitCode: null, stdout: '', stderr: err.message });
      return;
    }
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (err) => resolve({ exitCode: null, stdout: stdout, stderr: stderr + err.message }));
    child.on('close', (code) => resolve({ exitCode: code, stdout: stdout, stderr: stderr }));
  });
}

// ---------------------------------------------------------------------------

const fmtDuration = (ms) => (ms < 60000 ? (ms / 1000).toFixed(1) + 's' : Math.floor(ms / 60000) + 'm' + Math.round((ms % 60000) / 1000) + 's');
const SYMBOL = { OK: '✓', NOOP: '✓', REVIEW: '⏸', BLOCKED: '⛔', FAILED: '💥', PAUSE: '⏸', PAUSE_FOR_FIX: '🔧' };

async function run(argv, overrides) {
  const deps = Object.assign({
    fs: require('fs'), cwd: process.cwd(), cp: require('child_process'), now: () => new Date(),
    env: Object.assign({}, process.env), print: () => {}, runStep: null,
  }, overrides || {});
  const fs = deps.fs;
  const root = deps.cwd;
  const runStep = deps.runStep || defaultRunStep(root, deps.env);
  const opts = parseArgs(argv || []);
  const out = { script: SCRIPT, result: 'OK', changes: [], manual: [], blockers: [], notes: [], dryRun: opts.dryRun, steps: [], pause: null, next: null, state: null };
  const say = (line) => deps.print(line + '\n');
  let stubPackages = () => [];
  const stop = (result, pause) => {
    out.result = result;
    out.pause = pause;
    // every --json output of a stub run carries stubMode at the top level
    if (stubPackages().length) { out.stubMode = true; out.stubPackages = stubPackages(); }
    return out;
  };

  if (opts.errors.length) {
    opts.errors.forEach((e) => say('⛔ ' + e));
    return stop('PAUSE', { kind: 'args', message: opts.errors.join('; ') });
  }

  // run from inside the skill → .migration/ and every edit would land in the skill itself. Stop before writing anything.
  const rel = path.relative(path.resolve(SKILL_ROOT), path.resolve(root));
  if (!rel || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    say('⏸ run.js was run from inside the skill folder (' + root + '). Run it from the root of the service repo being migrated:');
    say('   cd <service root> && ' + RUN_CMD);
    return stop('PAUSE', { kind: 'skill-dir', message: 'cwd is inside the skill folder – nothing was written' });
  }

  // ---- state ----
  const statePath = path.join(root, STATE_FILE);
  let state = null;
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (_) { state = null; }
  let service = null;
  try { service = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name || null; } catch (_) { service = null; }

  if (opts.resume && !state) {
    say('⏸ No run to resume: ' + STATE_FILE + ' not found in ' + root);
    out.next = RUN_CMD;
    return stop('PAUSE', { kind: 'no-state', message: STATE_FILE + ' not found – run without --resume to start' });
  }
  if (state && service && state.service && state.service !== service && !opts.dryRun) {
    say('⏸ ' + STATE_FILE + ' belongs to service "' + state.service + '", not "' + service + '" – not continuing');
    return stop('PAUSE', { kind: 'other-service', message: 'state.json belongs to service ' + state.service });
  }
  const unfinished = state && state.current;
  if (unfinished && !opts.resume && !opts.from && !opts.only && !opts.dryRun) {
    say('⏸ A previous run did not finish (stopped at ' + state.current + ').');
    out.next = RUN_CMD + ' --resume';
    say('Next: ' + out.next + '   |   Start over: ' + RUN_CMD + ' --from preflight');
    return stop('PAUSE', { kind: 'unfinished', message: 'previous run stopped at ' + state.current });
  }
  const fresh = !state || (!opts.resume && !opts.only && !(opts.from && unfinished));
  if (fresh) {
    const prev = state;
    state = {
      startedAt: deps.now().toISOString(), service: service, completed: [], current: STEP_IDS[0],
      results: {}, answers: {}, buildIterations: 0, buildWindow: { history: [] },
    };
    // --from <a later step> does not re-run preflight, so an approved stub decision stays; --from preflight decides again
    if (prev && opts.from && opts.from !== STEP_IDS[0] && prev.stubMode) {
      ['stubMode', 'stubCandidates', 'stubRegistry'].forEach((k) => { if (prev[k] !== undefined) state[k] = prev[k]; });
    }
  }
  Object.assign(state.answers, opts.answers);
  state.buildWindow = state.buildWindow || { history: [] };
  const save = () => {
    if (opts.dryRun) return;
    state.updatedAt = deps.now().toISOString();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  };

  // .migration/ must never make the tree dirty (branch / preflight check git status)
  if (!opts.dryRun) ensureGitExclude(deps, root, out);

  // ---- which steps ----
  let startIdx = 0;
  if (opts.only) startIdx = STEP_IDS.indexOf(opts.only);
  else if (opts.from) startIdx = STEP_IDS.indexOf(opts.from);
  else if (opts.resume) startIdx = state.current ? STEP_IDS.indexOf(state.current) : STEP_IDS.length;
  const endIdx = opts.only ? startIdx + 1 : STEPS.length;
  if (opts.resume && !state.current) {
    say('✓ The pipeline is already complete (' + (state.finishedAt || '') + '). To run again: ' + RUN_CMD + ' --from <step>');
    out.state = state;
    return stop('OK', null);
  }
  if (startIdx > 0 && !opts.only) say('↻ Resuming from ' + STEP_IDS[startIdx] + ' (' + (startIdx + 1) + '/' + STEPS.length + ')');

  const total = STEPS.length;
  const label = (i, id) => '[' + String(i + 1).padStart(2) + '/' + total + '] ' + id.padEnd(22);
  const answerHint = () => Object.keys(state.answers).map((k) => ' --answer ' + k + '=' + state.answers[k]).join('');
  let worstDry = 'OK';

  // ---- stub mode ----
  // preflight מדווח stubCandidates (פנימית + לא ב-registry). ההחלטה כאן, באישור אדם, ונשמרת ב-state.stubMode.
  // כל שלב מקבל את MFE_MIGRATION_STUB – תמיד, גם ריק, כדי שערך שהוגדר ידנית בסביבה לא יפעיל stub
  const internal = stubMode.internalPackages();
  stubPackages = () => (state.stubMode && state.stubMode.approved === true ? stubMode.allowed(state.stubMode.packages, internal) : []);
  const stubEnv = () => ({ [stubMode.ENV_VAR]: stubPackages().join(',') });
  const stubPending = () => stubMode.allowed(state.stubCandidates || [], internal).length > 0 && !stubPackages().length;
  const sayStep = (line) => {
    say(line);
    if (stubPackages().length) say('   ⚠ STUB MODE – ' + stubPackages().join(', ') + ' is a local test stub: pipeline mechanics only, nothing is committed');
  };
  const stubGate = (i, step) => {
    const cands = stubMode.allowed(state.stubCandidates || [], internal);
    const registry = state.stubRegistry || 'the configured registry';
    const answer = state.answers['stub.mode'];
    const explain = () => {
      say('   ⚠ Internal package(s) not found in ' + registry + ': ' + cands.join(', '));
      say('   The pipeline can continue with a local test stub instead: ' + cands.map((p) => path.relative(SKILL_ROOT, stubMode.stubDir(p)).split(path.sep).join('/')).join(', '));
      say('   ⚠ Such a run validates the pipeline mechanics only – NOT the shared configuration against the real package.');
      say('   ⚠ No commits are made in such a run: package.json would depend on a local file: path.');
    };
    if (answer !== undefined && answer !== 'yes') {
      // לא אושר → נעצר כמו היום: חבילה שלא נמצאה ב-registry חוסמת את preflight
      const blockers = cands.map((p) => ({ message: p + ': package not found in ' + registry + ' (internal package; stub mode was not approved)', package: p }));
      say(label(0, STEP_IDS[0]) + '⛔ BLOCKED   stub mode not approved (--answer stub.mode=' + answer + ')');
      printBlocked(say, { blockers: blockers });
      delete state.answers['stub.mode'];
      state.current = STEP_IDS[0];
      state.completed = state.completed.filter((s) => s !== STEP_IDS[0]);
      state.results[STEP_IDS[0]] = 'BLOCKED';
      save();
      out.next = RUN_CMD + ' --resume';
      say('');
      say('Run where the internal registry is reachable, then: ' + out.next + ' (preflight runs again)');
      out.state = state;
      return stop('PAUSE', { kind: 'blocked', step: STEP_IDS[0], blockers: blockers });
    }
    if (answer === 'yes' || opts.yes || opts.dryRun) {
      const how = answer === 'yes' ? 'answer' : opts.yes ? '--yes' : 'dry-run';
      state.stubMode = { approved: true, packages: cands, registry: state.stubRegistry || null, approvedAt: deps.now().toISOString(), approvedBy: how };
      say('⚠ STUB MODE ' + (how === 'answer' ? 'approved' : how === '--yes' ? 'approved automatically (--yes)' : '[dry-run: simulated – a real run asks first]'));
      explain();
      save();
      return null;
    }
    save();
    say(label(i, step.id) + '⏸ PAUSE     Approval needed: continue with a local stub for ' + cands.join(', '));
    explain();
    out.steps.push(stepEntry(step.id, 'PAUSE', null, null, { reason: 'stub-mode' }));
    out.next = RUN_CMD + ' --resume --answer stub.mode=yes';
    say('');
    say('Next: ' + out.next);
    say('Without the stub: run where the internal registry is reachable – the pipeline stops here');
    out.state = state;
    return stop('PAUSE', { kind: 'stub-mode', step: step.id, key: 'stub.mode', packages: cands, registry: state.stubRegistry || null });
  };

  for (let i = startIdx; i < endIdx; i++) {
    const step = STEPS[i];
    const script = step.script || step.id;
    const args = ['--json'].concat(step.args || []);
    if (opts.dryRun) args.push('--dry-run');
    if (!opts.only) state.current = step.id;

    // ---- decision: stub mode (preflight reported stub candidates) – before any step after preflight ----
    if (step.id !== STEP_IDS[0] && stubPending()) {
      const stopped = stubGate(i, step);
      if (stopped) return stopped;
    }

    // ---- approval: source branch (target name is optional, defaults to digital_V2) ----
    if (step.approval === 'branch.source') {
      const targetAnswer = state.answers['branch.target'];
      const sourceAnswer = state.answers['branch.source'];
      if (targetAnswer) args.push('--target', targetAnswer);
      if (sourceAnswer) args.push('--source', sourceAnswer);
      else if (!opts.yes && !opts.dryRun) {
        // מה branch.js יעשה בפועל: מקור (ברירת מחדל: הבראנץ' הנוכחי) → יעד
        const probe = await runStep(script, ['--json', '--dry-run'].concat(targetAnswer ? ['--target', targetAnswer] : []), stubEnv());
        let plan = null;
        try { plan = JSON.parse(probe.stdout); } catch (_) { plan = null; }
        // NOOP = כבר עומדים על היעד; אין מה לאשר – השלב ירוץ (וישלים תג חסר אם צריך)
        if (!(plan && plan.result === 'NOOP')) {
          const mode = (plan && plan.targetMode) || 'create';
          const existing = mode === 'resume' || mode === 'adopt';
          // יעד קיים: אין מקור – branch.js מתעלם מ---source, והאישור הוא על הבראנץ' הנוכחי
          const source = existing ? (plan.previousBranch || null) : (plan && plan.sourceBranch) || null;
          const target = (plan && plan.targetBranch) || targetAnswer || null;
          save();
          if (mode === 'adopt') {
            // ההחלטה האנושית על בראנץ' שלא נוצר ע"י הסקיל נמצאת כאן – branch.js לא חוסם
            sayStep(label(i, step.id) + '⏸ PAUSE     Approval needed: run the migration on the EXISTING branch ' + (target || '<target>'));
            say('   ⚠ Branch ' + (target || '?') + ' already exists and was NOT created by this skill (no migration-start-* tag).');
            say('   ⚠ The migration will run on top of it; steps already done manually will return NOOP.');
            say('   ⚠ Restore point: a new tag ' + (plan.tag || 'migration-start-*') + ' on the current tip of ' + (target || '?') + '.');
          } else if (mode === 'resume') {
            sayStep(label(i, step.id) + '⏸ PAUSE     Approval needed: continue the existing migration on ' + (target || '<target>') + ' (start tag ' + (plan.tag || '?') + ')');
            say('   switch from: ' + (source || '?') + '   →   existing branch: ' + (target || '?'));
          } else {
            const current = source && plan.previousBranch === source ? ' (current branch)' : '';
            sayStep(label(i, step.id) + '⏸ PAUSE     Approval needed: create ' + (target || '<target>') + ' from ' + (source || '<source>') + current);
            say('   branch from: ' + (source || '?') + '   →   new branch: ' + (target || '?'));
          }
          if (plan && plan.blockers && plan.blockers.length) {
            say('   The pre-check found blockers to resolve before approving:');
            printBlocked(say, plan);
          }
          out.steps.push(stepEntry(step.id, 'PAUSE', null, plan, { reason: 'approval' }));
          out.next = RUN_CMD + ' --resume --answer branch.source=' + (source || '<source>') + (targetAnswer ? ' --answer branch.target=' + targetAnswer : '');
          say('');
          say('Next: ' + out.next);
          say('Different source: --answer branch.source=<name>   |   different target name: --answer branch.target=<name>');
          out.state = state;
          return stop('PAUSE', { kind: 'approval', step: step.id, key: 'branch.source', source: source, target: target, suggestion: source, targetMode: mode, targetExisted: existing });
        }
      }
    }

    // ---- run ----
    const t0 = Date.now();
    let r;
    if (script === 'commit' && stubPackages().length) {
      // מצב stub: שלבי ה-commit מדולגים לגמרי – commit.js לא מורץ בכלל (והוא עצמו מסרב גם כן)
      r = { exitCode: 0, stdout: JSON.stringify(stubMode.annotate({
        script: 'commit', result: 'NOOP', changes: [], manual: [], blockers: [], step: (step.args || [])[1] || null, skipped: 'stub-mode',
        notes: ['Skipped – stub mode. package.json depends on a local test stub (file:…); a migration branch with such a dependency is broken for anyone ' +
          'who pulls it, so nothing is committed in a stub run. The changes stay uncommitted in the working tree'],
      }, { active: true, packages: stubPackages() })) };
    } else {
      r = await runStep(script, args, stubEnv());
    }
    const ms = Date.now() - t0;
    let res = null;
    if (r.exitCode === 0) { try { res = JSON.parse(r.stdout); } catch (_) { res = null; } }

    // preflight: who may be stubbed. Available again → stub mode is dropped (never stub what the registry has)
    if (res && step.id === STEP_IDS[0]) {
      const cands = stubMode.allowed(res.stubCandidates || [], internal);
      if (cands.length) {
        const same = stubPackages().join(',') === cands.join(',');
        state.stubCandidates = cands;
        state.stubRegistry = (res.environment && res.environment.registryUrl) || null;
        if (!same) delete state.stubMode;
      } else {
        delete state.stubCandidates;
        delete state.stubRegistry;
        delete state.stubMode;
      }
    }

    if (!res) {
      const tail = (r.stderr || r.stdout || '').split(/\r?\n/).filter(Boolean).slice(-15);
      sayStep(label(i, step.id) + '💥 FAILED    ' + (r.exitCode === 0 ? 'output is not JSON' : 'exit ' + r.exitCode) + '  ' + fmtDuration(ms));
      tail.forEach((l) => say('   | ' + l));
      state.results[step.id] = 'FAILED';
      save();
      out.steps.push(stepEntry(step.id, 'FAILED', ms, null));
      out.next = RUN_CMD + ' --resume';
      say('');
      say('Script ' + script + ' crashed. After investigating, continue with: ' + out.next);
      out.state = state;
      return stop('FAILED', { kind: 'crash', step: step.id, exitCode: r.exitCode, tail: tail });
    }

    if (!opts.dryRun && SAVE_OUTPUT(step.id)) {
      try { fs.writeFileSync(path.join(root, '.migration', step.id + '.json'), JSON.stringify(res, null, 2) + '\n', 'utf8'); } catch (_) { /* report only */ }
    }
    state.results[step.id] = res.result;
    out.steps.push(stepEntry(step.id, res.result, ms, res));

    // ---- dry-run: simulate everything, never pause – but show why ----
    if (opts.dryRun) {
      sayStep(label(i, step.id) + (SYMBOL[res.result] || '?') + ' ' + res.result.padEnd(10) + fmtDuration(ms));
      printBlocked(say, res);
      if (res.result === 'BLOCKED') worstDry = 'BLOCKED';
      else if (res.result === 'REVIEW' && worstDry !== 'BLOCKED') worstDry = 'REVIEW';
      continue;
    }

    // ---- build: fix loop ----
    if (step.fixLoop && res.result !== 'OK' && res.result !== 'NOOP') {
      state.buildIterations++;
      const w = state.buildWindow;
      w.history.push(res.errorCount);
      const prev = w.history.length > 1 ? w.history[w.history.length - 2] : null;
      let stalled = 0;
      // סבבים רצופים בסוף ההיסטוריה שבהם מספר השגיאות לא ירד
      for (let k = w.history.length - 1; k > 0 && w.history[k] >= w.history[k - 1]; k--) stalled++;
      save();
      const trend = prev === null ? '' : ' (previous: ' + prev + ')';
      printDiagnostics(say, res);
      out.state = state;
      if (w.history.length >= BUILD_MAX_ROUNDS || stalled >= BUILD_NO_PROGRESS_ROUNDS) {
        const why = stalled >= BUILD_NO_PROGRESS_ROUNDS
          ? 'No progress: the error count did not go down in ' + stalled + ' rounds (' + w.history.join(' → ') + ')'
          : 'Reached the maximum of ' + BUILD_MAX_ROUNDS + ' fix rounds (' + w.history.join(' → ') + ')';
        sayStep(label(i, step.id) + '⏸ PAUSE     ' + why);
        state.buildWindow = { history: [] }; // --resume after a decision starts a new window
        save();
        out.next = RUN_CMD + ' --resume';
        say('');
        say('A human decision is needed before continuing the fixes. To run more rounds: ' + out.next);
        return stop('PAUSE', { kind: 'build-stalled', step: step.id, history: w.history, reason: why });
      }
      sayStep(label(i, step.id) + '🔧 PAUSE_FOR_FIX ' + res.errorCount + ' errors' + trend + ' | round ' + w.history.length + '/' + BUILD_MAX_ROUNDS + '  ' + fmtDuration(ms));
      out.next = RUN_CMD + ' --resume';
      say('');
      say('Fix the errors, then: ' + out.next);
      return stop('PAUSE_FOR_FIX', { kind: 'build', step: step.id, errorCount: res.errorCount, history: w.history.slice() });
    }

    if (res.result === 'OK' || res.result === 'NOOP') {
      sayStep(label(i, step.id) + SYMBOL.OK + ' ' + res.result.padEnd(10) + fmtDuration(ms));
      if (step.fixLoop) state.buildWindow = { history: [] };
      if (!opts.only) { if (state.completed.indexOf(step.id) === -1) state.completed.push(step.id); state.current = STEP_IDS[i + 1] || null; }
      save();
      continue;
    }

    if (res.result === 'REVIEW') {
      // השלב רץ ושינה – ההמשך הוא מהשלב הבא, אחרי שהאדם בדק
      sayStep(label(i, step.id) + '⏸ REVIEW    ' + fmtDuration(ms));
      if (!opts.only) { if (state.completed.indexOf(step.id) === -1) state.completed.push(step.id); state.current = STEP_IDS[i + 1] || null; }
      save();
      printReview(say, res);
      out.next = RUN_CMD + ' --resume' + answerHint();
      say('');
      say('After review, continue with: ' + (state.current ? RUN_CMD + ' --resume' : 'done (this was the last step)'));
      out.state = state;
      return stop('PAUSE', { kind: 'review', step: step.id, manual: res.manual, notes: res.notes });
    }

    // BLOCKED – השלב לא הושלם; --resume מריץ אותו שוב
    sayStep(label(i, step.id) + '⛔ BLOCKED   ' + fmtDuration(ms));
    save();
    printBlocked(say, res);
    out.next = RUN_CMD + ' --resume';
    say('');
    say('After fixing, continue with (the step runs again): ' + out.next);
    out.state = state;
    return stop('PAUSE', { kind: 'blocked', step: step.id, blockers: res.blockers });
  }

  out.state = state;
  if (opts.dryRun) {
    say('');
    say('[dry-run] Nothing was written. Step results are simulated – later steps depend on the changes of earlier ones');
    return stop(worstDry === 'OK' ? 'OK' : worstDry, null);
  }
  if (!opts.only) {
    state.current = null;
    state.finishedAt = deps.now().toISOString();
    save();
    say('');
    if (stubPackages().length) {
      say('⚠ The pipeline completed IN STUB MODE – ' + stubPackages().join(', ') + ' was a local test stub, not the real package.');
      say('⚠ Only the pipeline mechanics were validated (branch, codemods, install, build, report) – NOT the shared configuration against the real package.');
      say('⚠ Nothing was committed: the working tree is left with uncommitted changes, and package.json points to a local file: path – do not commit it.');
      say('⚠ Re-run on the internal network before any real use: ' + RUN_CMD + ' --from preflight. Report: MIGRATION-V2-REPORT.md (not committed)');
    } else {
      say('✅ The pipeline is complete. Report: MIGRATION-V2-REPORT.md (not committed)');
    }
  }
  return stop('OK', null);
}

function ensureGitExclude(deps, root, out) {
  try {
    const p = String(deps.cp.execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })).trim();
    const file = path.resolve(root, p);
    let text = '';
    try { text = deps.fs.readFileSync(file, 'utf8'); } catch (_) { text = ''; }
    if (text.split(/\r?\n/).some((l) => l.trim() === '.migration/' || l.trim() === '.migration')) return;
    deps.fs.mkdirSync(path.dirname(file), { recursive: true });
    deps.fs.writeFileSync(file, text + (text && !text.endsWith('\n') ? '\n' : '') + '# mfe-migration-v2 working files\n.migration/\n', 'utf8');
    out.notes.push('.migration/ was added to .git/info/exclude (local, never committed)');
  } catch (_) {
    // not a git repo – preflight will report it
  }
}

// One entry in out.steps: the step's reasons travel with its result, in every mode (incl. --dry-run / --json)
function stepEntry(id, result, ms, res, extra) {
  const e = { id: id, result: result };
  if (ms !== null) e.durationMs = ms;
  e.blockers = (res && res.blockers) || [];
  e.manual = (res && res.manual) || [];
  e.notes = (res && res.notes) || [];
  return Object.assign(e, extra || {});
}

function printReview(say, res) {
  (res.manual || []).forEach((m, i) => {
    say('  ' + (i + 1) + '. ' + (m.file ? m.file + (m.line ? ':' + m.line : '') + ' – ' : '') + m.reason);
    if (m.output) m.output.split(/\r?\n/).forEach((l) => say('       | ' + l));
    if (m.code) m.code.split('\n').forEach((l) => say('       | ' + l));
  });
  (res.changes || []).filter((c) => c.confidence === 'review').forEach((c) => say('  🔍 ' + c.file + (c.line ? ':' + c.line : '') + ' – ' + (c.reason || c.detail)));
  (res.notes || []).forEach((n) => say('  ℹ ' + n));
}

function printBlocked(say, res) {
  (res.blockers || []).forEach((b) => {
    say('  ⛔ ' + b.message);
    (b.files || []).slice(0, 30).forEach((f) => say('       ' + f));
    if (b.tree) b.tree.split(/\r?\n/).forEach((l) => say('     | ' + l));
    if (b.raw) b.raw.split(/\r?\n/).slice(-15).forEach((l) => say('     | ' + l));
    if (b.suggestion) say('     suggestion: ' + b.suggestion);
    if (b.code) b.code.split('\n').forEach((l) => say('     | ' + l));
  });
  (res.manual || []).forEach((m) => say('  ✋ ' + (m.file ? m.file + (m.line ? ':' + m.line : '') + ' – ' : '') + m.reason));
}

function printDiagnostics(say, res) {
  const diags = (res.diagnostics || []).filter((d) => d.severity === 'error');
  diags.slice(0, DIAG_PRINT_LIMIT).forEach((d) => {
    say('  ⛔ [' + d.source + (d.code ? ' ' + d.code : '') + '] ' + (d.file ? d.file + (d.line ? ':' + d.line + (d.column ? ':' + d.column : '') : '') : '(no file)') + ' – ' + d.message);
  });
  if (diags.length > DIAG_PRINT_LIMIT) say('  … and ' + (diags.length - DIAG_PRINT_LIMIT) + ' more – the full list (including raw) is in .migration/build-' + res.run + '.json');
  else if (res.run) say('  Full details (including raw): .migration/build-' + res.run + '.json');
}

function formatSummary(out) {
  const stub = out.stubMode
    ? '⚠ STUB MODE (' + (out.stubPackages || []).join(', ') + ') – pipeline mechanics only, NOT a validated migration; nothing committed. See MIGRATION-V2-REPORT.md\n'
    : '';
  return stub + 'RESULT: ' + out.result + '\n';
}

async function main(argv, deps, io) {
  io = io || { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) };
  try {
    const opts = parseArgs(argv || []);
    const res = await run(argv, Object.assign({}, deps, { print: opts.json ? () => {} : io.stdout }));
    io.stdout(opts.json ? JSON.stringify(res, null, 2) + '\n' : '\n' + formatSummary(res));
    return 0;
  } catch (err) {
    io.stderr(SCRIPT + ' crashed: ' + ((err && err.stack) || err) + '\n');
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.stdout.write('', () => process.exit(code)));
}

module.exports = { run: run, main: main, parseArgs: parseArgs, STEPS: STEPS };
