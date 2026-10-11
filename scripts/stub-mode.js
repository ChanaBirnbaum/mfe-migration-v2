'use strict';

// stub-mode: shared helpers for running the pipeline against a local test stub of an internal package
// that the configured registry does not have (a machine off the internal network).
// Not a step – required by the step scripts. Avoids ?. / ?? like preflight.js (it requires this file).
//
// Who decides what:
//   preflight.js  reports stubCandidates (internal + not in the registry). It never turns stub mode on.
//   run.js        asks the human (PAUSE stub-mode), stores state.stubMode, and sets ENV_VAR for every step.
//   the steps     read the mode with detect(): ENV_VAR first (set by run.js, also in --dry-run), else
//                 .migration/state.json – so a step run by hand after an approved run knows it too.
// Only packages listed in versions.json "internal" that have a folder in test-fixtures/ are ever stubbed.

const path = require('path');

const ENV_VAR = 'MFE_MIGRATION_STUB';
const STATE_FILE = path.join('.migration', 'state.json');
const VERSIONS_FILE = path.join(__dirname, '..', 'reference', 'versions.json');
const FIXTURES_DIR = path.join(__dirname, '..', 'test-fixtures');

const INACTIVE = Object.freeze({ active: false, packages: [], source: null });

function internalPackages(versions) {
  if (!versions) {
    try { versions = JSON.parse(require('fs').readFileSync(VERSIONS_FILE, 'utf8')); } catch (_) { return []; }
  }
  return Array.isArray(versions.internal) ? versions.internal.slice() : [];
}

// @ips/mfe-shared-deps → <skill>/test-fixtures/ips-mfe-shared-deps
function stubDir(name) {
  return path.join(FIXTURES_DIR, String(name).replace(/^@/, '').replace(/\//g, '-'));
}

// The stub folder must exist and declare the same package name – otherwise there is nothing to stub with
function hasStub(name, fs) {
  fs = fs || require('fs');
  try { return JSON.parse(fs.readFileSync(path.join(stubDir(name), 'package.json'), 'utf8')).name === name; } catch (_) { return false; }
}

// file: spec written to package.json – absolute, forward slashes (npm accepts file:C:/x on Windows)
function stubSpec(name) {
  return 'file:' + stubDir(name).split(path.sep).join('/');
}

// Does this dependency value point at one of our stubs?
function isStubSpec(value) {
  if (typeof value !== 'string' || value.indexOf('file:') !== 0) return false;
  return /(^|[\\/])test-fixtures[\\/][^\\/]+[\\/]?$/.test(value.slice(5));
}

// Keep only what may legally be stubbed: listed as internal and with a stub folder
function allowed(names, internal) {
  return (names || []).filter((n, i, all) => typeof n === 'string' && all.indexOf(n) === i && internal.indexOf(n) !== -1 && hasStub(n));
}

function detect(ctx) {
  ctx = ctx || {};
  const env = ctx.env || process.env;
  const fs = ctx.fs || require('fs');
  const internal = internalPackages(ctx.versions);
  if (typeof env[ENV_VAR] === 'string') {
    // run.js always sets the variable for its steps; empty = explicitly off (state.json is not consulted)
    const pkgs = allowed(env[ENV_VAR].split(',').map((s) => s.trim()).filter(Boolean), internal);
    return pkgs.length ? { active: true, packages: pkgs, source: 'env' } : INACTIVE;
  }
  let state = null;
  try { state = JSON.parse(fs.readFileSync(path.join(ctx.cwd || process.cwd(), STATE_FILE), 'utf8')); } catch (_) { state = null; }
  const sm = state && state.stubMode;
  if (!sm || sm.approved !== true) return INACTIVE;
  const pkgs = allowed(sm.packages, internal);
  return pkgs.length ? { active: true, packages: pkgs, source: 'state' } : INACTIVE;
}

function warning(mode) {
  return 'STUB MODE: ' + mode.packages.join(', ') + ' is a local test stub (test-fixtures/), not the real package. ' +
    'This run validates the pipeline mechanics only – NOT the shared configuration against the real package. Nothing is committed';
}

// Every step output in stub mode: stubMode: true at the top level + the warning as the first note
function annotate(res, mode) {
  if (!res || !mode || !mode.active) return res;
  res.stubMode = true;
  res.stubPackages = mode.packages.slice();
  const w = warning(mode);
  res.notes = Array.isArray(res.notes) ? res.notes : [];
  if (res.notes[0] !== w) res.notes.unshift(w);
  return res;
}

// First line of a step's text output in stub mode
function banner(res) {
  return res && res.stubMode ? '⚠ STUB MODE – ' + (res.stubPackages || []).join(', ') + ' is a local test stub. Pipeline mechanics only; nothing is committed\n' : '';
}

// main() helper shared by the steps: deps may carry an explicit `stub` (tests), else detect from env / state
function modeFor(deps) {
  if (deps && deps.stub) return deps.stub;
  return detect({ env: deps && deps.env, cwd: deps && deps.cwd });
}

module.exports = {
  ENV_VAR: ENV_VAR,
  INACTIVE: INACTIVE,
  internalPackages: internalPackages,
  stubDir: stubDir,
  hasStub: hasStub,
  stubSpec: stubSpec,
  isStubSpec: isStubSpec,
  allowed: allowed,
  detect: detect,
  warning: warning,
  annotate: annotate,
  banner: banner,
  modeFor: modeFor,
};
