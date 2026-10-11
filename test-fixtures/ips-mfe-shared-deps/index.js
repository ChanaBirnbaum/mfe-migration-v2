'use strict';
// ⚠️  TEST STUB — this is NOT the real @ips/mfe-shared-deps.
// It mimics the buildSharedGen1 contract so the migration pipeline can be
// exercised end-to-end off the internal network. Never publish it, and never
// trust a run that used it to validate real federation behaviour.

class FederationConfigError extends Error {
  constructor(message) { super(message); this.name = 'FederationConfigError'; }
}

const ROLES = ['host', 'remote', 'standalone'];

// Gen-1 catalogue: package → the compatibility floor kept for the transition
const CATALOGUE_GEN1 = {
  'react': '^17.0.0',
  'react-dom': '^17.0.0',
  'react-router': '^6.0.0',
  'react-router-dom': '^6.0.0',
};

function buildSharedGen1(opts) {
  const pkg = opts && opts.pkg;
  const req = opts && opts.require;
  const role = opts && opts.role;

  if (!pkg || typeof pkg !== 'object') throw new FederationConfigError('pkg is required');
  if (typeof req !== 'function') throw new FederationConfigError('require is required');
  if (ROLES.indexOf(role) === -1) {
    throw new FederationConfigError(
      'role must be one of ' + ROLES.join(' | ') + ', got ' + JSON.stringify(role));
  }

  const appName = pkg.name || '(unnamed package)';
  // peerDependencies win over dependencies; devDependencies are NOT a declaration
  const declared = Object.assign({}, pkg.dependencies, pkg.peerDependencies);

  const installedVersion = (name) => {
    try { return req(name + '/package.json').version; } catch (e) { return null; }
  };

  const shared = {};

  Object.keys(CATALOGUE_GEN1).forEach((name) => {
    const range = declared[name];
    const installed = installedVersion(name);

    // react-router joins the catalogue even undeclared, as long as it's installed
    const include = name === 'react-router' ? (range || installed) : range;

    if (!include) {
      if (pkg.devDependencies && pkg.devDependencies[name]) {
        throw new FederationConfigError(appName + ': "' + name +
          '" is only in devDependencies. Move it to dependencies so it can be shared.');
      }
      return;
    }

    if (!installed) {
      throw new FederationConfigError(appName + ': "' + name +
        '" is declared but not installed. Run npm install first.');
    }

    const effectiveRange = range || ('^' + installed);
    const entry = { singleton: true, strictVersion: false, version: installed };

    if (role === 'remote') {
      // the floor is what lets an old gen-1 host supply its own copy
      entry.requiredVersion = CATALOGUE_GEN1[name] + ' || ' + effectiveRange;
      entry.import = false;             // never bundled — the host provides it
    } else {
      entry.requiredVersion = effectiveRange;   // host and standalone
    }

    shared[name] = entry;
  });

  return shared;
}

module.exports = { buildSharedGen1, FederationConfigError };
