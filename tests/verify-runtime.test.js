'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');

const { run, main, readConfig } = require('../scripts/verify-runtime');

// Fake webpack-cli: a real HTTP server whose behaviour is set by FAKE_MODE. Records argv and pid.
const FAKE_CLI = `
const http = require('http');
const fs = require('fs');
const argv = process.argv.slice(2);
fs.writeFileSync('argv.json', JSON.stringify(argv));
fs.writeFileSync('server.pid', String(process.pid));
const port = Number(argv[argv.indexOf('--port') + 1]);
const mode = process.env.FAKE_MODE || 'ok';
if (mode === 'crash') { console.error('Error: Cannot find module "html-webpack-plugin"'); process.exit(1); }
if (mode === 'hang') { setInterval(() => {}, 1000); return; }
http.createServer((req, res) => {
  if (req.url === '/remoteEntry.js' && mode !== 'no-entry') { res.writeHead(200); res.end('var ServeLab;'); return; }
  if (req.url === '/' && mode !== 'no-root') { res.writeHead(200); res.end('<html></html>'); return; }
  res.writeHead(404); res.end();
}).listen(port, () => {
  if (mode === 'errors') {
    console.log("ERROR in ./src/a.js 1:0-20\\nModule not found: Error: Can't resolve './x' in '/src'\\n\\nwebpack 5.111.1 compiled with 1 error in 5 ms");
  } else {
    console.log('<i> [webpack-dev-server] Loopback: http://localhost:' + port + '/');
    console.log('webpack 5.111.1 compiled successfully in 5 ms');
  }
});
`;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function repo(port, opts) {
  opts = opts || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-runtime-test-'));
  const files = {
    'webpack.config.js': [
      "const ModuleFederationPlugin = require('webpack/lib/container/ModuleFederationPlugin');",
      'module.exports = ({ sviva }) => {',
      '  const PORT = ' + port + ';',
      '  return {',
      '    devServer: { port: PORT, open: true },',
      "    plugins: [new ModuleFederationPlugin({ name: 'A', filename: 'remoteEntry.js', " + (opts.host ? "remotes: { b: 'b@x' }" : "exposes: { './A': './src/A.jsx' }") + ' })],',
      '  };',
      '};',
      '',
    ].join('\n'),
    'node_modules/webpack-cli/package.json': '{ "name": "webpack-cli", "version": "5.1.4" }',
    'node_modules/webpack-cli/bin/cli.js': FAKE_CLI,
    'node_modules/react/package.json': JSON.stringify({ name: 'react', version: opts.react || '18.3.1' }),
    'node_modules/react-dom/package.json': JSON.stringify({ name: 'react-dom', version: opts.reactDom || opts.react || '18.3.1' }),
  };
  if (!opts.noClient) files['node_modules/react-dom/client.js'] = 'module.exports = {};';
  Object.keys(files).forEach((rel) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), files[rel]);
  });
  return root;
}

const deps = (root, mode, extra) => Object.assign({ cwd: root, env: Object.assign({}, process.env, { FAKE_MODE: mode }) }, extra || {});
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
const pidOf = (root) => Number(fs.readFileSync(path.join(root, 'server.pid'), 'utf8'));
const listening = (port) => new Promise((resolve) => {
  const s = net.connect({ port: port, host: '127.0.0.1' });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

// ---- happy path ----

test('serve → remoteEntry.js + / → React 18 → OK; server always stopped', async () => {
  const port = await freePort();
  const root = repo(port);
  const res = await run([], deps(root, 'ok'));
  assert.strictEqual(res.result, 'OK', JSON.stringify(res.blockers.concat(res.manual)));
  assert.strictEqual(res.port, port);
  assert.strictEqual(res.remoteEntryOk, true);
  assert.strictEqual(res.rootOk, true);
  assert.strictEqual(res.reactVersion, '18.3.1');
  assert.strictEqual(res.hasReactDomClient, true);
  assert.ok(!alive(pidOf(root)), 'dev server process must be stopped');
  assert.strictEqual(await listening(port), false);
});

test('never npm start / --open: webpack serve --mode development --env sviva=local --no-open', async () => {
  const port = await freePort();
  const root = repo(port);
  await run([], deps(root, 'ok'));
  const argv = JSON.parse(fs.readFileSync(path.join(root, 'argv.json'), 'utf8'));
  assert.deepStrictEqual(argv, ['serve', '--mode', 'development', '--env', 'sviva=local', '--no-open', '--port', String(port)]);
});

test('notes: version read from node_modules + standalone vs Host warning', async () => {
  const port = await freePort();
  const res = await run([], deps(repo(port), 'ok'));
  assert.ok(res.notes.some((n) => /node_modules/.test(n) && /תחת Host/.test(n)));
  assert.ok(res.notes.some((n) => /import: false ב-buildSharedGen1/.test(n)));
});

// ---- failures – the server is stopped in every one of them ----

test('remoteEntry.js missing → BLOCKED, server stopped', async () => {
  const port = await freePort();
  const root = repo(port);
  const res = await run([], deps(root, 'no-entry'));
  assert.strictEqual(res.result, 'BLOCKED');
  assert.strictEqual(res.remoteEntryOk, false);
  assert.match(res.blockers[0].message, /remoteEntry\.js לא נטען \(HTTP 404\)/);
  assert.ok(!alive(pidOf(root)));
});

test('host service (no exposes): missing remoteEntry is expected, not BLOCKED', async () => {
  const port = await freePort();
  const res = await run([], deps(repo(port, { host: true }), 'no-entry'));
  assert.strictEqual(res.result, 'OK');
  assert.strictEqual(res.remoteEntryOk, null);
});

test('GET / not 200 → REVIEW', async () => {
  const port = await freePort();
  const res = await run([], deps(repo(port), 'no-root'));
  assert.strictEqual(res.result, 'REVIEW');
  assert.match(res.manual[0].reason, /GET \/ החזיר HTTP 404/);
});

test('React 17 → REVIEW pointing to reference/coexistence.md', async () => {
  const port = await freePort();
  const res = await run([], deps(repo(port, { react: '17.0.2', noClient: true }), 'ok'));
  assert.strictEqual(res.result, 'REVIEW');
  assert.match(res.manual[0].reason, /React 17\.0\.2 ולא 18 – ראה reference\/coexistence\.md/);
  assert.strictEqual(res.hasReactDomClient, false);
});

test('react / react-dom version mismatch → REVIEW', async () => {
  const port = await freePort();
  const res = await run([], deps(repo(port, { react: '18.3.1', reactDom: '18.2.0' }), 'ok'));
  assert.strictEqual(res.result, 'REVIEW');
  assert.match(res.manual[0].reason, /בגרסאות שונות/);
});

test('compile errors → BLOCKED with diagnostics, server stopped', async () => {
  const port = await freePort();
  const root = repo(port);
  const res = await run([], deps(root, 'errors'));
  assert.strictEqual(res.result, 'BLOCKED');
  assert.strictEqual(res.diagnostics[0].code, 'MODULE_NOT_FOUND');
  assert.ok(!alive(pidOf(root)));
});

test('startup timeout → BLOCKED, server stopped', async () => {
  const port = await freePort();
  const root = repo(port);
  const res = await run(['--timeout', '1500ms'], deps(root, 'hang'));
  assert.strictEqual(res.result, 'BLOCKED');
  assert.match(res.blockers[0].message, /לא דיווח על קומפילציה מוצלחת/);
  assert.ok(!alive(pidOf(root)));
});

test('server crashes on start → BLOCKED with the output tail', async () => {
  const port = await freePort();
  const res = await run([], deps(repo(port), 'crash'));
  assert.strictEqual(res.result, 'BLOCKED');
  assert.match(res.blockers[0].message, /נסגר לפני שסיים לקמפל \(exit 1\)/);
  assert.match(res.blockers[0].raw, /html-webpack-plugin/);
});

test('port already in use → BLOCKED before starting anything', async () => {
  const port = await freePort();
  const root = repo(port);
  const blocker = net.createServer().listen(port);
  await new Promise((r) => blocker.once('listening', r));
  try {
    const res = await run([], deps(root, 'ok'));
    assert.strictEqual(res.result, 'BLOCKED');
    assert.match(res.blockers[0].message, /כבר תפוס/);
    assert.ok(!fs.existsSync(path.join(root, 'server.pid')));
  } finally {
    blocker.close();
  }
});

// ---- config / CLI ----

test('port from devServer.port: literal, const inside ({ sviva }) =>, fallback 8890', () => {
  const tsm = require('ts-morph');
  assert.strictEqual(readConfig(tsm, 'module.exports = { devServer: { port: 3001 } };').port, 3001);
  assert.strictEqual(readConfig(tsm, 'module.exports = ({ sviva }) => { const PORT = 8890; return { devServer: { port: PORT } }; };').port, 8890);
  assert.strictEqual(readConfig(tsm, 'module.exports = { devServer: { port: process.env.PORT || 4000 } };').port, 4000);
  assert.strictEqual(readConfig(tsm, 'module.exports = {};').port, null);
});

test('--dry-run starts nothing; --json contract; webpack-cli missing → BLOCKED', async () => {
  const port = await freePort();
  const root = repo(port);
  let out = '';
  await main(['--dry-run', '--json'], deps(root, 'ok'), { stdout: (s) => { out += s; }, stderr: () => {} });
  const res = JSON.parse(out);
  ['reactVersion', 'hasReactDomClient', 'remoteEntryOk', 'port'].forEach((k) => assert.ok(k in res, k));
  assert.strictEqual(res.port, port);
  assert.ok(!fs.existsSync(path.join(root, 'server.pid')));

  fs.rmSync(path.join(root, 'node_modules', 'webpack-cli'), { recursive: true, force: true });
  out = '';
  await main([], deps(root, 'ok'), { stdout: (s) => { out += s; }, stderr: () => {} });
  assert.match(out, /webpack-cli אינו מותקן[\s\S]*RESULT: BLOCKED\n$/);
});
