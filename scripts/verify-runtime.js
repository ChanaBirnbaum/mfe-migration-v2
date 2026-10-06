#!/usr/bin/env node
'use strict';

// verify-runtime: start the dev server (webpack serve --mode development --env sviva=local), check that
// remoteEntry.js and / are served, report the React version, and ALWAYS stop the server.
// Never uses `npm start` – it contains --open and would open a browser on every run.

const path = require('path');

const SCRIPT = 'verify-runtime';
const DEFAULT_PORT = 8890;
const DEFAULT_STARTUP_MS = 3 * 60 * 1000;
const HTTP_TIMEOUT_MS = 15000;
const COEXISTENCE_DOC = 'reference/coexistence.md';
const SUCCESS_RE = /compiled successfully|webpack(?: \S+)? compiled(?! with \d+ errors?)/i;
const FAILED_RE = /compiled with (\d+) errors?|Failed to compile/i;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;
const HOST_NOTE = 'בדיקה זו רצה בפיתוח עצמאי, שבו React 18 מותקן מקומית. תחת Host ישן השירות מקבל React 17 מה-Host ' +
  '(import: false ב-buildSharedGen1) – בדיקה זו אינה מעידה על ההתנהגות תחת Host.';

function parseDuration(v) {
  const m = /^(\d+(?:\.\d+)?)(m|min|s|ms)?$/.exec(String(v || '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] || 'm';
  const ms = unit === 'ms' ? n : unit === 's' ? n * 1000 : n * 60000;
  return ms > 0 ? Math.round(ms) : null;
}

function parseArgs(argv) {
  const opts = { dryRun: false, json: false, port: null, startupMs: DEFAULT_STARTUP_MS, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--port' || a.startsWith('--port=')) {
      const v = a === '--port' ? argv[++i] : a.slice('--port='.length);
      if (!/^\d+$/.test(String(v)) || Number(v) < 1 || Number(v) > 65535) opts.errors.push('‎--port לא תקין: "' + v + '"');
      else opts.port = Number(v);
    } else if (a === '--timeout' || a.startsWith('--timeout=')) {
      const v = a === '--timeout' ? argv[++i] : a.slice('--timeout='.length);
      const ms = parseDuration(v);
      if (ms === null) opts.errors.push('‎--timeout לא תקין: "' + v + '"');
      else opts.startupMs = ms;
    } else opts.errors.push('פרמטר לא מוכר: ' + a);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// webpack.config.js → devServer.port, MFP filename / exposes (AST)

function readConfig(tsm, text) {
  const { Node, SyntaxKind: K } = tsm;
  const sf = new tsm.Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } }).createSourceFile('/webpack.config.js', text);
  const unwrap = (n) => { while (n && Node.isParenthesizedExpression(n)) n = n.getExpression(); return n; };
  const name = (p) => {
    const n = p.getNameNode && p.getNameNode();
    if (!n) return null;
    if (Node.isIdentifier(n)) return n.getText();
    if (Node.isStringLiteral(n)) return n.getLiteralText();
    return null;
  };
  const literal = (n, depth) => {
    n = unwrap(n);
    if (!n || depth > 3) return null;
    if (Node.isNumericLiteral(n)) return Number(n.getLiteralText());
    if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) return n.getLiteralText();
    if (Node.isIdentifier(n)) {
      // const PORT = 8890 – גם בתוך ה-({ sviva }) => {...}
      const v = sf.getDescendantsOfKind(K.VariableDeclaration).find((d) => d.getName() === n.getText());
      return v ? literal(v.getInitializer(), depth + 1) : null;
    }
    if (Node.isBinaryExpression(n) && n.getOperatorToken().getKind() === K.BarBarToken) return literal(n.getRight(), depth + 1);
    return null;
  };
  const out = { port: null, portExpression: null, filename: null, exposes: false };
  const devServer = sf.getDescendantsOfKind(K.PropertyAssignment).find((p) => name(p) === 'devServer' && Node.isObjectLiteralExpression(unwrap(p.getInitializer())));
  if (devServer) {
    const portProp = unwrap(devServer.getInitializer()).getProperties().find((p) => name(p) === 'port' || (Node.isShorthandPropertyAssignment(p) && p.getName() === 'port'));
    if (portProp) {
      const v = Node.isShorthandPropertyAssignment(portProp) ? literal(portProp.getNameNode(), 0) : literal(portProp.getInitializer(), 0);
      if (typeof v === 'number' || /^\d+$/.test(String(v))) out.port = Number(v);
      else out.portExpression = portProp.getText();
    }
  }
  const mfp = sf.getDescendantsOfKind(K.NewExpression).find((n) => /(^|\.)ModuleFederationPlugin$/.test(n.getExpression().getText()));
  const opts = mfp && unwrap(mfp.getArguments()[0]);
  if (opts && Node.isObjectLiteralExpression(opts)) {
    opts.getProperties().forEach((p) => {
      if (name(p) === 'filename') out.filename = literal(p.getInitializer(), 0);
      if (name(p) === 'exposes') {
        const v = unwrap(p.getInitializer());
        out.exposes = !(Node.isObjectLiteralExpression(v) && v.getProperties().length === 0);
      }
    });
  }
  out.hasMfp = !!mfp;
  return out;
}

// ---------------------------------------------------------------------------

function httpGet(url, timeoutMs) {
  const http = require('http');
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let size = 0;
      res.on('data', (c) => { size += c.length; });
      res.on('end', () => resolve({ status: res.statusCode, bytes: size }));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.on('error', (err) => resolve({ status: null, bytes: 0, error: err.code || err.message }));
  });
}

function portInUse(port) {
  const net = require('net');
  return new Promise((resolve) => {
    const s = net.connect({ port: port, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.setTimeout(2000, () => { s.destroy(); resolve(false); });
  });
}

function killTree(child, platform, cp) {
  if (!child || child.exitCode !== null) return;
  try {
    if (platform === 'win32') cp.spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else child.kill('SIGTERM');
  } catch (_) { /* best effort */ }
}

function readJson(fs, file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

async function run(argv, overrides) {
  const deps = Object.assign({
    fs: require('fs'), cwd: process.cwd(), cp: require('child_process'), platform: process.platform,
    env: Object.assign({}, process.env, { FORCE_COLOR: '0', NO_COLOR: '1', BROWSER: 'none' }),
    onOutput: () => {}, now: () => Date.now(), httpGet: httpGet, portInUse: portInUse,
  }, overrides || {});
  const opts = parseArgs(argv || []);
  const fs = deps.fs;
  const root = deps.cwd;
  const res = {
    script: SCRIPT, result: 'OK', changes: [], manual: [], blockers: [], notes: [], dryRun: opts.dryRun,
    command: null, port: null, startupMs: null, remoteEntryOk: null, remoteEntryUrl: null, rootOk: null,
    reactVersion: null, reactDomVersion: null, hasReactDomClient: null, versionSource: 'node_modules', diagnostics: [],
  };
  const blocked = (m, extra) => { res.result = 'BLOCKED'; res.blockers.push(Object.assign({ message: m }, extra || {})); return res; };
  const review = (m) => { if (res.result === 'OK') res.result = 'REVIEW'; res.manual.push({ file: null, line: null, reason: m }); };
  if (opts.errors.length) return blocked(opts.errors.join('; '));

  let tsm;
  try { tsm = require('ts-morph'); } catch (_) {
    return blocked('ts-morph אינו מותקן בתיקיית הסקיל – הרץ npm install ב-' + path.join(__dirname, '..'));
  }
  let cfgText;
  try { cfgText = fs.readFileSync(path.join(root, 'webpack.config.js'), 'utf8'); } catch (err) {
    return blocked('webpack.config.js לא נמצא / לא קריא: ' + err.message);
  }
  const cfg = readConfig(tsm, cfgText);
  res.port = opts.port || cfg.port || DEFAULT_PORT;
  if (!opts.port && !cfg.port) {
    res.notes.push(cfg.portExpression ? 'devServer.port אינו ערך קבוע (' + cfg.portExpression + ') – נעשה שימוש ב-' + DEFAULT_PORT + '. ניתן לעקוף עם --port'
      : 'devServer.port לא הוגדר – נעשה שימוש בברירת המחדל ' + DEFAULT_PORT);
  }
  const remoteEntryName = cfg.filename || 'remoteEntry.js';
  const expectRemoteEntry = cfg.exposes;

  // installed versions – בלי דפדפן אין דרך להריץ JS בדף, לכן קוראים מ-node_modules
  // require.resolve שומר מטמון בתוך התהליך – מוודאים שהקובץ באמת קיים
  const resolveFile = (spec) => { try { const f = require.resolve(spec, { paths: [root] }); return fs.existsSync(f) ? f : null; } catch (_) { return null; } };
  const resolvePkg = (n) => resolveFile(n + '/package.json');
  const reactPkg = resolvePkg('react');
  const reactDomPkg = resolvePkg('react-dom');
  res.reactVersion = reactPkg ? (readJson(fs, reactPkg) || {}).version || null : null;
  res.reactDomVersion = reactDomPkg ? (readJson(fs, reactDomPkg) || {}).version || null : null;
  res.hasReactDomClient = reactDomPkg ? fs.existsSync(path.join(path.dirname(reactDomPkg), 'client.js')) : false;

  const cli = resolveFile('webpack-cli/bin/cli.js');
  if (!cli) return blocked('webpack-cli אינו מותקן ב-node_modules – הרץ קודם את install.js');
  // node <webpack-cli> ישירות: בלי npm/shell, כך שעצירת התהליך עוצרת את השרת עצמו
  const args = [cli, 'serve', '--mode', 'development', '--env', 'sviva=local', '--no-open', '--port', String(res.port)];
  res.command = 'webpack serve --mode development --env sviva=local --no-open --port ' + res.port;
  if (opts.dryRun) {
    res.notes.push('[dry-run] היה מורץ: ' + res.command + ', ואז GET /' + remoteEntryName + ' ו-GET /');
    return res;
  }

  if (await deps.portInUse(res.port)) {
    return blocked('הפורט ' + res.port + ' כבר תפוס – שרת אחר רץ (אולי dev server קודם). עצור אותו או העבר --port');
  }

  let child = null;
  const onExit = () => killTree(child, deps.platform, deps.cp);
  process.once('exit', onExit);
  try {
    const started = deps.now();
    const outcome = await new Promise((resolve) => {
      let output = '';
      let done = false;
      let streaming = true;
      const finish = (r) => { if (!done) { done = true; clearTimeout(timer); streaming = false; resolve(Object.assign({ output: output }, r)); } };
      try {
        child = deps.cp.spawn(process.execPath, args, { cwd: root, env: deps.env, windowsHide: true });
      } catch (err) {
        return finish({ spawnError: err });
      }
      const onData = (chunk) => {
        const s = chunk.toString();
        output += s;
        if (streaming) deps.onOutput(s);
        const clean = output.replace(ANSI_RE, '');
        const failed = FAILED_RE.exec(clean);
        if (failed) finish({ failed: true });
        else if (SUCCESS_RE.test(clean)) finish({ ok: true });
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', (err) => finish({ spawnError: err }));
      child.on('exit', (code) => finish({ exited: true, code: code }));
      const timer = setTimeout(() => finish({ timedOut: true }), opts.startupMs);
    });
    res.startupMs = deps.now() - started;
    const tail = outcome.output.replace(ANSI_RE, '').split(/\r?\n/).slice(-40).join('\n');

    if (outcome.spawnError) return blocked('לא ניתן להפעיל את השרת: ' + outcome.spawnError.message);
    if (outcome.timedOut) return blocked('השרת לא דיווח על קומפילציה מוצלחת תוך ' + Math.round(opts.startupMs / 60000) + ' דקות', { raw: tail });
    if (outcome.exited) return blocked('השרת נסגר לפני שסיים לקמפל (exit ' + outcome.code + ')', { raw: tail });
    if (outcome.failed) {
      try { res.diagnostics = require('./build').parseOutput(outcome.output, root).diagnostics; } catch (_) { res.diagnostics = []; }
      return blocked('הקומפילציה ב-dev server נכשלה (' + res.diagnostics.filter((d) => d.severity === 'error').length + ' שגיאות) – הרץ build.js לפירוט', { raw: tail });
    }
    // dev server שבחר פורט אחר (port: 'auto') מדווח עליו בפלט
    const actual = /Loopback:\s*https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)/.exec(outcome.output.replace(ANSI_RE, ''));
    if (actual && Number(actual[1]) !== res.port) {
      res.notes.push('השרת עלה על פורט ' + actual[1] + ' ולא ' + res.port);
      res.port = Number(actual[1]);
    }

    const base = 'http://localhost:' + res.port;
    res.remoteEntryUrl = base + '/' + remoteEntryName;
    const entry = await deps.httpGet(res.remoteEntryUrl, HTTP_TIMEOUT_MS);
    res.remoteEntryOk = entry.status === 200 && entry.bytes > 0;
    const page = await deps.httpGet(base + '/', HTTP_TIMEOUT_MS);
    res.rootOk = page.status === 200;

    if (!res.remoteEntryOk) {
      const why = entry.status === null ? entry.error : 'HTTP ' + entry.status + (entry.status === 200 ? ' עם תוכן ריק' : '');
      if (expectRemoteEntry) return blocked(remoteEntryName + ' לא נטען (' + why + ') מ-' + res.remoteEntryUrl + ' – בדוק את ModuleFederationPlugin ואת output.publicPath של sviva=local');
      res.notes.push(remoteEntryName + ' לא נטען (' + why + ') – אין exposes בקונפיג, לכן זה צפוי (host / standalone)');
      res.remoteEntryOk = null;
    }
    if (!res.rootOk) review('GET / החזיר ' + (page.status === null ? page.error : 'HTTP ' + page.status) + ' – צפוי 200 (HtmlWebPackPlugin / index.html)');
  } finally {
    // סגירת השרת תמיד – גם בכשל
    killTree(child, deps.platform, deps.cp);
    process.removeListener('exit', onExit);
    if (child && child.exitCode === null) {
      await new Promise((r) => { const t = setTimeout(r, 5000); child.once('exit', () => { clearTimeout(t); r(); }); });
    }
  }

  // React
  const major = res.reactVersion ? Number(res.reactVersion.split('.')[0]) : null;
  if (!res.reactVersion) review('react לא נמצא ב-node_modules');
  else if (major !== 18) review('React ' + res.reactVersion + ' ולא 18 – ראה ' + COEXISTENCE_DOC);
  else if (!res.hasReactDomClient) review('react-dom/client אינו זמין (react-dom ' + (res.reactDomVersion || '?') + ') – ראה ' + COEXISTENCE_DOC);
  if (res.reactVersion && res.reactDomVersion && res.reactVersion !== res.reactDomVersion) {
    review('react ' + res.reactVersion + ' ו-react-dom ' + res.reactDomVersion + ' בגרסאות שונות');
  }
  res.notes.push('גרסת React (' + (res.reactVersion || '?') + ') נקראה מ-node_modules – זו הגרסה המותקנת, לא בהכרח זו שנטענת בדפדפן תחת Host');
  res.notes.push(HOST_NOTE);
  return res;
}

function formatText(res) {
  const L = ['', SCRIPT + (res.dryRun ? ' [dry-run]' : '') + (res.command ? ' – ' + res.command : '')];
  const mark = (v) => (v === true ? '✓' : v === false ? '⛔' : '–');
  if (res.startupMs !== null) {
    L.push('🚀 השרת עלה תוך ' + Math.round(res.startupMs / 1000) + 's על פורט ' + res.port);
    L.push(mark(res.remoteEntryOk) + ' ' + (res.remoteEntryUrl || 'remoteEntry.js'));
    L.push(mark(res.rootOk) + ' GET /');
  }
  if (res.reactVersion !== null || res.startupMs !== null) {
    L.push('⚛ React ' + (res.reactVersion || '?') + ' | react-dom ' + (res.reactDomVersion || '?') + ' | react-dom/client: ' + (res.hasReactDomClient ? 'כן' : 'לא'));
  }
  res.blockers.forEach((b) => {
    L.push('⛔ ' + b.message);
    if (b.raw) b.raw.split('\n').slice(-15).forEach((l) => L.push('   | ' + l));
  });
  res.manual.forEach((m) => L.push('✋ ' + m.reason));
  res.notes.forEach((n) => L.push('ℹ ' + n));
  L.push('RESULT: ' + res.result);
  return L.join('\n') + '\n';
}

async function main(argv, deps, io) {
  io = io || { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) };
  try {
    const opts = parseArgs(argv || []);
    const res = await run(argv, Object.assign({}, deps, { onOutput: opts.json ? () => {} : io.stdout }));
    io.stdout(opts.json ? JSON.stringify(res, null, 2) + '\n' : formatText(res));
    return 0;
  } catch (err) {
    io.stderr(SCRIPT + ' crashed: ' + ((err && err.stack) || err) + '\n');
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.stdout.write('', () => process.exit(code)));
}

module.exports = { run: run, main: main, readConfig: readConfig };
