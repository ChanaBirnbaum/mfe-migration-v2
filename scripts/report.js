#!/usr/bin/env node
'use strict';

// report: build MIGRATION-V2-REPORT.md (Hebrew) from everything in .migration/ plus git history.
// Inputs: any .migration/*.json that is a script result ({ script, result, changes, manual, notes }),
// inventory.json (scan) and build-<n>.json (build). Git supplies commits / branch / tag.
// The report is written to the repo root and is never committed – that is the user's decision.

const path = require('path');

const SCRIPT = 'report';
const REPORT_FILE = 'MIGRATION-V2-REPORT.md';
const MIGRATION_DIR = '.migration';
const COLLAPSE_OVER = 20;

// order + labels of the steps that change source files
const STAGES = [
  ['package-json', 'package.json'],
  ['codemod-mui-imports', 'ייבוא MUI'],
  ['codemod-react18', 'React 18'],
  ['codemod-anti-patterns', 'useEffect אסינכרוני'],
  ['codemod-makestyles', 'makeStyles → sx'],
  ['use-shared-state', 'useSharedState'],
  ['webpack-shared', 'webpack federation'],
  ['install', 'התקנה'],
];
const STAGE_LABEL = new Map(STAGES);
// scripts whose "changes" are bookkeeping, not source edits
const NON_SOURCE = new Set(['preflight', 'scan', 'branch', 'commit', 'build', 'verify-runtime', 'report']);
const EXPECTED_INPUTS = ['preflight', 'scan', 'branch', 'package-json', 'codemod-mui-imports', 'codemod-react18',
  'codemod-anti-patterns', 'codemod-makestyles', 'use-shared-state', 'webpack-shared', 'install', 'build', 'verify-runtime'];

function parseArgs(argv) {
  const opts = { dryRun: false, json: false, errors: [] };
  argv.forEach((a) => {
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else opts.errors.push('פרמטר לא מוכר: ' + a);
  });
  return opts;
}

const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const cell = (s) => String(s === null || s === undefined ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const loc = (m) => (m.file ? m.file + (m.line ? ':' + m.line : '') : '');

// ---------------------------------------------------------------------------
// Inputs

function readInputs(fs, root) {
  const dir = path.join(root, MIGRATION_DIR);
  const results = [];
  let inventory = null;
  const builds = [];
  const unreadable = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch (_) { return null; }
  names.forEach((name) => {
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch (err) { unreadable.push(name); return; }
    const b = /^build-(\d+)\.json$/.exec(name);
    if (b) builds.push(Object.assign({ n: Number(b[1]) }, data));
    else if (name === 'inventory.json') inventory = data;
    // report.json (הפלט של הסקריפט הזה עצמו, נשמר ע"י run.js) אינו קלט – אחרת הדוח לעולם לא יתייצב
    else if (data && typeof data.script === 'string' && typeof data.result === 'string' && data.script !== SCRIPT && data.script !== 'run') results.push(Object.assign({ _file: name }, data));
  });
  builds.sort((a, b) => a.n - b.n);
  return { results: results, inventory: inventory, builds: builds, unreadable: unreadable };
}

function gitInfo(cp, root, env) {
  const git = (args) => {
    try { return String(cp.execFileSync('git', args, { cwd: root, env: env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, windowsHide: true })).trim(); } catch (_) { return null; }
  };
  const info = { branch: git(['symbolic-ref', '--short', '-q', 'HEAD']), tag: null, commits: [], changedFiles: [], stashCount: 0 };
  const tags = git(['tag', '--list', 'migration-start-*', '--sort=-creatordate']);
  if (tags) info.tag = tags.split(/\r?\n/)[0];
  const range = info.tag ? [info.tag + '..HEAD'] : [];
  const log = git(['log', '--format=%H%x09%s'].concat(range).concat(['--grep', '^migration-v2(']));
  if (log) {
    info.commits = log.split(/\r?\n/).filter(Boolean).map((l) => {
      const [sha, subject] = l.split('\t');
      const files = (git(['show', '--name-status', '--format=', sha]) || '').split(/\r?\n/).filter(Boolean).map((r) => {
        const parts = r.split('\t');
        return { status: parts[0], file: parts[parts.length - 1] };
      });
      return { sha: sha, subject: subject, step: (/^migration-v2\(([^)]+)\)/.exec(subject) || [])[1] || null, files: files };
    }).reverse();
  }
  if (info.tag) {
    const diff = git(['diff', '--name-only', info.tag, 'HEAD']);
    info.changedFiles = diff ? diff.split(/\r?\n/).filter((f) => f && !f.startsWith(MIGRATION_DIR + '/')) : [];
  } else {
    info.changedFiles = Array.from(new Set([].concat.apply([], info.commits.map((c) => c.files.map((f) => f.file)))));
  }
  const stash = git(['stash', 'list']);
  info.stashCount = stash ? stash.split(/\r?\n/).filter(Boolean).length : 0;
  return info;
}

// ---------------------------------------------------------------------------
// Model

function buildModel(inputs, git, pkg, now) {
  const byScript = new Map();
  inputs.results.forEach((r) => {
    if (!byScript.has(r.script)) byScript.set(r.script, []);
    byScript.get(r.script).push(r);
  });
  const all = inputs.results.concat(inputs.builds.map((b) => Object.assign({ script: 'build' }, b)));
  const lastBuild = inputs.builds[inputs.builds.length - 1] || null;
  const firstBuild = inputs.builds[0] || null;

  // changes – grouped by stage, from script outputs; git commits fill in stages with no saved output
  const changes = [];
  STAGES.forEach(([script]) => {
    (byScript.get(script) || []).forEach((r) => (r.changes || []).forEach((c) => {
      if (!c.file || String(c.file).startsWith(MIGRATION_DIR + '/')) return;
      changes.push({ stage: script, file: c.file + (c.line ? ':' + c.line : ''), what: c.detail || c.rule || '', confidence: c.confidence || 'auto' });
    }));
  });
  inputs.results.filter((r) => !STAGE_LABEL.has(r.script) && !NON_SOURCE.has(r.script)).forEach((r) => (r.changes || []).forEach((c) => {
    if (c.file && !String(c.file).startsWith(MIGRATION_DIR + '/')) changes.push({ stage: r.script, file: c.file, what: c.detail || c.rule || '', confidence: c.confidence || 'auto' });
  }));
  const fromScripts = new Set(changes.map((c) => c.file.split(':')[0]));
  git.commits.forEach((c) => c.files.forEach((f) => {
    if (fromScripts.has(f.file) || f.file.startsWith(MIGRATION_DIR + '/')) return;
    const what = { A: 'נוסף', M: 'שונה', D: 'נמחק' }[f.status.charAt(0)] || f.status;
    changes.push({ stage: 'commit:' + (c.step || '?'), file: f.file, what: what + ' (' + c.subject + ')', confidence: 'auto' });
  }));

  // manual – blocked scripts first, then every manual item; deduplicated, sorted by file/line
  const manual = [];
  const seen = new Set();
  const addManual = (m, source) => {
    const key = (m.file || '') + '|' + (m.line || '') + '|' + m.reason;
    if (seen.has(key)) return;
    seen.add(key);
    manual.push({ file: m.file || null, line: m.line || null, reason: m.reason, source: source });
  };
  const latestPerScript = Array.from(byScript.values()).map((rs) => rs[rs.length - 1]);
  latestPerScript.filter((r) => r.result === 'BLOCKED').forEach((r) => (r.blockers || []).forEach((b) => addManual({ reason: 'הסקריפט ' + r.script + ' נחסם: ' + b.message }, r.script)));
  if (lastBuild && lastBuild.errorCount) {
    (lastBuild.diagnostics || []).filter((d) => d.severity === 'error').forEach((d) => addManual({ file: d.file, line: d.line, reason: 'שגיאת build [' + d.source + (d.code ? ' ' + d.code : '') + ']: ' + d.message }, 'build'));
  }
  const fileManual = [];
  all.forEach((r) => (r.manual || []).forEach((m) => fileManual.push([m, r.script])));
  if (inputs.inventory) (inputs.inventory.warnings || []).filter((w) => w.file).forEach((w) => fileManual.push([{ file: w.file, line: w.line, reason: w.message }, 'scan']));
  fileManual.sort((a, b) => String(a[0].file || '').localeCompare(String(b[0].file || '')) || (a[0].line || 0) - (b[0].line || 0));
  fileManual.forEach(([m, s]) => addManual(m, s));
  // review-level changes also need a human look
  all.forEach((r) => (r.changes || []).filter((c) => c.confidence === 'review' && c.reason).forEach((c) => addManual({ file: c.file, line: c.line, reason: 'לבדיקה: ' + c.reason }, r.script)));

  // notes
  const notes = [];
  const noteSeen = new Set();
  const addNote = (text, source) => { const k = text; if (!noteSeen.has(k)) { noteSeen.add(k); notes.push({ source: source, text: text }); } };
  all.forEach((r) => (r.notes || []).forEach((n) => addNote(n, r.script)));
  const inv = inputs.inventory;
  if (inv) {
    (inv.react18Only || []).forEach((u) => addNote('שימוש ב-' + u.api + ' (API של React 18 בלבד) ב-' + u.file + ':' + u.line + ' – לא קיים תחת Host עם React 17', 'scan'));
    (inv.blockers || []).forEach((b) => addNote('חבילה לא תואמת React 18: ' + b.package + ' ' + b.range + ' → ' + (b.fixedIn || b.alternative || '?'), 'scan'));
  }

  // checklist
  const msChanges = changes.filter((c) => c.stage === 'codemod-makestyles');
  const msFiles = Array.from(new Set(msChanges.map((c) => c.file.split(':')[0])));
  const msPending = inv && (inv.makeStyles || []).length && !msFiles.length;
  const checklist = [{ text: 'טעינת השירות תחת ה-Host הישן (React 17) ותחת ה-Host החדש (React 18)', reason: 'תמיד' }];
  if (msFiles.length || msPending) {
    checklist.push({ text: 'בדיקה ויזואלית של המסכים שמשתמשים ברכיבים שעברו מ-makeStyles' + (msFiles.length ? ': ' + msFiles.join(', ') : ''), reason: 'שינויי makeStyles' });
  }
  const post602 = inv ? inv.routerPost602 || [] : [];
  if (post602.length) {
    checklist.push({ text: 'המסלולים שמשתמשים ב-API של react-router שנוסף אחרי 6.0.2: ' + post602.map((u) => u.api + ' (' + u.file + ':' + u.line + ')').join(', '), reason: 'routerPost602' });
  }
  if (inv && (inv.react18Only || []).length) checklist.push({ text: 'שימושי API של React 18 בלבד – לוודא התנהגות תחת Host עם React 17', reason: 'react18Only' });
  if (changes.some((c) => c.stage === 'codemod-anti-patterns')) checklist.push({ text: 'טעינת הנתונים במסכים שבהם useEffect אסינכרוני הומר (כולל StrictMode)', reason: 'anti-patterns' });
  if (inv && (inv.pickers || []).length) checklist.push({ text: 'בוררי התאריכים – ה-API של @mui/x-date-pickers שונה', reason: 'pickers' });
  if (git.stashCount) checklist.push({ text: 'ב-git stash יש ' + git.stashCount + ' רשומות – לבדוק אם יש מה להחזיר (git stash list)', reason: 'stash' });
  if (manual.length) checklist.push({ text: 'כל ' + manual.length + ' הפריטים בסעיף "דורש טיפול ידני" טופלו', reason: 'manual' });
  if (lastBuild && lastBuild.result !== 'OK') checklist.push({ text: 'ה-build עובר (npm run build:dev)', reason: 'build' });

  const present = new Set(inputs.results.map((r) => r.script).concat(inputs.builds.length ? ['build'] : []).concat(inv ? ['scan'] : []));
  return {
    service: (pkg && pkg.name) || (inv && inv.service && inv.service.name) || '(ללא שם)',
    date: isoDate(now),
    branch: git.branch,
    tag: git.tag,
    summary: {
      changedFiles: git.changedFiles.length || new Set(changes.map((c) => c.file.split(':')[0])).size,
      commits: git.commits.length,
      build: lastBuild ? { run: lastBuild.n, result: lastBuild.result, errorCount: lastBuild.errorCount, warningCount: lastBuild.warningCount, firstErrorCount: firstBuild.errorCount, runs: inputs.builds.length } : null,
      manualCount: manual.length,
    },
    changes: changes,
    manual: manual,
    notes: notes,
    checklist: checklist,
    missingInputs: EXPECTED_INPUTS.filter((s) => !present.has(s)),
    unreadableInputs: inputs.unreadable,
  };
}

// ---------------------------------------------------------------------------
// Markdown

function stageLabel(stage) {
  if (STAGE_LABEL.has(stage)) return STAGE_LABEL.get(stage);
  if (stage.startsWith('commit:')) return 'commit ' + stage.slice(7);
  return stage;
}

function renderMarkdown(m) {
  const L = [];
  L.push('# דוח הסבה לדור 2 – ' + m.service);
  L.push('');
  L.push('תאריך: ' + m.date + ' | בראנץ\': `' + (m.branch || '?') + '` | tag לשחזור: ' + (m.tag ? '`' + m.tag + '`' : 'לא נמצא'));
  L.push('');
  L.push('## סיכום');
  L.push('');
  const b = m.summary.build;
  const buildText = !b ? 'לא הורץ build'
    : b.result === 'OK' ? '✅ עובר (' + b.warningCount + ' אזהרות)'
      : '⛔ נכשל – ' + b.errorCount + ' שגיאות' + (b.runs > 1 ? ' (בהרצה הראשונה: ' + b.firstErrorCount + ', ' + b.runs + ' הרצות)' : '');
  L.push(m.summary.changedFiles + ' קבצים שונו ב-' + m.summary.commits + ' commits | build: ' + buildText + ' | ' +
    (m.summary.manualCount ? '**' + m.summary.manualCount + ' פריטים לטיפול ידני**' : 'אין פריטים לטיפול ידני'));
  L.push('');

  // החלק החשוב ביותר – לפני פירוט השינויים
  L.push('## דורש טיפול ידני');
  L.push('');
  if (!m.manual.length) L.push('אין פריטים לטיפול ידני.');
  m.manual.forEach((x, i) => L.push((i + 1) + '. ' + (loc(x) ? '`' + loc(x) + '` – ' : '') + x.reason));
  L.push('');

  L.push('## שינויים שבוצעו');
  L.push('');
  if (!m.changes.length) L.push('לא נמצאו שינויים.');
  const stages = [];
  m.changes.forEach((c) => { if (stages.indexOf(c.stage) === -1) stages.push(c.stage); });
  stages.forEach((stage) => {
    const rows = m.changes.filter((c) => c.stage === stage);
    const table = ['| שלב | קובץ | מה שונה |', '|---|---|---|'].concat(rows.map((c) =>
      '| ' + cell(stageLabel(stage)) + ' | `' + cell(c.file) + '` | ' + cell(c.what) + (c.confidence === 'review' ? ' 🔍' : '') + ' |'));
    L.push('### ' + stageLabel(stage) + ' (' + rows.length + ')');
    L.push('');
    if (rows.length > COLLAPSE_OVER) {
      L.push('<details>');
      L.push('<summary>' + rows.length + ' שינויים – לחץ להצגה</summary>');
      L.push('');
      L.push.apply(L, table);
      L.push('');
      L.push('</details>');
    } else {
      L.push.apply(L, table);
    }
    L.push('');
  });

  L.push('## הערות');
  L.push('');
  if (!m.notes.length) L.push('אין הערות.');
  m.notes.forEach((n) => L.push('- ' + n.text + ' _(' + n.source + ')_'));
  L.push('');

  L.push('## מה לבדוק לפני PR');
  L.push('');
  m.checklist.forEach((c) => L.push('- [ ] ' + c.text));
  L.push('');

  if (m.missingInputs.length || m.unreadableInputs.length) {
    L.push('---');
    L.push('');
    if (m.missingInputs.length) L.push('_פלטים שלא נמצאו ב-' + MIGRATION_DIR + '/: ' + m.missingInputs.join(', ') + '. השינויים שלהם נלקחו מ-git בלבד, ופריטים ידניים שלהם אינם בדוח._');
    if (m.unreadableInputs.length) L.push('_קבצים שלא ניתן היה לקרוא: ' + m.unreadableInputs.join(', ') + '_');
    L.push('');
  }
  return L.join('\n');
}

// ---------------------------------------------------------------------------

function run(argv, overrides) {
  const deps = Object.assign({
    fs: require('fs'), cwd: process.cwd(), cp: require('child_process'), now: new Date(),
    env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }),
  }, overrides || {});
  const opts = parseArgs(argv || []);
  const res = { script: SCRIPT, result: 'OK', changes: [], manual: [], blockers: [], notes: [], dryRun: opts.dryRun, report: null };
  const blocked = (m) => { res.result = 'BLOCKED'; res.blockers.push({ message: m }); return res; };
  if (opts.errors.length) return blocked(opts.errors.join('; '));
  const fs = deps.fs;
  const root = deps.cwd;

  const inputs = readInputs(fs, root);
  if (!inputs) return blocked('התיקייה ' + MIGRATION_DIR + '/ לא נמצאה – אין פלטים לדווח עליהם. הרץ קודם את scan.js');
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch (_) { pkg = null; }
  const git = gitInfo(deps.cp, root, deps.env);
  const model = buildModel(inputs, git, pkg, deps.now);
  res.report = model;
  if (!inputs.results.length && !inputs.inventory && !inputs.builds.length && !git.commits.length) {
    return blocked('לא נמצאו פלטי סקריפטים ב-' + MIGRATION_DIR + '/ ולא commits של migration-v2');
  }

  const md = renderMarkdown(model) + '\n';
  const full = path.join(root, REPORT_FILE);
  let existing = null;
  try { existing = fs.readFileSync(full, 'utf8'); } catch (_) { existing = null; }
  if (existing === md) {
    res.result = 'NOOP';
    res.notes.push(REPORT_FILE + ' לא השתנה');
    return res;
  }
  if (!opts.dryRun) {
    try { fs.writeFileSync(full, md, 'utf8'); } catch (err) { return blocked('לא ניתן לכתוב את ' + REPORT_FILE + ': ' + err.message); }
  }
  res.changes.push({ file: REPORT_FILE, rule: 'REPORT.WRITE', confidence: 'auto' });
  res.notes.push(REPORT_FILE + ' ' + (opts.dryRun ? 'היה נכתב' : 'נכתב') + ' לשורש הריפו ולא בוצע לו commit – ההחלטה אם לצרף אותו היא שלך');
  if (model.missingInputs.length) res.notes.push('פלטים חסרים ב-' + MIGRATION_DIR + '/: ' + model.missingInputs.join(', '));
  return res;
}

function formatText(res) {
  const L = [SCRIPT + (res.dryRun ? ' [dry-run]' : '')];
  if (res.report) {
    const s = res.report.summary;
    L.push('📄 ' + res.report.service + ' | ' + s.changedFiles + ' קבצים, ' + s.commits + ' commits | ✋ ' + s.manualCount + ' פריטים ידניים | ☑ ' + res.report.checklist.length + ' בדיקות לפני PR');
  }
  res.blockers.forEach((b) => L.push('⛔ ' + b.message));
  res.notes.forEach((n) => L.push('ℹ ' + n));
  L.push('RESULT: ' + res.result);
  return L.join('\n') + '\n';
}

function main(argv, deps, io) {
  io = io || { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) };
  try {
    const opts = parseArgs(argv || []);
    const res = run(argv, deps);
    io.stdout(opts.json ? JSON.stringify(res, null, 2) + '\n' : formatText(res));
    return 0;
  } catch (err) {
    io.stderr(SCRIPT + ' crashed: ' + ((err && err.stack) || err) + '\n');
    return 1;
  }
}

if (require.main === module) {
  const code = main(process.argv.slice(2));
  process.stdout.write('', () => process.exit(code));
}

module.exports = { run: run, main: main, renderMarkdown: renderMarkdown, buildModel: buildModel };
