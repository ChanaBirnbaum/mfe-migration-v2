'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { run, main } = require('../scripts/codemod-unused-imports');

const FIX = path.join(__dirname, 'fixtures', 'unused-imports');

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unused-imports-test-'));
  Object.keys(files).forEach((rel) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), files[rel]);
  });
  return root;
}
const readIn = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function golden(name) {
  const dir = path.join(FIX, name);
  const input = fs.readdirSync(dir).find((f) => f.startsWith('input.'));
  const ext = path.extname(input);
  const rel = 'src/' + name + ext;
  const root = repo({ [rel]: fs.readFileSync(path.join(dir, input), 'utf8') });
  const res = run([], { cwd: root });
  assert.strictEqual(readIn(root, rel), fs.readFileSync(path.join(dir, 'expected' + ext), 'utf8'), name);
  const again = run([], { cwd: root });
  assert.strictEqual(again.result, 'NOOP', name + ': second run produced changes');
  return res;
}

// one-file run: returns the new text and the result
function one(src, rel) {
  rel = rel || 'src/A.jsx';
  const root = repo({ [rel]: src });
  const res = run([], { cwd: root });
  return { out: readIn(root, rel), res: res };
}

test('golden: JSX – whole, partial, multiline, namespace and default+named imports', () => {
  const res = golden('basic');
  assert.ok(res.changes.every((c) => c.rule === 'UNUSED.IMPORT'));
  const byDetail = (d) => res.changes.find((c) => c.detail === d);
  assert.strictEqual(byDetail("import removed: unstable_createMuiStrictModeTheme from '@material-ui/core/styles'").confidence, 'auto');
  assert.strictEqual(byDetail("unused binding removed: Typography, Divider from '@material-ui/core'").confidence, 'auto');
  assert.strictEqual(byDetail("unused binding removed, stylesheet still loaded: classes from './Screen.module.scss'").confidence, 'auto');
  // a whole local import removed → review (the module may hold setup code); a partial one stays auto
  const local = byDetail("import removed: utils from './utils'");
  assert.strictEqual(local.confidence, 'review');
  assert.match(local.reason, /no longer loaded/);
  assert.strictEqual(byDetail("unused binding removed: Default from './helpers'").confidence, 'auto');
  assert.strictEqual(res.result, 'REVIEW');
});

test('stylesheet with a binding: kept as a side-effect import, quotes and semicolon preserved', () => {
  assert.strictEqual(one("import styles from './a.css'\nexport const x = 1;\n", 'src/x.js').out, "import './a.css'\nexport const x = 1;\n");
  assert.strictEqual(one("import * as s from '../b.less';\nexport const x = 1;\n", 'src/x.js').out, "import '../b.less';\nexport const x = 1;\n");
});

test('whole package import removed → auto; whole local import removed → review, printed with 🔍', () => {
  const root = repo({ 'src/x.js': "import { a } from 'lodash';\nimport { setup } from '../api';\nexport const x = 1;\n" });
  let out = '';
  main([], { cwd: root }, { stdout: (s) => { out += s; }, stderr: () => {} });
  assert.strictEqual(readIn(root, 'src/x.js'), 'export const x = 1;\n');
  assert.match(out, /🔍 src\/x\.js:2 – Unused import of the local module '\.\.\/api' removed/);
  assert.doesNotMatch(out, /🔍 src\/x\.js:1/);
  assert.match(out, /RESULT: REVIEW/);
});

test('golden: TypeScript – type positions count as a use, aliases, import type', () => {
  golden('typescript');
});

test('React default import stays in a file with JSX (classic runtime)', () => {
  const { out, res } = one("import React from 'react';\nexport const A = () => <div />;\n");
  assert.strictEqual(out, "import React from 'react';\nexport const A = () => <div />;\n");
  assert.strictEqual(res.result, 'NOOP');
});

test('React default import without JSX is removed', () => {
  const { out } = one("import React from 'react';\nimport { x } from './x';\nexport const a = x;\n", 'src/a.js');
  assert.strictEqual(out, "import { x } from './x';\nexport const a = x;\n");
});

test('@jsx pragma keeps its factory', () => {
  const src = "/** @jsx jsx */\nimport { jsx, css } from '@emotion/react';\nexport const A = () => <div />;\n";
  assert.strictEqual(one(src).out, "/** @jsx jsx */\nimport { jsx } from '@emotion/react';\nexport const A = () => <div />;\n");
});

test('side-effect imports and re-exported names are kept', () => {
  const src = "import './polyfills';\nimport A from './A';\nexport { A };\n";
  assert.strictEqual(one(src, 'src/index.js').res.result, 'NOOP');
});

test('trailing dead run and leading dead run in one import', () => {
  const src = "import { a, b, c, d, e } from 'm';\nexport default [c];\n";
  assert.strictEqual(one(src, 'src/x.js').out, "import { c } from 'm';\nexport default [c];\n");
});

test('default kept, all named dead → named bindings dropped', () => {
  const src = "import A, { b, c } from 'm';\nexport default A;\n";
  assert.strictEqual(one(src, 'src/x.js').out, "import A from 'm';\nexport default A;\n");
});

test('default dead, namespace kept', () => {
  const src = "import A, * as ns from 'm';\nexport default ns;\n";
  assert.strictEqual(one(src, 'src/x.js').out, "import * as ns from 'm';\nexport default ns;\n");
});

test('CRLF and BOM are preserved', () => {
  const src = "﻿import { a, b } from 'm';\r\nimport c from 'c';\r\n\r\nexport default a;\r\n";
  assert.strictEqual(one(src, 'src/x.js').out, "﻿import { a } from 'm';\r\n\r\nexport default a;\r\n");
});

test('.ts file left with no import and no export → manual item', () => {
  const { out, res } = one("import { a } from 'm';\nconst x = 1;\n", 'src/x.ts');
  assert.strictEqual(out, 'const x = 1;\n');
  assert.strictEqual(res.result, 'REVIEW');
  assert.strictEqual(res.manual.length, 1);
});

test('.d.ts files are skipped', () => {
  const src = "import { Theme } from '@mui/material';\ndeclare module 'x' {}\n";
  const { out, res } = one(src, 'src/types.d.ts');
  assert.strictEqual(out, src);
  assert.strictEqual(res.result, 'NOOP');
});

test('--dry-run writes nothing', () => {
  const src = "import { a } from 'm';\nexport const x = 1;\n";
  const root = repo({ 'src/x.js': src });
  const res = run(['--dry-run'], { cwd: root });
  assert.deepStrictEqual(res.filesChanged, ['src/x.js']);
  assert.strictEqual(readIn(root, 'src/x.js'), src);
});

test('no src/ → BLOCKED', () => {
  const root = repo({ 'package.json': '{}' });
  assert.strictEqual(run([], { cwd: root }).result, 'BLOCKED');
});

test('main prints a summary', () => {
  const root = repo({ 'src/x.js': "import { a } from 'm';\nexport const x = 1;\n" });
  let out = '';
  assert.strictEqual(main([], { cwd: root }, { stdout: (s) => { out += s; }, stderr: () => {} }), 0);
  assert.match(out, /UNUSED\.IMPORT ×1/);
  assert.match(out, /RESULT: OK/);
});
