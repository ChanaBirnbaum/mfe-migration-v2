#!/usr/bin/env node
'use strict';

// run: the whole migration pipeline in order – stops at decision points, resumable from .migration/state.json.
// Run from the service repo root (cwd = the service). Every step runs as `node <skill>/scripts/<script>.js --json …`;
// its JSON result decides what happens next.
// Exit code 0 for every expected outcome (incl. PAUSE / FAILED step); 1 only if run.js itself crashes.

const path = require('path');

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
  { id: 'branch', approval: 'branch.target' },
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
    if (!v) { opts.errors.push(flag + ' דורש שם שלב'); return null; }
    if (STEP_IDS.indexOf(v) === -1) {
      const close = STEP_IDS.filter((id) => id.indexOf(v) !== -1);
      opts.errors.push('שלב לא מוכר: "' + v + '"' + (close.length ? ' – התכוונת ל-' + close.join(' / ') + '?' : '') + '. שלבים: ' + STEP_IDS.join(', '));
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
      if (eq <= 0) opts.errors.push('‎--answer צריך להיות בצורה key=value (התקבל "' + v + '")');
      else opts.answers[v.slice(0, eq)] = v.slice(eq + 1);
    } else if (a === '--from') opts.from = stepArg('--from', argv[++i]);
    else if (a === '--only') opts.only = stepArg('--only', argv[++i]);
    else opts.errors.push('פרמטר לא מוכר: ' + a);
  }
  if (opts.from && opts.only) opts.errors.push('לא ניתן לשלב --from ו---only');
  return opts;
}

// ---------------------------------------------------------------------------
// Default step runner: node scripts/<script>.js --json …  (no shell, array args)

function defaultRunStep(cwd, env) {
  const cp = require('child_process');
  return (script, args) => new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = cp.spawn(process.execPath, [path.join(__dirname, script + '.js')].concat(args), { cwd: cwd, env: env, windowsHide: true });
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
  const stop = (result, pause) => { out.result = result; out.pause = pause; return out; };

  if (opts.errors.length) {
    opts.errors.forEach((e) => say('⛔ ' + e));
    return stop('PAUSE', { kind: 'args', message: opts.errors.join('; ') });
  }

  // run from inside the skill → .migration/ and every edit would land in the skill itself. Stop before writing anything.
  const rel = path.relative(path.resolve(SKILL_ROOT), path.resolve(root));
  if (!rel || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    say('⏸ run.js הורץ מתוך תיקיית הסקיל (' + root + '). יש להריץ אותו משורש הריפו של השירות המוסב:');
    say('   cd <שורש השירות> && ' + RUN_CMD);
    return stop('PAUSE', { kind: 'skill-dir', message: 'cwd נמצא בתוך תיקיית הסקיל – לא נכתב דבר' });
  }

  // ---- state ----
  const statePath = path.join(root, STATE_FILE);
  let state = null;
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (_) { state = null; }
  let service = null;
  try { service = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name || null; } catch (_) { service = null; }

  if (opts.resume && !state) {
    say('⏸ אין ריצה להמשיך: ' + STATE_FILE + ' לא נמצא בתיקייה ' + root);
    out.next = RUN_CMD;
    return stop('PAUSE', { kind: 'no-state', message: STATE_FILE + ' לא נמצא – הרץ בלי --resume כדי להתחיל' });
  }
  if (state && service && state.service && state.service !== service && !opts.dryRun) {
    say('⏸ ' + STATE_FILE + ' שייך לשירות "' + state.service + '" ולא ל-"' + service + '" – לא ממשיכים');
    return stop('PAUSE', { kind: 'other-service', message: 'state.json שייך לשירות ' + state.service });
  }
  const unfinished = state && state.current;
  if (unfinished && !opts.resume && !opts.from && !opts.only && !opts.dryRun) {
    say('⏸ קיימת ריצה שלא הסתיימה (עצרה ב-' + state.current + ').');
    out.next = RUN_CMD + ' --resume';
    say('להמשך: ' + out.next + '   |   להתחלה מחדש: ' + RUN_CMD + ' --from preflight');
    return stop('PAUSE', { kind: 'unfinished', message: 'ריצה קודמת עצרה ב-' + state.current });
  }
  const fresh = !state || (!opts.resume && !opts.only && !(opts.from && unfinished));
  if (fresh) {
    state = {
      startedAt: deps.now().toISOString(), service: service, completed: [], current: STEP_IDS[0],
      results: {}, answers: {}, buildIterations: 0, buildWindow: { history: [] },
    };
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
    say('✓ הצינור כבר הושלם (' + (state.finishedAt || '') + '). להרצה מחדש: ' + RUN_CMD + ' --from <שלב>');
    out.state = state;
    return stop('OK', null);
  }
  if (startIdx > 0 && !opts.only) say('↻ ממשיך מ-' + STEP_IDS[startIdx] + ' (' + (startIdx + 1) + '/' + STEPS.length + ')');

  const total = STEPS.length;
  const label = (i, id) => '[' + String(i + 1).padStart(2) + '/' + total + '] ' + id.padEnd(22);
  const answerHint = () => Object.keys(state.answers).map((k) => ' --answer ' + k + '=' + state.answers[k]).join('');
  let worstDry = 'OK';

  for (let i = startIdx; i < endIdx; i++) {
    const step = STEPS[i];
    const script = step.script || step.id;
    const args = ['--json'].concat(step.args || []);
    if (opts.dryRun) args.push('--dry-run');
    if (!opts.only) state.current = step.id;

    // ---- approval: branch name ----
    if (step.approval === 'branch.target') {
      const answer = state.answers['branch.target'];
      if (answer) args.push('--target', answer);
      else if (!opts.yes && !opts.dryRun) {
        // default suggestion = the name branch.js would derive
        const probe = await runStep(script, ['--json', '--dry-run']);
        let suggestion = null;
        try { suggestion = JSON.parse(probe.stdout).targetBranch || null; } catch (_) { suggestion = null; }
        save();
        say(label(i, step.id) + '⏸ PAUSE     נדרש אישור שם בראנץ\'' + (suggestion ? ' (הצעה: ' + suggestion + ')' : ''));
        out.steps.push({ id: step.id, result: 'PAUSE', reason: 'approval' });
        out.next = RUN_CMD + ' --resume --answer branch.target=' + (suggestion || '<שם>');
        say('');
        say('להמשך: ' + out.next);
        out.state = state;
        return stop('PAUSE', { kind: 'approval', step: step.id, key: 'branch.target', suggestion: suggestion });
      }
    }

    // ---- run ----
    const t0 = Date.now();
    const r = await runStep(script, args);
    const ms = Date.now() - t0;
    let res = null;
    if (r.exitCode === 0) { try { res = JSON.parse(r.stdout); } catch (_) { res = null; } }

    if (!res) {
      const tail = (r.stderr || r.stdout || '').split(/\r?\n/).filter(Boolean).slice(-15);
      say(label(i, step.id) + '💥 FAILED    ' + (r.exitCode === 0 ? 'פלט שאינו JSON' : 'exit ' + r.exitCode) + '  ' + fmtDuration(ms));
      tail.forEach((l) => say('   | ' + l));
      state.results[step.id] = 'FAILED';
      save();
      out.steps.push({ id: step.id, result: 'FAILED', durationMs: ms });
      out.next = RUN_CMD + ' --resume';
      say('');
      say('הסקריפט ' + script + ' קרס. לאחר בירור – להמשך: ' + out.next);
      out.state = state;
      return stop('FAILED', { kind: 'crash', step: step.id, exitCode: r.exitCode, tail: tail });
    }

    if (!opts.dryRun && SAVE_OUTPUT(step.id)) {
      try { fs.writeFileSync(path.join(root, '.migration', step.id + '.json'), JSON.stringify(res, null, 2) + '\n', 'utf8'); } catch (_) { /* report only */ }
    }
    state.results[step.id] = res.result;
    out.steps.push({ id: step.id, result: res.result, durationMs: ms });

    // ---- dry-run: simulate everything, never pause ----
    if (opts.dryRun) {
      say(label(i, step.id) + (SYMBOL[res.result] || '?') + ' ' + res.result.padEnd(10) + fmtDuration(ms));
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
      const trend = prev === null ? '' : ' (קודם: ' + prev + ')';
      printDiagnostics(say, res);
      out.state = state;
      if (w.history.length >= BUILD_MAX_ROUNDS || stalled >= BUILD_NO_PROGRESS_ROUNDS) {
        const why = stalled >= BUILD_NO_PROGRESS_ROUNDS
          ? 'אין התקדמות: מספר השגיאות לא ירד ב-' + stalled + ' סבבים (' + w.history.join(' → ') + ')'
          : 'הגעה למקסימום ' + BUILD_MAX_ROUNDS + ' סבבי תיקון (' + w.history.join(' → ') + ')';
        say(label(i, step.id) + '⏸ PAUSE     ' + why);
        state.buildWindow = { history: [] }; // --resume אחרי החלטה מתחיל חלון חדש
        save();
        out.next = RUN_CMD + ' --resume';
        say('');
        say('נדרשת החלטה אנושית לפני המשך התיקונים. להמשך סבבים: ' + out.next);
        return stop('PAUSE', { kind: 'build-stalled', step: step.id, history: w.history, reason: why });
      }
      say(label(i, step.id) + '🔧 PAUSE_FOR_FIX ' + res.errorCount + ' שגיאות' + trend + ' | סבב ' + w.history.length + '/' + BUILD_MAX_ROUNDS + '  ' + fmtDuration(ms));
      out.next = RUN_CMD + ' --resume';
      say('');
      say('תקן את השגיאות ואז: ' + out.next);
      return stop('PAUSE_FOR_FIX', { kind: 'build', step: step.id, errorCount: res.errorCount, history: w.history.slice() });
    }

    if (res.result === 'OK' || res.result === 'NOOP') {
      say(label(i, step.id) + SYMBOL.OK + ' ' + res.result.padEnd(10) + fmtDuration(ms));
      if (step.fixLoop) state.buildWindow = { history: [] };
      if (!opts.only) { if (state.completed.indexOf(step.id) === -1) state.completed.push(step.id); state.current = STEP_IDS[i + 1] || null; }
      save();
      continue;
    }

    if (res.result === 'REVIEW') {
      // השלב רץ ושינה – ההמשך הוא מהשלב הבא, אחרי שהאדם בדק
      say(label(i, step.id) + '⏸ REVIEW    ' + fmtDuration(ms));
      if (!opts.only) { if (state.completed.indexOf(step.id) === -1) state.completed.push(step.id); state.current = STEP_IDS[i + 1] || null; }
      save();
      printReview(say, res);
      out.next = RUN_CMD + ' --resume' + answerHint();
      say('');
      say('לאחר הבדיקה – להמשך: ' + (state.current ? RUN_CMD + ' --resume' : 'סיום (השלב האחרון)'));
      out.state = state;
      return stop('PAUSE', { kind: 'review', step: step.id, manual: res.manual, notes: res.notes });
    }

    // BLOCKED – השלב לא הושלם; --resume מריץ אותו שוב
    say(label(i, step.id) + '⛔ BLOCKED   ' + fmtDuration(ms));
    save();
    printBlocked(say, res);
    out.next = RUN_CMD + ' --resume';
    say('');
    say('לאחר הטיפול – להמשך (השלב ירוץ שוב): ' + out.next);
    out.state = state;
    return stop('PAUSE', { kind: 'blocked', step: step.id, blockers: res.blockers });
  }

  out.state = state;
  if (opts.dryRun) {
    say('');
    say('[dry-run] לא נכתב דבר. תוצאות השלבים הן הדמיה – שלבים מאוחרים תלויים בשינויים של הקודמים');
    return stop(worstDry === 'OK' ? 'OK' : worstDry, null);
  }
  if (!opts.only) {
    state.current = null;
    state.finishedAt = deps.now().toISOString();
    save();
    say('');
    say('✅ הצינור הושלם. הדוח: MIGRATION-V2-REPORT.md (לא בוצע לו commit)');
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
    out.notes.push('.migration/ נוסף ל-.git/info/exclude (מקומי, לא נכנס ל-commit)');
  } catch (_) {
    // not a git repo – preflight will report it
  }
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
    if (b.suggestion) say('     הצעה: ' + b.suggestion);
    if (b.code) b.code.split('\n').forEach((l) => say('     | ' + l));
  });
  (res.manual || []).forEach((m) => say('  ✋ ' + (m.file ? m.file + (m.line ? ':' + m.line : '') + ' – ' : '') + m.reason));
}

function printDiagnostics(say, res) {
  const diags = (res.diagnostics || []).filter((d) => d.severity === 'error');
  diags.slice(0, DIAG_PRINT_LIMIT).forEach((d) => {
    say('  ⛔ [' + d.source + (d.code ? ' ' + d.code : '') + '] ' + (d.file ? d.file + (d.line ? ':' + d.line + (d.column ? ':' + d.column : '') : '') : '(ללא קובץ)') + ' – ' + d.message);
  });
  if (diags.length > DIAG_PRINT_LIMIT) say('  … ועוד ' + (diags.length - DIAG_PRINT_LIMIT) + ' – הרשימה המלאה (כולל raw) ב-.migration/build-' + res.run + '.json');
  else if (res.run) say('  פירוט מלא (כולל raw): .migration/build-' + res.run + '.json');
}

function formatSummary(out) {
  return 'RESULT: ' + out.result + '\n';
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
