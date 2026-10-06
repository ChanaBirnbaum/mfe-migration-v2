#!/usr/bin/env node
'use strict';

// install: clean reinstall – rm -rf node_modules, rm -f package-lock.json, npm install.
// Always reinstalls (intentional – not idempotent). Never adds --legacy-peer-deps / --force: that is a human decision.
// npm output is streamed to stdout in real time (never to stderr – see the contract).

const path = require('path');

const SCRIPT = 'install';
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
// --no-audit / --no-fund: לא משנים את פתרון התלויות, רק חוסכים קריאות ל-registry שאולי לא קיימות ברשת הסגורה
const NPM_ARGS = ['install', '--no-audit', '--no-fund'];
const FORBIDDEN_FLAGS = ['--legacy-peer-deps', '--force'];

function parseDuration(v) {
  const m = /^(\d+(?:\.\d+)?)(m|min|s|ms)?$/.exec(String(v || '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] || 'm';
  const ms = unit === 'ms' ? n : unit === 's' ? n * 1000 : n * 60000;
  return ms > 0 ? Math.round(ms) : null;
}

function parseArgs(argv) {
  const opts = { dryRun: false, json: false, timeoutMs: DEFAULT_TIMEOUT_MS, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--timeout' || a.startsWith('--timeout=')) {
      const v = a === '--timeout' ? argv[++i] : a.slice('--timeout='.length);
      const ms = parseDuration(v);
      if (ms === null) opts.errors.push('‎--timeout לא תקין: "' + v + '" (דוגמאות: 20, 20m, 900s)');
      else opts.timeoutMs = ms;
    } else if (FORBIDDEN_FLAGS.indexOf(a) !== -1) {
      opts.errors.push(a + ' אסור – פתרון קונפליקט peer deps הוא החלטת אדם');
    } else opts.errors.push('פרמטר לא מוכר: ' + a);
  }
  return opts;
}

const firstLines = (s, n) => String(s || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, n || 3).join(' | ');

// strips "npm ERR! " (npm ≤9) / "npm error " (npm 10+)
const stripPrefix = (l) => l.replace(/^npm (ERR!|error) ?/, '');

function diagnose(output, fs) {
  const errLines = output.split(/\r?\n/).filter((l) => /^npm (ERR!|error)/.test(l)).map(stripPrefix);
  const code = (errLines.map((l) => /^code (\w+)/.exec(l)).find(Boolean) || [])[1] || null;
  const errText = errLines.join('\n');

  if (code === 'ERESOLVE') {
    // npm כותב את העץ המלא ל-eresolve-report.txt; ביומן עצמו יש רק חלק
    const reportPath = (/(\S*eresolve-report\.txt)/.exec(errText) || [])[1];
    let report = null;
    if (reportPath) { try { report = fs.readFileSync(reportPath, 'utf8'); } catch (_) { report = null; } }
    return {
      kind: 'ERESOLVE',
      message: 'ERESOLVE – קונפליקט peer dependencies. לא נוסף --legacy-peer-deps / --force: פתרון הקונפליקט הוא החלטת אדם',
      tree: report || errLines.filter((l) => !/^(code|A complete log|See |To permanently fix|Fix the upstream|this command with|to accept an incorrect)/.test(l)).join('\n'),
      reportPath: reportPath || null,
    };
  }
  if (code === 'E404') {
    const notIn = /'(.+?)' is not in (this|the npm) registry/.exec(errText);
    const url = /404 Not Found - GET (\S+)/.exec(errText);
    let pkg = notIn ? notIn[1] : null;
    if (!pkg && url) pkg = decodeURIComponent(url[1].split('/').pop());
    return {
      kind: 'E404',
      package: pkg,
      message: '404 – החבילה ' + (pkg || '(לא זוהתה)') + ' לא נמצאה ב-registry' + (url ? ' (' + url[1].split('/').slice(0, 3).join('/') + ')' : '') +
        '. בדוק שהיא קיימת ב-registry הפנימי או שהגרסה ב-package.json נכונה',
    };
  }
  if (code === 'EACCES' || code === 'EPERM') {
    const p = (/path (\S+)/.exec(errText) || [])[1];
    return { kind: code, message: 'אין הרשאות כתיבה' + (p ? ' ל-' + p : '') + ' – סגור תהליכים שמחזיקים קבצים ב-node_modules (IDE, dev server) ובדוק הרשאות. אל תריץ כ-admin/sudo' };
  }
  if (code === 'ENOSPC') return { kind: 'ENOSPC', message: 'אין מקום פנוי בדיסק – פנה מקום (גם ב-npm cache) והרץ שוב' };
  if (code === 'E401' || code === 'E403') return { kind: code, message: 'כשל הרשאה מול ה-registry (' + code + ') – בדוק את ה-token ב-.npmrc' };
  if (/^(ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN)$/.test(code || '')) return { kind: code, message: 'כשל רשת מול ה-registry (' + code + ')' };
  return { kind: code || 'UNKNOWN', message: 'npm install נכשל' + (code ? ' (' + code + ')' : '') + ': ' + (errLines.filter((l) => !/^code /.test(l)).slice(0, 5).join(' | ') || firstLines(output.split(/\r?\n/).slice(-5).join('\n'), 5)) };
}

function collectWarnings(output) {
  const seen = new Set();
  output.split(/\r?\n/).forEach((l) => {
    const m = /^npm (WARN|warn) (.+)$/.exec(l.trim());
    if (m) seen.add(m[2].trim());
  });
  return Array.from(seen);
}

function countInstalled(output, fs, lockPath) {
  const m = /added (\d+) packages?/.exec(output);
  if (m) return Number(m[1]);
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return Object.keys(lock.packages || {}).filter((k) => k !== '').length;
  } catch (_) {
    return null;
  }
}

function killTree(child, platform, cp) {
  try {
    // ב-Windows npm רץ דרך cmd.exe – kill רגיל הורג רק את ה-shell ומשאיר את node של npm חי
    if (platform === 'win32') cp.spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else child.kill('SIGTERM');
  } catch (_) { /* best effort */ }
}

// ---------------------------------------------------------------------------

async function run(argv, overrides) {
  const deps = Object.assign({
    fs: require('fs'), cwd: process.cwd(), cp: require('child_process'), platform: process.platform,
    env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }),
    onOutput: () => {}, now: () => Date.now(),
  }, overrides || {});
  const opts = parseArgs(argv || []);
  const res = {
    script: SCRIPT, result: 'OK', changes: [], manual: [], blockers: [], notes: [], dryRun: opts.dryRun,
    commands: [], installedPackages: null, durationMs: null, warnings: [], timeoutMs: opts.timeoutMs,
  };
  const blocked = (m, extra) => { res.result = 'BLOCKED'; res.blockers.push(Object.assign({ message: m }, extra || {})); return res; };
  if (opts.errors.length) return blocked(opts.errors.join('; '));

  const fs = deps.fs;
  const root = deps.cwd;
  const git = (args) => {
    try {
      return { ok: true, out: String(deps.cp.execFileSync('git', args, { cwd: root, env: deps.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, windowsHide: true })) };
    } catch (err) {
      if (err.status === undefined && !err.code) throw err;
      return { ok: false, out: String(err.stdout || ''), err: String(err.stderr || err.message) };
    }
  };

  if (!fs.existsSync(path.join(root, 'package.json'))) return blocked('package.json לא נמצא ב-' + root);

  // ---- precondition: nothing that is deleted can lose work ----
  const repo = git(['rev-parse', '--is-inside-work-tree']);
  if (!repo.ok || repo.out.trim() !== 'true') return blocked('התיקייה אינה git repo – אין דרך לשחזר את package-lock.json אחרי המחיקה');
  const status = git(['status', '--porcelain']);
  if (!status.ok) return blocked('git status נכשל: ' + firstLines(status.err));
  const dirty = status.out.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim());
  const head = git(['rev-parse', '--verify', '-q', 'HEAD']);
  if (dirty.length && !(head.ok && head.out.trim())) {
    return blocked('אין אף commit ועץ העבודה אינו נקי – בצע commit לפני מחיקת node_modules ו-package-lock.json');
  }
  // package-lock.json שתוכנו אינו ב-git (M / ??) – מגבים לפני המחיקה במקום לחסום.
  // כך הרצה חוזרת (למשל אחרי ERESOLVE שכבר מחק את ה-lock) אינה נחסמת, ושום דבר לא אובד.
  // lock שנמחק (D) ניתן לשחזור מ-HEAD ואינו דורש גיבוי.
  const lockEntry = dirty.find((l) => l.slice(3) === 'package-lock.json');
  const lockPath = path.join(root, 'package-lock.json');
  let lockBackup = null;
  if (lockEntry && lockEntry.slice(0, 2).indexOf('D') === -1 && fs.existsSync(lockPath)) {
    const sha = require('crypto').createHash('sha256').update(fs.readFileSync(lockPath)).digest('hex').slice(0, 12);
    lockBackup = '.migration/backup/package-lock.json.' + sha + '.bak';
  }
  const tracked = git(['ls-files', '--', 'node_modules']);
  if (tracked.ok && tracked.out.trim()) {
    return blocked('node_modules נמצא במעקב git (' + tracked.out.trim().split('\n').length + ' קבצים) – מחיקתו תיראה כשינוי בריפו; יש לטפל בזה ידנית');
  }
  const otherDirty = dirty.filter((l) => l !== lockEntry);
  if (otherDirty.length) res.notes.push('יש ' + otherDirty.length + ' שינויים פתוחים בעץ העבודה – הם לא נוגעים ב-node_modules / package-lock.json ולכן לא נפגעים');
  if (lockBackup) res.notes.push('ל-package-lock.json יש תוכן שאינו ב-git – ' + (opts.dryRun ? 'היה מגובה' : 'גובה') + ' ל-' + lockBackup + ' לפני המחיקה');

  const npmDisplay = 'npm ' + NPM_ARGS.join(' ');
  const plan = ['rm -rf node_modules', 'rm -f package-lock.json', npmDisplay];
  if (opts.dryRun) {
    res.commands = plan.map((c) => ({ command: c, status: 'planned' }));
    return res;
  }

  // ---- rm ----
  try {
    if (lockBackup) {
      const dest = path.join(root, lockBackup);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (!fs.existsSync(dest)) fs.copyFileSync(lockPath, dest);
      res.changes.push({ file: lockBackup, rule: 'INSTALL.LOCK_BACKUP', confidence: 'auto', detail: 'גיבוי של package-lock.json שלא היה ב-git' });
    }
    fs.rmSync(path.join(root, 'node_modules'), { recursive: true, force: true, maxRetries: 3 });
    res.commands.push({ command: plan[0], status: 'done' });
    fs.rmSync(path.join(root, 'package-lock.json'), { force: true });
    res.commands.push({ command: plan[1], status: 'done' });
  } catch (err) {
    const msg = err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES'
      ? 'לא ניתן למחוק את node_modules (' + err.code + ') – קובץ נעול. סגור IDE / dev server / תהליכי node והרץ שוב'
      : 'מחיקה נכשלה: ' + err.message;
    return blocked(msg);
  }

  // ---- npm install (streamed) ----
  const started = deps.now();
  const outcome = await new Promise((resolve) => {
    let output = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(Object.assign({ output: output }, r)); } };
    let child;
    try {
      // npm.cmd דורש shell ב-Windows; הפקודה קבועה ואינה כוללת קלט משתמש
      child = deps.platform === 'win32'
        ? deps.cp.spawn('npm ' + NPM_ARGS.join(' '), [], { cwd: root, env: deps.env, shell: true, windowsHide: true })
        : deps.cp.spawn('npm', NPM_ARGS, { cwd: root, env: deps.env });
    } catch (err) {
      return finish({ code: null, spawnError: err });
    }
    const onData = (chunk) => { const s = chunk.toString(); output += s; deps.onOutput(s); };
    if (child.stdout) child.stdout.on('data', onData);
    if (child.stderr) child.stderr.on('data', onData); // ל-stdout בלבד – ראה החוזה
    child.on('error', (err) => finish({ code: null, spawnError: err }));
    child.on('close', (code) => finish({ code: code }));
    const timer = setTimeout(() => { killTree(child, deps.platform, deps.cp); finish({ code: null, timedOut: true }); }, opts.timeoutMs);
  });
  res.durationMs = deps.now() - started;
  res.commands.push({ command: npmDisplay, status: outcome.code === 0 ? 'done' : 'failed' });
  res.warnings = collectWarnings(outcome.output);

  if (outcome.timedOut) return blocked('npm install לא הסתיים תוך ' + Math.round(opts.timeoutMs / 60000) + ' דקות – התהליך הופסק. בדוק את ה-registry או הרץ עם --timeout גדול יותר', { kind: 'timeout' });
  if (outcome.spawnError) return blocked('לא ניתן להריץ npm: ' + outcome.spawnError.message, { kind: 'spawn' });
  if (outcome.code !== 0) {
    const d = diagnose(outcome.output, fs);
    return blocked(d.message, d);
  }

  res.installedPackages = countInstalled(outcome.output, fs, path.join(root, 'package-lock.json'));
  res.changes.push({ file: 'package-lock.json', rule: 'INSTALL.LOCK', confidence: 'auto', detail: 'נוצר מחדש' });
  res.notes.push('package-lock.json נוצר מחדש – יש לבצע לו commit');
  const peer = res.warnings.filter((w) => /ERESOLVE|peer dep/i.test(w));
  if (peer.length) res.notes.push(peer.length + ' אזהרות peer dependencies – ההתקנה הצליחה, אך כדאי לעבור עליהן');
  return res;
}

function formatText(res) {
  const L = ['', SCRIPT + (res.dryRun ? ' [dry-run]' : '')];
  const sym = { done: '✓', failed: '⛔', planned: '→' };
  res.commands.forEach((c) => L.push(sym[c.status] + ' ' + c.command));
  if (res.result !== 'BLOCKED' && !res.dryRun) {
    L.push('📦 ' + (res.installedPackages === null ? '?' : res.installedPackages) + ' חבילות | ⏱ ' + Math.round(res.durationMs / 1000) + 's | ⚠ ' + res.warnings.length + ' אזהרות');
  }
  res.blockers.forEach((b) => {
    L.push('⛔ ' + b.message);
    if (b.tree) { L.push('   עץ הקונפליקט:'); b.tree.split(/\r?\n/).forEach((l) => L.push('   | ' + l)); }
    (b.files || []).forEach((f) => L.push('     ' + f));
  });
  res.notes.forEach((n) => L.push('ℹ ' + n));
  L.push('RESULT: ' + res.result);
  return L.join('\n') + '\n';
}

async function main(argv, deps, io) {
  io = io || { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) };
  try {
    const opts = parseArgs(argv || []);
    // ב---json לא מזרימים: הפלט חייב להיות JSON תקין בלבד
    const res = await run(argv, Object.assign({}, deps, { onOutput: opts.json ? () => {} : io.stdout }));
    io.stdout(opts.json ? JSON.stringify(res, null, 2) + '\n' : formatText(res));
    return 0;
  } catch (err) {
    io.stderr(SCRIPT + ' crashed: ' + ((err && err.stack) || err) + '\n');
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.stdout.write('', () => process.exit(code)));
}

module.exports = { run: run, main: main, diagnose: diagnose, parseArgs: parseArgs };
