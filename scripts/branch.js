#!/usr/bin/env node
'use strict';

// branch: create the migration work branch from an up-to-date source branch and tag the starting point.
// Every git call goes through execFileSync with an argument array – user input is never put into a command string.

const path = require('path');

const SCRIPT = 'branch';
const DEFAULT_SOURCE = 'digital_V2';
const NETWORK_TIMEOUT_MS = 60000;
const LOCAL_TIMEOUT_MS = 30000;
const MAX_LISTED_FILES = 30;

const AUTH_RE = /Authentication failed|could not read (Username|Password)|terminal prompts disabled|Permission denied \(publickey|Host key verification failed|HTTP Basic: Access denied|The requested URL returned error: 40[13]|\b40[13]\b.*(Unauthorized|Forbidden)|invalid credentials/i;
const DIVERGED_RE = /Not possible to fast-forward|diverg|non-fast-forward|cannot fast-forward/i;
const NO_REMOTE_RE = /'origin' does not appear to be a git repository|No such remote/i;

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { source: DEFAULT_SOURCE, target: null, dryRun: false, json: false, errors: [] };
  const takeValue = (flag, i) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) { opts.errors.push(flag + ' דורש ערך'); return null; }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--source' || a === '--target') {
      const v = takeValue(a, i);
      if (v !== null) { opts[a.slice(2)] = v; i++; }
    } else if (a.startsWith('--source=')) opts.source = a.slice('--source='.length);
    else if (a.startsWith('--target=')) opts.target = a.slice('--target='.length);
    else opts.errors.push('פרמטר לא מוכר: ' + a);
  }
  return opts;
}

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
const ymdHm = (d) => ymd(d) + '-' + pad(d.getHours()) + pad(d.getMinutes());

// "@ips/hasava-mfe" -> "hasava-mfe"; anything not valid in a ref segment -> "-"
function slugify(name) {
  return String(name || '')
    .replace(/^@[^/]+\//, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '')
    .replace(/\.lock$/i, '');
}

// For display only – never executed as a string.
function displayCommand(args) {
  return 'git ' + args.map((a) => (/^[\w./@:=+-]+$/.test(a) ? a : JSON.stringify(a))).join(' ');
}

function firstLine(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] || '';
}

function makeGit(deps) {
  return function git(args, timeoutMs) {
    try {
      const stdout = deps.execFileSync('git', args, {
        cwd: deps.cwd,
        env: deps.env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs || LOCAL_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024,
      });
      return { ok: true, status: 0, stdout: String(stdout || ''), stderr: '' };
    } catch (err) {
      // רק כשל של תהליך git (קוד יציאה / spawn / timeout) הוא צפוי; כל השאר הוא באג → קריסה
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

// Human message for a failed network command (fetch / ls-remote / pull).
function networkFailure(r, what) {
  const detail = firstLine(r.stderr) || r.message;
  if (r.timedOut) return { message: what + ' לא הסתיים תוך ' + Math.round(NETWORK_TIMEOUT_MS / 1000) + ' שניות – בדוק חיבור ל-origin', kind: 'timeout' };
  if (AUTH_RE.test(r.stderr)) return { message: 'כשל אימות מול origin (' + what + '): ' + detail + ' – בדוק הרשאות / credentials', kind: 'auth' };
  if (NO_REMOTE_RE.test(r.stderr)) return { message: 'לא מוגדר remote בשם origin', kind: 'no-remote' };
  return { message: what + ' נכשל: ' + detail, kind: 'error' };
}

// ---------------------------------------------------------------------------

function run(argv, overrides) {
  const deps = Object.assign({
    execFileSync: require('child_process').execFileSync,
    fs: require('fs'),
    cwd: process.cwd(),
    env: Object.assign({}, process.env, {
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      // הודעות git באנגלית, כדי שזיהוי diverged / כשל אימות יעבוד בכל locale
      LC_ALL: 'C',
      LANGUAGE: 'C',
    }),
    now: new Date(),
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
    sourceBranch: opts.source,
    targetBranch: opts.target,
    tag: null,
    previousHead: null,
    previousBranch: null,
    commands: [],
  };
  const block = (message, extra) => res.blockers.push(Object.assign({ message: message }, extra || {}));
  const finish = () => {
    if (res.blockers.length) res.result = 'BLOCKED';
    return res;
  };

  if (opts.errors.length) {
    opts.errors.forEach((m) => block(m, { check: 'args' }));
    return finish();
  }

  // --- repo -----------------------------------------------------------------
  const repo = git(['rev-parse', '--is-inside-work-tree']);
  if (!repo.ok || repo.stdout.trim() !== 'true') {
    block(repo.notFound ? 'git לא מותקן או לא נמצא ב-PATH' : 'התיקייה ' + deps.cwd + ' אינה git repo', { check: 'git-repo' });
    return finish();
  }

  const validBranch = (name, label) => {
    if (!name || name.startsWith('-')) { block('שם בראנץ\' ' + label + ' לא תקין: "' + name + '"', { check: 'branch-name' }); return false; }
    const r = git(['check-ref-format', '--branch', name]);
    if (!r.ok) { block('שם בראנץ\' ' + label + ' לא תקין: "' + name + '"', { check: 'branch-name' }); return false; }
    return true;
  };
  const sourceValid = validBranch(opts.source, 'מקור');

  // --- current branch / detached HEAD ----------------------------------------
  const sym = git(['symbolic-ref', '--short', '-q', 'HEAD']);
  if (sym.ok && sym.stdout.trim()) {
    res.previousBranch = sym.stdout.trim();
  } else {
    block('HEAD במצב detached – עבור לבראנץ\' לפני יצירת בראנץ\' העבודה', { check: 'detached-head' });
  }
  const head = git(['rev-parse', '--verify', '-q', 'HEAD']);
  res.previousHead = head.ok && head.stdout.trim() ? head.stdout.trim() : null;

  // --- target name -----------------------------------------------------------
  let derivedPrefix = null;
  if (opts.target === null) {
    let name = null;
    try {
      const pkg = JSON.parse(deps.fs.readFileSync(path.join(deps.cwd, 'package.json'), 'utf8'));
      name = pkg && typeof pkg.name === 'string' ? slugify(pkg.name) : null;
    } catch (err) {
      name = null;
    }
    if (!name) {
      block('לא ניתן לגזור שם בראנץ\' – אין name תקין ב-package.json. העבר --target במפורש', { check: 'target-name' });
    } else {
      derivedPrefix = 'feature/migration-v2-' + name + '-';
      res.targetBranch = derivedPrefix + ymd(deps.now);
    }
  }
  const target = res.targetBranch;
  const targetValid = target ? validBranch(target, 'יעד') : false;
  if (targetValid && target === opts.source) block('בראנץ\' היעד זהה לבראנץ\' המקור', { check: 'branch-name' });

  // --- already done → NOOP ---------------------------------------------------
  if (res.previousBranch && targetValid &&
      (res.previousBranch === target || (derivedPrefix && res.previousBranch.startsWith(derivedPrefix)))) {
    res.result = 'NOOP';
    res.targetBranch = res.previousBranch;
    res.notes.push('כבר נמצאים על בראנץ\' העבודה ' + res.previousBranch + ' – אין מה לעשות');
    return res;
  }

  // --- clean working tree ----------------------------------------------------
  const status = git(['status', '--porcelain']);
  if (!status.ok) {
    block('git status נכשל: ' + (firstLine(status.stderr) || status.message), { check: 'git-clean' });
  } else {
    const files = status.stdout.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim());
    if (files.length) {
      // לא מבצעים stash – ההחלטה מה לעשות בשינויים פתוחים היא של אדם
      block('עץ העבודה אינו נקי (' + files.length + ' קבצים). בצע commit או stash ידנית ואז הרץ שוב', { check: 'git-clean', files: files });
    }
  }

  // --- local refs ------------------------------------------------------------
  const localBranchExists = (name) => git(['show-ref', '--verify', '--quiet', 'refs/heads/' + name]).ok;
  const tag = 'migration-start-' + ymdHm(deps.now);
  res.tag = tag;
  if (git(['show-ref', '--verify', '--quiet', 'refs/tags/' + tag]).ok) {
    block('התג ' + tag + ' כבר קיים – המתן דקה והרץ שוב', { check: 'tag-exists' });
  }

  // --- origin (read-only, also in dry-run) -----------------------------------
  let remoteHeads = null;
  if (sourceValid) {
    const ls = git(['ls-remote', '--heads', 'origin'], NETWORK_TIMEOUT_MS);
    if (!ls.ok) {
      const f = networkFailure(ls, 'git ls-remote');
      block(f.message, { check: 'origin', kind: f.kind });
    } else {
      remoteHeads = new Set(ls.stdout.split(/\r?\n/).map((l) => l.split('\t')[1]).filter(Boolean)
        .map((ref) => ref.replace(/^refs\/heads\//, '')));
      if (!remoteHeads.has(opts.source)) {
        block('הבראנץ\' ' + opts.source + ' לא קיים ב-origin', { check: 'source-missing' });
      }
    }
  }

  if (targetValid) {
    const existsLocal = localBranchExists(target);
    const existsRemote = !!(remoteHeads && remoteHeads.has(target));
    if (existsLocal || existsRemote) {
      let suggestion = null;
      for (let n = 2; n < 100; n++) {
        const candidate = target + '-' + n;
        if (!localBranchExists(candidate) && !(remoteHeads && remoteHeads.has(candidate))) { suggestion = candidate; break; }
      }
      const where = existsLocal && existsRemote ? 'מקומית וב-origin' : existsLocal ? 'מקומית' : 'ב-origin';
      block('בראנץ\' היעד ' + target + ' כבר קיים ' + where + (suggestion ? '. הצעה: --target ' + suggestion : ''), {
        check: 'target-exists', suggestion: suggestion,
      });
    }
  }

  if (res.blockers.length) return finish();

  // --- plan ------------------------------------------------------------------
  const source = opts.source;
  const plan = [{ args: ['fetch', 'origin', '--prune'], step: 'fetch', network: true }];
  if (res.previousBranch !== source) {
    plan.push(localBranchExists(source)
      ? { args: ['checkout', source], step: 'checkout-source' }
      : { args: ['checkout', '-b', source, '--track', 'origin/' + source], step: 'checkout-source' });
  } else {
    res.notes.push('כבר על ' + source + ' – דילוג על checkout');
  }
  // --no-rebase: גם אם pull.rebase=true בקונפיג, לעולם לא מבצעים rebase
  plan.push({ args: ['pull', '--ff-only', '--no-rebase', 'origin', source], step: 'pull', network: true });
  plan.push({ args: ['checkout', '-b', target], step: 'create-branch' });
  plan.push({ args: ['tag', tag], step: 'tag' });

  if (opts.dryRun) {
    res.commands = plan.map((p) => ({ command: displayCommand(p.args), status: 'planned' }));
    return res;
  }

  // --- execute ---------------------------------------------------------------
  let movedOffPrevious = false;
  const rollback = () => {
    if (!movedOffPrevious || !res.previousBranch) return;
    const r = git(['checkout', res.previousBranch]);
    res.commands.push({ command: displayCommand(['checkout', res.previousBranch]), status: r.ok ? 'done' : 'failed' });
    res.notes.push(r.ok
      ? 'הוחזר לבראנץ\' הקודם ' + res.previousBranch
      : 'לא ניתן לחזור לבראנץ\' ' + res.previousBranch + ': ' + firstLine(r.stderr));
  };

  for (const p of plan) {
    const r = git(p.args, p.network ? NETWORK_TIMEOUT_MS : LOCAL_TIMEOUT_MS);
    res.commands.push({ command: displayCommand(p.args), status: r.ok ? 'done' : 'failed' });
    if (r.ok) {
      if (p.step === 'checkout-source') movedOffPrevious = true;
      if (p.step === 'create-branch') {
        movedOffPrevious = false; // הבראנץ' נוצר – לא חוזרים אחורה
        res.changes.push({ file: 'refs/heads/' + target, rule: 'BRANCH.CREATE', confidence: 'auto' });
      }
      if (p.step === 'tag') res.changes.push({ file: 'refs/tags/' + tag, rule: 'BRANCH.TAG', confidence: 'auto' });
      if (p.step === 'pull') {
        // ff-only לא מגן מקומיטים מקומיים שלא נדחפו – הם ייכנסו לבראנץ' העבודה
        const ahead = git(['rev-list', '--count', 'origin/' + source + '..HEAD']);
        const n = ahead.ok ? parseInt(ahead.stdout.trim(), 10) : 0;
        if (n > 0) {
          res.result = 'REVIEW';
          res.notes.push('ל-' + source + ' המקומי יש ' + n + ' קומיטים שלא קיימים ב-origin – הם ייכללו בבראנץ\' העבודה. ודא שזה מכוון');
        }
      }
      continue;
    }

    // failure
    if (p.step === 'fetch') {
      const f = networkFailure(r, 'git fetch');
      block(f.message, { check: 'fetch', kind: f.kind });
    } else if (p.step === 'pull') {
      if (DIVERGED_RE.test(r.stderr)) {
        block('ה-' + source + ' המקומי וה-origin/' + source + ' התפצלו (diverged) – לא ניתן fast-forward. ' +
          'לא מבוצע merge או rebase; יש ליישב ידנית', { check: 'diverged' });
      } else {
        const f = networkFailure(r, 'git pull');
        block(f.message, { check: 'pull', kind: f.kind });
      }
    } else if (p.step === 'tag') {
      block('הבראנץ\' ' + target + ' נוצר, אך יצירת התג ' + tag + ' נכשלה: ' + (firstLine(r.stderr) || r.message), { check: 'tag' });
    } else {
      block(displayCommand(p.args) + ' נכשל: ' + (firstLine(r.stderr) || r.message), { check: p.step });
    }
    rollback();
    return finish();
  }
  return finish();
}

// ---------------------------------------------------------------------------

function formatText(res) {
  const L = [];
  const sym = { done: '✓', failed: '⛔', planned: '→' };
  L.push('branch – יצירת בראנץ\' עבודה' + (res.dryRun ? ' [dry-run]' : ''));
  L.push('   מקור: ' + (res.sourceBranch || '?') + ' | יעד: ' + (res.targetBranch || '?') + ' | תג: ' + (res.tag || '?'));
  L.push('   HEAD קודם: ' + (res.previousBranch || 'detached') + ' @ ' + (res.previousHead ? res.previousHead.slice(0, 12) : '?'));
  if (res.commands.length) {
    L.push('');
    res.commands.forEach((c) => L.push(sym[c.status] + ' ' + c.command));
  }
  if (res.blockers.length) {
    L.push('');
    res.blockers.forEach((b) => {
      L.push('⛔ ' + b.message);
      (b.files || []).slice(0, MAX_LISTED_FILES).forEach((f) => L.push('     ' + f));
      if (b.files && b.files.length > MAX_LISTED_FILES) L.push('     ... ועוד ' + (b.files.length - MAX_LISTED_FILES));
    });
  }
  res.notes.forEach((n) => L.push('⚠ ' + n));
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
    io.stderr('branch crashed: ' + ((err && err.stack) || err) + '\n');
    return 1;
  }
}

if (require.main === module) {
  const code = main(process.argv.slice(2));
  process.stdout.write('', () => process.exit(code));
}

module.exports = { run: run, main: main, parseArgs: parseArgs, slugify: slugify, formatText: formatText };
