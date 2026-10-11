#!/usr/bin/env node
'use strict';

// Preflight: environment checks before starting a migration. Read-only – never changes anything.
// הקובץ נמנע במכוון מ-?. ו-?? כדי שירוץ גם על Node ישן ויוכל לדווח שהגרסה נמוכה מדי.

const path = require('path');

const SCRIPT = 'preflight';
const NETWORK_TIMEOUT_MS = 15000;
const LOCAL_TIMEOUT_MS = 15000;
const MIN_NODE_MAJOR = 18;
const MAX_LISTED_FILES = 30;
const TARGETS_FILE = path.join(__dirname, '..', 'reference', 'versions.json');

const stubMode = require('./stub-mode');

const SYMBOLS = { ok: '✓', warn: '⚠', blocked: '⛔', 'stub-available': '⚠' };

function parseArgs(argv) {
  return {
    json: argv.indexOf('--json') !== -1,
    dryRun: argv.indexOf('--dry-run') !== -1,
  };
}

function defaultDeps() {
  return {
    execFile: require('child_process').execFile,
    fs: require('fs'),
    cwd: process.cwd(),
    env: Object.assign({}, process.env, {
      // לא אינטראקטיבי: git לא יבקש סיסמה, npm לא יציג הודעות עדכון
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      npm_config_update_notifier: 'false',
    }),
    platform: process.platform,
    nodeVersion: process.versions.node,
    networkTimeoutMs: NETWORK_TIMEOUT_MS,
    localTimeoutMs: LOCAL_TIMEOUT_MS,
    targets: null,
  };
}

function loadTargets() {
  return JSON.parse(require('fs').readFileSync(TARGETS_FILE, 'utf8'));
}

// "^18.3.1" -> "18.3.1"; "*" / "" -> null (any published version)
function exactVersion(range) {
  const v = String(range || '').trim().replace(/^[\^~=v]+/, '');
  return /^\d+\.\d+\.\d+/.test(v) ? v : null;
}

function targetSpecs(targets) {
  const specs = [];
  [targets.dependencies, targets.conditionalDependencies, targets.requiredDependencies].forEach((map) => {
    Object.keys(map || {}).filter((name) => name.charAt(0) !== '_').forEach((name) => {
      specs.push({ name: name, version: exactVersion(map[name]) });
    });
  });
  return specs;
}

function firstLine(text) {
  const line = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
  return line || '';
}

function seconds(ms) {
  return Math.max(1, Math.round(ms / 1000));
}

// Runs a command without throwing. Our own timer (not execFile's) guarantees we resolve even
// when a grandchild process (npm.cmd -> node on Windows) keeps the pipes open.
function makeRunner(deps) {
  return function run(cmd, args, timeoutMs, useShell) {
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      let child = null;
      const finish = (res) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(res);
      };
      const callback = (err, stdout, stderr) => {
        const out = { stdout: String(stdout || ''), stderr: String(stderr || '') };
        if (!err) return finish(Object.assign({ ok: true, code: 0 }, out));
        finish(Object.assign({
          ok: false,
          code: typeof err.code === 'number' ? err.code : null,
          errno: typeof err.code === 'string' ? err.code : null,
          message: err.message,
        }, out));
      };
      const options = {
        cwd: deps.cwd,
        env: deps.env,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      };
      try {
        if (useShell) {
          // On Windows npm is npm.cmd, which cannot be spawned without a shell.
          // Arguments here are package specs we control (no spaces/quotes/^).
          options.shell = true;
          child = deps.execFile([cmd].concat(args).join(' '), [], options, callback);
        } else {
          child = deps.execFile(cmd, args, options, callback);
        }
      } catch (err) {
        return finish({ ok: false, code: null, errno: err.code || null, message: err.message, stdout: '', stderr: '' });
      }
      if (child && child.stdin && typeof child.stdin.end === 'function') child.stdin.end();
      timer = setTimeout(() => {
        if (settled) return;
        try {
          if (child) {
            child.kill();
            if (child.stdout && child.stdout.destroy) child.stdout.destroy();
            if (child.stderr && child.stderr.destroy) child.stderr.destroy();
            if (child.unref) child.unref();
          }
        } catch (_) { /* best effort */ }
        finish({ ok: false, timedOut: true, code: null, errno: null, message: 'timeout', stdout: '', stderr: '' });
      }, timeoutMs);
    });
  };
}

function check(id, title, status, message, extra) {
  return Object.assign({ id: id, title: title, status: status, message: message }, extra || {});
}

function skipped(id, title, reason) {
  return check(id, title, 'warn', 'skipped – ' + reason, { skipped: true });
}

async function runPreflight(options, overrides) {
  options = options || {};
  const deps = Object.assign(defaultDeps(), overrides || {});
  const run = makeRunner(deps);
  const git = (args, timeoutMs) => run('git', args, timeoutMs || deps.localTimeoutMs, false);
  const npm = (args, timeoutMs) => run('npm', args, timeoutMs || deps.localTimeoutMs, deps.platform === 'win32');
  const netSec = seconds(deps.networkTimeoutMs);

  const checks = [];
  const blockers = [];
  const notes = [];
  const environment = {
    nodeVersion: deps.nodeVersion,
    npmVersion: null,
    registryUrl: null,
    currentBranch: null,
    serviceName: null,
  };

  const addBlocker = (checkId, message, extra) => blockers.push(Object.assign({ check: checkId, message: message }, extra || {}));

  if (options.dryRun) notes.push('preflight is read-only – --dry-run has no effect');

  // 1. git repo
  let isRepo = false;
  {
    const r = await git(['rev-parse', '--is-inside-work-tree']);
    if (r.ok && r.stdout.trim() === 'true') {
      isRepo = true;
      checks.push(check('git-repo', 'git repo', 'ok', deps.cwd));
    } else {
      let msg;
      if (r.errno === 'ENOENT') msg = 'git is not installed or not on PATH';
      else if (r.timedOut) msg = 'git rev-parse did not respond within ' + seconds(deps.localTimeoutMs) + ' seconds';
      else msg = 'The folder ' + deps.cwd + ' is not a git repo' + (firstLine(r.stderr) ? ' (' + firstLine(r.stderr) + ')' : '');
      checks.push(check('git-repo', 'git repo', 'blocked', msg));
      addBlocker('git-repo', msg);
    }
  }

  // 1a. detached HEAD
  if (!isRepo) {
    checks.push(skipped('git-branch', 'Current branch', 'no git repo'));
  } else {
    const r = await git(['symbolic-ref', '--short', '-q', 'HEAD']);
    if (r.ok && r.stdout.trim()) {
      environment.currentBranch = r.stdout.trim();
      checks.push(check('git-branch', 'Current branch', 'ok', environment.currentBranch));
    } else if (r.code === 1) {
      const sha = await git(['rev-parse', '--short', 'HEAD']);
      const at = sha.ok && sha.stdout.trim() ? ' (' + sha.stdout.trim() + ')' : '';
      const msg = 'HEAD is detached' + at + ' – switch to a branch before migrating';
      checks.push(check('git-branch', 'Current branch', 'blocked', msg));
      addBlocker('git-branch', msg, { detached: true });
    } else {
      const msg = 'Cannot determine the current branch' + (firstLine(r.stderr) ? ': ' + firstLine(r.stderr) : '');
      checks.push(check('git-branch', 'Current branch', 'blocked', msg));
      addBlocker('git-branch', msg);
    }
  }

  // 2. clean working tree
  if (!isRepo) {
    checks.push(skipped('git-clean', 'Clean working tree', 'no git repo'));
  } else {
    const r = await git(['status', '--porcelain']);
    if (!r.ok) {
      const msg = r.timedOut
        ? 'git status did not respond within ' + seconds(deps.localTimeoutMs) + ' seconds'
        : 'git status failed: ' + (firstLine(r.stderr) || r.message);
      checks.push(check('git-clean', 'Clean working tree', 'blocked', msg));
      addBlocker('git-clean', msg);
    } else {
      // לא לעשות trim לכל השורה – הרווח המוביל הוא חלק מקוד הסטטוס (" M file")
      const files = r.stdout.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim());
      if (files.length === 0) {
        checks.push(check('git-clean', 'Clean working tree', 'ok', 'no uncommitted changes'));
      } else {
        const msg = files.length + ' files have uncommitted changes – commit or stash them';
        const lines = files.slice(0, MAX_LISTED_FILES);
        if (files.length > MAX_LISTED_FILES) lines.push('... and ' + (files.length - MAX_LISTED_FILES) + ' more');
        checks.push(check('git-clean', 'Clean working tree', 'blocked', msg, { lines: lines }));
        addBlocker('git-clean', msg, { files: files });
      }
    }
  }

  // 3. package.json with react in dependencies
  {
    const pkgPath = path.join(deps.cwd, 'package.json');
    let pkg = null;
    let msg = null;
    if (!deps.fs.existsSync(pkgPath)) {
      msg = 'package.json not found in the root (' + deps.cwd + ')';
    } else {
      try {
        pkg = JSON.parse(deps.fs.readFileSync(pkgPath, 'utf8'));
      } catch (err) {
        msg = 'package.json is not valid JSON: ' + err.message;
      }
    }
    if (pkg && typeof pkg.name === 'string') environment.serviceName = pkg.name;
    if (pkg && !msg) {
      const react = pkg.dependencies && pkg.dependencies.react;
      if (!react) {
        msg = 'react is not in the dependencies of package.json';
        if (pkg.devDependencies && pkg.devDependencies.react) msg += ' (it is only in devDependencies)';
      } else {
        const major = parseInt((String(react).match(/\d+/) || [])[0], 10);
        if (major >= 18) {
          const warn = 'react is already at ' + react + ' – the service may already be migrated';
          checks.push(check('package-json', 'package.json', 'warn', warn));
          notes.push(warn);
        } else {
          checks.push(check('package-json', 'package.json', 'ok', (pkg.name || '(no name)') + ', react ' + react));
        }
      }
    }
    if (msg) {
      checks.push(check('package-json', 'package.json', 'blocked', msg));
      addBlocker('package-json', msg);
    }
  }

  // 4. Node version
  {
    const major = parseInt(String(deps.nodeVersion).replace(/^v/, ''), 10);
    if (major >= MIN_NODE_MAJOR) {
      checks.push(check('node', 'Node', 'ok', 'v' + String(deps.nodeVersion).replace(/^v/, '')));
    } else {
      const msg = 'Node ' + deps.nodeVersion + ' – version ' + MIN_NODE_MAJOR + ' or higher is required';
      checks.push(check('node', 'Node', 'blocked', msg));
      addBlocker('node', msg);
    }
  }

  // Environment info for npm (not checks by themselves)
  {
    const ver = await npm(['--version']);
    if (ver.ok && ver.stdout.trim()) environment.npmVersion = ver.stdout.trim();
    const reg = await npm(['config', 'get', 'registry']);
    if (reg.ok && reg.stdout.trim()) environment.registryUrl = reg.stdout.trim();
  }
  const registryLabel = environment.registryUrl || 'the configured registry';

  let targets = deps.targets;
  let targetsError = null;
  if (!targets) {
    try {
      targets = loadTargets();
    } catch (err) {
      targetsError = 'Cannot load ' + TARGETS_FILE + ': ' + err.message;
    }
  }

  const internal = targets ? stubMode.internalPackages(targets) : [];
  let stubs = [];

  // Registry checks: ping, then all target versions concurrently; results are reported in fixed order.
  const registryChain = (async () => {
    // 5. npm ping
    const ping = await npm(['ping'], deps.networkTimeoutMs);
    let pingCheck;
    if (ping.ok) {
      pingCheck = check('npm-ping', 'npm ping', 'ok', registryLabel);
    } else {
      const msg = ping.timedOut
        ? 'npm ping did not respond within ' + netSec + ' seconds – no access to ' + registryLabel
        : 'npm ping to ' + registryLabel + ' failed: ' + (firstLine(ping.stderr) || firstLine(ping.stdout) || ping.message);
      pingCheck = check('npm-ping', 'npm ping', 'blocked', msg, { timeout: !!ping.timedOut });
    }

    // 6. target versions
    let versionsCheck;
    let versionBlockers = [];
    if (targetsError) {
      versionsCheck = check('target-versions', 'Target versions', 'blocked', targetsError);
      versionBlockers.push({ message: targetsError });
    } else if (!ping.ok) {
      versionsCheck = skipped('target-versions', 'Target versions', 'the registry is not available');
    } else {
      const results = await Promise.all(targetSpecs(targets).map(async (spec) => {
        const ref = spec.version ? spec.name + '@' + spec.version : spec.name;
        const r = await npm(['view', ref, 'version'], deps.networkTimeoutMs);
        if (r.timedOut) return { ref: ref, spec: spec, ok: false, message: ref + ': did not respond within ' + netSec + ' seconds', timeout: true };
        // חבילה פנימית שה-registry המוגדר אינו מכיר → מועמדת ל-stub, לא חוסם. רק "לא נמצא":
        // timeout / שגיאה אחרת אינם הוכחה שהחבילה לא זמינה, ונשארים חוסמים
        // התיקייה של ה-stub שייכת לסקיל, לא לריפו של השירות – נבדקת תמיד מול ה-fs האמיתי
        const stubbable = internal.indexOf(spec.name) !== -1 && stubMode.hasStub(spec.name);
        if (!r.ok) {
          const text = r.stderr + '\n' + r.stdout;
          const notFound = /E404|404 Not Found|is not in this registry/i.test(text);
          return {
            ref: ref, spec: spec, ok: false, stub: notFound && stubbable,
            message: ref + ': ' + (notFound ? 'package not found in the registry' : 'npm view failed – ' + (firstLine(r.stderr) || r.message)),
          };
        }
        const found = r.stdout.split(/\s+/).map((s) => s.replace(/^'|'$/g, '')).filter(Boolean);
        // npm view מחזיר פלט ריק וקוד 0 כשהגרסה המבוקשת לא קיימת
        if (found.length === 0 || (spec.version && found.indexOf(spec.version) === -1)) {
          return { ref: ref, spec: spec, ok: false, stub: stubbable, message: ref + ': this version is not available in the registry' };
        }
        return { ref: ref, spec: spec, ok: true, found: found[found.length - 1] };
      }));
      const failed = results.filter((x) => !x.ok && !x.stub);
      stubs = results.filter((x) => !x.ok && x.stub);
      const lines = results.map((x) => (x.ok
        ? SYMBOLS.ok + ' ' + (x.spec.version ? x.ref : x.ref + ' (' + x.found + ')')
        : x.stub
          ? SYMBOLS['stub-available'] + ' ' + x.message + ' – internal package, a local stub is available (stub-available)'
          : SYMBOLS.blocked + ' ' + x.message));
      if (failed.length === 0 && stubs.length === 0) {
        versionsCheck = check('target-versions', 'Target versions', 'ok', results.length + ' packages available', { lines: lines });
      } else if (failed.length === 0) {
        versionsCheck = check('target-versions', 'Target versions', 'stub-available',
          stubs.length + ' internal package(s) not in ' + registryLabel + ' – a local stub can be used (run.js asks)', { lines: lines });
      } else {
        versionsCheck = check('target-versions', 'Target versions', 'blocked', failed.length + ' of ' + results.length + ' packages are not available', { lines: lines });
        versionBlockers = failed.map((x) => ({
          message: x.message,
          package: x.spec.name,
          version: x.spec.version,
          timeout: !!x.timeout,
        }));
      }
    }
    return { pingCheck: pingCheck, versionsCheck: versionsCheck, versionBlockers: versionBlockers };
  })();

  const reg = await registryChain;

  checks.push(reg.pingCheck);
  if (reg.pingCheck.status === 'blocked') addBlocker('npm-ping', reg.pingCheck.message, { timeout: reg.pingCheck.timeout });
  checks.push(reg.versionsCheck);
  reg.versionBlockers.forEach((b) => addBlocker('target-versions', b.message, b));

  // preflight רק מדווח שאפשר stub. ההחלטה (עם אישור אדם) היא של run.js
  const stubCandidates = stubs.map((x) => x.spec.name);
  if (stubCandidates.length) {
    notes.push('stub-available: ' + stubCandidates.join(', ') + ' – internal, not found in ' + registryLabel +
      '. Not a blocker: a local test stub (test-fixtures/) can stand in for it so the pipeline can run off the internal network. ' +
      'run.js asks before using it; such a run validates the pipeline mechanics only and never commits');
  }

  return {
    script: SCRIPT,
    result: blockers.length === 0 ? 'OK' : 'BLOCKED',
    changes: [],
    manual: [],
    blockers: blockers,
    notes: notes,
    checks: checks,
    environment: environment,
    stubCandidates: stubCandidates,
  };
}

function formatText(result) {
  const lines = ['preflight – environment checks before migration', ''];
  result.checks.forEach((c) => {
    lines.push(SYMBOLS[c.status] + ' ' + c.title + ': ' + c.message);
    (c.lines || []).forEach((l) => lines.push('    ' + l));
  });
  lines.push('');
  const env = result.environment;
  lines.push('Environment: node ' + env.nodeVersion + ', npm ' + (env.npmVersion || '?') +
    ', registry ' + (env.registryUrl || '?') + ', branch ' + (env.currentBranch || '?') +
    ', service ' + (env.serviceName || '?'));
  result.notes.forEach((n) => lines.push('Note: ' + n));
  if (result.blockers.length) lines.push(result.blockers.length + ' blockers');
  lines.push('RESULT: ' + result.result);
  return lines.join('\n') + '\n';
}

async function main(argv, deps, io) {
  io = io || {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  };
  try {
    const options = parseArgs(argv || []);
    const result = stubMode.annotate(await runPreflight(options, deps), stubMode.modeFor(deps));
    io.stdout(options.json ? JSON.stringify(result, null, 2) + '\n' : stubMode.banner(result) + formatText(result));
    return 0;
  } catch (err) {
    // קריסה אמיתית בלבד – רק כאן נכתב ל-stderr ויוצאים עם 1
    io.stderr('preflight crashed: ' + ((err && err.stack) || err) + '\n');
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    // process.exit מפורש: תהליך שנתקע אחרי timeout לא יחזיק את הסקריפט פתוח
    process.stdout.write('', () => process.exit(code));
  });
}

module.exports = {
  runPreflight: runPreflight,
  formatText: formatText,
  main: main,
  parseArgs: parseArgs,
  targetSpecs: targetSpecs,
  exactVersion: exactVersion,
  loadTargets: loadTargets,
};
