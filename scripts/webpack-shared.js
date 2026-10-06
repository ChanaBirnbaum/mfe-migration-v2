#!/usr/bin/env node
'use strict';

// webpack-shared: ModuleFederationPlugin `shared` → buildSharedGen1({ pkg, require, role }).
// Works on the standard dynamic config `module.exports = ({ sviva }) => {...}` as well as plain objects.
// ts-morph only; position-based edits keep the rest of the file byte-for-byte identical.

const path = require('path');

const SCRIPT = 'webpack-shared';
const CONFIG = 'webpack.config.js';
const SHARED_PKG = '@ips/mfe-shared-deps';
const VALID_ROLES = ['host', 'remote', 'standalone'];
const MARKER = '// MIGRATION-V2: previous shared config';
const VALIDATE_TIMEOUT_MS = 60000;
const VALIDATE_ENV = 'dev'; // npm run build:dev → --env sviva=dev

function parseArgs(argv) {
  const opts = { dryRun: false, json: false, errors: [] };
  argv.forEach((a) => {
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else opts.errors.push('פרמטר לא מוכר: ' + a);
  });
  return opts;
}

function applyEdits(text, edits) {
  const sorted = edits.slice().sort((a, b) => b.start - a.start || b.end - a.end);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].end > sorted[i - 1].start) throw new Error('overlapping edits at ' + sorted[i].start);
  }
  return sorted.reduce((t, e) => t.slice(0, e.start) + e.text + t.slice(e.end), text);
}

function lineIndent(text, pos) {
  const ls = text.lastIndexOf('\n', pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(ls))[0];
}

function pasteCode(role, q) {
  return [
    'const pkg = require(' + q + './package.json' + q + ');',
    'const { buildSharedGen1 } = require(' + q + SHARED_PKG + q + ');',
    '',
    '// בתוך new ModuleFederationPlugin({ ... }):',
    "shared: buildSharedGen1({ pkg, require, role: '" + role + "' }),",
  ].join('\n');
}

// ---------------------------------------------------------------------------

function analyse(tsm, text) {
  const { Node, SyntaxKind: K } = tsm;
  const project = new tsm.Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
  const sf = project.createSourceFile('/' + CONFIG, text);
  const eol = text.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  const unwrap = (n) => { while (n && Node.isParenthesizedExpression(n)) n = n.getExpression(); return n; };
  const propName = (p) => {
    const n = p.getNameNode && p.getNameNode();
    if (!n) return null;
    if (Node.isIdentifier(n)) return n.getText();
    if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) return n.getLiteralText();
    return null;
  };
  const resolveInit = (n) => {
    n = unwrap(n);
    if (n && Node.isIdentifier(n)) {
      const v = sf.getVariableDeclaration(n.getText());
      if (v && v.getInitializer()) return unwrap(v.getInitializer());
    }
    return n;
  };
  const r = { sf: sf, eol: eol, edits: [], notes: [], quote: '"' };

  const firstRequire = sf.getDescendantsOfKind(K.CallExpression).find((c) => c.getExpression().getText() === 'require' && Node.isStringLiteral(c.getArguments()[0]));
  if (firstRequire) r.quote = firstRequire.getArguments()[0].getText().charAt(0);

  // already migrated?
  r.alreadyMigrated = sf.getDescendantsOfKind(K.CallExpression).some((c) => Node.isIdentifier(c.getExpression()) && c.getExpression().getText() === 'buildSharedGen1');

  // module.exports shape
  r.esm = sf.getImportDeclarations().length > 0 || sf.getExportAssignments().length > 0;
  let exported = null;
  sf.getStatements().forEach((st) => {
    if (!Node.isExpressionStatement(st)) return;
    const e = st.getExpression();
    if (Node.isBinaryExpression(e) && e.getOperatorToken().getKind() === K.EqualsToken && e.getLeft().getText() === 'module.exports') exported = e.getRight();
  });
  let shape = exported ? resolveInit(exported) : null;
  if (exported && Node.isIdentifier(unwrap(exported)) && sf.getFunction(unwrap(exported).getText())) shape = sf.getFunction(unwrap(exported).getText());
  if (!shape) r.shape = 'none';
  else if (Node.isArrowFunction(shape) || Node.isFunctionExpression(shape) || Node.isFunctionDeclaration(shape)) r.shape = 'function';
  else if (Node.isObjectLiteralExpression(shape)) r.shape = 'object';
  else r.shape = 'unknown';
  r.exportedText = exported ? exported.getText() : null;

  // ModuleFederationPlugin (aliases included)
  const MFP_RE = /(^|[.\/])ModuleFederationPlugin\b/;
  const aliases = new Set(['ModuleFederationPlugin']);
  sf.getDescendantsOfKind(K.VariableDeclaration).forEach((v) => {
    if (Node.isIdentifier(v.getNameNode()) && v.getInitializer() && MFP_RE.test(v.getInitializer().getText())) aliases.add(v.getName());
  });
  sf.getDescendantsOfKind(K.BindingElement).forEach((el) => {
    const p = el.getPropertyNameNode();
    if ((p ? p.getText() : el.getName()) === 'ModuleFederationPlugin') aliases.add(el.getName());
  });
  r.plugins = sf.getDescendantsOfKind(K.NewExpression).filter((n) => {
    const t = n.getExpression().getText();
    return aliases.has(t) || /(^|\.)ModuleFederationPlugin$/.test(t);
  });

  if (r.plugins.length === 1) {
    const opts = resolveInit(r.plugins[0].getArguments()[0]);
    r.options = opts && Node.isObjectLiteralExpression(opts) ? opts : null;
    if (r.options) {
      const get = (k) => r.options.getProperties().find((p) => !Node.isSpreadAssignment(p) && propName(p) === k) || null;
      const present = (p) => {
        if (!p) return false;
        const v = Node.isPropertyAssignment(p) ? resolveInit(p.getInitializer()) : null;
        return !(v && Node.isObjectLiteralExpression(v) && v.getProperties().length === 0);
      };
      r.hasExposes = present(get('exposes'));
      r.hasRemotes = present(get('remotes'));
      r.sharedProp = get('shared');
    }
  }

  // publicPath per environment output
  sf.getDescendantsOfKind(K.PropertyAssignment).filter((p) => propName(p) === 'output').forEach((p) => {
    const v = unwrap(p.getInitializer());
    if (!Node.isObjectLiteralExpression(v)) return;
    if (v.getProperties().some((x) => propName(x) === 'publicPath')) return;
    const owner = p.getParent().getParent();
    const env = owner && Node.isPropertyAssignment(owner) ? propName(owner) : null;
    r.notes.push('ל-output' + (env ? ' של ' + env : '') + ' (שורה ' + p.getStartLineNumber() + ") אין publicPath – מומלץ publicPath: 'auto' ב-remote");
  });

  // const deps = require("./package.json").dependencies
  r.depsDecl = sf.getVariableStatements().map((vs) => vs.getDeclarations()).reduce((a, b) => a.concat(b), []).find((d) => {
    const init = unwrap(d.getInitializer());
    if (!init || !Node.isPropertyAccessExpression(init) || init.getName() !== 'dependencies') return false;
    const call = unwrap(init.getExpression());
    const arg = Node.isCallExpression(call) && call.getArguments()[0];
    return Node.isCallExpression(call) && call.getExpression().getText() === 'require' && arg && Node.isStringLiteral(arg) &&
      /^\.\/package(\.json)?$/.test(arg.getLiteralText()) && Node.isIdentifier(d.getNameNode());
  }) || null;

  // existing pkg = require('./package.json') to reuse
  r.pkgName = null;
  r.pkgTaken = false;
  sf.getVariableStatements().forEach((vs) => vs.getDeclarations().forEach((d) => {
    if (!Node.isIdentifier(d.getNameNode())) return;
    const init = unwrap(d.getInitializer());
    const isPkgRequire = init && Node.isCallExpression(init) && init.getExpression().getText() === 'require' &&
      Node.isStringLiteral(init.getArguments()[0]) && /^\.\/package(\.json)?$/.test(init.getArguments()[0].getLiteralText());
    if (isPkgRequire && !r.pkgName) r.pkgName = d.getName();
    else if (d.getName() === 'pkg') r.pkgTaken = true;
  }));
  r.hasBuildImport = sf.getDescendantsOfKind(K.Identifier).some((i) => i.getText() === 'buildSharedGen1' && Node.isBindingElement(i.getParent()));
  r.propName = propName;
  r.unwrap = unwrap;
  return r;
}

function run(argv, overrides) {
  const deps = Object.assign({
    fs: require('fs'), cwd: process.cwd(), execFileSync: require('child_process').execFileSync,
  }, overrides || {});
  const opts = parseArgs(argv || []);
  const res = { script: SCRIPT, result: 'OK', changes: [], manual: [], blockers: [], notes: [], dryRun: opts.dryRun, role: null, validation: null };
  const blocked = (m) => { res.result = 'BLOCKED'; res.blockers.push({ message: m }); return res; };
  const review = (reason, code) => { res.result = 'REVIEW'; res.manual.push({ file: CONFIG, line: null, reason: reason, code: code || undefined }); return res; };
  if (opts.errors.length) return blocked(opts.errors.join('; '));

  let tsm;
  try { tsm = require('ts-morph'); } catch (_) {
    return blocked('ts-morph אינו מותקן בתיקיית הסקיל – הרץ npm install ב-' + path.join(__dirname, '..'));
  }
  const full = path.join(deps.cwd, CONFIG);
  let raw;
  try { raw = deps.fs.readFileSync(full, 'utf8'); } catch (err) { return blocked(CONFIG + ' לא נמצא / לא קריא: ' + err.message); }
  const bom = raw.charCodeAt(0) === 0xfeff ? '﻿' : '';
  const text = bom ? raw.slice(1) : raw;
  const { Node, SyntaxKind: K } = tsm;
  const a = analyse(tsm, text);
  res.notes.push.apply(res.notes, a.notes);

  if (a.alreadyMigrated) {
    res.result = 'NOOP';
    res.notes.unshift('buildSharedGen1 כבר קיים ב-' + CONFIG);
    return res;
  }

  // role
  if (a.plugins.length === 0) {
    res.role = 'standalone';
    res.result = 'NOOP';
    res.notes.unshift('אין ModuleFederationPlugin – שירות standalone, אין shared להחליף');
    return res;
  }
  if (a.plugins.length > 1) return review('נמצאו ' + a.plugins.length + ' מופעי ModuleFederationPlugin – יש להחליט ידנית', pasteCode('remote', a.quote));
  if (a.shape !== 'function' && a.shape !== 'object') {
    return review('module.exports אינו פונקציה ואינו אובייקט מזוהה (' + (a.exportedText ? a.exportedText.split('\n')[0] : 'לא נמצא') + ') – הדבק ידנית את הקוד', pasteCode('remote', a.quote));
  }
  if (a.esm) return review(CONFIG + ' כתוב ב-ESM (import/export) – require לא זמין; יש להמיר ידנית', pasteCode('remote', a.quote));
  if (!a.options) return review('האפשרויות של ModuleFederationPlugin אינן אובייקט ליטרלי – הדבק ידנית', pasteCode('remote', a.quote));
  if (a.hasExposes && a.hasRemotes) {
    res.role = 'hybrid';
    return review("שירות היברידי (exposes וגם remotes) – יש לבחור role: 'host' או 'remote'. buildSharedGen1 מקבלת רק " + VALID_ROLES.join(' | '), pasteCode('remote', a.quote));
  }
  if (!a.hasExposes && !a.hasRemotes) return review('ל-ModuleFederationPlugin אין exposes ואין remotes – לא ניתן לקבוע role', pasteCode('remote', a.quote));
  const role = a.hasExposes ? 'remote' : 'host';
  if (VALID_ROLES.indexOf(role) === -1) throw new Error('invalid role ' + role); // FederationConfigError guard
  res.role = role;

  // ---- edits ----
  const edits = [];
  const eol = a.eol;
  const q = a.quote;
  const options = a.options;
  const sharedRange = a.sharedProp ? [a.sharedProp.getStart(), a.sharedProp.getEnd()] : null;
  const inShared = (n) => sharedRange && n.getStart() >= sharedRange[0] && n.getEnd() <= sharedRange[1];

  // 1. pkg / buildSharedGen1 requires
  let pkgName = a.pkgName;
  const newLines = [];
  if (!pkgName) {
    pkgName = a.pkgTaken ? 'packageJson' : 'pkg';
    newLines.push('const ' + pkgName + ' = require(' + q + './package.json' + q + ');');
  }
  if (!a.hasBuildImport) newLines.push('const { buildSharedGen1 } = require(' + q + SHARED_PKG + q + ');');
  if (a.depsDecl) {
    const depsName = a.depsDecl.getName();
    const stmt = a.depsDecl.getVariableStatement();
    const usedElsewhere = a.sf.getDescendantsOfKind(K.Identifier).some((id) => id.getText() === depsName && id !== a.depsDecl.getNameNode() && !inShared(id) &&
      !(Node.isPropertyAccessExpression(id.getParent()) && id.getParent().getNameNode() === id) &&
      !(Node.isPropertyAssignment(id.getParent()) && id.getParent().getNameNode() === id));
    const indent = lineIndent(text, stmt.getStart());
    if (stmt.getDeclarations().length !== 1) {
      edits.push({ start: stmt.getEnd(), end: stmt.getEnd(), text: newLines.map((l) => eol + indent + l).join('') });
    } else if (usedElsewhere) {
      edits.push({ start: stmt.getEnd(), end: stmt.getEnd(), text: newLines.map((l) => eol + indent + l).join('') });
      res.notes.push(depsName + ' בשימוש במקום נוסף ב-' + CONFIG + ' – נשאר, ו-' + pkgName + ' נוסף לצידו');
    } else {
      edits.push({ start: stmt.getStart(), end: stmt.getEnd(), text: newLines.join(eol + indent) });
    }
    res.changes.push({ file: CONFIG, line: stmt.getStartLineNumber(), rule: 'WEBPACK.REQUIRE', confidence: 'auto', detail: newLines.join(' ') });
  } else if (newLines.length) {
    // after the last top-level require statement, or at the top
    const reqStmts = a.sf.getStatements().filter((s) => Node.isVariableStatement(s) && s.getDeclarations().some((d) => {
      const init = a.unwrap(d.getInitializer());
      return init && init.getDescendantsOfKind(K.CallExpression).concat(Node.isCallExpression(init) ? [init] : []).some((c) => c.getExpression().getText() === 'require');
    }));
    const anchor = reqStmts[reqStmts.length - 1];
    if (anchor) edits.push({ start: anchor.getEnd(), end: anchor.getEnd(), text: newLines.map((l) => eol + l).join('') });
    else edits.push({ start: 0, end: 0, text: newLines.join(eol) + eol });
    res.changes.push({ file: CONFIG, line: anchor ? anchor.getStartLineNumber() : 1, rule: 'WEBPACK.REQUIRE', confidence: 'auto', detail: newLines.join(' ') });
  }

  // 3. shared
  const call = 'buildSharedGen1({ ' + (pkgName === 'pkg' ? 'pkg' : 'pkg: ' + pkgName) + ", require, role: '" + role + "' })";
  if (a.sharedProp) {
    const p = a.sharedProp;
    const indent = lineIndent(text, p.getStart());
    const hasComma = /^\s*,/.test(text.slice(p.getEnd()));
    const lines = p.getText().split(/\r?\n/);
    const commented = lines.map((l, i) => {
      if (i === 0) return indent + '// ' + l;
      return l.startsWith(indent) ? indent + '// ' + l.slice(indent.length) : indent + '// ' + l.trim();
    });
    if (hasComma) commented[commented.length - 1] += ',';
    const replacement = MARKER + eol + commented.map((l) => l).join(eol) + eol + indent + 'shared: ' + call;
    edits.push({ start: p.getStart(), end: p.getEnd(), text: replacement });
    res.changes.push({ file: CONFIG, line: p.getStartLineNumber(), rule: 'WEBPACK.SHARED', confidence: 'auto', detail: 'shared → ' + call + ' (הקודם נשמר בהערה)' });
  } else {
    const props = options.getProperties();
    const last = props[props.length - 1];
    const indent = lineIndent(text, last.getStart());
    const multiline = last.getStartLineNumber() !== options.getStartLineNumber();
    edits.push({ start: last.getEnd(), end: last.getEnd(), text: ',' + (multiline ? eol + indent : ' ') + 'shared: ' + call });
    res.changes.push({ file: CONFIG, line: last.getStartLineNumber(), rule: 'WEBPACK.SHARED', confidence: 'auto', detail: 'shared: ' + call + ' נוסף' });
  }

  const out = applyEdits(text, edits);
  // sanity: still parses
  const check = new tsm.Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } }).createSourceFile('/check.js', out);
  const diags = check.compilerNode.parseDiagnostics || [];
  if (diags.length) {
    res.changes = [];
    return review('ההמרה יצרה קוד לא תקין – הקובץ לא שונה. הדבק ידנית', pasteCode(role, q));
  }

  if (opts.dryRun) {
    res.validation = { ran: false, reason: 'dry-run' };
    return res;
  }
  try { deps.fs.writeFileSync(full, bom + out, 'utf8'); } catch (err) { return blocked('לא ניתן לכתוב את ' + CONFIG + ': ' + err.message); }

  // ---- validation ----
  const nm = path.join(deps.cwd, 'node_modules');
  if (!deps.fs.existsSync(nm)) {
    res.validation = { ran: false, reason: 'node_modules חסר' };
    res.notes.push('node_modules חסר – הוולידציה דולגה. הרץ npm i ואז: node -e "require(\'./' + CONFIG + '\')"');
    return res;
  }
  if (!deps.fs.existsSync(path.join(nm, SHARED_PKG))) {
    res.validation = { ran: false, reason: SHARED_PKG + ' לא מותקן' };
    res.notes.push(SHARED_PKG + ' עדיין לא מותקן ב-node_modules – הוולידציה דולגה. הרץ npm i ואז את הסקריפט שוב או את הוולידציה ידנית');
    return res;
  }
  // require() alone does not run ({ sviva }) => {...}; calling it is what reaches buildSharedGen1
  const script = "const c = require('./" + CONFIG + "'); if (typeof c === 'function') c({ sviva: '" + VALIDATE_ENV + "' }, { mode: 'production' });";
  try {
    deps.execFileSync(process.execPath, ['-e', script], {
      cwd: deps.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: VALIDATE_TIMEOUT_MS, windowsHide: true,
    });
    res.validation = { ran: true, ok: true, env: VALIDATE_ENV };
  } catch (err) {
    const msg = String(err.stderr || err.message || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 4).join(' | ');
    try { deps.fs.writeFileSync(full, raw, 'utf8'); } catch (_) { /* reported below */ }
    res.validation = { ran: true, ok: false, env: VALIDATE_ENV, error: msg };
    res.changes = [];
    return review('הוולידציה נכשלה (' + msg + ') – ' + CONFIG + ' הוחזר למצבו המקורי', pasteCode(role, q));
  }
  return res;
}

function formatText(res) {
  const L = [SCRIPT + (res.dryRun ? ' [dry-run]' : '')];
  if (res.result === 'BLOCKED') res.blockers.forEach((b) => L.push('⛔ ' + b.message));
  else {
    if (res.role) L.push('🔗 role: ' + res.role);
    res.changes.forEach((c) => L.push('✏️ ' + CONFIG + ':' + c.line + ' – ' + c.detail));
    if (res.validation) L.push(res.validation.ran ? (res.validation.ok ? '✓ ולידציה עברה (sviva=' + res.validation.env + ')' : '⛔ ולידציה נכשלה: ' + res.validation.error) : '⚠ ולידציה דולגה: ' + res.validation.reason);
    res.manual.forEach((m) => {
      L.push('✋ ' + m.reason);
      if (m.code) { L.push('   קוד להדבקה:'); m.code.split('\n').forEach((l) => L.push('   | ' + l)); }
    });
    res.notes.forEach((n) => L.push('ℹ ' + n));
  }
  L.push('RESULT: ' + res.result);
  return L.join('\n') + '\n';
}

function main(argv, deps, io) {
  io = io || { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) };
  try {
    const opts = parseArgs(argv || []);
    const res = run(argv, deps);
    io.stdout(opts.json ? JSON.stringify(res, null, 2) + '\n' : formatText(res));
    return 0;
  } catch (err) {
    io.stderr(SCRIPT + ' crashed: ' + ((err && err.stack) || err) + '\n');
    return 1;
  }
}

if (require.main === module) {
  const code = main(process.argv.slice(2));
  process.stdout.write('', () => process.exit(code));
}

module.exports = { run: run, main: main };
