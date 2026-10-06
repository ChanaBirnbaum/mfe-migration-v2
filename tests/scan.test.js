'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { run, main, minVersion, formatText } = require('../scripts/scan');

// ---------------------------------------------------------------------------
// Fixture repo

const FILES = {
  'package.json': JSON.stringify({
    name: 'hasava-mfe',
    version: '0.1.1',
    dependencies: {
      '@material-ui/core': '^4.12.3',
      '@material-ui/pickers': '^3.3.10',
      '@mui/x-date-pickers': '^5.0.0-alpha.4',
      react: '^17.0.2',
      'react-dom': '^17.0.2',
      'react-router-dom': '^6.0.2',
      'react-beautiful-dnd': '^12.2.0',
      'react-test-renderer': '^18.2.0',
    },
    devDependencies: { react: '^17.0.2', enzyme: '^3.11.0' },
    scripts: { build: 'webpack --mode production  --env sviva=prod' },
  }, null, 2),

  'node_modules/react/package.json': '{ "name": "react", "version": "17.0.2" }',

  'webpack.config.js': [
    'const ModuleFederationPlugin = require("webpack/lib/container/ModuleFederationPlugin");',
    'const deps = require("./package.json").dependencies;',
    'module.exports = ({ sviva }) => {',
    '  const config = {',
    '    plugins: [',
    '      new ModuleFederationPlugin({',
    '        name: "MichsotSheten",',
    '        filename: "remoteEntry.js",',
    '        exposes: { "./MichsotSheten": "./src/App.jsx" },',
    '        shared: {',
    '          ...deps,',
    '          react: { singleton: true, requiredVersion: deps.react },',
    '          "react-dom": { singleton: true, requiredVersion: deps["react-dom"] },',
    '        },',
    '      }),',
    '    ],',
    '  };',
    '  return config;',
    '};',
  ].join('\n'),

  'src/bootstrap.js': [
    "import React from 'react';",
    "import ReactDOM from 'react-dom';",
    "import App from './App';",
    "// ReactDOM.hydrate(<App />, document.getElementById('root'));",
    "ReactDOM.render(<App />, document.getElementById('root'));",
  ].join('\n'),

  'src/App.jsx': [
    "import React, { useContext, useEffect } from 'react';",
    "import { BrowserRouter, Switch, Route } from 'react-router-dom';",
    "import { ShellContext } from '@ips/shell';",
    "import { LocalContext } from './LocalContext';",
    "import Home from './Home';",
    '',
    'export default function App({ children, header, Footer, title }) {',
    '  const shell = useContext(ShellContext);',
    '  const local = useContext(LocalContext);',
    '  useEffect(async () => { await shell.load(); }, []);',
    '  /*',
    '  useEffect(async () => {}, []);',
    '  const x = useContext(OtherContext);',
    '  */',
    '  return (',
    '    <BrowserRouter>',
    '      {header}',
    '      <Switch>',
    '        <Route exact path="/" component={Home} />',
    '        <Route path="/x" loader={() => null} element={<Home />} />',
    '        {/* <Redirect to="/" /> */}',
    '      </Switch>',
    '      {children}',
    '      <Footer title={title} />',
    '    </BrowserRouter>',
    '  );',
    '}',
  ].join('\n'),

  'src/LocalContext.js': "import React from 'react';\nexport const LocalContext = React.createContext();\n",

  'src/Home.jsx': [
    "import React, { useId } from 'react';",
    "import { useHistory } from 'react-router-dom';",
    "// import { useDeferredValue } from 'react';",
    'export default function Home() {',
    '  const id = useId();',
    '  const [pending, start] = React.useTransition();',
    '  const history = useHistory();',
    '  // const v = useDeferredValue(1);',
    '  return <div id={id} />;',
    '}',
  ].join('\n'),

  'src/components/SearchReport.jsx': [
    "import * as React from 'react';",
    "import TextField from '@mui/material/TextField';",
    "import Autocomplete from '@mui/material/Autocomplete';",
    "import { makeStyles } from '@material-ui/core'",
    '',
    'const useStyles = makeStyles({',
    "  paper: { direction: 'rtl', width: '160px', right: '0px', position: 'absolute' },",
    '  option: {',
    "    // borderBottom: '1px solid gray',",
    '  }',
    '});',
    '',
    'export const SearchReport = ({ data, placeholder, onChange }) => {',
    '  const classes = useStyles();',
    '  return (',
    '    <Autocomplete',
    '      freeSolo',
    '      options={data}',
    '      classes={{ paper: classes.paper, option: classes.option }}',
    '      renderInput={(params) => (',
    '        <div ref={params.InputProps.ref}>',
    '          <input {...params.inputProps} placeholder={placeholder}/>',
    '        </div>',
    '      )}',
    '    />',
    '  );',
    '}',
  ].join('\n'),

  'src/components/Themed.jsx': [
    "import { makeStyles } from '@material-ui/core/styles';",
    "import Button from '@material-ui/core/Button';",
    'const useStyles = makeStyles((theme) => ({',
    '  root: { padding: theme.spacing(2) },',
    "  title: { color: 'red' },",
    '}));',
    'export function Themed() {',
    '  const { root, title } = useStyles();',
    '  return <Button className={root}><span className={title}>x</span></Button>;',
    '}',
  ].join('\n'),

  'src/components/Dynamic.jsx': [
    "import { makeStyles, Paper } from '@material-ui/core';",
    'const useStyles = makeStyles({',
    '  box: { width: (props) => props.w },',
    '  plain: { margin: 0 },',
    '});',
    '// const useOld = makeStyles({ a: {} });',
    'export const Dynamic = (props) => {',
    '  const classes = useStyles(props);',
    '  return <Paper className={classes.box} />;',
    '};',
  ].join('\n'),

  'src/components/Dates.jsx': [
    "import { KeyboardDatePicker } from '@material-ui/pickers';",
    "import { DatePicker } from '@mui/x-date-pickers/DatePicker';",
    'export const Dates = () => <KeyboardDatePicker />;',
  ].join('\n'),

  'src/routes.js': [
    "import { createBrowserRouter } from 'react-router-dom';",
    'export const router = createBrowserRouter([]);',
  ].join('\n'),

  'src/Commented.jsx': [
    "// import { makeStyles } from '@material-ui/core';",
    '/* ReactDOM.render(<App/>, el);',
    '   useEffect(async () => {}, []); */',
    'export const x = 1;',
  ].join('\n'),

  // must be skipped
  'src/node_modules/junk.js': "import { makeStyles } from '@material-ui/core'; makeStyles({});",
  'src/build/out.js': "import ReactDOM from 'react-dom'; ReactDOM.render(1, 2);",
  'src/dist/out.js': "import ReactDOM from 'react-dom'; ReactDOM.render(1, 2);",
  'src/styles.css': 'body {}',
};

function makeRepo(overrides) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'));
  const files = Object.assign({}, FILES, overrides || {});
  Object.keys(files).forEach((rel) => {
    if (files[rel] === null) return;
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, files[rel]);
  });
  return root;
}

function lineIn(rel, needle) {
  const idx = FILES[rel].split('\n').findIndex((l) => l.indexOf(needle) !== -1);
  assert.ok(idx !== -1, 'needle not found: ' + needle);
  return idx + 1;
}

function listTree(root) {
  const out = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f); else out.push(path.relative(root, f).split(path.sep).join('/') + ':' + fs.statSync(f).mtimeMs);
  });
  walk(root);
  return out.sort();
}

let ROOT;
let RES;
test.before(() => {
  ROOT = makeRepo();
  RES = run(['--dry-run'], { cwd: ROOT });
});

const files = (list) => Array.from(new Set(list.map((x) => x.file))).sort();

// ---------------------------------------------------------------------------
// Inventory content

test('basic fields (fixture has deny-list packages → BLOCKED, inventory still complete)', () => {
  assert.strictEqual(RES.result, 'BLOCKED');
  const inv = RES.inventory;
  assert.deepStrictEqual(inv.service, { name: 'hasava-mfe', version: '0.1.1' });
  assert.strictEqual(inv.filesScanned, 10); // node_modules/build/dist and .css skipped
  assert.deepStrictEqual(inv.react, { range: '^17.0.2', installed: '17.0.2', target: '18.3.1' });
  assert.strictEqual(inv.deps.devDependencies.enzyme, '^3.11.0');
  assert.deepStrictEqual(inv.scripts, { build: 'webpack --mode production  --env sviva=prod' });
});

test('deny-list: only incompatible versions, copied to the top-level blockers[] → BLOCKED', () => {
  const b = RES.inventory.blockers;
  assert.deepStrictEqual(b.map((x) => x.package).sort(), ['enzyme', 'react-beautiful-dnd']);
  const dnd = b.find((x) => x.package === 'react-beautiful-dnd');
  assert.strictEqual(dnd.fixedIn, '13.1.1');
  assert.strictEqual(dnd.checkedVersion, '12.2.0');
  assert.deepStrictEqual(RES.blockers.map((x) => [x.package, x.range, x.suggestion]), [
    ['react-beautiful-dnd', '^12.2.0', 'שדרוג ל-13.1.1 או החלפה ב-@hello-pangea/dnd'],
    ['enzyme', '^3.11.0', 'החלפה ב-@testing-library/react'],
  ]);
  assert.match(RES.blockers[1].message, /^חבילה לא תואמת React 18: enzyme \^3\.11\.0 \(devDependencies\) – /);
  assert.strictEqual(RES.result, 'BLOCKED'); // also has react18Only – BLOCKED wins over REVIEW
});

test('muiFiles: @material-ui imports with names, commented imports ignored', () => {
  const mui = RES.inventory.muiFiles;
  assert.deepStrictEqual(files(mui), ['src/components/Dates.jsx', 'src/components/Dynamic.jsx', 'src/components/SearchReport.jsx', 'src/components/Themed.jsx']);
  const themed = mui.find((m) => m.file === 'src/components/Themed.jsx');
  assert.deepStrictEqual(themed.imports.map((i) => [i.module, i.names, i.default]), [
    ['@material-ui/core/styles', ['makeStyles'], null],
    ['@material-ui/core/Button', [], 'Button'],
  ]);
  assert.deepStrictEqual(mui.find((m) => m.file === 'src/components/Dynamic.jsx').imports[0].names, ['makeStyles', 'Paper']);
});

test('makeStyles: levels, keys, emptyKeys, commented call ignored', () => {
  const ms = RES.inventory.makeStyles;
  assert.strictEqual(ms.length, 3);
  const by = (f) => ms.find((m) => m.file === f);

  const sr = by('src/components/SearchReport.jsx');
  assert.strictEqual(sr.level, 'static');
  assert.strictEqual(sr.line, lineIn('src/components/SearchReport.jsx', 'makeStyles({'));
  assert.deepStrictEqual(sr.keys, ['paper', 'option']);
  assert.deepStrictEqual(sr.emptyKeys, ['option']);

  const th = by('src/components/Themed.jsx');
  assert.strictEqual(th.level, 'theme');
  assert.deepStrictEqual(th.keys, ['root', 'title']);
  assert.deepStrictEqual(th.emptyKeys, []);

  const dy = by('src/components/Dynamic.jsx');
  assert.strictEqual(dy.level, 'props');
  assert.deepStrictEqual(dy.propsKeys, ['box']);
});

test('makeStyles components: slot vs className consumers', () => {
  const ms = RES.inventory.makeStyles;
  const sr = ms.find((m) => m.file === 'src/components/SearchReport.jsx');
  assert.deepStrictEqual(sr.components.map((c) => [c.key, c.component, c.attribute, c.slot]), [
    ['paper', 'Autocomplete', 'classes', 'paper'],
    ['option', 'Autocomplete', 'classes', 'option'],
  ]);
  const th = ms.find((m) => m.file === 'src/components/Themed.jsx');
  assert.deepStrictEqual(th.components.map((c) => [c.key, c.component, c.attribute]), [
    ['root', 'Button', 'className'],
    ['title', 'span', 'className'],
  ]);
  const dy = ms.find((m) => m.file === 'src/components/Dynamic.jsx');
  assert.deepStrictEqual(dy.components.map((c) => [c.key, c.component]), [['box', 'Paper']]);
});

test('jssApis: withStyles / createStyles / StylesProvider with file, line, module; commented ignored', () => {
  assert.deepStrictEqual(RES.inventory.jssApis, []);
  const root = makeRepo({
    'src/components/Legacy.jsx': [
      "import { withStyles, createStyles, makeStyles, StylesProvider } from '@material-ui/core/styles';",
      "import * as Styles from '@mui/styles';",
      "import Button from '@material-ui/core/Button';",
      '// const W = withStyles({ root: {} })(Button);',
      'const useStyles = makeStyles(() => createStyles({ root: { margin: 0 } }));',
      'const Styled = withStyles({ root: { padding: 0 } })(Button);',
      'const Other = Styles.withStyles({})(Button);',
      'export const L = () => <StylesProvider injectFirst><Styled /><Other /></StylesProvider>;',
    ].join('\n'),
    'src/components/Unused.jsx': "import { createStyles } from '@material-ui/core';\nexport const u = 1;\n",
  });
  const res = run(['--dry-run'], { cwd: root });
  const core = '@material-ui/core/styles';
  assert.deepStrictEqual(res.inventory.jssApis.map((u) => [u.file.replace('src/components/', ''), u.line, u.api, u.kind, u.module, u.insideMakeStyles]), [
    ['Legacy.jsx', 5, 'createStyles', 'call', core, true],
    ['Legacy.jsx', 6, 'withStyles', 'call', core, false],
    ['Legacy.jsx', 7, 'withStyles', 'call', '@mui/styles', false],
    ['Legacy.jsx', 8, 'StylesProvider', 'jsx', core, false],
    ['Unused.jsx', 1, 'createStyles', 'import', '@material-ui/core', false],
  ]);
  // only @material-ui imports outside makeStyles break the build
  assert.match(formatText(res), /🧱 JSS ללא המרה: withStyles ×1, StylesProvider ×1, createStyles ×1 ב-2 קבצים \(\+2 /);
});

test('routerImports: every react-router(-dom) import with file and line', () => {
  assert.deepStrictEqual(RES.inventory.routerImports.map((r) => [r.file, r.line, r.module, r.names]), [
    ['src/App.jsx', 2, 'react-router-dom', ['BrowserRouter', 'Switch', 'Route']],
    ['src/Home.jsx', 2, 'react-router-dom', ['useHistory']],
    ['src/routes.js', 1, 'react-router-dom', ['createBrowserRouter']],
  ]);
});

test('asyncEffects: only the live one', () => {
  assert.deepStrictEqual(RES.inventory.asyncEffects, [
    { file: 'src/App.jsx', line: lineIn('src/App.jsx', 'useEffect(async () => { await'), hook: 'useEffect' },
  ]);
});

test('reactDomApi: render only, commented hydrate and build/dist ignored', () => {
  assert.deepStrictEqual(RES.inventory.reactDomApi, [
    { file: 'src/bootstrap.js', api: 'render', line: lineIn('src/bootstrap.js', 'ReactDOM.render'), kind: 'call' },
  ]);
});

test('react18Only: useId + React.useTransition, commented useDeferredValue ignored; each is a warning', () => {
  const r = RES.inventory.react18Only;
  assert.deepStrictEqual(r.map((x) => [x.api, x.line]), [
    ['useId', lineIn('src/Home.jsx', 'useId()')],
    ['useTransition', lineIn('src/Home.jsx', 'React.useTransition')],
  ]);
  const w = RES.inventory.warnings.filter((x) => x.kind === 'react18Only');
  assert.strictEqual(w.length, 2);
  assert.ok(RES.manual.some((m) => m.file === 'src/Home.jsx' && /React 17/.test(m.reason)));
});

test('router: version, v5 usages, post-6.0.2 APIs', () => {
  const inv = RES.inventory;
  assert.deepStrictEqual(inv.routerVersion, { range: '^6.0.2', installed: null, target: '6.30.1' });
  const legacy = inv.routerUsages.map((u) => u.file + ' ' + u.api);
  assert.deepStrictEqual(legacy.sort(), [
    'src/App.jsx Route[component]',
    'src/App.jsx Route[exact]',
    'src/App.jsx Switch',
    'src/Home.jsx useHistory',
  ]);
  const post = inv.routerPost602.map((u) => u.file + ' ' + u.api);
  assert.deepStrictEqual(post.sort(), ['src/App.jsx Route[loader]', 'src/routes.js createBrowserRouter']);
  assert.strictEqual(inv.warnings.filter((w) => w.kind === 'routerPost602').length, 2);
});

test('federation: function config, remote role, shared structure', () => {
  const f = RES.inventory.federation;
  assert.strictEqual(f.configShape, 'function');
  assert.strictEqual(f.role, 'remote');
  assert.strictEqual(f.name, 'MichsotSheten');
  assert.deepStrictEqual(f.exposes, { './MichsotSheten': './src/App.jsx' });
  assert.deepStrictEqual(f.remotes, {});
  assert.deepStrictEqual(f.shared.spreads, ['deps']);
  assert.deepStrictEqual(f.shared.keys, ['react', 'react-dom']);
  assert.deepStrictEqual(f.shared.entries.react, { singleton: true, requiredVersion: { expression: 'deps.react' } });
});

test('pickers: both libraries', () => {
  assert.deepStrictEqual(RES.inventory.pickers.map((p) => [p.module, p.names]), [
    ['@material-ui/pickers', ['KeyboardDatePicker']],
    ['@mui/x-date-pickers/DatePicker', ['DatePicker']],
  ]);
});

test('contextCrossing: external useContext + children/element/component props on exposed App', () => {
  const cc = RES.inventory.contextCrossing;
  const ctx = cc.filter((c) => c.kind === 'useContext');
  assert.deepStrictEqual(ctx.map((c) => [c.context, c.module]), [['ShellContext', '@ips/shell']]);
  const props = cc.filter((c) => c.kind === 'exposedProp');
  assert.deepStrictEqual(props.map((p) => [p.prop, p.propKind]).sort(), [
    ['Footer', 'component'], ['children', 'children'], ['header', 'element'],
  ]);
  assert.ok(props.every((p) => p.exposedAs === './MichsotSheten' && p.component === 'App'));
});

// ---------------------------------------------------------------------------
// Federation variants

function fed(webpack) {
  const root = makeRepo({ 'webpack.config.js': webpack });
  return run(['--dry-run'], { cwd: root }).inventory.federation;
}

test('federation: object config with remotes only → host', () => {
  const f = fed('const MFP = require("webpack").container.ModuleFederationPlugin;\nmodule.exports = { plugins: [new MFP({ remotes: { shell: "shell@x/remoteEntry.js" } })] };');
  assert.strictEqual(f.configShape, 'object');
  assert.strictEqual(f.role, 'host');
});

test('federation: exposes + remotes → hybrid; options via variable', () => {
  const f = fed('const { ModuleFederationPlugin } = require("webpack").container;\nconst opts = { exposes: { "./A": "./src/App.jsx" }, remotes: { b: "b@x" } };\nconst config = { plugins: [new ModuleFederationPlugin(opts)] };\nmodule.exports = config;');
  assert.strictEqual(f.configShape, 'object');
  assert.strictEqual(f.role, 'hybrid');
});

test('federation: buildSharedGen1 call', () => {
  const f = fed('const pkg = require("./package.json");\nconst { buildSharedGen1 } = require("@ips/mfe-shared-deps");\nmodule.exports = () => ({ plugins: [new ModuleFederationPlugin({ exposes: { "./A": "./src/App.jsx" }, shared: buildSharedGen1({ pkg, require, role: "remote" }) })] });');
  assert.strictEqual(f.shared.kind, 'call');
  assert.strictEqual(f.shared.buildSharedGen1, true);
  assert.strictEqual(f.shared.arguments[0].role, 'remote');
});

test('federation: no plugin → standalone; no config → standalone', () => {
  assert.strictEqual(fed('module.exports = { mode: "production" };').role, 'standalone');
  const root = makeRepo({ 'webpack.config.js': null });
  const f = run(['--dry-run'], { cwd: root }).inventory.federation;
  assert.strictEqual(f.configFile, null);
  assert.strictEqual(f.role, 'standalone');
});

// ---------------------------------------------------------------------------
// Output / CLI contract

test('writes only the output file; second run leaves it untouched', () => {
  const root = makeRepo();
  const before = listTree(root);
  const r1 = run([], { cwd: root });
  assert.strictEqual(r1.result, 'BLOCKED'); // deny-list – the inventory is written anyway
  assert.deepStrictEqual(r1.changes, [{ file: '.migration/inventory.json', rule: 'SCAN.INVENTORY', confidence: 'auto' }]);
  const after = listTree(root);
  const added = after.filter((x) => before.indexOf(x) === -1);
  assert.strictEqual(added.length, 1);
  assert.match(added[0], /^\.migration\/inventory\.json:/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, '.migration/inventory.json'), 'utf8')), r1.inventory);

  const r2 = run([], { cwd: root });
  assert.strictEqual(r2.result, 'BLOCKED');
  assert.deepStrictEqual(r2.changes, []);
  assert.deepStrictEqual(listTree(root), after);
});

test('--dry-run writes nothing', () => {
  const root = makeRepo();
  const before = listTree(root);
  const r = run(['--dry-run'], { cwd: root });
  assert.strictEqual(r.changes.length, 1);
  assert.deepStrictEqual(listTree(root), before);
});

test('--out custom path', () => {
  const root = makeRepo();
  run(['--out', 'tmp/inv.json'], { cwd: root });
  assert.ok(fs.existsSync(path.join(root, 'tmp/inv.json')));
  assert.ok(!fs.existsSync(path.join(root, '.migration')));
});

test('text output: Hebrew summary, RESULT last', () => {
  let out = '';
  const code = main(['--dry-run'], { cwd: ROOT }, { stdout: (s) => { out += s; }, stderr: () => {} });
  assert.strictEqual(code, 0);
  assert.match(out, /📦 hasava-mfe/);
  assert.match(out, /React 17\.0\.2 → 18\.3\.1/);
  assert.match(out, /10 קבצים נסרקו/);
  assert.match(out, /3 קבצים עם @material-ui\/core/);
  assert.match(out, /3 מופעי makeStyles: 1 static \| 1 theme \| 1 props/);
  // a deny-list BLOCKED still prints the full inventory summary, not "scan failed"
  assert.doesNotMatch(out, /הסריקה נכשלה/);
  assert.match(out, /⛔ 2 חבילות לא תואמות React 18:/);
  assert.match(out, /⛔ 2 חסמים – /);
  assert.strictEqual(out.trimEnd().split('\n').pop(), 'RESULT: BLOCKED');
});

// ---------------------------------------------------------------------------
// RESULT: BLOCKED (deny-list) > REVIEW (react18Only / routerPost602 / uncertain) > OK

function mini(pkg, src) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-result-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(Object.assign({ name: 'mini' }, pkg)));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'App.jsx'), src || "import React from 'react';\nexport default () => <div />;\n");
  return run(['--dry-run'], { cwd: root });
}
const REACT17 = { dependencies: { react: '^17.0.2' } };

test('result: clean repo → OK, no blockers, no manual', () => {
  const res = mini(REACT17);
  assert.strictEqual(res.result, 'OK');
  assert.deepStrictEqual(res.blockers, []);
  assert.deepStrictEqual(res.manual, []);
});

test('result: deny-list package only → BLOCKED', () => {
  const res = mini({ dependencies: { react: '^17.0.2', 'react-hot-loader': '^4.13.0' } });
  assert.strictEqual(res.result, 'BLOCKED');
  assert.deepStrictEqual(res.blockers.map((b) => b.package), ['react-hot-loader']);
});

test('result: compatible version of a deny-list package → OK', () => {
  assert.strictEqual(mini({ dependencies: { react: '^17.0.2', 'react-beautiful-dnd': '^13.1.1' } }).result, 'OK');
});

test('result: react18Only only → REVIEW, not BLOCKED', () => {
  const res = mini(REACT17, "import { useId } from 'react';\nexport default () => <div id={useId()} />;\n");
  assert.strictEqual(res.result, 'REVIEW');
  assert.deepStrictEqual(res.blockers, []);
  assert.deepStrictEqual(res.manual.map((m) => [m.file, m.line]), [['src/App.jsx', 2]]); // the useId() call, not the import
});

test('result: routerPost602 only → REVIEW', () => {
  const res = mini({ dependencies: { react: '^17.0.2', 'react-router-dom': '^6.0.2' } },
    "import { useOutletContext } from 'react-router-dom';\nexport default () => useOutletContext();\n");
  assert.strictEqual(res.result, 'REVIEW');
  assert.deepStrictEqual(res.blockers, []);
});

test('result: deny-list match with unknown version (not installed, "latest") → REVIEW + manual, not BLOCKED', () => {
  const res = mini({ dependencies: { react: '^17.0.2', 'react-beautiful-dnd': 'latest' } });
  assert.strictEqual(res.result, 'REVIEW');
  assert.deepStrictEqual(res.blockers, []);
  assert.strictEqual(res.manual.length, 1);
  assert.strictEqual(res.manual[0].file, 'package.json');
  assert.match(res.manual[0].reason, /react-beautiful-dnd latest.*הגרסה לא ודאית/);
});

test('result: deny-list + react18Only → BLOCKED wins', () => {
  const res = mini({ dependencies: { react: '^17.0.2', enzyme: '^3.11.0' } }, "import { useId } from 'react';\nexport default () => <div id={useId()} />;\n");
  assert.strictEqual(res.result, 'BLOCKED');
  assert.strictEqual(res.manual.length, 1); // the react18Only warning is still reported
});

test('--json output follows the contract', () => {
  let out = '';
  main(['--json', '--dry-run'], { cwd: ROOT }, { stdout: (s) => { out += s; }, stderr: () => {} });
  const res = JSON.parse(out);
  assert.deepStrictEqual(Object.keys(res).slice(0, 6), ['script', 'result', 'changes', 'manual', 'blockers', 'notes']);
  assert.strictEqual(res.script, 'scan');
  assert.ok(res.inventory.makeStyles);
});

// ---------------------------------------------------------------------------
// Read failures → BLOCKED, exit 0

function blocked(root, deps) {
  let out = '';
  const code = main([], Object.assign({ cwd: root }, deps || {}), { stdout: (s) => { out += s; }, stderr: () => {} });
  assert.strictEqual(code, 0);
  assert.strictEqual(out.trimEnd().split('\n').pop(), 'RESULT: BLOCKED');
  return out;
}

test('missing package.json → BLOCKED', () => {
  assert.match(blocked(makeRepo({ 'package.json': null })), /package\.json/);
});

test('invalid package.json → BLOCKED', () => {
  assert.match(blocked(makeRepo({ 'package.json': '{ nope' })), /JSON/);
});

test('missing src/ → BLOCKED', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"x"}');
  assert.match(blocked(root), /src/);
});

test('unreadable source file → BLOCKED', () => {
  const root = makeRepo();
  const fsWrap = Object.assign({}, fs, {
    readFileSync: (p, enc) => {
      if (String(p).endsWith('Home.jsx')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return fs.readFileSync(p, enc);
    },
  });
  assert.match(blocked(root, { fs: fsWrap }), /Home\.jsx/);
});

test('unknown argument → BLOCKED', () => {
  let out = '';
  main(['--bogus'], { cwd: ROOT }, { stdout: (s) => { out += s; }, stderr: () => {} });
  assert.match(out, /RESULT: BLOCKED/);
});

test('minVersion', () => {
  assert.strictEqual(minVersion('^12.2.0'), '12.2.0');
  assert.strictEqual(minVersion('~3'), '3.0.0');
  assert.strictEqual(minVersion('latest'), null);
  assert.strictEqual(minVersion('git+https://x/y.git'), null);
});
