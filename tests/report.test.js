'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const { run, main } = require('../scripts/report');
const commit = require('../scripts/commit');

const GIT_ENV = Object.assign({}, process.env, {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1',
});
const g = (cwd, args) => childProcess.execFileSync('git', args, { cwd: cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
const NOW = new Date(2026, 9, 6, 10, 0);

const result = (script, extra) => Object.assign({ script: script, result: 'OK', changes: [], manual: [], blockers: [], notes: [] }, extra);

function setup(opts) {
  opts = opts || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-test-'));
  g(root, ['init', '-q', '-b', 'digital_V2']);
  write(root, 'package.json', '{ "name": "hasava-mfe", "version": "0.1.1" }\n');
  write(root, 'src/SearchReport.jsx', 'v1\n');
  write(root, 'src/App.jsx', 'v1\n');
  g(root, ['add', '.']);
  g(root, ['commit', '-q', '-m', 'base']);
  g(root, ['checkout', '-q', '-b', 'feature/migration-v2-hasava-mfe-20261005']);
  g(root, ['tag', 'migration-start-20261005-1407']);
  write(root, 'package.json', '{ "name": "hasava-mfe", "version": "2.0.0" }\n');
  write(root, 'src/App.jsx', 'v2\n');
  g(root, ['add', '.']);
  g(root, ['commit', '-q', '-m', 'migration-v2(mechanical): package.json, MUI imports, React 18 (2 files)']);
  write(root, 'src/SearchReport.jsx', 'v2\n');
  g(root, ['add', '.']);
  g(root, ['commit', '-q', '-m', 'migration-v2(infra): styles, useSharedState, webpack federation (1 files)']);
  if (opts.stash) { write(root, 'src/App.jsx', 'wip\n'); g(root, ['stash', '-q']); }

  const m = (name, data) => write(root, '.migration/' + name, JSON.stringify(data, null, 2));
  m('inventory.json', {
    service: { name: 'hasava-mfe' },
    makeStyles: [{ file: 'src/SearchReport.jsx', line: 7, level: 'static' }],
    react18Only: [{ file: 'src/Home.jsx', line: 5, api: 'useId' }],
    routerPost602: opts.noRouter ? [] : [{ file: 'src/routes.js', line: 2, api: 'createBrowserRouter' }],
    pickers: [],
    blockers: [],
    warnings: [{ kind: 'react18Only', file: 'src/Home.jsx', line: 5, message: 'useId אינו קיים ב-React 17' }],
  });
  m('package-json.json', result('package-json', {
    changes: [{ file: 'package.json', rule: 'PKG.UPDATE', confidence: 'auto', detail: 'react ^18.3.1' }],
    notes: ['כלי build ב-dependencies (לא הוזזו): babel-loader, react-scripts'],
  }));
  m('codemod-mui-imports.json', result('codemod-mui-imports', {
    result: 'REVIEW',
    changes: [{ file: 'src/App.jsx', line: 2, rule: 'MUI.IMPORT', confidence: 'auto', detail: '@material-ui/core → @mui/material' }],
    manual: [{ file: 'src/App.jsx', line: 9, reason: 'Hidden: הוסר ב-v5 – דורש המרה סמנטית' }],
  }));
  const ms = [];
  for (let i = 1; i <= 25; i++) ms.push({ file: 'src/components/C' + i + '.jsx', line: i, rule: 'MS.SLOT', confidence: 'auto', detail: 'classes.paper → slotProps.paper.sx' });
  ms.push({ file: 'src/SearchReport.jsx', line: 18, rule: 'MS.HOOK', confidence: 'review', detail: "classes.option → '& .MuiAutocomplete-option'", reason: 'מיקום ה-selector נגזר ממבנה ה-DOM – ודא ויזואלית' });
  m('codemod-makestyles.json', result('codemod-makestyles', {
    result: 'REVIEW',
    changes: ms,
    manual: [{ file: 'src/Dynamic.jsx', line: 4, reason: 'רמה C – המפתחות box תלויים ב-props' }],
  }));
  m('webpack-shared.json', result('webpack-shared', {
    changes: [{ file: 'webpack.config.js', line: 23, rule: 'WEBPACK.SHARED', confidence: 'auto', detail: "shared → buildSharedGen1({ pkg, require, role: 'remote' })" }],
    notes: ["ל-output של prod (שורה 13) אין publicPath – מומלץ publicPath: 'auto' ב-remote"],
  }));
  m('build-1.json', { script: 'build', result: 'BLOCKED', errorCount: 3, warningCount: 1, diagnostics: [], notes: [], changes: [], manual: [] });
  m('build-2.json', {
    script: 'build', result: opts.buildOk ? 'OK' : 'BLOCKED', errorCount: opts.buildOk ? 0 : 1, warningCount: 1, notes: [], changes: [], manual: [],
    diagnostics: opts.buildOk ? [] : [{ source: 'webpack', severity: 'error', file: 'src/index.jsx', line: 3, column: 1, code: 'MODULE_NOT_FOUND', message: "Can't resolve './Missing'" }],
  });
  return root;
}

const reportOf = (root) => fs.readFileSync(path.join(root, 'MIGRATION-V2-REPORT.md'), 'utf8');

test('header and summary: service, date, branch, tag, files / commits, build, manual count', () => {
  const root = setup({ buildOk: true });
  const res = run([], { cwd: root, now: NOW, env: GIT_ENV });
  assert.strictEqual(res.result, 'OK');
  const md = reportOf(root);
  assert.match(md, /^# דוח הסבה לדור 2 – hasava-mfe\n/);
  assert.match(md, /תאריך: 2026-10-06 \| בראנץ': `feature\/migration-v2-hasava-mfe-20261005` \| tag לשחזור: `migration-start-20261005-1407`/);
  assert.match(md, /3 קבצים שונו ב-2 commits \| build: ✅ עובר \(1 אזהרות\) \| \*\*\d+ פריטים לטיפול ידני\*\*/);
});

test('manual section comes before the changes, numbered, file:line – reason', () => {
  const root = setup({ buildOk: true });
  run([], { cwd: root, now: NOW, env: GIT_ENV });
  const md = reportOf(root);
  assert.ok(md.indexOf('## דורש טיפול ידני') < md.indexOf('## שינויים שבוצעו'));
  const section = md.slice(md.indexOf('## דורש טיפול ידני'), md.indexOf('## שינויים שבוצעו'));
  assert.match(section, /^1\. `src\/App\.jsx:9` – Hidden: הוסר ב-v5/m);
  assert.match(section, /^2\. `src\/Dynamic\.jsx:4` – רמה C/m);
  assert.match(section, /^3\. `src\/Home\.jsx:5` – useId אינו קיים ב-React 17/m);
  assert.match(section, /`src\/SearchReport\.jsx:18` – לבדיקה: מיקום ה-selector/);
});

test('failed build → blocked items and build errors listed first in manual', () => {
  const root = setup();
  run([], { cwd: root, now: NOW, env: GIT_ENV });
  const md = reportOf(root);
  assert.match(md, /build: ⛔ נכשל – 1 שגיאות \(בהרצה הראשונה: 3, 2 הרצות\)/);
  assert.match(md, /^1\. `src\/index\.jsx:3` – שגיאת build \[webpack MODULE_NOT_FOUND\]: Can't resolve '\.\/Missing'/m);
  assert.match(md, /- \[ \] ה-build עובר/);
});

test('changes grouped by stage; a stage with more than 20 rows is collapsed', () => {
  const root = setup({ buildOk: true });
  run([], { cwd: root, now: NOW, env: GIT_ENV });
  const md = reportOf(root);
  const order = ['### package.json (1)', '### ייבוא MUI (1)', '### makeStyles → sx (26)', '### webpack federation (1)'].map((h) => md.indexOf(h));
  assert.ok(order.every((i, k) => i !== -1 && (k === 0 || i > order[k - 1])), order.join(','));
  const ms = md.slice(md.indexOf('### makeStyles → sx'), md.indexOf('### webpack federation'));
  assert.match(ms, /<details>\n<summary>26 שינויים – לחץ להצגה<\/summary>/);
  assert.match(ms, /\| makeStyles → sx \| `src\/SearchReport\.jsx:18` \| classes\.option → '& \.MuiAutocomplete-option' 🔍 \|/);
  const pkg = md.slice(md.indexOf('### package.json'), md.indexOf('### ייבוא MUI'));
  assert.ok(pkg.indexOf('<details>') === -1);
});

test('notes from all scripts + inventory findings', () => {
  const root = setup({ buildOk: true });
  run([], { cwd: root, now: NOW, env: GIT_ENV });
  const md = reportOf(root);
  const notes = md.slice(md.indexOf('## הערות'), md.indexOf('## מה לבדוק לפני PR'));
  assert.match(notes, /כלי build ב-dependencies \(לא הוזזו\): babel-loader, react-scripts _\(package-json\)_/);
  assert.match(notes, /אין publicPath/);
  assert.match(notes, /useId \(API של React 18 בלבד\) ב-src\/Home\.jsx:5/);
});

test('checklist is derived from the findings', () => {
  const root = setup({ buildOk: true, stash: true });
  run([], { cwd: root, now: NOW, env: GIT_ENV });
  const list = reportOf(root).split('## מה לבדוק לפני PR')[1];
  assert.match(list, /- \[ \] טעינת השירות תחת ה-Host הישן \(React 17\) ותחת ה-Host החדש/);
  assert.match(list, /- \[ \] בדיקה ויזואלית של המסכים .*src\/components\/C1\.jsx/);
  assert.match(list, /createBrowserRouter \(src\/routes\.js:2\)/);
  assert.match(list, /git stash יש 1 רשומות/);
  assert.ok(list.indexOf('ה-build עובר') === -1);
});

test('no router / no stash → those checklist items are absent', () => {
  const root = setup({ buildOk: true, noRouter: true });
  run([], { cwd: root, now: NOW, env: GIT_ENV });
  const list = reportOf(root).split('## מה לבדוק לפני PR')[1];
  assert.ok(list.indexOf('react-router') === -1);
  assert.ok(list.indexOf('stash') === -1);
});

test('missing script outputs are listed; git commits fill the gap', () => {
  const root = setup({ buildOk: true });
  fs.unlinkSync(path.join(root, '.migration', 'codemod-mui-imports.json'));
  run([], { cwd: root, now: NOW, env: GIT_ENV });
  const md = reportOf(root);
  assert.match(md, /פלטים שלא נמצאו ב-\.migration\/: preflight, branch, codemod-mui-imports/);
  assert.match(md, /### commit mechanical \(1\)\n\n\| שלב \| קובץ \| מה שונה \|\n\|---\|---\|---\|\n\| commit mechanical \| `src\/App\.jsx` \| שונה \(migration-v2\(mechanical\)/);
});

test('never committed: HEAD unchanged, and commit.js skips the report', () => {
  const root = setup({ buildOk: true });
  const head = g(root, ['rev-parse', 'HEAD']);
  run([], { cwd: root, now: NOW, env: GIT_ENV });
  assert.strictEqual(g(root, ['rev-parse', 'HEAD']), head);
  assert.match(g(root, ['status', '--porcelain']), /\?\? MIGRATION-V2-REPORT\.md/);
  const c = commit.run(['--step', 'build-fixes', '--dry-run'], { cwd: root, env: GIT_ENV });
  assert.strictEqual(c.result, 'NOOP');
});

test('second run → NOOP; --dry-run writes nothing; --json carries the same model', () => {
  const root = setup({ buildOk: true });
  const dry = run(['--dry-run'], { cwd: root, now: NOW, env: GIT_ENV });
  assert.strictEqual(dry.result, 'OK');
  assert.ok(!fs.existsSync(path.join(root, 'MIGRATION-V2-REPORT.md')));
  run([], { cwd: root, now: NOW, env: GIT_ENV });
  assert.strictEqual(run([], { cwd: root, now: NOW, env: GIT_ENV }).result, 'NOOP');
  let out = '';
  main(['--json', '--dry-run'], { cwd: root, now: NOW, env: GIT_ENV }, { stdout: (s) => { out += s; }, stderr: () => {} });
  const res = JSON.parse(out);
  assert.strictEqual(res.report.service, 'hasava-mfe');
  assert.strictEqual(res.report.summary.commits, 2);
  ['changes', 'manual', 'notes', 'checklist'].forEach((k) => assert.ok(Array.isArray(res.report[k]), k));
});

test('its own saved output (.migration/report.json from run.js) is not an input – report stays stable', () => {
  const root = setup({ buildOk: true });
  const first = run([], { cwd: root, now: NOW, env: GIT_ENV });
  fs.writeFileSync(path.join(root, '.migration', 'report.json'), JSON.stringify(first));
  assert.strictEqual(run([], { cwd: root, now: NOW, env: GIT_ENV }).result, 'NOOP');
});

test('no .migration/ → BLOCKED', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-test-'));
  let out = '';
  assert.strictEqual(main([], { cwd: root, env: GIT_ENV }, { stdout: (s) => { out += s; }, stderr: () => {} }), 0);
  assert.match(out, /RESULT: BLOCKED\n$/);
});
