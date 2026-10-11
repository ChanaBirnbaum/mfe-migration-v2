'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const STUB_DIR = path.join(__dirname, '..', 'test-fixtures', 'ips-mfe-shared-deps');
const { buildSharedGen1, FederationConfigError } = require(STUB_DIR);

// fake require: name/package.json → { version } for the "installed" packages only
const installed = (versions) => (id) => {
  const name = id.replace(/\/package\.json$/, '');
  if (!versions[name]) throw Object.assign(new Error('Cannot find module ' + id), { code: 'MODULE_NOT_FOUND' });
  return { version: versions[name] };
};

const PKG = {
  name: 'hasava-mfe',
  dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1', 'react-router-dom': '^6.30.1' },
};
const INSTALLED = installed({ react: '18.3.1', 'react-dom': '18.3.1', 'react-router': '6.30.1', 'react-router-dom': '6.30.1' });

test('stub package.json: name, stub version, private, main', () => {
  const pkg = require(path.join(STUB_DIR, 'package.json'));
  assert.deepStrictEqual(pkg, { name: '@ips/mfe-shared-deps', version: '0.0.0-stub', private: true, main: 'index.js' });
});

test('host: singleton entries, requiredVersion = declared range, bundled', () => {
  const shared = buildSharedGen1({ pkg: PKG, require: INSTALLED, role: 'host' });
  assert.deepStrictEqual(Object.keys(shared), ['react', 'react-dom', 'react-router', 'react-router-dom']);
  assert.deepStrictEqual(shared.react, { singleton: true, strictVersion: false, version: '18.3.1', requiredVersion: '^18.3.1' });
  // react-router: not declared, installed → joins with ^installed
  assert.deepStrictEqual(shared['react-router'], { singleton: true, strictVersion: false, version: '6.30.1', requiredVersion: '^6.30.1' });
  Object.keys(shared).forEach((n) => assert.ok(!('import' in shared[n]), n + ' must be bundled by a host'));
});

test('standalone: same shape as host', () => {
  assert.deepStrictEqual(
    buildSharedGen1({ pkg: PKG, require: INSTALLED, role: 'standalone' }),
    buildSharedGen1({ pkg: PKG, require: INSTALLED, role: 'host' }));
});

test('remote: gen-1 floor || range, import: false', () => {
  const shared = buildSharedGen1({ pkg: PKG, require: INSTALLED, role: 'remote' });
  assert.deepStrictEqual(shared.react, { singleton: true, strictVersion: false, version: '18.3.1', requiredVersion: '^17.0.0 || ^18.3.1', import: false });
  assert.strictEqual(shared['react-dom'].requiredVersion, '^17.0.0 || ^18.3.1');
  assert.strictEqual(shared['react-router-dom'].requiredVersion, '^6.0.0 || ^6.30.1');
  Object.keys(shared).forEach((n) => assert.strictEqual(shared[n].import, false));
});

test('invalid role → FederationConfigError', () => {
  [undefined, 'hybrid', 'Host', ''].forEach((role) => {
    assert.throws(() => buildSharedGen1({ pkg: PKG, require: INSTALLED, role: role }), (err) => {
      assert.ok(err instanceof FederationConfigError);
      assert.strictEqual(err.name, 'FederationConfigError');
      assert.match(err.message, /role must be one of host \| remote \| standalone/);
      return true;
    });
  });
});

test('missing pkg / require → FederationConfigError', () => {
  assert.throws(() => buildSharedGen1({ require: INSTALLED, role: 'host' }), FederationConfigError);
  assert.throws(() => buildSharedGen1({ pkg: PKG, role: 'host' }), FederationConfigError);
});

test('declared only in devDependencies → FederationConfigError', () => {
  const pkg = { name: 'x', dependencies: { 'react-dom': '^18.3.1' }, devDependencies: { react: '^18.3.1' } };
  assert.throws(() => buildSharedGen1({ pkg: pkg, require: INSTALLED, role: 'host' }), /"react" is only in devDependencies/);
});

test('declared but not installed → FederationConfigError', () => {
  assert.throws(() => buildSharedGen1({ pkg: PKG, require: installed({ react: '18.3.1' }), role: 'host' }), /"react-dom" is declared but not installed/);
});

test('peerDependencies win over dependencies', () => {
  const pkg = { name: 'x', dependencies: { react: '^18.0.0' }, peerDependencies: { react: '^18.3.1' } };
  const shared = buildSharedGen1({ pkg: pkg, require: installed({ react: '18.3.1' }), role: 'host' });
  assert.strictEqual(shared.react.requiredVersion, '^18.3.1');
});
