#!/usr/bin/env node
'use strict';

// branch: create the target branch (digital_V2 by default) from the source branch (the current one by default),
// after bringing the source up to date with its upstream, and tag the starting point.
// Every git call goes through execFileSync with an argument array – user input is never put into a command string.

const path = require('path');

const SCRIPT = 'branch';
const STEPS_FILE = path.join(__dirname, '..', 'reference', 'commit-steps.json');
const NETWORK_TIMEOUT_MS = 60000;
const LOCAL_TIMEOUT_MS = 30000;
const MAX_LISTED_FILES = 30;

const AUTH_RE = /Authentication failed|could not read (Username|Password)|terminal prompts disabled|Permission denied \(publickey|Host key verification failed|HTTP Basic: Access denied|The requested URL returned error: 40[13]|\b40[13]\b.*(Unauthorized|Forbidden)|invalid credentials/i;
const DIVERGED_RE = /Not possible to fast-forward|diverg|non-fast-forward|cannot fast-forward/i;
const NO_REMOTE_RE = /'origin' does not appear to be a git repository|No such remote/i;

// ---------------------------------------------------------------------------

// null = not given; the defaults come from reference/commit-steps.json (defaultSource null = the current branch)
function parseArgs(argv) {
  const opts = { source: null, target: null, dryRun: false, json: false, errors: [] };
  const takeValue = (flag, i) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) { opts.errors.push(flag + ' requires a value'); return null; }
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
    else opts.errors.push('Unknown argument: ' + a);
  }
  return opts;
}

function loadConfig() {
  const c = JSON.parse(require('fs').readFileSync(STEPS_FILE, 'utf8'));
  return { defaultTarget: c.defaultTarget || null, defaultSource: c.defaultSource || null };
}

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
const ymdHm = (d) => ymd(d) + '-' + pad(d.getHours()) + pad(d.getMinutes());

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
  if (r.timedOut) return { message: what + ' did not finish within ' + Math.round(NETWORK_TIMEOUT_MS / 1000) + ' seconds – check the connection to origin', kind: 'timeout' };
  if (AUTH_RE.test(r.stderr)) return { message: 'Authentication to origin failed (' + what + '): ' + detail + ' – check permissions / credentials', kind: 'auth' };
  if (NO_REMOTE_RE.test(r.stderr)) return { message: 'No remote named origin is configured', kind: 'no-remote' };
  return { message: what + ' failed: ' + detail, kind: 'error' };
}

// ---------------------------------------------------------------------------

function run(argv, overrides) {
  const deps = Object.assign({
    execFileSync: require('child_process').execFileSync,
    cwd: process.cwd(),
    env: Object.assign({}, process.env, {
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      // הודעות git באנגלית, כדי שזיהוי diverged / כשל אימות יעבוד בכל locale
      LC_ALL: 'C',
      LANGUAGE: 'C',
    }),
    now: new Date(),
    config: null,
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
    sourceBranch: null,
    targetBranch: null,
    upstream: null,
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

  let config = deps.config;
  if (!config) {
    try {
      config = loadConfig();
    } catch (err) {
      block('Cannot load reference/commit-steps.json: ' + err.message, { check: 'config' });
      return finish();
    }
  }
  const target = opts.target || config.defaultTarget;
  res.targetBranch = target || null;
  if (!target) {
    block('No target branch – set defaultTarget in reference/commit-steps.json or pass --target', { check: 'target-name' });
    return finish();
  }

  // --- repo -----------------------------------------------------------------
  const repo = git(['rev-parse', '--is-inside-work-tree']);
  if (!repo.ok || repo.stdout.trim() !== 'true') {
    block(repo.notFound ? 'git is not installed or not on PATH' : 'The folder ' + deps.cwd + ' is not a git repo', { check: 'git-repo' });
    return finish();
  }

  // HEAD עומד על היעד: הבראנץ' כבר נוצר. רק מוודאים שיש תג migration-start-* בהיסטוריה שלו
  const alreadyDone = () => {
    res.sourceBranch = null;
    res.notes.push('Branch ' + target + ' was created in a previous run and HEAD is already on it – this step is already done');
    const tags = git(['tag', '--list', 'migration-start-*', '--merged', 'HEAD']);
    const existing = tags.ok ? tags.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).sort() : [];
    if (existing.length) {
      res.tag = existing[existing.length - 1];
      res.result = 'NOOP';
      return res;
    }
    const tag = 'migration-start-' + ymdHm(deps.now);
    res.tag = tag;
    const args = ['tag', tag, 'HEAD'];
    if (opts.dryRun) {
      res.commands.push({ command: displayCommand(args), status: 'planned' });
      res.result = 'NOOP';
      return res;
    }
    const r = git(args);
    res.commands.push({ command: displayCommand(args), status: r.ok ? 'done' : 'failed' });
    if (!r.ok) {
      block('Creating the missing tag ' + tag + ' failed: ' + (firstLine(r.stderr) || r.message), { check: 'tag' });
      return finish();
    }
    res.changes.push({ file: 'refs/tags/' + tag, rule: 'BRANCH.TAG', confidence: 'auto' });
    res.notes.push('The migration-start-* tag was missing – created ' + tag + ' on the current HEAD (' + (res.previousHead || '').slice(0, 12) + ')');
    res.result = 'NOOP';
    return res;
  };

  const validBranch = (name, label) => {
    if (!name || name.startsWith('-')) { block('Invalid ' + label + ' branch name: "' + name + '"', { check: 'branch-name' }); return false; }
    const r = git(['check-ref-format', '--branch', name]);
    if (!r.ok) { block('Invalid ' + label + ' branch name: "' + name + '"', { check: 'branch-name' }); return false; }
    return true;
  };

  // --- current branch / detached HEAD ----------------------------------------
  const sym = git(['symbolic-ref', '--short', '-q', 'HEAD']);
  if (sym.ok && sym.stdout.trim()) {
    res.previousBranch = sym.stdout.trim();
  } else {
    block('HEAD is detached – there is nothing to branch from. Switch to a branch and run again', { check: 'detached-head' });
  }
  const head = git(['rev-parse', '--verify', '-q', 'HEAD']);
  res.previousHead = head.ok && head.stdout.trim() ? head.stdout.trim() : null;

  // --- source ----------------------------------------------------------------
  // --source, אחרת defaultSource מהקונפיג, אחרת (null) הבראנץ' הנוכחי
  const source = opts.source || config.defaultSource || res.previousBranch;
  res.sourceBranch = source;
  const sourceValid = source ? validBranch(source, 'source') : false;
  const targetValid = validBranch(target, 'target');

  // --- already on the target → the step was done (idempotent re-run / resume after a failed tag) ---
  if (targetValid && res.previousBranch === target) return alreadyDone();

  if (sourceValid && targetValid && target === source) {
    block('The target branch is the same as the source branch (' + target + ')', { check: 'branch-name' });
  }

  // --- clean working tree ----------------------------------------------------
  const status = git(['status', '--porcelain']);
  if (!status.ok) {
    block('git status failed: ' + (firstLine(status.stderr) || status.message), { check: 'git-clean' });
  } else {
    const files = status.stdout.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim());
    if (files.length) {
      // לא מבצעים stash – ההחלטה מה לעשות בשינויים פתוחים היא של אדם
      block('The working tree is not clean (' + files.length + ' files). Commit or stash manually, then run again', { check: 'git-clean', files: files });
    }
  }

  // --- local refs ------------------------------------------------------------
  const localBranchExists = (name) => git(['show-ref', '--verify', '--quiet', 'refs/heads/' + name]).ok;
  const commitOf = (ref) => {
    const r = git(['rev-parse', '--verify', '-q', ref + '^{commit}']);
    return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
  };
  const tag = 'migration-start-' + ymdHm(deps.now);
  res.tag = tag;
  const tagCommit = commitOf('refs/tags/' + tag);

  // --- origin (read-only, also in dry-run) -----------------------------------
  // אין origin בכלל → ריפו מקומי: דילוג על fetch ו-pull, לא כשל
  const hasOrigin = git(['config', '--get', 'remote.origin.url']).ok;
  let remoteHeads = null;
  if (!hasOrigin) {
    remoteHeads = new Set();
    res.notes.push('No remote named origin – skipping fetch and pull; ' + target + ' will be checked and created locally only');
  } else if (targetValid) {
    const ls = git(['ls-remote', '--heads', 'origin'], NETWORK_TIMEOUT_MS);
    if (!ls.ok) {
      const f = networkFailure(ls, 'git ls-remote');
      block(f.message, { check: 'origin', kind: f.kind });
    } else {
      remoteHeads = new Set(ls.stdout.split(/\r?\n/).map((l) => l.split('\t')[1]).filter(Boolean)
        .map((ref) => ref.replace(/^refs\/heads\//, '')));
    }
  }

  // --- source: local or origin, upstream ---------------------------------------
  let sourceLocal = false;
  let sourceFound = false;
  if (sourceValid) {
    sourceLocal = localBranchExists(source);
    if (sourceLocal) {
      sourceFound = true;
      const up = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', source + '@{upstream}']);
      if (up.ok && up.stdout.trim()) res.upstream = up.stdout.trim();
    } else if (remoteHeads && remoteHeads.has(source)) {
      sourceFound = true;
      res.upstream = 'origin/' + source;
    } else if (remoteHeads) {
      block('Branch ' + source + ' does not exist ' + (hasOrigin ? 'locally or on origin' : 'locally') +
        ' – pass --source <existing branch>', { check: 'source-missing' });
    }
  }

  // --- tag name taken (same minute) ------------------------------------------
  // מצביע לאותו commit שממנו ייווצר היעד → שימוש חוזר; למקום אחר → חסימה
  let reuseTag = false;
  if (tagCommit) {
    const tip = sourceFound ? commitOf(sourceLocal ? 'refs/heads/' + source : 'refs/remotes/origin/' + source) : null;
    if (tip && tip === tagCommit) {
      reuseTag = true;
      res.notes.push('Tag ' + tag + ' already exists and points to the same commit (' + tagCommit.slice(0, 12) + ') – reusing it');
    } else {
      block('Tag ' + tag + ' already exists and points to a different commit (' + tagCommit.slice(0, 12) + ') – wait a minute and run again', { check: 'tag-exists' });
    }
  }

  // --- target must not exist yet ---------------------------------------------
  if (targetValid) {
    const existsLocal = localBranchExists(target);
    const existsRemote = !!(remoteHeads && remoteHeads.has(target));
    if (existsLocal || existsRemote) {
      const where = existsLocal && existsRemote ? 'locally and on origin' : existsLocal ? 'locally' : 'on origin';
      block('Target branch ' + target + ' already exists ' + where + ' – the service was probably migrated already. ' +
        'Check ' + target + ', or pass --target <other name> to create a branch with a different name', { check: 'target-exists' });
    }
  }

  if (res.blockers.length) return finish();

  // --- plan ------------------------------------------------------------------
  const plan = [];
  if (hasOrigin) plan.push({ args: ['fetch', 'origin', '--prune'], step: 'fetch', network: true });
  if (res.previousBranch !== source) {
    plan.push(sourceLocal
      ? { args: ['checkout', source], step: 'checkout-source' }
      : { args: ['checkout', '-b', source, '--track', 'origin/' + source], step: 'checkout-source' });
  } else {
    res.notes.push('Already on ' + source + ' – skipping checkout');
  }
  if (res.upstream && hasOrigin) {
    // בלי ארגומנטים = מה-upstream המוגדר. --no-rebase: גם אם pull.rebase=true בקונפיג, לעולם לא מבצעים rebase
    plan.push({ args: ['pull', '--ff-only', '--no-rebase'], step: 'pull', network: true });
  } else if (hasOrigin) {
    res.notes.push('Branch ' + source + ' has no upstream – skipping git pull; ' + target + ' will be created from the local state of ' + source);
  }
  plan.push({ args: ['checkout', '-b', target], step: 'create-branch' });
  if (!reuseTag) plan.push({ args: ['tag', tag], step: 'tag' });

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
      ? 'Switched back to the previous branch ' + res.previousBranch
      : 'Could not switch back to branch ' + res.previousBranch + ': ' + firstLine(r.stderr));
  };

  for (const p of plan) {
    // ה-pull יכול היה להזיז את המקור – התג שנבחר לשימוש חוזר חייב עדיין להצביע לאותו commit
    if (p.step === 'create-branch' && reuseTag && commitOf('HEAD') !== tagCommit) {
      block('Tag ' + tag + ' already exists and points to a different commit (' + tagCommit.slice(0, 12) + ') – wait a minute and run again', { check: 'tag-exists' });
      rollback();
      return finish();
    }
    const r = git(p.args, p.network ? NETWORK_TIMEOUT_MS : LOCAL_TIMEOUT_MS);
    res.commands.push({ command: displayCommand(p.args), status: r.ok ? 'done' : 'failed' });
    if (r.ok) {
      if (p.step === 'checkout-source') movedOffPrevious = true;
      if (p.step === 'create-branch') {
        movedOffPrevious = false; // branch created – no going back
        res.changes.push({ file: 'refs/heads/' + target, rule: 'BRANCH.CREATE', confidence: 'auto' });
      }
      if (p.step === 'tag') res.changes.push({ file: 'refs/tags/' + tag, rule: 'BRANCH.TAG', confidence: 'auto' });
      if (p.step === 'pull') {
        // ff-only לא מגן מקומיטים מקומיים שלא נדחפו – הם ייכנסו לבראנץ' היעד
        const ahead = git(['rev-list', '--count', '@{upstream}..HEAD']);
        const n = ahead.ok ? parseInt(ahead.stdout.trim(), 10) : 0;
        if (n > 0) {
          res.notes.push('Local ' + source + ' has ' + n + ' commits that are not on ' + res.upstream + ' – they will be included in ' + target + '. Make sure this is intended');
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
        block('Local ' + source + ' and ' + res.upstream + ' have diverged – fast-forward is not possible. ' +
          'No merge or rebase is done; resolve it manually', { check: 'diverged' });
      } else {
        const f = networkFailure(r, 'git pull');
        block(f.message, { check: 'pull', kind: f.kind });
      }
    } else if (p.step === 'tag') {
      block('Branch ' + target + ' was created, but creating tag ' + tag + ' failed: ' + (firstLine(r.stderr) || r.message), { check: 'tag' });
    } else {
      block(displayCommand(p.args) + ' failed: ' + (firstLine(r.stderr) || r.message), { check: p.step });
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
  L.push('branch – create the target branch' + (res.dryRun ? ' [dry-run]' : ''));
  L.push('   source: ' + (res.sourceBranch || '?') + (res.upstream ? ' (upstream: ' + res.upstream + ')' : '') +
    ' → target: ' + (res.targetBranch || '?') + ' | tag: ' + (res.tag || '?'));
  L.push('   previous HEAD: ' + (res.previousBranch || 'detached') + ' @ ' + (res.previousHead ? res.previousHead.slice(0, 12) : '?'));
  if (res.commands.length) {
    L.push('');
    res.commands.forEach((c) => L.push(sym[c.status] + ' ' + c.command));
  }
  if (res.blockers.length) {
    L.push('');
    res.blockers.forEach((b) => {
      L.push('⛔ ' + b.message);
      (b.files || []).slice(0, MAX_LISTED_FILES).forEach((f) => L.push('     ' + f));
      if (b.files && b.files.length > MAX_LISTED_FILES) L.push('     ... and ' + (b.files.length - MAX_LISTED_FILES) + ' more');
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

module.exports = { run: run, main: main, parseArgs: parseArgs, formatText: formatText };
