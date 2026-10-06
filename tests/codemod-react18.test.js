'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { run, main } = require('../scripts/codemod-react18');

const FIX = path.join(__dirname, 'fixtures', 'react18');

function fixture(name) {
  const dir = path.join(FIX, name);
  const input = fs.readdirSync(dir).find((f) => f.startsWith('input.'));
  const ext = path.extname(input);
  return {
    ext: ext,
    input: fs.readFileSync(path.join(dir, input), 'utf8'),
    expected: fs.readFileSync(path.join(dir, 'expected' + ext), 'utf8'),
  };
}

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'react18-test-'));
  Object.keys(files).forEach((rel) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), files[rel]);
  });
  return root;
}
const readIn = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// Runs a fixture as `rel`, checks the golden output and that a second run changes nothing.
function golden(name, rel) {
  const f = fixture(name);
  rel = rel || 'src/' + name + f.ext;
  const root = repo({ [rel]: f.input });
  const res = run([], { cwd: root });
  assert.strictEqual(readIn(root, rel), f.expected, name);
  const again = run([], { cwd: root });
  assert.deepStrictEqual(again.changes, [], name + ': second run produced changes');
  assert.strictEqual(readIn(root, rel), f.expected);
  return { res: res, again: again };
}

// ---- bootstrap golden files ----

test('golden: bootstrap with StrictMode and a custom element id', () => {
  const { res, again } = golden('bootstrap-strict', 'src/bootstrap.jsx');
  assert.strictEqual(res.result, 'OK');
  assert.deepStrictEqual(res.bootstrapFiles, ['src/bootstrap.jsx']);
  assert.strictEqual(again.result, 'NOOP');
});

test('golden: bootstrap without StrictMode', () => {
  const { res } = golden('bootstrap-plain', 'src/bootstrap.js');
  assert.strictEqual(res.result, 'OK');
});

test('golden: render with callback → manual, file unchanged (commented render ignored)', () => {
  const { res } = golden('bootstrap-callback', 'src/bootstrap.jsx');
  assert.strictEqual(res.result, 'REVIEW');
  assert.strictEqual(res.manual.length, 1);
  assert.match(res.manual[0].reason, /callback/);
  assert.strictEqual(res.manual[0].line, 6);
});

test('golden: already converted → NOOP', () => {
  const { res } = golden('bootstrap-converted', 'src/bootstrap.jsx');
  assert.strictEqual(res.result, 'NOOP');
  assert.deepStrictEqual(res.changes, []);
});

// ---- other transformations ----

test('golden: defaultProps → default parameters (class untouched, unused default dropped)', () => {
  const { res } = golden('default-props');
  assert.strictEqual(res.result, 'REVIEW'); // items: [] is not primitive
  const card = res.changes.find((c) => /^Card/.test(c.detail));
  assert.strictEqual(card.confidence, 'review');
  assert.match(card.reason, /items/);
  const badge = res.changes.find((c) => /^Badge/.test(c.detail));
  assert.strictEqual(badge.confidence, 'auto');
  assert.match(badge.detail, /color/);
});

test('golden: React.FC gets children?: React.ReactNode', () => {
  const { res } = golden('fc-children');
  assert.strictEqual(res.changes.filter((c) => c.rule === 'R18.FC_CHILDREN').length, 3);
});

test('entry from webpack config + import() boundary → main.jsx treated as bootstrap', () => {
  const root = repo({
    'webpack.config.js': "module.exports = () => ({ entry: './src/index.js' });\n",
    'src/index.js': "import('./main');\n",
    'src/main.jsx': fixture('bootstrap-plain').input,
    'src/Other.jsx': "import ReactDOM from 'react-dom';\nReactDOM.render(<div />, el);\n",
  });
  const res = run([], { cwd: root });
  assert.deepStrictEqual(res.bootstrapFiles, ['src/index.js', 'src/main.jsx']);
  assert.strictEqual(readIn(root, 'src/main.jsx'), fixture('bootstrap-plain').expected);
  // render outside bootstrap is never converted
  assert.match(readIn(root, 'src/Other.jsx'), /ReactDOM\.render/);
  assert.ok(res.manual.some((m) => m.file === 'src/Other.jsx' && /מחוץ לקובץ bootstrap/.test(m.reason)));
});

test('hydrate → hydrateRoot (argument order swapped); unmount with root in scope', () => {
  const root = repo({
    'src/bootstrap.js': [
      "import ReactDOM from 'react-dom';",
      "const el = document.getElementById('root');",
      'ReactDOM.hydrate(<App />, el);',
      'if (module.hot) module.hot.dispose(() => ReactDOM.unmountComponentAtNode(el));',
      '',
    ].join('\n'),
  });
  const res = run([], { cwd: root });
  assert.strictEqual(res.result, 'OK');
  assert.strictEqual(readIn(root, 'src/bootstrap.js'), [
    "import ReactDOM from 'react-dom/client';",
    "const el = document.getElementById('root');",
    'const root = ReactDOM.hydrateRoot(el, <App />);',
    'if (module.hot) module.hot.dispose(() => root.unmount());',
    '',
  ].join('\n'));
});

test('unmount without an accessible root → manual', () => {
  const root = repo({
    'src/bootstrap.js': [
      "import ReactDOM from 'react-dom';",
      'function mount(el) {',
      '  ReactDOM.render(<App />, el);',
      '}',
      'function unmount(el) {',
      '  ReactDOM.unmountComponentAtNode(el);',
      '}',
      '',
    ].join('\n'),
  });
  const res = run([], { cwd: root });
  assert.strictEqual(res.result, 'REVIEW');
  assert.ok(res.manual.some((m) => m.line === 6 && /אין root נגיש/.test(m.reason)));
  // react-dom is still needed for the manual call → named client import added instead
  assert.match(readIn(root, 'src/bootstrap.js'), /^import ReactDOM from 'react-dom';\nimport \{ createRoot \} from 'react-dom\/client';/);
  assert.match(readIn(root, 'src/bootstrap.js'), / {2}const root = createRoot\(el\);\n {2}root\.render\(<App \/>\);/);
});

test('named import { render } → { createRoot } from react-dom/client', () => {
  const root = repo({ 'src/bootstrap.js': "import { render } from 'react-dom';\nrender(<App />, document.getElementById('root'));\n" });
  run([], { cwd: root });
  assert.strictEqual(readIn(root, 'src/bootstrap.js'),
    "import { createRoot } from 'react-dom/client';\nconst root = createRoot(document.getElementById('root'));\nroot.render(<App />);\n");
});

test('findDOMNode and string refs → manual only, code untouched', () => {
  const input = [
    "import React from 'react';",
    "import ReactDOM from 'react-dom';",
    'export class Old extends React.Component {',
    '  componentDidMount() { ReactDOM.findDOMNode(this).focus(); this.refs.input.blur(); }',
    '  render() { return <input ref="input" />; }',
    '}',
    '',
  ].join('\n');
  const root = repo({ 'src/Old.jsx': input });
  const res = run([], { cwd: root });
  assert.strictEqual(readIn(root, 'src/Old.jsx'), input);
  assert.deepStrictEqual(res.changes, []);
  assert.strictEqual(res.manual.length, 3);
});

test('no React-18-only APIs and no mount/unmount API are ever introduced', () => {
  const f = fixture('bootstrap-strict');
  const root = repo({ 'src/bootstrap.jsx': f.input, 'src/App.jsx': 'export default function App() { return null; }\n' });
  run([], { cwd: root });
  const all = readIn(root, 'src/bootstrap.jsx') + readIn(root, 'src/App.jsx');
  ['useId', 'useSyncExternalStore', 'useTransition', 'useDeferredValue', 'useInsertionEffect', 'export function mount', 'export function unmount']
    .forEach((s) => assert.ok(all.indexOf(s) === -1, s));
});

test('--dry-run writes nothing; --json contract; missing src → BLOCKED', () => {
  const f = fixture('bootstrap-plain');
  const root = repo({ 'src/bootstrap.js': f.input });
  let out = '';
  main(['--dry-run', '--json'], { cwd: root }, { stdout: (s) => { out += s; }, stderr: () => {} });
  const res = JSON.parse(out);
  assert.strictEqual(res.result, 'OK');
  assert.deepStrictEqual(res.filesChanged, ['src/bootstrap.js']);
  assert.strictEqual(readIn(root, 'src/bootstrap.js'), f.input);

  out = '';
  assert.strictEqual(main([], { cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'react18-test-')) }, { stdout: (s) => { out += s; }, stderr: () => {} }), 0);
  assert.match(out, /RESULT: BLOCKED\n$/);
});

// ---- expected failures → BLOCKED, exit 0 ----

// Two identical edits make the real applyEdits detect an overlap – a codemod bug no input triggers on purpose.
const { applyEdits } = require('../scripts/codemod-react18');
const overlapping = (onlyIf) => (text, edits) => {
  if (text.indexOf(onlyIf) === -1) return applyEdits(text, edits);
  const p = edits[0].start;
  return applyEdits(text, edits.concat([{ start: p, end: p + 1, text: 'X' }, { start: p, end: p + 1, text: 'Y' }]));
};

test('overlapping edits → BLOCKED with file:line, exit 0, that file untouched, other files still converted', () => {
  const bootstrap = fixture('bootstrap-plain').input;
  const card = "import React from 'react';\nexport function Card({ title }) { return <h1>{title}</h1>; }\nCard.defaultProps = { title: 'x' };\n";
  const root = repo({ 'src/bootstrap.jsx': bootstrap, 'src/Card.jsx': card });
  let out = '';
  const code = main([], { cwd: root, applyEdits: overlapping('ReactDOM.render') }, { stdout: (s) => { out += s; }, stderr: (s) => { throw new Error('stderr: ' + s); } });
  assert.strictEqual(code, 0);
  // line 2: the first edit is the 'react-dom' → 'react-dom/client' specifier
  assert.match(out, /⛔ src\/bootstrap\.jsx:2 – codemod-react18 יצר שתי עריכות חופפות באותו מקום \(באג בקודמוד\)\. הקובץ לא שונה/);
  assert.match(out, /✏️ 1 קבצים שונו/); // the summary of the rest is still printed
  assert.strictEqual(out.trimEnd().split('\n').pop(), 'RESULT: BLOCKED');
  assert.strictEqual(readIn(root, 'src/bootstrap.jsx'), bootstrap);
  assert.doesNotMatch(readIn(root, 'src/Card.jsx'), /defaultProps/);

  const res = run(['--dry-run'], { cwd: repo({ 'src/bootstrap.jsx': bootstrap, 'src/Card.jsx': card }), applyEdits: overlapping('ReactDOM.render') });
  assert.deepStrictEqual(res.blockers.map((b) => b.file), ['src/bootstrap.jsx']);
  assert.ok(res.changes.every((c) => c.file === 'src/Card.jsx'), 'changes of the blocked file are not reported');
});
