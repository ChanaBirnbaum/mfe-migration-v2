#!/usr/bin/env node
'use strict';

// report: build MIGRATION-V2-REPORT.md (Hebrew) from everything in .migration/ plus git history.
// Inputs: any .migration/*.json that is a script result ({ script, result, changes, manual, notes }),
// inventory.json (scan) and build-<n>.json (build). Git supplies commits / branch / tag.
// The report is written to the repo root and is never committed – that is the user's decision.

const path = require('path');
const stubMode = require('./stub-mode');

const SCRIPT = 'report';
const REPORT_FILE = 'MIGRATION-V2-REPORT.md';
const MIGRATION_DIR = '.migration';
const COLLAPSE_OVER = 20;

// order + labels of the steps that change source files
const STAGES = [
  ['package-json', 'package.json'],
  ['codemod-mui-imports', 'MUI imports'],
  ['codemod-react18', 'React 18'],
  ['codemod-anti-patterns', 'async useEffect'],
  ['codemod-makestyles', 'makeStyles → sx'],
  ['use-shared-state', 'useSharedState'],
  ['webpack-shared', 'webpack federation'],
  ['install', 'install'],
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
    else opts.errors.push('Unknown argument: ' + a);
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

// Stub run: the steps that ran against the local stub and what each one proved about the pipeline
const STUB_PROVED = [
  ['branch', 'Branch'],
  ['codemods', 'Codemods'],
  ['install', 'Install'],
  ['build', 'Build'],
  ['verify-runtime', 'Runtime check'],
];
const CODEMODS = ['codemod-mui-imports', 'codemod-react18', 'codemod-anti-patterns', 'codemod-makestyles', 'use-shared-state', 'webpack-shared'];
const RANK = { BLOCKED: 3, REVIEW: 2, OK: 1, NOOP: 0 };

function stubModel(stub, latestPerScript, lastBuild) {
  const packages = new Set(stub && stub.active ? stub.packages : []);
  latestPerScript.forEach((r) => { if (r.stubMode) (r.stubPackages || []).forEach((p) => packages.add(p)); });
  if (lastBuild && lastBuild.stubMode) (lastBuild.stubPackages || []).forEach((p) => packages.add(p));
  if (!packages.size) return null;
  const latest = new Map(latestPerScript.map((r) => [r.script, r.result]));
  const resultOf = (id) => {
    if (id === 'build') return lastBuild ? lastBuild.result : null;
    if (id !== 'codemods') return latest.get(id) || null;
    const rs = CODEMODS.map((s) => latest.get(s)).filter(Boolean);
    return rs.length ? rs.reduce((a, b) => ((RANK[b] || 0) > (RANK[a] || 0) ? b : a)) : null;
  };
  return {
    packages: Array.from(packages),
    proved: STUB_PROVED.map(([id, label]) => ({ label: label, result: resultOf(id) })),
  };
}

function buildModel(inputs, git, pkg, now, stub) {
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
    const what = { A: 'added', M: 'modified', D: 'deleted' }[f.status.charAt(0)] || f.status;
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
  latestPerScript.filter((r) => r.result === 'BLOCKED').forEach((r) => (r.blockers || []).forEach((b) => addManual({ reason: 'Script ' + r.script + ' was blocked: ' + b.message }, r.script)));
  if (lastBuild && lastBuild.errorCount) {
    (lastBuild.diagnostics || []).filter((d) => d.severity === 'error').forEach((d) => addManual({ file: d.file, line: d.line, reason: 'Build error [' + d.source + (d.code ? ' ' + d.code : '') + ']: ' + d.message }, 'build'));
  }
  const fileManual = [];
  all.forEach((r) => (r.manual || []).forEach((m) => fileManual.push([m, r.script])));
  if (inputs.inventory) (inputs.inventory.warnings || []).filter((w) => w.file).forEach((w) => fileManual.push([{ file: w.file, line: w.line, reason: w.message }, 'scan']));
  fileManual.sort((a, b) => String(a[0].file || '').localeCompare(String(b[0].file || '')) || (a[0].line || 0) - (b[0].line || 0));
  fileManual.forEach(([m, s]) => addManual(m, s));
  // review-level changes also need a human look
  all.forEach((r) => (r.changes || []).filter((c) => c.confidence === 'review' && c.reason).forEach((c) => addManual({ file: c.file, line: c.line, reason: 'To review: ' + c.reason }, r.script)));

  // notes
  const notes = [];
  const noteSeen = new Set();
  const addNote = (text, source) => { const k = text; if (!noteSeen.has(k)) { noteSeen.add(k); notes.push({ source: source, text: text }); } };
  // the per-step stub warning is the first section of the report – not repeated as a note
  all.forEach((r) => (r.notes || []).forEach((n) => { if (!/^STUB MODE: /.test(n)) addNote(n, r.script); }));
  const inv = inputs.inventory;
  if (inv) {
    (inv.react18Only || []).forEach((u) => addNote('Uses ' + u.api + ' (a React 18-only API) in ' + u.file + ':' + u.line + ' – not available under a Host with React 17', 'scan'));
    (inv.blockers || []).forEach((b) => addNote('Package not compatible with React 18: ' + b.package + ' ' + b.range + ' → ' + (b.fixedIn || b.alternative || '?'), 'scan'));
  }

  // checklist
  const msChanges = changes.filter((c) => c.stage === 'codemod-makestyles');
  const msFiles = Array.from(new Set(msChanges.map((c) => c.file.split(':')[0])));
  const msPending = inv && (inv.makeStyles || []).length && !msFiles.length;
  const stubInfo = stubModel(stub, Array.from(byScript.values()).map((rs) => rs[rs.length - 1]), lastBuild);
  const checklist = [];
  if (stubInfo) checklist.push({ text: 'Re-run the whole pipeline on the internal network with the real ' + stubInfo.packages.join(', ') + ' (run.js --from preflight) – this run used a local stub and committed nothing', reason: 'stub' });
  checklist.push({ text: 'Load the service under the old Host (React 17) and under the new Host (React 18)', reason: 'always' });
  if (msFiles.length || msPending) {
    checklist.push({ text: 'Visually check the screens that use components converted from makeStyles' + (msFiles.length ? ': ' + msFiles.join(', ') : ''), reason: 'makeStyles changes' });
  }
  const post602 = inv ? inv.routerPost602 || [] : [];
  if (post602.length) {
    checklist.push({ text: 'The routes that use react-router APIs added after 6.0.2: ' + post602.map((u) => u.api + ' (' + u.file + ':' + u.line + ')').join(', '), reason: 'routerPost602' });
  }
  if (inv && (inv.react18Only || []).length) checklist.push({ text: 'React 18-only API usages – verify behavior under a Host with React 17', reason: 'react18Only' });
  if (changes.some((c) => c.stage === 'codemod-anti-patterns')) checklist.push({ text: 'Data loading on screens where an async useEffect was converted (including StrictMode)', reason: 'anti-patterns' });
  if (inv && (inv.pickers || []).length) checklist.push({ text: 'Date pickers – the @mui/x-date-pickers API is different', reason: 'pickers' });
  if (git.stashCount) checklist.push({ text: 'git stash has ' + git.stashCount + ' entries – check whether anything needs to be restored (git stash list)', reason: 'stash' });
  if (manual.length) checklist.push({ text: 'All ' + manual.length + ' items in the "Needs manual handling" section have been handled', reason: 'manual' });
  if (lastBuild && lastBuild.result !== 'OK') checklist.push({ text: 'The build passes (npm run build:dev)', reason: 'build' });

  const present = new Set(inputs.results.map((r) => r.script).concat(inputs.builds.length ? ['build'] : []).concat(inv ? ['scan'] : []));
  return {
    service: (pkg && pkg.name) || (inv && inv.service && inv.service.name) || '(no name)',
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
    stub: stubInfo,
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
  L.push('# Generation 2 migration report – ' + m.service);
  L.push('');
  L.push('Date: ' + m.date + ' | Branch: `' + (m.branch || '?') + '` | Restore tag: ' + (m.tag ? '`' + m.tag + '`' : 'not found'));
  L.push('');
  // סעיף ראשון ובולט: אסור שמישהו יקרא "הצינור הושלם" ויחשוב שהכל אומת
  if (m.stub) {
    const pk = m.stub.packages.map((p) => '`' + p + '`').join(', ');
    L.push('## ⚠️ STUB RUN – this is NOT a validated migration');
    L.push('');
    L.push('> **This run used a local test stub (`test-fixtures/`) instead of ' + pk + '.** The stub only imitates the `buildSharedGen1` contract.');
    L.push('');
    L.push('**What this run proved** – the pipeline mechanics, end to end:');
    L.push('');
    m.stub.proved.forEach((p) => L.push('- ' + p.label + ': ' + (p.result || 'not run')));
    L.push('- Report: generated (this file)');
    L.push('');
    L.push('**What it did NOT prove:**');
    L.push('');
    L.push('- The `shared` configuration against the real ' + pk + ' – `buildSharedGen1` came from the stub, so its output (versions, singleton / import settings) says nothing about the real package.');
    L.push('');
    L.push('**Nothing was committed.** The commit steps were skipped, and the working tree is left with uncommitted changes. ' +
      '`package.json` and `package-lock.json` point to the local stub (`file:`) – **do not commit them**: the branch would be broken for anyone who pulls it.');
    L.push('');
    L.push('**Before any real use:** re-run the pipeline on the internal network (`run.js --from preflight`), with the real ' + pk + '.');
    L.push('');
  }

  L.push('## Summary');
  L.push('');
  const b = m.summary.build;
  const buildText = !b ? 'build was not run'
    : b.result === 'OK' ? '✅ passing (' + b.warningCount + ' warnings)'
      : '⛔ failing – ' + b.errorCount + ' errors' + (b.runs > 1 ? ' (first run: ' + b.firstErrorCount + ', ' + b.runs + ' runs)' : '');
  L.push(m.summary.changedFiles + ' files changed in ' + m.summary.commits + ' commits | build: ' + buildText + ' | ' +
    (m.summary.manualCount ? '**' + m.summary.manualCount + ' items need manual handling**' : 'no items need manual handling'));
  L.push('');

  // החלק החשוב ביותר – לפני פירוט השינויים
  L.push('## Needs manual handling');
  L.push('');
  if (!m.manual.length) L.push('No items need manual handling.');
  m.manual.forEach((x, i) => L.push((i + 1) + '. ' + (loc(x) ? '`' + loc(x) + '` – ' : '') + x.reason));
  L.push('');

  L.push('## Changes made');
  L.push('');
  if (!m.changes.length) L.push('No changes found.');
  const stages = [];
  m.changes.forEach((c) => { if (stages.indexOf(c.stage) === -1) stages.push(c.stage); });
  stages.forEach((stage) => {
    const rows = m.changes.filter((c) => c.stage === stage);
    const table = ['| Step | File | What changed |', '|---|---|---|'].concat(rows.map((c) =>
      '| ' + cell(stageLabel(stage)) + ' | `' + cell(c.file) + '` | ' + cell(c.what) + (c.confidence === 'review' ? ' 🔍' : '') + ' |'));
    L.push('### ' + stageLabel(stage) + ' (' + rows.length + ')');
    L.push('');
    if (rows.length > COLLAPSE_OVER) {
      L.push('<details>');
      L.push('<summary>' + rows.length + ' changes – click to expand</summary>');
      L.push('');
      L.push.apply(L, table);
      L.push('');
      L.push('</details>');
    } else {
      L.push.apply(L, table);
    }
    L.push('');
  });

  L.push('## Notes');
  L.push('');
  if (!m.notes.length) L.push('No notes.');
  m.notes.forEach((n) => L.push('- ' + n.text + ' _(' + n.source + ')_'));
  L.push('');

  L.push('## What to check before the PR');
  L.push('');
  m.checklist.forEach((c) => L.push('- [ ] ' + c.text));
  L.push('');

  if (m.missingInputs.length || m.unreadableInputs.length) {
    L.push('---');
    L.push('');
    if (m.missingInputs.length) L.push('_Outputs not found in ' + MIGRATION_DIR + '/: ' + m.missingInputs.join(', ') + '. Their changes were taken from git only, and their manual items are not in the report._');
    if (m.unreadableInputs.length) L.push('_Files that could not be read: ' + m.unreadableInputs.join(', ') + '_');
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
  if (!inputs) return blocked('The folder ' + MIGRATION_DIR + '/ was not found – there are no outputs to report on. Run scan.js first');
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch (_) { pkg = null; }
  const git = gitInfo(deps.cp, root, deps.env);
  const model = buildModel(inputs, git, pkg, deps.now, stubMode.modeFor(deps));
  res.report = model;
  if (!inputs.results.length && !inputs.inventory && !inputs.builds.length && !git.commits.length) {
    return blocked('No script outputs found in ' + MIGRATION_DIR + '/ and no migration-v2 commits');
  }

  const md = renderMarkdown(model) + '\n';
  const full = path.join(root, REPORT_FILE);
  let existing = null;
  try { existing = fs.readFileSync(full, 'utf8'); } catch (_) { existing = null; }
  if (existing === md) {
    res.result = 'NOOP';
    res.notes.push(REPORT_FILE + ' unchanged');
    return res;
  }
  if (!opts.dryRun) {
    try { fs.writeFileSync(full, md, 'utf8'); } catch (err) { return blocked('Cannot write ' + REPORT_FILE + ': ' + err.message); }
  }
  res.changes.push({ file: REPORT_FILE, rule: 'REPORT.WRITE', confidence: 'auto' });
  res.notes.push(REPORT_FILE + ' ' + (opts.dryRun ? 'would be written' : 'was written') + ' to the repo root and was not committed – whether to include it is your decision');
  if (model.missingInputs.length) res.notes.push('Missing outputs in ' + MIGRATION_DIR + '/: ' + model.missingInputs.join(', '));
  return res;
}

function formatText(res) {
  const L = [SCRIPT + (res.dryRun ? ' [dry-run]' : '')];
  if (res.report) {
    const s = res.report.summary;
    L.push('📄 ' + res.report.service + ' | ' + s.changedFiles + ' files, ' + s.commits + ' commits | ✋ ' + s.manualCount + ' manual items | ☑ ' + res.report.checklist.length + ' checks before the PR');
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
    const res = stubMode.annotate(run(argv, deps), stubMode.modeFor(deps));
    io.stdout(opts.json ? JSON.stringify(res, null, 2) + '\n' : stubMode.banner(res) + formatText(res));
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
