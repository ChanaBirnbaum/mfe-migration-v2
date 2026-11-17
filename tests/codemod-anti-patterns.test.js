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
  assert.match(res.manual[0].reason, /loop/);
  assert.match(res.manual[1].reason, /return/);
});

test('golden: setTimeout / localStorage.setItem are not setters – only the useState setter is guarded', () => {
  const { res, again } = golden('non-setters');
  assert.strictEqual(res.result, 'OK');
  assert.strictEqual(res.changes[0].confidence, 'auto');
  assert.strictEqual(again.result, 'NOOP');
});

test('golden: --no-cancel-guard', () => {
  const { res } = golden('no-guard', ['--no-cancel-guard']);
  assert.strictEqual(res.result, 'OK');
  assert.strictEqual(res.cancelGuard, false);
});

test('golden: no await – async removed without run(); setState in .then / .then(setX) guarded; nothing to guard → no flag', () => {
  const { res, again } = golden('promise-then');
  assert.strictEqual(res.result, 'OK');
  assert.deepStrictEqual(res.changes.map((c) => c.detail), [
    'useEffect(async …) → async removed + cancelled guard',
    'useEffect(async …) → async removed + cancelled guard',
    'useEffect(async …) → async removed',
  ]);
  assert.strictEqual(again.result, 'NOOP');
});

// ---- extra cases ----

function convert(src, args) {
  const root = repo({ 'src/C.jsx': src });
  const res = run(args || [], { cwd: root });
  return { res: res, out: readIn(root, 'src/C.jsx') };
}

const effectOf = (body, params) => [
  "import { useEffect, useState } from 'react';",
  'export function A(' + (params || '') + ') {',
  '  const [v, setV] = useState();',
  '  useEffect(async () => {',
  body,
  '  }, []);',
  '}',
  '',
].join('\n');

test('await without any setState → run() but no cancelled flag', () => {
  const { res, out } = convert(effectOf('    await track();'));
  assert.strictEqual(res.changes[0].detail, 'useEffect(async …) → run()');
  assert.doesNotMatch(out, /cancelled/);
  assert.match(out, /const run = async \(\) => \{\n {6}await track\(\);\n {4}\};\n {4}run\(\);\n {2}\}, \[\]\);/);
});

test('await + .then callback in the same effect → both guarded, one flag', () => {
  const { out } = convert(effectOf('    const r = await load();\n    setV(r);\n    more().then((m) => { setV(m); });'));
  assert.strictEqual(out.match(/let cancelled = false;/g).length, 1);
  assert.match(out, /if \(!cancelled\) setV\(r\);/);
  assert.match(out, /more\(\)\.then\(\(m\) => \{ if \(!cancelled\) setV\(m\); \}\);/);
});

test('nested .then inside .then, and async .then callback with await → guarded', () => {
  const { out } = convert(effectOf('    a().then((x) => b(x).then((y) => setV(y)));\n    c().then(async (r) => { const d = await r.json(); setV(d); });'));
  assert.match(out, /b\(x\)\.then\(\(y\) => \{ if \(!cancelled\) setV\(y\); \}\)/);
  assert.match(out, /const d = await r\.json\(\); if \(!cancelled\) setV\(d\);/);
  assert.doesNotMatch(out, /const run/);
});

test('setState in a non-promise callback (setTimeout, forEach) → not guarded; no flag', () => {
  const { out } = convert(effectOf('    setTimeout(() => setV(1), 0);\n    [1].forEach((x) => { setV(x); });'));
  assert.doesNotMatch(out, /cancelled/);
});

test('brace-less if inside .then → block added; setState in an expression inside .then → manual', () => {
  const ok = convert(effectOf('    load().then((r) => { if (r) setV(r); else setV(null); });')).out;
  assert.match(ok, /if \(r\) \{ if \(!cancelled\) setV\(r\); \} else \{ if \(!cancelled\) setV\(null\); \}/);

  const { res, out } = convert(effectOf('    load().then((r) => r && setV(r));'));
  assert.strictEqual(res.result, 'REVIEW');
  assert.match(res.manual[0].reason, /\.then\/\.catch within an expression/);
  assert.match(out, /useEffect\(async/);
});

test('no await but the effect returns a value → kept inside run() (a sync effect may only return a cleanup)', () => {
  const { out } = convert(effectOf('    return load().then((r) => setV(r));'));
  assert.match(out, /const run = async \(\) => \{\n {6}return load\(\)\.then\(\(r\) => \{ if \(!cancelled\) setV\(r\); \}\);/);
});

test('no await with an existing cleanup → cleanup kept, merged with the flag', () => {
  const { out } = convert(effectOf('    load().then((r) => setV(r));\n    return () => abort();'));
  assert.doesNotMatch(out, /const run/);
  assert.match(out, /return \(\) => \{ cancelled = true; abort\(\); \};/);
});

test('setter-like prop inside .then → not wrapped, effect marked review', () => {
  const { res, out } = convert(effectOf('    load().then((t) => setTitle(t));', '{ setTitle }'));
  assert.strictEqual(res.result, 'REVIEW');
  assert.match(res.changes[0].reason, /setTitle.*inside \.then/);
  assert.match(out, /load\(\)\.then\(\(t\) => setTitle\(t\)\);/);
  assert.doesNotMatch(out, /cancelled/);
});

test('--no-cancel-guard with .then → async removed, nothing guarded', () => {
  const { out } = convert(effectOf('    load().then((r) => setV(r));'), ['--no-cancel-guard']);
  assert.match(out, /useEffect\(\(\) => \{\n {4}load\(\)\.then\(\(r\) => setV\(r\)\);\n {2}\}, \[\]\);/);
});

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

test('setter-like prop (destructured) after await → not wrapped, effect marked review', () => {
  const { res, out } = convert([
    "import { useEffect, useState } from 'react';",
    'export function A({ id, setTitle }) {',
    '  const [v, setV] = useState();',
    '  useEffect(async () => {',
    '    const t = await load(id);',
    '    setTitle(t);',
    '    setV(t);',
    '  }, [id]);',
    '}',
    '',
  ].join('\n'));
  assert.strictEqual(res.result, 'REVIEW');
  assert.strictEqual(res.changes[0].confidence, 'review');
  assert.match(res.changes[0].reason, /setTitle/);
  assert.match(out, /\n {6}setTitle\(t\);/);
  assert.match(out, /if \(!cancelled\) setV\(t\);/);
});

test('props.setX(...) after await → not wrapped (property access), effect marked review', () => {
  const { res, out } = convert([
    "import { useEffect } from 'react';",
    'export function A(props) {',
    '  useEffect(async () => {',
    '    const t = await load();',
    '    props.setTitle(t);',
    '  }, []);',
    '}',
    '',
  ].join('\n'));
  assert.strictEqual(res.result, 'REVIEW');
  assert.match(res.changes[0].reason, /props\.setTitle/);
  assert.doesNotMatch(out, /if \(!cancelled\) props/);
});

test('setter-named function that is neither useState nor a prop → not wrapped, still auto', () => {
  const { res, out } = convert([
    "import { useEffect } from 'react';",
    "import { setGlobalTitle } from './title';",
    'export function A() {',
    '  useEffect(async () => {',
    '    setGlobalTitle(await load());',
    '  }, []);',
    '}',
    '',
  ].join('\n'));
  assert.strictEqual(res.result, 'OK');
  assert.strictEqual(res.changes[0].confidence, 'auto');
  assert.match(out, /setGlobalTitle\(await load\(\)\);/);
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

// ---- expected failures → BLOCKED, exit 0 ----

const { applyEdits } = require('../scripts/codemod-anti-patterns');
// Two identical edits make the real applyEdits detect an overlap – a codemod bug no input triggers on purpose.
const overlapping = (text, edits) => {
  const p = edits[0].start;
  return applyEdits(text, edits.concat([{ start: p, end: p + 1, text: 'X' }, { start: p, end: p + 1, text: 'Y' }]));
};

test('overlapping edits → BLOCKED with file:line, exit 0, file untouched, no changes reported', () => {
  const f = fixture('simple');
  const root = repo({ 'src/C.jsx': f.input });
  let out = '';
  const code = main(['--json'], { cwd: root, applyEdits: overlapping }, { stdout: (s) => { out += s; }, stderr: (s) => { throw new Error('stderr: ' + s); } });
  assert.strictEqual(code, 0);
  const res = JSON.parse(out);
  assert.strictEqual(res.result, 'BLOCKED');
  assert.match(res.blockers[0].message, /^src\/C\.jsx:6 – codemod-anti-patterns produced two overlapping edits/); // the async effect
  assert.deepStrictEqual(res.changes, []);
  assert.strictEqual(readIn(root, 'src/C.jsx'), f.input);
});
