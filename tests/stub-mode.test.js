'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const stub = require('../scripts/stub-mode');

const PKG = '@ips/mfe-shared-deps';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stub-mode-test-'));
const withState = (stubMode) => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.migration'));
  fs.writeFileSync(path.join(root, '.migration', 'state.json'), JSON.stringify({ stubMode: stubMode }));
  return root;
};

test('stubDir / stubSpec: absolute file: path into test-fixtures, forward slashes', () => {
  assert.strictEqual(stub.stubDir(PKG), path.join(__dirname, '..', 'test-fixtures', 'ips-mfe-shared-deps'));
  const spec = stub.stubSpec(PKG);
  assert.match(spec, /^file:/);
  assert.ok(path.isAbsolute(spec.slice(5)));
  assert.ok(spec.indexOf('\\') === -1);
  assert.match(spec, /\/test-fixtures\/ips-mfe-shared-deps$/);
});

test('isStubSpec: only file: paths into test-fixtures/<pkg>', () => {
  assert.ok(stub.isStubSpec(stub.stubSpec(PKG)));
  assert.ok(stub.isStubSpec('file:C:\\skills\\mfe\\test-fixtures\\ips-mfe-shared-deps'));
  assert.ok(!stub.isStubSpec('^1.4.0'));
  assert.ok(!stub.isStubSpec('file:../shared-lib'));
  assert.ok(!stub.isStubSpec(undefined));
});

test('only internal packages that have a stub folder are allowed', () => {
  assert.deepStrictEqual(stub.internalPackages(), [PKG]);
  assert.ok(stub.hasStub(PKG));
  assert.ok(!stub.hasStub('@ips/other'));
  assert.deepStrictEqual(stub.allowed([PKG, 'react', '@ips/other', PKG], [PKG, '@ips/other']), [PKG]);
});

test('detect: env (set by run.js) wins; empty env = explicitly off even with an approved state', () => {
  const root = withState({ approved: true, packages: [PKG] });
  assert.deepStrictEqual(stub.detect({ env: { MFE_MIGRATION_STUB: PKG }, cwd: tmp() }), { active: true, packages: [PKG], source: 'env' });
  assert.strictEqual(stub.detect({ env: { MFE_MIGRATION_STUB: '' }, cwd: root }).active, false);
});

test('detect: no env → .migration/state.json stubMode (approved only)', () => {
  assert.deepStrictEqual(stub.detect({ env: {}, cwd: withState({ approved: true, packages: [PKG] }) }), { active: true, packages: [PKG], source: 'state' });
  assert.strictEqual(stub.detect({ env: {}, cwd: withState({ approved: false, packages: [PKG] }) }).active, false);
  assert.strictEqual(stub.detect({ env: {}, cwd: withState({ approved: true, packages: ['react'] }) }).active, false);
  assert.strictEqual(stub.detect({ env: {}, cwd: tmp() }).active, false);
});

test('annotate: stubMode + stubPackages + the warning first (once); inactive leaves the result untouched', () => {
  const mode = { active: true, packages: [PKG] };
  const res = stub.annotate({ script: 'x', result: 'OK', notes: ['n'] }, mode);
  assert.strictEqual(res.stubMode, true);
  assert.deepStrictEqual(res.stubPackages, [PKG]);
  assert.match(res.notes[0], /^STUB MODE: @ips\/mfe-shared-deps is a local test stub/);
  assert.match(res.notes[0], /pipeline mechanics only – NOT the shared configuration/);
  stub.annotate(res, mode);
  assert.strictEqual(res.notes.filter((n) => /^STUB MODE/.test(n)).length, 1);
  assert.match(stub.banner(res), /^⚠ STUB MODE – @ips\/mfe-shared-deps/);

  const plain = { script: 'x', result: 'OK', notes: [] };
  assert.deepStrictEqual(stub.annotate(plain, stub.INACTIVE), { script: 'x', result: 'OK', notes: [] });
  assert.strictEqual(stub.banner(plain), '');
});
