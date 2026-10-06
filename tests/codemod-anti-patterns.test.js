'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { run, main } = require('../scripts/codemod-anti-patterns');

const FIX = path.join(__dirname, 'fixtures', 'anti-patterns');
const fixture = (name) => ({
  input: fs.readFileSync(path.join(FIX, name, 'input.jsx'), 'utf8'),
  expected: fs.readFileSync(path.join(FIX, name, 'expected.jsx'), 'utf8'),
});

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-test-'));
  Object.keys(files).forEach((rel) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), files[rel]);
  });
  return root;
}
const readIn = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function golden(name, args) {
  const f = fixture(name);
  const root = repo({ 'src/C.jsx': f.input });
  const res = run(args || [], { cwd: root });
  assert.strictEqual(readIn(root, 'src/C.jsx'), f.expected, name);
  const again = run(args || [], { cwd: root });
  assert.deepStrictEqual(again.changes, [], name + ': second run produced changes');
  return { res: res, again: again };
}

test('golden: simple', () => {
  const { res, again } = golden('simple');
  assert.strictEqual(res.result, 'OK');
  assert.strictEqual(again.result, 'NOOP');
});

test('golden: try/catch/finally – guard in catch and finally, not before the first await; run → runEffect', () => {
  const { res } = golden('try-catch');
  assert.strictEqual(res.result, 'OK');
});

test('golden: existing cleanup merged with the cancel flag', () => {
  const { res } = golden('cleanup');
  assert.strictEqual(res.result, 'OK');
});

test('golden: complex (await in loop, several returns) → manual, file unchanged', () => {
  const { res } = golden('complex');
  assert.strictEqual(res.result, 'REVIEW');
  assert.deepStrictEqual(res.manual.map((m) => m.line), [7, 14]);
  assert.match(res.manual[0].reason, /לולאה/);
  assert.match(res.manual[1].reason, /return/);
});

test('golden: --no-cancel-guard', () => {
  const { res } = golden('no-guard', ['--no-cancel-guard']);
  assert.strictEqual(res.result, 'OK');
  assert.strictEqual(res.cancelGuard, false);
});

// ---- extra cases ----

function convert(src, args) {
  const root = repo({ 'src/C.jsx': src });
  const res = run(args || [], { cwd: root });
  return { res: res, out: readIn(root, 'src/C.jsx') };
}

test('setX(await f()) is split so the guard runs after the await', () => {
  const { out } = convert([
    "import { useEffect, useState } from 'react';",
    'export function A() {',
    '  const [v, setV] = useState();',
    '  useEffect(async () => {',
    '    setV(await load());',
    '  }, []);',
    '}',
    '',
  ].join('\n'));
  assert.match(out, /const result = await load\(\);\n {6}if \(!cancelled\) setV\(result\);/);
});

test('brace-less if branch gets a block (no dangling else)', () => {
  const { out } = convert([
    "import React from 'react';",
    'export function A() {',
    '  const [v, setV] = React.useState();',
    '  React.useEffect(async () => {',
    '    const r = await load();',
    '    if (r) setV(r); else setV(null);',
    '  }, []);',
    '}',
    '',
  ].join('\n'));
  assert.match(out, /if \(r\) \{ if \(!cancelled\) setV\(r\); \} else \{ if \(!cancelled\) setV\(null\); \}/);
});

test('cleanup that uses a variable declared in the effect body → manual', () => {
  const { res, out } = convert([
    "import { useEffect, useState } from 'react';",
    'export function A() {',
    '  const [v, setV] = useState();',
    '  useEffect(async () => {',
    '    const sub = source.subscribe(setV);',
    '    await ready();',
    '    return () => sub.unsubscribe();',
    '  }, []);',
    '}',
    '',
  ].join('\n'));
  assert.strictEqual(res.result, 'REVIEW');
  assert.match(res.manual[0].reason, /sub/);
  assert.match(out, /useEffect\(async/);
});

test('async function expression using this → manual', () => {
  const { res } = convert([
    "import { useEffect } from 'react';",
    'export function A() {',
    '  useEffect(async function () { await this.load(); }, []);',
    '}',
    '',
  ].join('\n'));
  assert.match(res.manual[0].reason, /this/);
});

test('useEffect not imported from react is ignored; commented async effect ignored → NOOP', () => {
  const { res } = convert([
    "import { useEffect } from './my-hooks';",
    '// useEffect(async () => { await x(); }, []);',
    'export function A() { useEffect(async () => { await x(); }, []); }',
    '',
  ].join('\n'));
  assert.strictEqual(res.result, 'NOOP');
});

test('--dry-run writes nothing; --json contract', () => {
  const f = fixture('simple');
  const root = repo({ 'src/C.jsx': f.input });
  let out = '';
  assert.strictEqual(main(['--dry-run', '--json'], { cwd: root }, { stdout: (s) => { out += s; }, stderr: () => {} }), 0);
  const res = JSON.parse(out);
  assert.deepStrictEqual(Object.keys(res).slice(0, 6), ['script', 'result', 'changes', 'manual', 'blockers', 'notes']);
  assert.strictEqual(res.changes.length, 1);
  assert.strictEqual(readIn(root, 'src/C.jsx'), f.input);
});
