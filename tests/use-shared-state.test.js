'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { run, main } = require('../scripts/use-shared-state');

const ASSET = path.join(__dirname, 'fixtures', 'use-shared-state', 'asset-stand-in.js');
const ASSET_TEXT = fs.readFileSync(ASSET, 'utf8');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const lfSha = (s) => sha(s.replace(/\r\n/g, '\n'));
const OLD = 'export default function useSharedState(n, v) { /* 1.x */ return [v, () => {}]; }\n';

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-state-test-'));
  Object.keys(files).forEach((rel) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), files[rel]);
  });
  return root;
}
// skill dir stand-in: reference/versions.json + assets/useSharedState.v<version>.js + assets/useSharedState.meta.json
function skill(o) {
  o = Object.assign({ version: '2.0.0', assets: null, meta: null }, o || {});
  const files = { 'reference/versions.json': JSON.stringify({ assets: { useSharedState: o.version } }) };
  const assets = o.assets || { ['useSharedState.v' + o.version + '.js']: ASSET_TEXT };
  Object.keys(assets).forEach((n) => { files['assets/' + n] = assets[n]; });
  const meta = Object.assign({ version: o.version, source: '', ref: '', sha256: lfSha(ASSET_TEXT), syncedAt: '2026-10-07' }, o.meta || {});
  files['assets/useSharedState.meta.json'] = JSON.stringify(meta);
  const dir = repo(files);
  return { assetsDir: path.join(dir, 'assets'), versionsFile: path.join(dir, 'reference', 'versions.json') };
}
const SKILL = skill();
const deps = (root, sk) => Object.assign({ cwd: root }, sk || SKILL);
const readIn = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const GOOD_CALLER = [
  "import useSharedState from '../services/hooks/useSharedState';",
  'export function A() {',
  "  const [user, setUser] = useSharedState('user');",
  "  const [, setTab] = useSharedState('tab', 0);",
  '  return user;',
  '}',
  '',
].join('\n');

test('identical → NOOP, nothing written', () => {
  const root = repo({ 'src/services/hooks/useSharedState.js': ASSET_TEXT, 'src/pages/A.jsx': GOOD_CALLER });
  const res = run([], deps(root));
  assert.strictEqual(res.result, 'NOOP');
  assert.strictEqual(res.replaced, false);
  assert.strictEqual(res.previousSha, sha(ASSET_TEXT));
  assert.strictEqual(res.callSites.length, 2);
  assert.ok(!fs.existsSync(path.join(root, '.migration')));
});

test('identical except CRLF → NOOP', () => {
  const root = repo({ 'src/hooks/useSharedState.js': ASSET_TEXT.replace(/\n/g, '\r\n') });
  assert.strictEqual(run([], deps(root)).result, 'NOOP');
});

test('different → replaced, previous version backed up; second run NOOP', () => {
  const root = repo({ 'src/shared/useSharedState.js': OLD, 'src/A.jsx': GOOD_CALLER.replace('../services/hooks/useSharedState', './shared/useSharedState') });
  const res = run([], deps(root));
  assert.strictEqual(res.result, 'OK');
  assert.strictEqual(res.replaced, true);
  assert.strictEqual(res.hookPath, 'src/shared/useSharedState.js');
  assert.strictEqual(res.previousSha, sha(OLD));
  assert.strictEqual(readIn(root, 'src/shared/useSharedState.js'), ASSET_TEXT);
  assert.strictEqual(readIn(root, res.backup), OLD);
  assert.match(res.backup, /^\.migration\/backup\/src\/shared\/useSharedState\.js\.[0-9a-f]{12}\.bak$/);
  assert.deepStrictEqual(res.callSites.map((s) => [s.file, s.line, s.ok]), [['src/A.jsx', 3, true], ['src/A.jsx', 4, true]]);
  assert.strictEqual(run([], deps(root)).result, 'NOOP');
});

test('missing → created at src/services/hooks/useSharedState.js', () => {
  const root = repo({ 'src/pages/A.jsx': GOOD_CALLER });
  const res = run([], deps(root));
  assert.strictEqual(res.result, 'OK');
  assert.strictEqual(res.created, true);
  assert.strictEqual(res.previousSha, null);
  assert.strictEqual(readIn(root, 'src/services/hooks/useSharedState.js'), ASSET_TEXT);
  assert.strictEqual(res.callSites.length, 2);
});

test('more than one hook file → REVIEW with all paths, nothing replaced', () => {
  const root = repo({ 'src/a/useSharedState.js': OLD, 'src/b/useSharedState.jsx': OLD });
  const res = run([], deps(root));
  assert.strictEqual(res.result, 'REVIEW');
  assert.match(res.manual[0].reason, /src\/a\/useSharedState\.js, src\/b\/useSharedState\.jsx/);
  assert.strictEqual(readIn(root, 'src/a/useSharedState.js'), OLD);
});

test('node_modules / build copies are ignored when locating the hook', () => {
  const root = repo({ 'src/hooks/useSharedState.js': ASSET_TEXT, 'node_modules/x/useSharedState.js': OLD, 'build/useSharedState.js': OLD });
  assert.strictEqual(run([], deps(root)).result, 'NOOP');
});

test('TypeScript hook that differs → REVIEW, not overwritten with JS', () => {
  const root = repo({ 'src/hooks/useSharedState.ts': 'export default function useSharedState(n: string) { return [n, n]; }\n' });
  const res = run([], deps(root));
  assert.strictEqual(res.result, 'REVIEW');
  assert.match(res.manual[0].reason, /TypeScript/);
});

test('invalid call-sites → REVIEW with each location', () => {
  const root = repo({
    'src/hooks/useSharedState.js': ASSET_TEXT,
    'src/Bad.jsx': [
      "import useShared from './hooks/useSharedState';",
      "import { useSharedState as named } from './hooks/useSharedState';",
      'export function Bad() {',
      "  const state = useShared('a');",
      '  const [x, setX] = useShared();',
      "  const [y, setY, extra] = useShared('b', 1, 2);",
      "  const [z, setZ] = useShared('c', 1);",
      '  const fn = useShared;',
      '  return [state, x, y, z, fn, named];',
      '}',
      '',
    ].join('\n'),
  });
  const res = run([], deps(root));
  assert.strictEqual(res.result, 'REVIEW');
  const bad = res.callSites.filter((s) => !s.ok).map((s) => s.line);
  assert.deepStrictEqual(bad, [2, 4, 5, 6, 8]);
  assert.ok(res.callSites.some((s) => s.line === 7 && s.ok));
  assert.match(res.callSites.find((s) => s.line === 2).reason, /export default/);
  assert.match(res.callSites.find((s) => s.line === 6).reason, /3 ארגומנטים.*3 איברים/);
});

test('commented imports / calls are not call-sites', () => {
  const root = repo({
    'src/hooks/useSharedState.js': ASSET_TEXT,
    'src/C.jsx': "// import useSharedState from './hooks/useSharedState';\n/* const s = useSharedState(); */\nexport const c = 1;\n",
  });
  const res = run([], deps(root));
  assert.strictEqual(res.result, 'NOOP');
  assert.deepStrictEqual(res.callSites, []);
});

test('asset file name comes from versions.json', () => {
  const sk = skill({ version: '2.1.0' });
  const root = repo({});
  const res = run([], deps(root, sk));
  assert.strictEqual(res.result, 'OK');
  assert.strictEqual(res.assetVersion, '2.1.0');
  assert.strictEqual(readIn(root, 'src/services/hooks/useSharedState.js'), ASSET_TEXT);
  assert.match(res.changes[0].detail, /2\.1\.0/);
});

test('asset for the listed version missing → BLOCKED naming missing and present versions, nothing written', () => {
  const sk = skill({ version: '2.1.0', assets: { 'useSharedState.v2.0.0.js': ASSET_TEXT, 'other.js': '' } });
  const root = repo({ 'src/hooks/useSharedState.js': OLD });
  let out = '';
  const code = main([], deps(root, sk), { stdout: (s) => { out += s; }, stderr: () => {} });
  assert.strictEqual(code, 0);
  assert.match(out, /2\.1\.0/);
  assert.match(out, /useSharedState\.v2\.1\.0\.js לא קיים/);
  assert.match(out, /קיים ב-assets\/: useSharedState\.v2\.0\.0\.js/);
  assert.doesNotMatch(out, /other\.js/);
  assert.match(out, /RESULT: BLOCKED\n$/);
  assert.strictEqual(readIn(root, 'src/hooks/useSharedState.js'), OLD);
});

test('versions.json without assets.useSharedState → BLOCKED', () => {
  const sk = skill();
  fs.writeFileSync(sk.versionsFile, JSON.stringify({ packageVersion: '2.0.0' }));
  const res = run([], deps(repo({}), sk));
  assert.strictEqual(res.result, 'BLOCKED');
  assert.match(res.blockers[0].message, /assets\.useSharedState/);
});

test('asset edited without updating meta sha256 → BLOCKED, nothing written', () => {
  const sk = skill({ assets: { 'useSharedState.v2.0.0.js': ASSET_TEXT + '// local tweak\n' } });
  const root = repo({ 'src/hooks/useSharedState.js': OLD });
  const res = run([], deps(root, sk));
  assert.strictEqual(res.result, 'BLOCKED');
  assert.match(res.blockers[0].message, /שונה בלי ש-assets\/useSharedState\.meta\.json עודכן/);
  assert.ok(res.blockers[0].message.includes(lfSha(ASSET_TEXT)));
  assert.strictEqual(readIn(root, 'src/hooks/useSharedState.js'), OLD);
});

test('asset with CRLF line endings still matches meta sha256', () => {
  const sk = skill({ assets: { 'useSharedState.v2.0.0.js': ASSET_TEXT.replace(/\n/g, '\r\n') } });
  assert.strictEqual(run([], deps(repo({}), sk)).result, 'OK');
});

test('meta missing or for another version → BLOCKED', () => {
  const missing = skill();
  fs.unlinkSync(path.join(missing.assetsDir, 'useSharedState.meta.json'));
  assert.match(run([], deps(repo({}), missing)).blockers[0].message, /useSharedState\.meta\.json/);
  const stale = skill({ meta: { version: '1.9.0' } });
  assert.match(run([], deps(repo({}), stale)).blockers[0].message, /1\.9\.0.*2\.0\.0/);
});

test('bundled asset: version in versions.json exists and matches assets/useSharedState.meta.json', () => {
  const res = run(['--dry-run'], { cwd: repo({}) });
  assert.notStrictEqual(res.result, 'BLOCKED', res.blockers.map((b) => b.message).join('; '));
  const meta = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'useSharedState.meta.json'), 'utf8'));
  assert.strictEqual(res.assetVersion, meta.version);
});

test('--dry-run writes nothing; --json has replaced / previousSha / callSites', () => {
  const root = repo({ 'src/hooks/useSharedState.js': OLD, 'src/A.jsx': GOOD_CALLER.replace('../services/hooks/useSharedState', './hooks/useSharedState') });
  let out = '';
  main(['--dry-run', '--json'], deps(root), { stdout: (s) => { out += s; }, stderr: () => {} });
  const res = JSON.parse(out);
  assert.strictEqual(res.replaced, true);
  assert.strictEqual(res.previousSha, sha(OLD));
  assert.deepStrictEqual(res.callSites.map((s) => s.file + ':' + s.line), ['src/A.jsx:3', 'src/A.jsx:4']);
  assert.strictEqual(readIn(root, 'src/hooks/useSharedState.js'), OLD);
  assert.ok(!fs.existsSync(path.join(root, '.migration')));
});
