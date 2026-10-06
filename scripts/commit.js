#!/usr/bin/env node
'use strict';

// commit: one topical commit per migration step. Never pushes.
// Every git call goes through execFileSync with an argument array – no command strings.

const os = require('os');
const path = require('path');

const SCRIPT = 'commit';
const STEPS_FILE = path.join(__dirname, '..', 'reference', 'commit-steps.json');
const GIT_TIMEOUT_MS = 120000; // commit may run hooks
const MAX_LISTED_FILES = 30;

function parseArgs(argv) {
  const opts = { step: null, dryRun: false, json: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--step') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) opts.errors.push('‎--step דורש ערך');
      else { opts.step = v; i++; }
    } else if (a.startsWith('--step=')) opts.step = a.slice('--step='.length);
    else opts.errors.push('פרמטר לא מוכר: ' + a);
  }
  return opts;
}

function firstLines(text, n) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, n || 3).join(' | ');
}

function displayCommand(args) {
  return 'git ' + args.map((a) => (/^[\w./@:=+-]+$/.test(a) ? a : JSON.stringify(a))).join(' ');
}

function makeGit(deps) {
  return function git(args, env) {
    try {
      const stdout = deps.execFileSync('git', args, {
        cwd: deps.cwd,
        env: env || deps.env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 50 * 1024 * 1024,
      });
      return { ok: true, status: 0, stdout: String(stdout || ''), stderr: '' };
    } catch (err) {
      // רק כשל של תהליך git הוא צפוי; כל השאר הוא באג → קריסה
      if (err.status === undefined && !err.code) throw err;
      return {
        ok: false,
        status: typeof err.status === 'number' ? err.status : null,
        stdout: String(err.stdout || ''),
        stderr: String(err.stderr || ''),
        timedOut: err.code === 'ETIMEDOUT',
        notFound: err.code === 'ENOENT',
        message: err.message,
      };
    }
  };
}

function run(argv, overrides) {
  const deps = Object.assign({
    execFileSync: require('child_process').execFileSync,
    fs: require('fs'),
    cwd: process.cwd(),
    env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C', LANGUAGE: 'C' }),
    tmpDir: os.tmpdir(),
  }, overrides || {});

  const opts = parseArgs(argv || []);
  const git = makeGit(deps);
  const res = {
    script: SCRIPT,
    result: 'OK',
    changes: [],
    manual: [],
    blockers: [],
    notes: [],
    dryRun: opts.dryRun,
    step: opts.step,
    sha: null,
    filesChanged: 0,
    message: null,
    branch: null,
    commands: [],
  };
  const block = (message, extra) => res.blockers.push(Object.assign({ message: message }, extra || {}));
  const blocked = () => { res.result = 'BLOCKED'; return res; };

  if (opts.errors.length) { opts.errors.forEach((m) => block(m, { check: 'args' })); return blocked(); }

  let config;
  try {
    config = JSON.parse(require('fs').readFileSync(STEPS_FILE, 'utf8'));
  } catch (err) {
    block('לא ניתן לטעון את reference/commit-steps.json: ' + err.message, { check: 'config' });
    return blocked();
  }
  const steps = Object.keys(config.steps);
  if (!opts.step || steps.indexOf(opts.step) === -1) {
    block('‎--step חייב להיות אחד מ: ' + steps.join(' | ') + (opts.step ? ' (התקבל "' + opts.step + '")' : ''), { check: 'step' });
    return blocked();
  }

  // --- repo state ------------------------------------------------------------
  const repo = git(['rev-parse', '--is-inside-work-tree']);
  if (!repo.ok || repo.stdout.trim() !== 'true') {
    block(repo.notFound ? 'git לא מותקן או לא נמצא ב-PATH' : 'התיקייה ' + deps.cwd + ' אינה git repo', { check: 'git-repo' });
    return blocked();
  }

  const sym = git(['symbolic-ref', '--short', '-q', 'HEAD']);
  if (sym.ok && sym.stdout.trim()) {
    res.branch = sym.stdout.trim();
    if (config.protectedBranches.indexOf(res.branch) !== -1) {
      block('לא מבצעים commit ישירות על ' + res.branch + ' – הרץ קודם את branch.js', { check: 'protected-branch' });
    }
  } else {
    block('HEAD במצב detached – commit לא יהיה שייך לאף בראנץ\'', { check: 'detached-head' });
  }

  const gitPath = (name) => {
    const r = git(['rev-parse', '--git-path', name]);
    return r.ok ? path.resolve(deps.cwd, r.stdout.trim()) : null;
  };
  const inProgress = [
    ['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'],
    ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase / am'],
  ].filter((x) => { const p = gitPath(x[0]); return p && deps.fs.existsSync(p); }).map((x) => x[1]);
  if (inProgress.length) {
    block('יש פעולת ' + inProgress[0] + ' באמצע – יש להשלים או לבטל אותה ידנית', { check: 'operation-in-progress' });
  }

  // git add -A היה מסמן קונפליקטים כפתורים – חובה לעצור לפני
  const unmerged = git(['diff', '--name-only', '-z', '--diff-filter=U']);
  const conflicted = unmerged.ok ? unmerged.stdout.split('\0').filter(Boolean) : [];
  if (conflicted.length) {
    block('יש ' + conflicted.length + ' קבצים עם קונפליקט לא פתור', { check: 'conflicts', files: conflicted });
  }

  if (res.blockers.length) return blocked();

  // --- stage -----------------------------------------------------------------
  // ב-dry-run עובדים על עותק זמני של ה-index: אותו נתיב קוד בדיוק, בלי לגעת ב-index האמיתי
  let env = deps.env;
  let tmp = null;
  try {
    if (opts.dryRun) {
      const indexPath = gitPath('index');
      tmp = deps.fs.mkdtempSync(path.join(deps.tmpDir, 'commit-dryrun-'));
      const tmpIndex = path.join(tmp, 'index');
      if (indexPath && deps.fs.existsSync(indexPath)) deps.fs.copyFileSync(indexPath, tmpIndex);
      env = Object.assign({}, deps.env, { GIT_INDEX_FILE: tmpIndex });
    }

    const addArgs = ['add', '-A', '--', '.'].concat((config.excludePaths || []).map((p) => ':(exclude)' + p));
    const add = git(addArgs, env);
    res.commands.push({ command: displayCommand(addArgs), status: add.ok ? (opts.dryRun ? 'simulated' : 'done') : 'failed' });
    if (!add.ok) {
      block('git add נכשל: ' + (firstLines(add.stderr) || add.message), { check: 'add' });
      return blocked();
    }

    const diff = git(['diff', '--cached', '--name-only', '-z'], env);
    if (!diff.ok) {
      block('git diff --cached נכשל: ' + (firstLines(diff.stderr) || diff.message), { check: 'diff' });
      return blocked();
    }
    const files = diff.stdout.split('\0').filter(Boolean);
    res.filesChanged = files.length;
    if (files.length === 0) {
      res.result = 'NOOP';
      res.notes.push('אין שינויים לשלב ' + opts.step);
      return res;
    }

    res.message = config.messagePrefix + '(' + opts.step + '): ' + config.steps[opts.step] + ' (' + files.length + ' files)';
    const commitArgs = ['commit', '-q', '-m', res.message];
    const rule = 'COMMIT.' + opts.step.toUpperCase().replace(/-/g, '_');
    files.forEach((f) => res.changes.push({ file: f, rule: rule, confidence: 'auto' }));

    if (opts.dryRun) {
      res.commands.push({ command: displayCommand(commitArgs), status: 'planned' });
      return res;
    }

    const commit = git(commitArgs, env);
    res.commands.push({ command: displayCommand(commitArgs), status: commit.ok ? 'done' : 'failed' });
    if (!commit.ok) {
      const out = commit.stderr + '\n' + commit.stdout;
      let msg;
      if (/Please tell me who you are|unable to auto-detect email/i.test(out)) msg = 'לא מוגדרים user.name / user.email ב-git';
      else if (commit.timedOut) msg = 'git commit לא הסתיים תוך ' + GIT_TIMEOUT_MS / 1000 + ' שניות (hook? חתימת GPG?)';
      else msg = 'git commit נכשל (ייתכן hook): ' + (firstLines(out, 5) || commit.message);
      block(msg, { check: 'commit' });
      res.changes = [];
      res.notes.push('השינויים נשארו ב-staging; לא בוצע commit');
      return blocked();
    }
    const head = git(['rev-parse', 'HEAD']);
    res.sha = head.ok ? head.stdout.trim() : null;
    return res;
  } finally {
    if (tmp) {
      try { deps.fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* temp dir only */ }
    }
  }
}

function formatText(res) {
  const L = [];
  const sym = { done: '✓', simulated: '✓', failed: '⛔', planned: '→' };
  L.push('commit – ' + (res.step || '?') + (res.dryRun ? ' [dry-run]' : '') + (res.branch ? ' על ' + res.branch : ''));
  res.commands.forEach((c) => L.push(sym[c.status] + ' ' + c.command));
  if (res.result === 'OK') {
    L.push('');
    L.push((res.dryRun ? '📝 היה נוצר: ' : '📝 ') + res.message);
    if (res.sha) L.push('   sha: ' + res.sha);
    res.changes.slice(0, MAX_LISTED_FILES).forEach((c) => L.push('     ' + c.file));
    if (res.changes.length > MAX_LISTED_FILES) L.push('     ... ועוד ' + (res.changes.length - MAX_LISTED_FILES));
  }
  res.blockers.forEach((b) => {
    L.push('⛔ ' + b.message);
    (b.files || []).slice(0, MAX_LISTED_FILES).forEach((f) => L.push('     ' + f));
  });
  res.notes.forEach((n) => L.push('ℹ ' + n));
  L.push('RESULT: ' + res.result);
  return L.join('\n') + '\n';
}

function main(argv, deps, io) {
  io = io || {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  };
  try {
    const opts = parseArgs(argv || []);
    const res = run(argv, deps);
    io.stdout(opts.json ? JSON.stringify(res, null, 2) + '\n' : formatText(res));
    return 0;
  } catch (err) {
    io.stderr('commit crashed: ' + ((err && err.stack) || err) + '\n');
    return 1;
  }
}

if (require.main === module) {
  const code = main(process.argv.slice(2));
  process.stdout.write('', () => process.exit(code));
}

module.exports = { run: run, main: main, parseArgs: parseArgs, formatText: formatText };
