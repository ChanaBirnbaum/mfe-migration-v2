'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { run, main } = require('../scripts/package-json');

const FIX = path.join(__dirname, 'fixtures', 'package-json');
const read = (c, f) => fs.readFileSync(path.join(FIX, c, f), 'utf8');
const toCrlf = (s) => s.replace(/\r?\n/g, '\r\n');

function repo(pkgText, inventory) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-test-'));
  fs.writeFileSync(path.join(root, 'package.json'), pkgText);
  if (inventory) {
    fs.mkdirSync(path.join(root, '.migration'));
    fs.writeFileSync(path.join(root, '.migration', 'inventory.json'), JSON.stringify(inventory));
  }
  return root;
}

const npmCalls = [];
const deps = (root) => ({ cwd: root, npmView: (name) => { npmCalls.push(name); return '1.4.0'; } });
const pkgOf = (root) => fs.readFileSync(path.join(root, 'package.json'), 'utf8');
const ICONS_INVENTORY = { muiFiles: [{ file: 'src/A.jsx', imports: [{ module: '@material-ui/icons/Add' }] }] };

// ---- golden files ----

test('golden: typical service (pickers upgraded → REVIEW)', () => {
  const root = repo(read('typical', 'before.json'));
  const res = run([], deps(root));
  assert.strictEqual(res.result, 'REVIEW');
  assert.strictEqual(pkgOf(root), read('typical', 'after.json'));
  assert.match(res.notes.join('\n'), /babel-loader, react-scripts/);
});

test('golden: already migrated → NOOP, file untouched, no registry call', () => {
  const root = repo(read('already-migrated', 'before.json'));
  const before = fs.statSync(path.join(root, 'package.json')).mtimeMs;
  npmCalls.length = 0;
  const res = run([], deps(root));
  assert.strictEqual(res.result, 'NOOP');
  assert.deepStrictEqual(res.changes, []);
  assert.strictEqual(pkgOf(root), read('already-migrated', 'after.json'));
  assert.strictEqual(fs.statSync(path.join(root, 'package.json')).mtimeMs, before);
  assert.deepStrictEqual(npmCalls, []);
});

test('golden: CRLF + 4 spaces, unsorted block, react only in devDependencies, @types, icons via inventory', () => {
  const root = repo(toCrlf(read('crlf-dev-only', 'before.json')), ICONS_INVENTORY);
  const res = run([], deps(root));
  assert.strictEqual(res.result, 'OK');
  const out = pkgOf(root);
  assert.strictEqual(out, toCrlf(read('crlf-dev-only', 'after.json')));
  assert.ok(!/[^\r]\n/.test(out), 'no bare LF');
  const devNotes = res.notes.filter((n) => /only in devDependencies/.test(n));
  assert.strictEqual(devNotes.length, 3); // react, react-dom, react-router-dom
});

test('golden: no icons / no router anywhere → neither added; version inserted after name', () => {
  const root = repo(read('no-icons', 'before.json'));
  const res = run([], deps(root));
  assert.strictEqual(res.result, 'OK');
  assert.strictEqual(pkgOf(root), read('no-icons', 'after.json'));
  assert.ok(res.notes.some((n) => /^react-router-dom not added/.test(n)));
});

test('every golden "after" is idempotent', () => {
  ['typical', 'crlf-dev-only', 'no-icons'].forEach((c) => {
    const root = repo(read(c, 'before.json'), ICONS_INVENTORY);
    run([], deps(root));
    const once = pkgOf(root);
    const res = run([], deps(root));
    assert.strictEqual(res.result, 'NOOP', c);
    assert.strictEqual(pkgOf(root), once, c);
  });
});

// ---- rules ----

test('react / react-dom stay in devDependencies (not removed) with the same version', () => {
  const root = repo(read('typical', 'before.json'));
  run([], deps(root));
  const pkg = JSON.parse(pkgOf(root));
  assert.strictEqual(pkg.devDependencies.react, pkg.dependencies.react);
  assert.strictEqual(pkg.devDependencies['react-dom'], pkg.dependencies['react-dom']);
});

test('@ips/mfe-shared-deps goes to dependencies only', () => {
  const root = repo(read('typical', 'before.json'));
  run([], deps(root));
  const pkg = JSON.parse(pkgOf(root));
  assert.strictEqual(pkg.dependencies['@ips/mfe-shared-deps'], '^1.4.0');
  assert.strictEqual(pkg.devDependencies['@ips/mfe-shared-deps'], undefined);
});

test('build tools are not moved between blocks', () => {
  const root = repo(read('typical', 'before.json'));
  run([], deps(root));
  const pkg = JSON.parse(pkgOf(root));
  assert.strictEqual(pkg.dependencies['babel-loader'], '^8.2.2');
  assert.strictEqual(pkg.dependencies['react-scripts'], '5.0.0');
  assert.strictEqual(pkg.devDependencies.webpack, '^5.57.1');
});

test('@material-ui/icons declared but no inventory → icons added, REVIEW', () => {
  const root = repo(read('crlf-dev-only', 'before.json'));
  const res = run([], deps(root));
  assert.strictEqual(res.result, 'REVIEW');
  assert.strictEqual(JSON.parse(pkgOf(root)).dependencies['@mui/icons-material'], '^7.3.11');
});

test('inventory without icons usage → icons not added', () => {
  const root = repo(read('crlf-dev-only', 'before.json'), { muiFiles: [{ file: 'a', imports: [{ module: '@material-ui/core' }] }] });
  run([], deps(root));
  assert.strictEqual(JSON.parse(pkgOf(root)).dependencies['@mui/icons-material'], undefined);
});

test('single-line block and missing dependencies block', () => {
  const root = repo('{ "name": "x", "dependencies": { "react": "^17.0.2" } }\n');
  run([], deps(root));
  const out = pkgOf(root);
  assert.match(out, /^\{ "name": "x", "version": "2\.0\.0", "dependencies": \{ "@emotion\/react"/);
  assert.strictEqual(JSON.parse(out).dependencies['react-router-dom'], undefined);

  const root2 = repo('{\n  "name": "y"\n}\n');
  run([], deps(root2));
  const pkg = JSON.parse(pkgOf(root2));
  assert.strictEqual(pkg.dependencies.react, '^18.3.1');
  assert.deepStrictEqual(Object.keys(pkg), ['name', 'version', 'dependencies']);
});

test('--dry-run reports changes, writes nothing', () => {
  const root = repo(read('typical', 'before.json'));
  const res = run(['--dry-run'], deps(root));
  assert.strictEqual(res.result, 'REVIEW');
  assert.ok(res.changes.length > 5);
  assert.strictEqual(pkgOf(root), read('typical', 'before.json'));
});

test('registry failure for @ips/mfe-shared-deps → BLOCKED, nothing written', () => {
  const root = repo(read('typical', 'before.json'));
  const res = run([], { cwd: root, npmView: () => { throw new Error('ETIMEDOUT'); } });
  assert.strictEqual(res.result, 'BLOCKED');
  assert.match(res.blockers[0].message, /@ips\/mfe-shared-deps/);
  assert.strictEqual(pkgOf(root), read('typical', 'before.json'));
});

// ---- stub mode (approved in run.js) ----

const stubMode = require('../scripts/stub-mode');
const STUB = { active: true, packages: ['@ips/mfe-shared-deps'], source: 'env' };
const STUB_SPEC = 'file:' + path.join(__dirname, '..', 'test-fixtures', 'ips-mfe-shared-deps').split(path.sep).join('/');
const offline = () => { throw new Error('npm ERR! code E404'); };

test('stub mode: @ips/mfe-shared-deps → file:<absolute stub path> in dependencies, everything else unchanged', () => {
  const normal = repo(read('typical', 'before.json'));
  run([], deps(normal));
  const root = repo(read('typical', 'before.json'));
  const res = run([], { cwd: root, npmView: offline, stub: STUB });
  assert.strictEqual(res.result, 'REVIEW', JSON.stringify(res.blockers));
  const pkg = JSON.parse(pkgOf(root));
  assert.strictEqual(pkg.dependencies['@ips/mfe-shared-deps'], STUB_SPEC);
  assert.ok(path.isAbsolute(STUB_SPEC.slice(5)));
  assert.strictEqual(STUB_SPEC, stubMode.stubSpec('@ips/mfe-shared-deps'));
  // the only difference from a normal run is that one value
  assert.strictEqual(pkgOf(root), pkgOf(normal).replace('"^1.4.0"', JSON.stringify(STUB_SPEC)));
  assert.match(res.notes.join(' '), /must NOT be committed/);
});

test('stub mode: an already-declared real version is replaced by the stub', () => {
  const root = repo(JSON.stringify({ name: 'x', dependencies: { react: '^17.0.2', '@ips/mfe-shared-deps': '^1.2.0' } }, null, 2) + '\n');
  run([], { cwd: root, npmView: offline, stub: STUB });
  assert.strictEqual(JSON.parse(pkgOf(root)).dependencies['@ips/mfe-shared-deps'], STUB_SPEC);
});

test('stub mode but the registry HAS the package → BLOCKED, the stub is never written', () => {
  const root = repo(read('typical', 'before.json'));
  const res = run([], { cwd: root, npmView: () => '1.4.0', stub: STUB });
  assert.strictEqual(res.result, 'BLOCKED');
  assert.match(res.blockers[0].message, /is available in the registry \(1\.4\.0\) – stub mode must not be used/);
  assert.strictEqual(pkgOf(root), read('typical', 'before.json'));
});

test('stub mode is idempotent: second run → NOOP', () => {
  const root = repo(read('already-migrated', 'before.json'));
  run([], { cwd: root, npmView: offline, stub: STUB });
  const again = run([], { cwd: root, npmView: offline, stub: STUB });
  assert.strictEqual(again.result, 'NOOP');
});

test('not in stub mode, but package.json still points to the stub → replaced with the real version', () => {
  const root = repo(JSON.stringify({ name: 'x', dependencies: { react: '^17.0.2', '@ips/mfe-shared-deps': STUB_SPEC } }, null, 2) + '\n');
  const res = run([], Object.assign(deps(root), { stub: stubMode.INACTIVE }));
  assert.strictEqual(JSON.parse(pkgOf(root)).dependencies['@ips/mfe-shared-deps'], '^1.4.0');
  assert.match(res.notes.join(' '), /pointed to the local test stub .* replaced with the real package/);
});

test('stub mode only touches packages that are stubbed – an env list with a public package is ignored', () => {
  const mode = stubMode.detect({ env: { MFE_MIGRATION_STUB: 'react,@ips/mfe-shared-deps' }, cwd: os.tmpdir() });
  assert.deepStrictEqual(mode.packages, ['@ips/mfe-shared-deps']);
  assert.strictEqual(stubMode.detect({ env: { MFE_MIGRATION_STUB: 'react' }, cwd: os.tmpdir() }).active, false);
});

test('stub mode --json: stubMode: true at the top level, warning first; text output starts with a banner', () => {
  const env = Object.assign({}, process.env, { MFE_MIGRATION_STUB: '@ips/mfe-shared-deps' });
  let out = '';
  main(['--json', '--dry-run'], { cwd: repo(read('typical', 'before.json')), npmView: offline, env: env }, { stdout: (s) => { out += s; }, stderr: () => {} });
  const res = JSON.parse(out);
  assert.strictEqual(res.stubMode, true);
  assert.deepStrictEqual(res.stubPackages, ['@ips/mfe-shared-deps']);
  assert.match(res.notes[0], /^STUB MODE: @ips\/mfe-shared-deps is a local test stub/);
  out = '';
  main(['--dry-run'], { cwd: repo(read('typical', 'before.json')), npmView: offline, env: env }, { stdout: (s) => { out += s; }, stderr: () => {} });
  assert.match(out.split('\n')[0], /^⚠ STUB MODE – @ips\/mfe-shared-deps is a local test stub/);
});

test('not in stub mode: no stubMode field in the output', () => {
  let out = '';
  main(['--json', '--dry-run'], Object.assign(deps(repo(read('typical', 'before.json'))), { env: {} }), { stdout: (s) => { out += s; }, stderr: () => {} });
  assert.strictEqual(JSON.parse(out).stubMode, undefined);
});

test('invalid JSON / missing file → BLOCKED, exit 0', () => {
  let out = '';
  const io = { stdout: (s) => { out += s; }, stderr: () => {} };
  assert.strictEqual(main([], deps(repo('{ "name": ')), io), 0);
  assert.match(out, /RESULT: BLOCKED\n$/);
  out = '';
  assert.strictEqual(main([], deps(fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-test-'))), io), 0);
  assert.match(out, /RESULT: BLOCKED\n$/);
});

test('--json contract', () => {
  let out = '';
  main(['--json', '--dry-run'], deps(repo(read('typical', 'before.json'))), { stdout: (s) => { out += s; }, stderr: () => {} });
  const res = JSON.parse(out);
  assert.deepStrictEqual(Object.keys(res).slice(0, 6), ['script', 'result', 'changes', 'manual', 'blockers', 'notes']);
  assert.ok(res.changes.every((c) => c.file === 'package.json'));
  const review = res.changes.filter((c) => c.confidence === 'review').map((c) => c.detail);
  assert.deepStrictEqual(review, ['@material-ui/pickers', '@mui/x-date-pickers ^9.3.0']);
});

// ---- react-router-dom: only if declared or used ----

const MINI = read('no-icons', 'before.json'); // no router declared
const routerOf = (root) => JSON.parse(pkgOf(root)).dependencies['react-router-dom'];

test('router: not declared, inventory shows router imports → added', () => {
  const root = repo(MINI, { routerImports: [{ file: 'src/App.jsx', line: 2, module: 'react-router-dom', names: ['BrowserRouter'] }] });
  const res = run([], deps(root));
  assert.strictEqual(routerOf(root), '^6.30.1');
  assert.ok(res.changes.some((c) => c.rule === 'PKG.ADD' && /^react-router-dom \^6\.30\.1 \(used according to inventory\)$/.test(c.detail)));
});

test('router: not declared, inventory shows no router imports → skipped with a note', () => {
  const root = repo(MINI, { routerImports: [] });
  const res = run([], deps(root));
  assert.strictEqual(routerOf(root), undefined);
  assert.ok(res.notes.includes('react-router-dom not added – it is not declared in package.json and the inventory shows no usage'));
  assert.ok(!res.changes.some((c) => /react-router-dom/.test(c.detail)));
});

test('router: not declared, no inventory (or inventory without routerImports) → skipped, note points to scan.js', () => {
  [null, { muiFiles: [] }].forEach((inv) => {
    const root = repo(MINI, inv);
    const res = run([], deps(root));
    assert.strictEqual(routerOf(root), undefined);
    assert.ok(res.notes.some((n) => /^react-router-dom not added – .*scan\.js/.test(n)));
  });
});

test('router: already declared → updated even when the inventory shows no use (never removed)', () => {
  const root = repo(read('typical', 'before.json'), { routerImports: [] });
  const res = run([], deps(root));
  assert.strictEqual(routerOf(root), '^6.30.1');
  assert.ok(!res.notes.some((n) => /react-router-dom not added/.test(n)));
});

// ---- pickers ----

const PICKERS_REASON = 'Moving from pickers v3/v5 to x-date-pickers v9 — extensive API changes, needs manual review';

test('pickers: upgrade + removal are review, one manual item per file from inventory, REVIEW', () => {
  const root = repo(read('typical', 'before.json'), {
    pickers: [
      { file: 'src/Dates.jsx', line: 3, module: '@material-ui/pickers', names: ['KeyboardDatePicker'] },
      { file: 'src/Dates.jsx', line: 4, module: '@mui/x-date-pickers/DatePicker', names: ['DatePicker'] },
      { file: 'src/Range.jsx', line: 1, module: '@mui/x-date-pickers', names: ['LocalizationProvider'] },
    ],
  });
  const res = run([], deps(root));
  assert.strictEqual(res.result, 'REVIEW');
  // the versions are still updated
  const pkg = JSON.parse(pkgOf(root));
  assert.strictEqual(pkg.dependencies['@mui/x-date-pickers'], '^9.3.0');
  assert.strictEqual(pkg.dependencies['@material-ui/pickers'], undefined);

  const pick = res.changes.filter((c) => /pickers/.test(c.detail));
  assert.deepStrictEqual(pick.map((c) => [c.rule, c.confidence, c.reason]), [
    ['PKG.REMOVE', 'review', PICKERS_REASON],
    ['PKG.UPDATE', 'review', PICKERS_REASON],
  ]);
  assert.ok(res.changes.filter((c) => !/pickers/.test(c.detail)).every((c) => c.confidence === 'auto'));
  assert.deepStrictEqual(res.manual, [
    { file: 'src/Dates.jsx', line: 3, reason: PICKERS_REASON },
    { file: 'src/Range.jsx', line: 1, reason: PICKERS_REASON },
  ]);

  // second run: nothing left to change → NOOP, no manual
  const again = run([], deps(root));
  assert.strictEqual(again.result, 'NOOP');
  assert.deepStrictEqual(again.manual, []);
});

test('pickers: no inventory → one manual item on package.json pointing to scan.js', () => {
  const res = run([], deps(repo(read('typical', 'before.json'))));
  assert.strictEqual(res.result, 'REVIEW');
  assert.strictEqual(res.manual.length, 1);
  assert.strictEqual(res.manual[0].file, 'package.json');
  assert.match(res.manual[0].reason, /^Moving from pickers v3\/v5 to x-date-pickers v9 — .*scan\.js/);
});

test('pickers: x-date-pickers only added (never declared) → stays auto, no manual', () => {
  const res = run([], deps(repo(read('no-icons', 'before.json'))));
  assert.strictEqual(res.result, 'OK');
  const add = res.changes.find((c) => /x-date-pickers/.test(c.detail));
  assert.strictEqual(add.rule, 'PKG.ADD');
  assert.strictEqual(add.confidence, 'auto');
  assert.deepStrictEqual(res.manual, []);
});

// ---- expected failures → BLOCKED, exit 0 ----

test('package.json with a comment / trailing comma (TS parser accepts, JSON.parse does not) → BLOCKED, exit 0, not written', () => {
  ['{\n  // legacy\n  "name": "x",\n  "dependencies": { "react": "^17.0.2" }\n}\n',
    '{\n  "name": "x",\n  "dependencies": { "react": "^17.0.2", }\n}\n'].forEach((text) => {
    const root = repo(text);
    let out = '';
    const code = main(['--json'], deps(root), { stdout: (s) => { out += s; }, stderr: (s) => { throw new Error('stderr: ' + s); } });
    assert.strictEqual(code, 0);
    const res = JSON.parse(out);
    assert.strictEqual(res.result, 'BLOCKED');
    assert.match(res.blockers[0].message, /^package\.json: the original file is not valid JSON \(.+\) – probably a comment or a trailing comma.*The file was not written$/);
    assert.deepStrictEqual(res.changes, []);
    assert.deepStrictEqual(res.manual, []);
    assert.strictEqual(pkgOf(root), text);
  });
});
