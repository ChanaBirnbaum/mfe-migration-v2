#!/usr/bin/env node
'use strict';

// Preflight: environment checks before starting a migration. Read-only – never changes anything.
// הקובץ נמנע במכוון מ-?. ו-?? כדי שירוץ גם על Node ישן ויוכל לדווח שהגרסה נמוכה מדי.

const path = require('path');

const SCRIPT = 'preflight';
const NETWORK_TIMEOUT_MS = 15000;
const LOCAL_TIMEOUT_MS = 15000;
const MIN_NODE_MAJOR = 18;
const TARGET_BRANCH = 'digital_V2';
const MAX_LISTED_FILES = 30;
const TARGETS_FILE = path.join(__dirname, '..', 'reference', 'versions.json');

const SYMBOLS = { ok: '✓', warn: '⚠', blocked: '⛔' };

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
  return check(id, title, 'warn', 'דולג – ' + reason, { skipped: true });
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

  if (options.dryRun) notes.push('preflight הוא קריאה בלבד – ל-‎--dry-run אין השפעה');

  // 1. git repo
  let isRepo = false;
  {
    const r = await git(['rev-parse', '--is-inside-work-tree']);
    if (r.ok && r.stdout.trim() === 'true') {
      isRepo = true;
      checks.push(check('git-repo', 'git repo', 'ok', deps.cwd));
    } else {
      let msg;
      if (r.errno === 'ENOENT') msg = 'git לא מותקן או לא נמצא ב-PATH';
      else if (r.timedOut) msg = 'git rev-parse לא הגיב תוך ' + seconds(deps.localTimeoutMs) + ' שניות';
      else msg = 'התיקייה ' + deps.cwd + ' אינה git repo' + (firstLine(r.stderr) ? ' (' + firstLine(r.stderr) + ')' : '');
      checks.push(check('git-repo', 'git repo', 'blocked', msg));
      addBlocker('git-repo', msg);
    }
  }

  // 1a. detached HEAD
  if (!isRepo) {
    checks.push(skipped('git-branch', 'בראנץ\' נוכחי', 'אין git repo'));
  } else {
    const r = await git(['symbolic-ref', '--short', '-q', 'HEAD']);
    if (r.ok && r.stdout.trim()) {
      environment.currentBranch = r.stdout.trim();
      checks.push(check('git-branch', 'בראנץ\' נוכחי', 'ok', environment.currentBranch));
    } else if (r.code === 1) {
      const sha = await git(['rev-parse', '--short', 'HEAD']);
      const at = sha.ok && sha.stdout.trim() ? ' (' + sha.stdout.trim() + ')' : '';
      const msg = 'HEAD במצב detached' + at + ' – עבור לבראנץ\' לפני ההסבה';
      checks.push(check('git-branch', 'בראנץ\' נוכחי', 'blocked', msg));
      addBlocker('git-branch', msg, { detached: true });
    } else {
      const msg = 'לא ניתן לזהות את הבראנץ\' הנוכחי' + (firstLine(r.stderr) ? ': ' + firstLine(r.stderr) : '');
      checks.push(check('git-branch', 'בראנץ\' נוכחי', 'blocked', msg));
      addBlocker('git-branch', msg);
    }
  }

  // 2. clean working tree
  if (!isRepo) {
    checks.push(skipped('git-clean', 'עץ עבודה נקי', 'אין git repo'));
  } else {
    const r = await git(['status', '--porcelain']);
    if (!r.ok) {
      const msg = r.timedOut
        ? 'git status לא הגיב תוך ' + seconds(deps.localTimeoutMs) + ' שניות'
        : 'git status נכשל: ' + (firstLine(r.stderr) || r.message);
      checks.push(check('git-clean', 'עץ עבודה נקי', 'blocked', msg));
      addBlocker('git-clean', msg);
    } else {
      // לא לעשות trim לכל השורה – הרווח המוביל הוא חלק מקוד הסטטוס (" M file")
      const files = r.stdout.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim());
      if (files.length === 0) {
        checks.push(check('git-clean', 'עץ עבודה נקי', 'ok', 'אין שינויים פתוחים'));
      } else {
        const msg = 'יש ' + files.length + ' קבצים עם שינויים שלא נשמרו – בצע commit או stash';
        const lines = files.slice(0, MAX_LISTED_FILES);
        if (files.length > MAX_LISTED_FILES) lines.push('... ועוד ' + (files.length - MAX_LISTED_FILES));
        checks.push(check('git-clean', 'עץ עבודה נקי', 'blocked', msg, { lines: lines }));
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
      msg = 'package.json לא נמצא בשורש (' + deps.cwd + ')';
    } else {
      try {
        pkg = JSON.parse(deps.fs.readFileSync(pkgPath, 'utf8'));
      } catch (err) {
        msg = 'package.json אינו JSON תקין: ' + err.message;
      }
    }
    if (pkg && typeof pkg.name === 'string') environment.serviceName = pkg.name;
    if (pkg && !msg) {
      const react = pkg.dependencies && pkg.dependencies.react;
      if (!react) {
        msg = 'react לא מופיע ב-dependencies של package.json';
        if (pkg.devDependencies && pkg.devDependencies.react) msg += ' (מופיע רק ב-devDependencies)';
      } else {
        const major = parseInt((String(react).match(/\d+/) || [])[0], 10);
        if (major >= 18) {
          const warn = 'react כבר בגרסה ' + react + ' – ייתכן שהשירות כבר הוסב';
          checks.push(check('package-json', 'package.json', 'warn', warn));
          notes.push(warn);
        } else {
          checks.push(check('package-json', 'package.json', 'ok', (pkg.name || '(ללא name)') + ', react ' + react));
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
      const msg = 'Node ' + deps.nodeVersion + ' – נדרש ' + MIN_NODE_MAJOR + ' ומעלה';
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
  const registryLabel = environment.registryUrl || 'ה-registry המוגדר';

  let targets = deps.targets;
  let targetsError = null;
  if (!targets) {
    try {
      targets = loadTargets();
    } catch (err) {
      targetsError = 'לא ניתן לטעון את ' + TARGETS_FILE + ': ' + err.message;
    }
  }

  // Network checks run concurrently; results are reported in fixed order.
  const registryChain = (async () => {
    // 5. npm ping
    const ping = await npm(['ping'], deps.networkTimeoutMs);
    let pingCheck;
    if (ping.ok) {
      pingCheck = check('npm-ping', 'npm ping', 'ok', registryLabel);
    } else {
      const msg = ping.timedOut
        ? 'npm ping לא הגיב תוך ' + netSec + ' שניות – אין גישה ל-' + registryLabel
        : 'npm ping ל-' + registryLabel + ' נכשל: ' + (firstLine(ping.stderr) || firstLine(ping.stdout) || ping.message);
      pingCheck = check('npm-ping', 'npm ping', 'blocked', msg, { timeout: !!ping.timedOut });
    }

    // 6. target versions
    let versionsCheck;
    let versionBlockers = [];
    if (targetsError) {
      versionsCheck = check('target-versions', 'גרסאות יעד', 'blocked', targetsError);
      versionBlockers.push({ message: targetsError });
    } else if (!ping.ok) {
      versionsCheck = skipped('target-versions', 'גרסאות יעד', 'ה-registry אינו זמין');
    } else {
      const results = await Promise.all(targetSpecs(targets).map(async (spec) => {
        const ref = spec.version ? spec.name + '@' + spec.version : spec.name;
        const r = await npm(['view', ref, 'version'], deps.networkTimeoutMs);
        if (r.timedOut) return { ref: ref, spec: spec, ok: false, message: ref + ': לא הגיב תוך ' + netSec + ' שניות', timeout: true };
        if (!r.ok) {
          const text = r.stderr + '\n' + r.stdout;
          const notFound = /E404|404 Not Found|is not in this registry/i.test(text);
          return {
            ref: ref, spec: spec, ok: false,
            message: ref + ': ' + (notFound ? 'החבילה לא נמצאה ב-registry' : 'npm view נכשל – ' + (firstLine(r.stderr) || r.message)),
          };
        }
        const found = r.stdout.split(/\s+/).map((s) => s.replace(/^'|'$/g, '')).filter(Boolean);
        // npm view מחזיר פלט ריק וקוד 0 כשהגרסה המבוקשת לא קיימת
        if (found.length === 0 || (spec.version && found.indexOf(spec.version) === -1)) {
          return { ref: ref, spec: spec, ok: false, message: ref + ': הגרסה אינה זמינה ב-registry' };
        }
        return { ref: ref, spec: spec, ok: true, found: found[found.length - 1] };
      }));
      const failed = results.filter((x) => !x.ok);
      const lines = results.map((x) => (x.ok
        ? SYMBOLS.ok + ' ' + (x.spec.version ? x.ref : x.ref + ' (' + x.found + ')')
        : SYMBOLS.blocked + ' ' + x.message));
      if (failed.length === 0) {
        versionsCheck = check('target-versions', 'גרסאות יעד', 'ok', results.length + ' חבילות זמינות', { lines: lines });
      } else {
        versionsCheck = check('target-versions', 'גרסאות יעד', 'blocked', failed.length + ' מתוך ' + results.length + ' חבילות אינן זמינות', { lines: lines });
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

  const remoteBranch = (async () => {
    // 7. digital_V2 on origin
    const title = 'origin/' + TARGET_BRANCH;
    if (!isRepo) return skipped('remote-branch', title, 'אין git repo');
    const r = await git(['ls-remote', '--heads', 'origin', TARGET_BRANCH], deps.networkTimeoutMs);
    if (r.timedOut) {
      return check('remote-branch', title, 'blocked', 'git ls-remote לא הגיב תוך ' + netSec + ' שניות – אין גישה ל-origin', { timeout: true });
    }
    if (!r.ok) {
      return check('remote-branch', title, 'blocked', 'git ls-remote origin נכשל: ' + (firstLine(r.stderr) || r.message));
    }
    // ls-remote מתאים גם לסיומת (refs/heads/x/digital_V2), לכן בודקים התאמה מדויקת
    const exists = r.stdout.split(/\r?\n/).some((l) => l.split('\t')[1] === 'refs/heads/' + TARGET_BRANCH);
    return exists
      ? check('remote-branch', title, 'ok', 'קיים')
      : check('remote-branch', title, 'blocked', 'הבראנץ\' ' + TARGET_BRANCH + ' לא קיים ב-origin');
  })();

  const net = await Promise.all([registryChain, remoteBranch]);
  const reg = net[0];
  const remote = net[1];

  checks.push(reg.pingCheck);
  if (reg.pingCheck.status === 'blocked') addBlocker('npm-ping', reg.pingCheck.message, { timeout: reg.pingCheck.timeout });
  checks.push(reg.versionsCheck);
  reg.versionBlockers.forEach((b) => addBlocker('target-versions', b.message, b));
  checks.push(remote);
  if (remote.status === 'blocked') addBlocker('remote-branch', remote.message, { timeout: !!remote.timeout });

  return {
    script: SCRIPT,
    result: blockers.length === 0 ? 'OK' : 'BLOCKED',
    changes: [],
    manual: [],
    blockers: blockers,
    notes: notes,
    checks: checks,
    environment: environment,
  };
}

function formatText(result) {
  const lines = ['preflight – בדיקות סביבה לפני הסבה', ''];
  result.checks.forEach((c) => {
    lines.push(SYMBOLS[c.status] + ' ' + c.title + ': ' + c.message);
    (c.lines || []).forEach((l) => lines.push('    ' + l));
  });
  lines.push('');
  const env = result.environment;
  lines.push('סביבה: node ' + env.nodeVersion + ', npm ' + (env.npmVersion || '?') +
    ', registry ' + (env.registryUrl || '?') + ', בראנץ\' ' + (env.currentBranch || '?') +
    ', שירות ' + (env.serviceName || '?'));
  result.notes.forEach((n) => lines.push('הערה: ' + n));
  if (result.blockers.length) lines.push(result.blockers.length + ' חוסמים');
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
    const result = await runPreflight(options, deps);
    io.stdout(options.json ? JSON.stringify(result, null, 2) + '\n' : formatText(result));
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
  TARGET_BRANCH: TARGET_BRANCH,
};
