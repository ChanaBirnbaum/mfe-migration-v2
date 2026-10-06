#!/usr/bin/env node
'use strict';

// build: run the service build and turn its output into a uniform Diagnostic[] – the input for the fix-errors step.
// Default command is `npm run build:dev`: every build script here needs --env sviva=..., plain `npm run build`
// crashes on envVriables[undefined]. Override with --command "<cmd>".
// Every diagnostic keeps `raw` (the original text) so nothing is lost when parsing is imperfect.
// Columns are 1-based everywhere (webpack and Babel report 0-based columns – converted here).

const path = require('path');

const SCRIPT = 'build';
const DEFAULT_SCRIPT = 'build:dev';
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const OUT_DIR = '.migration';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;

function parseDuration(v) {
  const m = /^(\d+(?:\.\d+)?)(m|min|s|ms)?$/.exec(String(v || '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] || 'm';
  const ms = unit === 'ms' ? n : unit === 's' ? n * 1000 : n * 60000;
  return ms > 0 ? Math.round(ms) : null;
}

function parseArgs(argv) {
  const opts = { dryRun: false, json: false, command: null, timeoutMs: DEFAULT_TIMEOUT_MS, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--command' || a.startsWith('--command=')) {
      const v = a === '--command' ? argv[++i] : a.slice('--command='.length);
      if (!v || !v.trim()) opts.errors.push('‎--command דורש פקודה');
      else opts.command = v.trim();
    } else if (a === '--timeout' || a.startsWith('--timeout=')) {
      const v = a === '--timeout' ? argv[++i] : a.slice('--timeout='.length);
      const ms = parseDuration(v);
      if (ms === null) opts.errors.push('‎--timeout לא תקין: "' + v + '"');
      else opts.timeoutMs = ms;
    } else opts.errors.push('פרמטר לא מוכר: ' + a);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Parsing

function makeRelative(file, cwd) {
  if (!file) return null;
  let f = file.trim().replace(/^["']|["']$/g, '');
  // נתיבי Windows מטופלים עם path.win32 גם כשהסקריפט רץ על Linux (למשל בדיקות ב-CI)
  const p = /^[A-Za-z]:[\\/]/.test(f) ? path.win32 : path;
  if (p.isAbsolute(f)) {
    const rel = p.relative(cwd, f);
    if (!rel.startsWith('..') && !p.isAbsolute(rel)) f = rel;
  }
  f = f.split('\\').join('/').replace(/^\.\//, '');
  return f;
}

const TSC_LINE = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;
const TSC_PRETTY = /^(.+?):(\d+):(\d+) - (error|warning) (TS\d+): (.*)$/;
const BABEL_SYNTAX = /^(?:SyntaxError|Error): (.+?): (.+?) \((\d+):(\d+)\)\s*$/;
const ESLINT_ROW = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}([@\w/-]+))?\s*$/;
const WEBPACK_HEADER = /^(ERROR|WARNING) in (.*)$/;
// lines that close an ERROR/WARNING block (verified against webpack 5.111 CLI output)
const WEBPACK_END = /^(webpack(?: \S+)? compiled|LOG from|asset |orphan modules|runtime modules|cacheable modules|modules by path|built modules|\d+ (errors?|warnings?) (has|have) detailed information|Use 'stats\.)/;

function diag(source, severity, file, line, column, code, message, raw) {
  return { source: source, severity: severity, file: file || null, line: line || null, column: column || null, code: code || null, message: message, raw: raw };
}

// One webpack "ERROR in …" / "WARNING in …" block → one or more diagnostics.
function parseWebpackBlock(kind, target, body, cwd) {
  const severity = kind === 'ERROR' ? 'error' : 'warning';
  const raw = [kind + ' in ' + target].concat(body).join('\n').trimEnd();
  const lines = body.map((l) => l.replace(/\s+$/, ''));
  const nonEmpty = lines.filter((l) => l.trim());

  // ESLint (eslint-webpack-plugin): "[eslint]" then file path, then "  line:col  severity  message  rule"
  if (/^\[eslint\]/.test(target.trim()) || /^\[eslint\]/.test((nonEmpty[0] || '').trim())) {
    const out = [];
    let file = null;
    lines.forEach((l) => {
      const row = ESLINT_ROW.exec(l);
      if (row && file) {
        out.push(diag('eslint', row[3], file, Number(row[1]), Number(row[2]), row[5] || null, row[4].trim(), file + '\n' + l));
      } else if (l.trim() && !/^\[eslint\]/.test(l.trim()) && !/^\s/.test(l) && !/^✖|problems? \(/.test(l.trim())) {
        file = makeRelative(l.trim(), cwd);
      }
    });
    if (out.length) return out;
  }

  // ts-loader / fork-ts-checker: "[tsl] ERROR in C:\…\X.tsx(22,5)" + "      TS2322: …"
  const tsl = /^(?:\[tsl\] )?(?:ERROR|WARNING)? ?in (.+?)\((\d+),(\d+)\)/.exec(target) || /^\[tsl\] (?:ERROR|WARNING) in (.+?)\((\d+),(\d+)\)/.exec(nonEmpty[0] || '');
  const tsCode = nonEmpty.map((l) => /^\s*(TS\d+): (.*)$/.exec(l)).find(Boolean);
  if (tsl && tsCode) {
    return [diag('tsc', severity, makeRelative(tsl[1], cwd), Number(tsl[2]), Number(tsl[3]), tsCode[1], tsCode[2], raw)];
  }

  // header: "./src/X.jsx 22:5-12" | "./src/X.jsx 22:5" | "./src/X.jsx" | "./src/x.css (./node_modules/css-loader…)" | "main" …
  const hm = /^(\S+)(?:\s+(\d+):(\d+)(?:-\d+(?::\d+)?)?)?/.exec(target.trim());
  let file = hm && /[./\\]/.test(hm[1]) && !/^\[/.test(hm[1]) ? makeRelative(hm[1], cwd) : null;
  let line = hm && hm[2] ? Number(hm[2]) : null;
  let column = hm && hm[3] ? Number(hm[3]) + 1 : null;

  // Babel syntax error inside "Module build failed (from …babel-loader…)"
  const babel = nonEmpty.map((l) => BABEL_SYNTAX.exec(l.trim())).find(Boolean);
  if (babel && nonEmpty.some((l) => /babel-loader|SyntaxError/.test(l))) {
    return [diag('babel', severity, makeRelative(babel[1], cwd) || file, Number(babel[3]), Number(babel[4]) + 1, 'BABEL_SYNTAX', babel[2], raw)];
  }

  const notFound = nonEmpty.map((l) => /Module not found: Error: Can't resolve '(.+?)' in '(.+?)'/.exec(l)).find(Boolean);
  if (notFound) return [diag('webpack', severity, file, line, column, 'MODULE_NOT_FOUND', "Can't resolve '" + notFound[1] + "'", raw)];

  const exportMissing = nonEmpty.map((l) => /export '(.+?)' \(imported as '(.+?)'\) was not found in '(.+?)'/.exec(l)).find(Boolean);
  if (exportMissing) {
    return [diag('webpack', severity, file, line, column, 'EXPORT_NOT_FOUND',
      "export '" + exportMissing[1] + "' (imported as '" + exportMissing[2] + "') was not found in '" + exportMissing[3] + "'", raw)];
  }

  const message = (nonEmpty.find((l) => !/^Module build failed/.test(l)) || nonEmpty[0] || target).trim();
  return [diag('webpack', severity, file, line, column, null, message, raw)];
}

function parseOutput(output, cwd) {
  const lines = output.replace(ANSI_RE, '').split(/\r?\n/);
  const diagnostics = [];
  const loose = [];
  const blocks = { errors: 0, warnings: 0 };
  let block = null;
  const flush = () => {
    if (!block) return;
    while (block.body.length && !block.body[block.body.length - 1].trim()) block.body.pop();
    blocks[block.kind === 'ERROR' ? 'errors' : 'warnings']++;
    diagnostics.push.apply(diagnostics, parseWebpackBlock(block.kind, block.target, block.body, cwd));
    block = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const h = WEBPACK_HEADER.exec(l);
    if (h) { flush(); block = { kind: h[1], target: h[2], body: [] }; continue; }
    if (block) {
      if (WEBPACK_END.test(l)) { flush(); loose.push(l); continue; }
      block.body.push(l);
      continue;
    }
    loose.push(l);
  }
  flush();

  // tsc / babel CLI output outside webpack blocks
  for (let i = 0; i < loose.length; i++) {
    const l = loose[i];
    const t = TSC_LINE.exec(l) || TSC_PRETTY.exec(l);
    if (t) {
      const rawLines = [l];
      // continuation lines of a multi-line tsc message are indented
      while (i + 1 < loose.length && /^\s{2,}\S/.test(loose[i + 1]) && !TSC_LINE.test(loose[i + 1])) rawLines.push(loose[++i]);
      const extra = rawLines.slice(1).map((x) => x.trim()).filter((x) => !/^\d+\s/.test(x) && !/^~+$/.test(x));
      diagnostics.push(diag('tsc', t[4], makeRelative(t[1], cwd), Number(t[2]), Number(t[3]), t[5], [t[6]].concat(extra).join(' '), rawLines.join('\n')));
      continue;
    }
    const b = BABEL_SYNTAX.exec(l.trim());
    if (b) diagnostics.push(diag('babel', 'error', makeRelative(b[1], cwd), Number(b[3]), Number(b[4]) + 1, 'BABEL_SYNTAX', b[2], l));
  }

  // "webpack 5.x compiled with 3 errors and 1 warning" – used to cross-check the parse
  const summary = /compiled with (\d+) errors?(?: and (\d+) warnings?)?|compiled with (\d+) warnings?/.exec(lines.join('\n'));
  let reported = null;
  if (summary) reported = { errors: Number(summary[1] || 0), warnings: Number(summary[2] || summary[3] || 0) };
  return { diagnostics: diagnostics, reported: reported, blocks: blocks };
}

// ---------------------------------------------------------------------------

function killTree(child, platform, cp) {
  try {
    if (platform === 'win32') cp.spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else child.kill('SIGTERM');
  } catch (_) { /* best effort */ }
}

function nextRunNumber(fs, dir) {
  let max = 0;
  try {
    fs.readdirSync(dir).forEach((f) => { const m = /^build-(\d+)\.json$/.exec(f); if (m) max = Math.max(max, Number(m[1])); });
  } catch (_) { /* no dir yet */ }
  return max + 1;
}

async function run(argv, overrides) {
  const deps = Object.assign({
    fs: require('fs'), cwd: process.cwd(), cp: require('child_process'), platform: process.platform,
    env: Object.assign({}, process.env, { FORCE_COLOR: '0', NO_COLOR: '1', npm_config_color: 'false' }),
    onOutput: () => {}, now: () => Date.now(),
  }, overrides || {});
  const opts = parseArgs(argv || []);
  const res = {
    script: SCRIPT, result: 'OK', changes: [], manual: [], blockers: [], notes: [], dryRun: opts.dryRun,
    buildCommand: null, exitCode: null, durationMs: null, errorCount: 0, warningCount: 0, diagnostics: [], run: null, previous: null,
  };
  const blocked = (m) => { res.result = 'BLOCKED'; res.blockers.push({ message: m }); return res; };
  if (opts.errors.length) return blocked(opts.errors.join('; '));
  const fs = deps.fs;
  const root = deps.cwd;

  if (opts.command) {
    res.buildCommand = opts.command;
  } else {
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch (err) {
      return blocked('לא ניתן לקרוא את package.json: ' + err.message);
    }
    const scripts = pkg.scripts || {};
    if (!scripts[DEFAULT_SCRIPT]) {
      const builds = Object.keys(scripts).filter((k) => /build/.test(k));
      return blocked('אין סקריפט "' + DEFAULT_SCRIPT + '" ב-package.json' + (builds.length ? ' (קיימים: ' + builds.join(', ') + ')' : '') +
        '. העבר --command "<פקודה>" – שים לב שפקודות build כאן דורשות --env sviva=...');
    }
    res.buildCommand = 'npm run ' + DEFAULT_SCRIPT;
  }

  if (opts.dryRun) {
    res.notes.push('[dry-run] היה מורץ: ' + res.buildCommand);
    return res;
  }

  const started = deps.now();
  const outcome = await new Promise((resolve) => {
    let output = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(Object.assign({ output: output }, r)); } };
    let child;
    try {
      // --command מגיע מהמשתמשת/קלוד במפורש כפקודת shell; ברירת המחדל קבועה
      child = deps.cp.spawn(res.buildCommand, [], { cwd: root, env: deps.env, shell: true, windowsHide: true });
    } catch (err) {
      return finish({ code: null, spawnError: err });
    }
    const onData = (chunk) => { const s = chunk.toString(); output += s; deps.onOutput(s); };
    if (child.stdout) child.stdout.on('data', onData);
    if (child.stderr) child.stderr.on('data', onData);
    child.on('error', (err) => finish({ code: null, spawnError: err }));
    child.on('close', (code) => finish({ code: code }));
    const timer = setTimeout(() => { killTree(child, deps.platform, deps.cp); finish({ code: null, timedOut: true }); }, opts.timeoutMs);
  });
  res.durationMs = deps.now() - started;
  res.exitCode = outcome.code;

  if (outcome.spawnError) return blocked('לא ניתן להריץ את "' + res.buildCommand + '": ' + outcome.spawnError.message);

  const parsed = parseOutput(outcome.output, root);
  res.diagnostics = parsed.diagnostics;
  if (outcome.timedOut) {
    res.diagnostics.push(diag('webpack', 'error', null, null, null, 'TIMEOUT', 'ה-build לא הסתיים תוך ' + Math.round(opts.timeoutMs / 60000) + ' דקות',
      outcome.output.split(/\r?\n/).slice(-30).join('\n')));
  } else if (outcome.code !== 0 && !res.diagnostics.some((d) => d.severity === 'error')) {
    // הפקודה נכשלה אך לא זוהתה אף שגיאה – לעולם לא מדווחים OK; קלוד יקרא את ה-raw
    res.diagnostics.push(diag('webpack', 'error', null, null, null, 'UNPARSED_FAILURE', 'הפקודה נכשלה (exit ' + outcome.code + ') ולא זוהתה שגיאה ניתנת לפרסור',
      outcome.output.split(/\r?\n/).slice(-60).join('\n')));
  }
  res.errorCount = res.diagnostics.filter((d) => d.severity === 'error').length;
  res.warningCount = res.diagnostics.filter((d) => d.severity === 'warning').length;
  // webpack סופר בלוקים (בלוק eslint אחד = שגיאה אחת), לכן ההשוואה היא מול מספר הבלוקים שזוהו
  if (parsed.reported && (parsed.reported.errors !== parsed.blocks.errors || parsed.reported.warnings !== parsed.blocks.warnings)) {
    res.notes.push('webpack דיווח ' + parsed.reported.errors + ' שגיאות ו-' + parsed.reported.warnings + ' אזהרות, אך זוהו ' + parsed.blocks.errors + '/' + parsed.blocks.warnings +
      ' בלוקים – ייתכן שחלק מהפלט לא פורסר; ראה raw ב-build-<n>.json');
  }

  // .migration/build-<n>.json
  const dir = path.join(root, OUT_DIR);
  const n = nextRunNumber(fs, dir);
  res.run = n;
  if (n > 1) {
    try {
      const prev = JSON.parse(fs.readFileSync(path.join(dir, 'build-' + (n - 1) + '.json'), 'utf8'));
      res.previous = { run: n - 1, errorCount: prev.errorCount, warningCount: prev.warningCount };
    } catch (_) { res.previous = null; }
  }
  if (outcome.code !== 0 || res.errorCount) res.result = 'BLOCKED';
  const outFile = OUT_DIR + '/build-' + n + '.json';
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(root, outFile), JSON.stringify(res, null, 2) + '\n', 'utf8');
    res.changes.push({ file: outFile, rule: 'BUILD.REPORT', confidence: 'auto' });
  } catch (err) {
    res.notes.push('לא ניתן לכתוב את ' + outFile + ': ' + err.message);
  }
  if (res.result === 'BLOCKED' && !res.blockers.length) {
    res.blockers.push({ message: res.errorCount + ' שגיאות build' + (outcome.timedOut ? ' (timeout)' : '') });
  }
  return res;
}

function formatText(res) {
  const L = ['', SCRIPT + (res.dryRun ? ' [dry-run]' : '') + (res.buildCommand ? ' – ' + res.buildCommand : '')];
  if (res.durationMs !== null) {
    let trend = '';
    if (res.previous && typeof res.previous.errorCount === 'number') {
      const d = res.errorCount - res.previous.errorCount;
      trend = ' | מול הרצה ' + res.previous.run + ': ' + res.previous.errorCount + ' → ' + res.errorCount + (d < 0 ? ' 📉' : d > 0 ? ' 📈' : ' ➖');
    }
    L.push('🔨 הרצה #' + res.run + ' | exit ' + res.exitCode + ' | ⏱ ' + Math.round(res.durationMs / 1000) + 's | ⛔ ' + res.errorCount + ' שגיאות | ⚠ ' + res.warningCount + ' אזהרות' + trend);
    res.diagnostics.forEach((d) => {
      const loc = d.file ? d.file + (d.line ? ':' + d.line + (d.column ? ':' + d.column : '') : '') : '(ללא קובץ)';
      L.push((d.severity === 'error' ? '  ⛔ ' : '  ⚠ ') + '[' + d.source + (d.code ? ' ' + d.code : '') + '] ' + loc + ' – ' + d.message);
    });
    if (res.changes.length) L.push('💾 ' + res.changes[0].file);
  }
  if (!res.durationMs) res.blockers.forEach((b) => L.push('⛔ ' + b.message));
  res.notes.forEach((n) => L.push('ℹ ' + n));
  L.push('RESULT: ' + res.result);
  return L.join('\n') + '\n';
}

async function main(argv, deps, io) {
  io = io || { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) };
  try {
    const opts = parseArgs(argv || []);
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

module.exports = { run: run, main: main, parseOutput: parseOutput };
