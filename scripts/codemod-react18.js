#!/usr/bin/env node
'use strict';

// codemod-react18: React 17 -> 18 entry-point and API changes (ts-morph only).
// Positions come from the AST; changes are applied as position-based text edits so everything else
// in the file (comments, formatting, line endings) stays byte-for-byte identical.
// Never introduces React-18-only hooks and never adds a mount/unmount API – services expose a component.

const path = require('path');

const SCRIPT = 'codemod-react18';
const SOURCE_EXTS = ['.js', '.jsx', '.ts', '.tsx'];
const SKIP_DIRS = new Set(['node_modules', 'build', 'dist']);
const BOOTSTRAP_RE = /^bootstrap\.(js|jsx|ts|tsx)$/;
const FC_NAMES = ['FC', 'FunctionComponent'];

class CodemodError extends Error {}
// a bug in this codemod (two edits on the same range) – expected enough to report as BLOCKED, not crash
class EditConflict extends Error {
  constructor(pos) { super('overlapping edits at ' + pos); this.pos = pos; }
}

function parseArgs(argv) {
  const opts = { dryRun: false, json: false, errors: [] };
  argv.forEach((a) => {
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else opts.errors.push('פרמטר לא מוכר: ' + a);
  });
  return opts;
}

const toPosix = (p) => p.split(path.sep).join('/');

function listSourceFiles(fs, root) {
  const srcDir = path.join(root, 'src');
  let stat = null;
  try { stat = fs.statSync(srcDir); } catch (_) { /* missing */ }
  if (!stat || !stat.isDirectory()) throw new CodemodError('תיקיית src/ לא נמצאה ב-' + root);
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) {
      throw new CodemodError('לא ניתן לקרוא את ' + toPosix(path.relative(root, dir)) + ': ' + err.message);
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full); } else if (e.isFile() && SOURCE_EXTS.indexOf(path.extname(e.name)) !== -1) out.push(full);
    }
  };
  walk(srcDir);
  return out;
}

function resolveModuleFile(fs, base) {
  for (const e of [''].concat(SOURCE_EXTS)) {
    try { if (fs.statSync(base + e).isFile()) return base + e; } catch (_) { /* next */ }
  }
  for (const e of SOURCE_EXTS) {
    try { if (fs.statSync(path.join(base, 'index' + e)).isFile()) return path.join(base, 'index' + e); } catch (_) { /* next */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Text edits

function applyEdits(text, edits) {
  const sorted = edits.slice().sort((a, b) => b.start - a.start || b.end - a.end);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].end > sorted[i - 1].start) throw new EditConflict(sorted[i - 1].start);
  }
  return sorted.reduce((t, e) => t.slice(0, e.start) + e.text + t.slice(e.end), text);
}

function lineIndent(text, pos) {
  const ls = text.lastIndexOf('\n', pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(ls))[0];
}

// Range of a whole statement line(s): from line start (if only whitespace precedes) through the line break.
function wholeLineRange(text, start, end) {
  const ls = text.lastIndexOf('\n', start - 1) + 1;
  const s = /^[ \t]*$/.test(text.slice(ls, start)) ? ls : start;
  let e = end;
  while (e < text.length && (text[e] === ' ' || text[e] === '\t')) e++;
  if (text[e] === '\r') e++;
  if (text[e] === '\n') e++;
  // blank line both before and after → swallow one, so no double blank line remains
  if (s === ls && /\n[ \t]*\r?\n$/.test(text.slice(0, s))) {
    const m = /^[ \t]*\r?\n/.exec(text.slice(e));
    if (m) e += m[0].length;
  }
  return { start: s, end: e };
}

// ---------------------------------------------------------------------------
// Entry points (bootstrap)

function findBootstrapFiles(tsm, fs, root, files) {
  const { Node, SyntaxKind: K } = tsm;
  const set = new Set(files.filter((f) => BOOTSTRAP_RE.test(path.basename(f))));
  const cfg = path.join(root, 'webpack.config.js');
  let text = null;
  try { text = fs.readFileSync(cfg, 'utf8'); } catch (_) { /* no webpack config */ }
  if (text === null) return set;

  const project = new tsm.Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
  const sf = project.createSourceFile('/webpack.config.js', text);
  const entries = [];
  const collect = (node) => {
    if (!node) return;
    if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) entries.push(node.getLiteralText());
    else if (Node.isArrayLiteralExpression(node)) node.getElements().forEach(collect);
    else if (Node.isObjectLiteralExpression(node)) {
      node.getProperties().forEach((p) => { if (Node.isPropertyAssignment(p)) collect(p.getInitializer()); });
    }
  };
  sf.getDescendantsOfKind(K.PropertyAssignment).filter((p) => p.getName() === 'entry').forEach((p) => collect(p.getInitializer()));

  entries.filter((e) => e.startsWith('.')).forEach((e) => {
    const full = resolveModuleFile(fs, path.resolve(root, e));
    if (!full) return;
    set.add(full);
    // index.js → import('./bootstrap') – the classic Module Federation async boundary
    let src = null;
    try { src = fs.readFileSync(full, 'utf8'); } catch (_) { return; }
    const esf = project.createSourceFile('/entry' + path.extname(full), src, { overwrite: true });
    esf.getDescendantsOfKind(K.CallExpression).forEach((c) => {
      const arg = c.getArguments()[0];
      if (c.getExpression().getKind() === K.ImportKeyword && arg && Node.isStringLiteral(arg) && arg.getLiteralText().startsWith('.')) {
        const target = resolveModuleFile(fs, path.resolve(path.dirname(full), arg.getLiteralText()));
        if (target) set.add(target);
      }
    });
  });
  return set;
}

// ---------------------------------------------------------------------------
// Per-file transform

function transformFile(tsm, sf, file, isBootstrap) {
  const { Node, SyntaxKind: K } = tsm;
  const text = sf.getFullText();
  const eol = text.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  const edits = [];
  const changes = [];
  const manual = [];
  const change = (line, rule, detail, review) => changes.push({
    file: file, line: line, rule: rule, confidence: review ? 'review' : 'auto', detail: detail, reason: review || undefined,
  });
  const addManual = (node, reason) => manual.push({ file: file, line: node.getStartLineNumber(), reason: reason });

  const usedNames = new Set(sf.getDescendantsOfKind(K.Identifier).map((i) => i.getText()));
  const unique = (base) => {
    let n = base;
    for (let i = 2; usedNames.has(n); i++) n = base + i;
    usedNames.add(n);
    return n;
  };

  // ---- react-dom bindings ----
  const rdImports = sf.getImportDeclarations().filter((d) => d.getModuleSpecifierValue() === 'react-dom');
  const clientImports = sf.getImportDeclarations().filter((d) => d.getModuleSpecifierValue() === 'react-dom/client');
  const nsLocals = new Set();
  const named = new Map(); // local -> exported
  rdImports.forEach((d) => {
    if (d.getDefaultImport()) nsLocals.add(d.getDefaultImport().getText());
    if (d.getNamespaceImport()) nsLocals.add(d.getNamespaceImport().getText());
    d.getNamedImports().forEach((s) => named.set(s.getAliasNode() ? s.getAliasNode().getText() : s.getName(), s.getName()));
  });
  const apiOf = (callee) => {
    if (Node.isIdentifier(callee)) return named.get(callee.getText()) || null;
    if (Node.isPropertyAccessExpression(callee) && Node.isIdentifier(callee.getExpression()) && nsLocals.has(callee.getExpression().getText())) return callee.getName();
    return null;
  };

  const calls = sf.getDescendantsOfKind(K.CallExpression).map((c) => ({ call: c, api: apiOf(c.getExpression()) })).filter((x) => x.api);
  const converted = new Set(); // CallExpression nodes whose react-dom usage disappears
  const needClient = new Set(); // createRoot / hydrateRoot
  const roots = [];
  const pendingRootEdits = [];

  // ---- 1 + 2: render / hydrate ----
  calls.filter((x) => x.api === 'render' || x.api === 'hydrate').forEach((x) => {
    const call = x.call;
    const args = call.getArguments();
    const stmt = call.getParent();
    const label = x.api === 'render' ? 'ReactDOM.render' : 'ReactDOM.hydrate';
    if (!isBootstrap) return addManual(call, label + ' מחוץ לקובץ bootstrap – יש להמיר ידנית (השירות חושף קומפוננטה, לא mount)');
    if (args.length >= 3) return addManual(call, label + ' עם callback (ארגומנט שלישי) – אין מקבילה ישירה ב-createRoot; יש להמיר ידנית (useEffect / ref callback)');
    if (args.length < 2) return addManual(call, label + ' ללא container');
    if (!Node.isExpressionStatement(stmt)) return addManual(call, 'הערך המוחזר מ-' + label + ' בשימוש – יש להמיר ידנית');

    const api = x.api === 'render' ? 'createRoot' : 'hydrateRoot';
    const rootName = unique('root');
    const element = args[0];
    const container = args[1].getText();
    const stmtIndent = lineIndent(text, stmt.getStart());
    const multiline = element.getStartLineNumber() !== call.getStartLineNumber();
    const elemIndent = lineIndent(text, element.getStart());
    const elemText = element.getText();
    pendingRootEdits.push({
      stmt: stmt, api: api,
      build: (accessor) => {
        if (api === 'createRoot') {
          const renderCall = multiline
            ? rootName + '.render(' + eol + elemIndent + elemText + eol + stmtIndent + ');'
            : rootName + '.render(' + elemText + ');';
          return 'const ' + rootName + ' = ' + accessor + '(' + container + ');' + eol + stmtIndent + renderCall;
        }
        return multiline
          ? 'const ' + rootName + ' = ' + accessor + '(' + container + ',' + eol + elemIndent + elemText + eol + stmtIndent + ');'
          : 'const ' + rootName + ' = ' + accessor + '(' + container + ', ' + elemText + ');';
      },
    });
    roots.push({ name: rootName, container: container.replace(/\s+/g, ''), scope: stmt.getParent() });
    converted.add(call);
    needClient.add(api);
    change(call.getStartLineNumber(), x.api === 'render' ? 'R18.CREATE_ROOT' : 'R18.HYDRATE_ROOT', label + ' → ' + api);
  });

  // ---- 3: unmountComponentAtNode ----
  calls.filter((x) => x.api === 'unmountComponentAtNode').forEach((x) => {
    const call = x.call;
    const arg = call.getArguments()[0];
    const parent = call.getParent();
    // module.hot.dispose(() => ReactDOM.unmountComponentAtNode(el)) – the boolean result is ignored there too
    const valueIgnored = Node.isExpressionStatement(parent) || (Node.isArrowFunction(parent) && parent.getBody() === call);
    if (!valueIgnored) return addManual(call, 'הערך של unmountComponentAtNode בשימוש – יש להמיר ידנית');
    const key = arg ? arg.getText().replace(/\s+/g, '') : null;
    const root = roots.find((r) => r.container === key && call.getAncestors().indexOf(r.scope) !== -1);
    if (!root) return addManual(call, 'unmountComponentAtNode – אין root נגיש ב-scope עבור ' + (arg ? arg.getText() : '?') + '; יש להמיר ידנית');
    edits.push({ start: call.getStart(), end: call.getEnd(), text: root.name + '.unmount()' });
    converted.add(call);
    change(call.getStartLineNumber(), 'R18.UNMOUNT', 'unmountComponentAtNode → ' + root.name + '.unmount()');
  });

  // ---- 6: findDOMNode / string refs → manual only ----
  calls.filter((x) => x.api === 'findDOMNode').forEach((x) => addManual(x.call, 'findDOMNode – הוצא משימוש; יש להחליף ב-ref'));
  sf.getDescendantsOfKind(K.JsxAttribute).forEach((a) => {
    if (a.getNameNode().getText() !== 'ref') return;
    let init = a.getInitializer();
    if (init && Node.isJsxExpression(init)) init = init.getExpression();
    if (init && (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init))) addManual(a, 'string ref (ref="' + init.getLiteralText() + '") – יש להחליף ב-createRef / useRef');
  });
  sf.getDescendantsOfKind(K.PropertyAccessExpression).forEach((pa) => {
    if (pa.getName() === 'refs' && pa.getExpression().getKind() === K.ThisKeyword) addManual(pa, 'this.refs – string refs; יש להחליף ב-createRef');
  });

  // ---- react-dom → react-dom/client import ----
  if (pendingRootEdits.length) {
    // all react-dom usages through the default/namespace binding
    const nsUses = sf.getDescendantsOfKind(K.Identifier).filter((id) => nsLocals.has(id.getText()) && !id.getFirstAncestorByKind(K.ImportDeclaration));
    const nsUsedElsewhere = nsUses.some((id) => {
      const call = id.getParent() && id.getParent().getParent();
      return !(call && Node.isCallExpression(call) && converted.has(call));
    });
    const namedConverted = (d) => d.getNamedImports().every((s) => {
      const local = s.getAliasNode() ? s.getAliasNode().getText() : s.getName();
      const refs = sf.getDescendantsOfKind(K.Identifier).filter((id) => id.getText() === local && !id.getFirstAncestorByKind(K.ImportDeclaration));
      return refs.every((id) => converted.has(id.getParent()));
    });

    let accessorFor = null;
    const nsDecl = rdImports.find((d) => d.getDefaultImport() || d.getNamespaceImport());
    const existingClientNs = clientImports.find((d) => d.getDefaultImport() || d.getNamespaceImport());
    if (existingClientNs) {
      const l = (existingClientNs.getDefaultImport() || existingClientNs.getNamespaceImport()).getText();
      accessorFor = (api) => l + '.' + api;
    } else if (nsDecl && !nsUsedElsewhere && nsDecl.getNamedImports().length === 0 && rdImports.length === 1) {
      // import ReactDOM from 'react-dom' → 'react-dom/client'
      const lit = nsDecl.getModuleSpecifier();
      const q = lit.getText().charAt(0);
      edits.push({ start: lit.getStart(), end: lit.getEnd(), text: q + 'react-dom/client' + q });
      const l = (nsDecl.getDefaultImport() || nsDecl.getNamespaceImport()).getText();
      accessorFor = (api) => l + '.' + api;
      change(nsDecl.getStartLineNumber(), 'R18.IMPORT', "'react-dom' → 'react-dom/client'");
    } else {
      // keep react-dom (still used, e.g. createPortal) and add a named client import
      const anchor = rdImports[rdImports.length - 1];
      const q = anchor.getModuleSpecifier().getText().charAt(0);
      const semi = anchor.getLastToken().getKind() === K.SemicolonToken ? ';' : '';
      const names = Array.from(needClient).sort();
      const fullyConverted = rdImports.filter((d) => !d.getDefaultImport() && !d.getNamespaceImport() && namedConverted(d));
      const importText = 'import { ' + names.join(', ') + ' } from ' + q + 'react-dom/client' + q + semi;
      if (fullyConverted.length === rdImports.length) {
        // import { render } from 'react-dom' → import { createRoot } from 'react-dom/client'
        fullyConverted.forEach((d, i) => {
          if (i === 0) edits.push({ start: d.getStart(), end: d.getEnd(), text: importText });
          else { const r = wholeLineRange(text, d.getStart(), d.getEnd()); edits.push({ start: r.start, end: r.end, text: '' }); }
        });
      } else {
        edits.push({ start: anchor.getEnd(), end: anchor.getEnd(), text: eol + importText });
      }
      accessorFor = (api) => api;
      change(anchor.getStartLineNumber(), 'R18.IMPORT', importText);
    }
    pendingRootEdits.forEach((p) => edits.push({ start: p.stmt.getStart(), end: p.stmt.getEnd(), text: p.build(accessorFor(p.api)) }));
  }

  // ---- 4: Component.defaultProps on function components ----
  const reactLocals = new Set();
  const reactNamed = new Map();
  sf.getImportDeclarations().filter((d) => d.getModuleSpecifierValue() === 'react').forEach((d) => {
    if (d.getDefaultImport()) reactLocals.add(d.getDefaultImport().getText());
    if (d.getNamespaceImport()) reactLocals.add(d.getNamespaceImport().getText());
    d.getNamedImports().forEach((s) => reactNamed.set(s.getAliasNode() ? s.getAliasNode().getText() : s.getName(), s.getName()));
  });

  const PRIMITIVE = new Set([K.StringLiteral, K.NumericLiteral, K.TrueKeyword, K.FalseKeyword, K.NullKeyword, K.NoSubstitutionTemplateLiteral]);
  const isPrimitive = (n) => PRIMITIVE.has(n.getKind()) || (Node.isIdentifier(n) && n.getText() === 'undefined') ||
    (Node.isPrefixUnaryExpression(n) && Node.isNumericLiteral(n.getOperand()));

  sf.getDescendantsOfKind(K.BinaryExpression).forEach((bin) => {
    if (bin.getOperatorToken().getKind() !== K.EqualsToken) return;
    const left = bin.getLeft();
    if (!Node.isPropertyAccessExpression(left) || left.getName() !== 'defaultProps' || !Node.isIdentifier(left.getExpression())) return;
    const stmt = bin.getParent();
    if (!Node.isExpressionStatement(stmt)) return;
    const compName = left.getExpression().getText();
    if (sf.getClass(compName)) return; // class components: defaultProps still supported

    let fn = sf.getFunction(compName) || null;
    if (!fn) {
      const v = sf.getVariableDeclaration(compName);
      let init = v && v.getInitializer();
      while (init && Node.isParenthesizedExpression(init)) init = init.getExpression();
      if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) fn = init;
      else if (init && Node.isCallExpression(init)) return addManual(stmt, compName + '.defaultProps על רכיב עטוף (' + init.getExpression().getText() + ') – יש להמיר ידנית');
      else if (init && Node.isClassExpression(init)) return;
    }
    if (!fn) return addManual(stmt, compName + '.defaultProps – הרכיב לא נמצא בקובץ; יש להמיר ידנית');

    const obj = bin.getRight();
    if (!Node.isObjectLiteralExpression(obj)) return addManual(stmt, compName + '.defaultProps אינו אובייקט ליטרלי');
    const otherRefs = sf.getDescendantsOfKind(K.PropertyAccessExpression)
      .filter((pa) => pa !== left && pa.getName() === 'defaultProps' && pa.getExpression().getText() === compName);
    if (otherRefs.length) return addManual(stmt, compName + '.defaultProps נקרא או מוגדר במקום נוסף – יש להמיר ידנית');

    const entries = [];
    for (const p of obj.getProperties()) {
      if (Node.isPropertyAssignment(p) && Node.isIdentifier(p.getNameNode())) entries.push({ key: p.getName(), value: p.getInitializer() });
      else if (Node.isShorthandPropertyAssignment(p)) entries.push({ key: p.getName(), value: p.getNameNode() });
      else return addManual(stmt, compName + '.defaultProps מכיל spread / מפתח מחושב / שם לא חוקי כמשתנה');
    }
    const param = fn.getParameters()[0];
    if (!param) return addManual(stmt, compName + ' אינו מקבל props אך מוגדר לו defaultProps');
    const pattern = param.getNameNode();
    if (!Node.isObjectBindingPattern(pattern)) return addManual(stmt, compName + '(props) – props אינו מפורק; המרה ל-default parameters דורשת שינוי חתימה ידני');
    const elements = pattern.getElements();
    const rest = elements.find((e) => e.getDotDotDotToken());

    const localEdits = [];
    const unused = [];
    const applied = [];
    for (const e of entries) {
      const el = elements.find((x) => !x.getDotDotDotToken() &&
        (x.getPropertyNameNode() ? x.getPropertyNameNode().getText() : x.getName()) === e.key);
      if (el) {
        if (el.getInitializer()) return addManual(stmt, compName + ': ל-' + e.key + ' כבר יש ערך ברירת מחדל בחתימה וגם ב-defaultProps');
        localEdits.push({ start: el.getEnd(), end: el.getEnd(), text: ' = ' + e.value.getText() });
        applied.push(e);
      } else if (rest) {
        // הוספת המפתח לחתימה תוציא אותו מ-rest – שינוי התנהגות
        return addManual(stmt, compName + ': ' + e.key + ' לא מפורק בחתימה ויש ...' + rest.getName() + ' – יש להמיר ידנית');
      } else {
        // בלי rest הרכיב לא יכול לקרוא את המפתח – ברירת המחדל אינה נצפית
        unused.push(e.key);
      }
    }
    const r = wholeLineRange(text, stmt.getStart(), stmt.getEnd());
    localEdits.push({ start: r.start, end: r.end, text: '' });
    edits.push.apply(edits, localEdits);
    const nonPrimitive = applied.filter((e) => !isPrimitive(e.value)).map((e) => e.key);
    change(stmt.getStartLineNumber(), 'R18.DEFAULT_PROPS', compName + '.defaultProps → default parameters' +
      (unused.length ? ' (הושמטו – לא בשימוש ברכיב: ' + unused.join(', ') + ')' : ''),
      nonPrimitive.length ? 'ערך ברירת מחדל שאינו פרימיטיבי (' + nonPrimitive.join(', ') + ') נוצר מחדש בכל רינדור – עלול לשבור תלויות של useEffect/useMemo; שקול להוציא לקבוע' : null);
  });

  // ---- 5: React.FC without children (TypeScript) ----
  if (/\.tsx?$/.test(file)) {
    let reactNode = null;
    const ensureReactNode = () => {
      if (reactNode) return reactNode;
      if (reactLocals.size) { reactNode = Array.from(reactLocals)[0] + '.ReactNode'; return reactNode; }
      const local = Array.from(reactNamed.entries()).find((e) => e[1] === 'ReactNode');
      if (local) { reactNode = local[0]; return reactNode; }
      const decl = sf.getImportDeclarations().find((d) => d.getModuleSpecifierValue() === 'react' && d.getNamedImports().length);
      if (decl) {
        const last = decl.getNamedImports()[decl.getNamedImports().length - 1];
        edits.push({ start: last.getEnd(), end: last.getEnd(), text: ', ReactNode' });
      } else {
        edits.push({ start: 0, end: 0, text: "import type { ReactNode } from 'react';" + eol });
      }
      reactNode = 'ReactNode';
      return reactNode;
    };
    const isFcRef = (tr) => {
      const n = tr.getTypeName();
      if (Node.isQualifiedName(n)) return reactLocals.has(n.getLeft().getText()) && FC_NAMES.indexOf(n.getRight().getText()) !== -1;
      return FC_NAMES.indexOf(reactNamed.get(n.getText())) !== -1;
    };
    const hasChildren = (members) => members.some((m) => (m.getName && m.getName()) === 'children');
    const doneTypes = new Set();

    const addMember = (container, members, node) => {
      const member = 'children?: ' + ensureReactNode() + ';';
      if (members.length === 0) {
        const open = container.getStart() + container.getText().indexOf('{');
        edits.push({ start: open + 1, end: open + 1, text: ' ' + member + ' ' });
        return;
      }
      const last = members[members.length - 1];
      const sameLine = last.getStartLineNumber() === node.getStartLineNumber() && last.getEndLineNumber() === container.getEndLineNumber();
      if (sameLine) {
        const sep = /[;,]$/.test(last.getText()) ? ' ' : '; ';
        edits.push({ start: last.getEnd(), end: last.getEnd(), text: sep + member });
      } else {
        edits.push({ start: last.getEnd(), end: last.getEnd(), text: eol + lineIndent(text, last.getStart()) + member });
      }
    };

    sf.getDescendantsOfKind(K.TypeReference).filter(isFcRef).forEach((tr) => {
      const args = tr.getTypeArguments();
      if (args.length === 0) {
        edits.push({ start: tr.getTypeName().getEnd(), end: tr.getTypeName().getEnd(), text: '<{ children?: ' + ensureReactNode() + ' }>' });
        change(tr.getStartLineNumber(), 'R18.FC_CHILDREN', tr.getText() + ' → children?: ReactNode');
        return;
      }
      const arg = args[0];
      if (Node.isTypeLiteral(arg)) {
        if (hasChildren(arg.getMembers()) || doneTypes.has(arg)) return;
        doneTypes.add(arg);
        addMember(arg, arg.getMembers(), arg);
        change(tr.getStartLineNumber(), 'R18.FC_CHILDREN', 'children?: ReactNode נוסף לטיפוס ה-props');
        return;
      }
      if (Node.isTypeReference(arg) && Node.isIdentifier(arg.getTypeName()) && arg.getTypeArguments().length === 0) {
        const name = arg.getTypeName().getText();
        const iface = sf.getInterface(name);
        const alias = sf.getTypeAlias(name);
        if (iface) {
          if (doneTypes.has(iface)) return;
          doneTypes.add(iface);
          const heritage = iface.getExtends().map((e) => e.getText()).join(' ');
          if (hasChildren(iface.getMembers()) || /PropsWithChildren|children/.test(heritage)) return;
          addMember(iface, iface.getMembers(), iface);
          change(iface.getStartLineNumber(), 'R18.FC_CHILDREN', 'children?: ReactNode נוסף ל-interface ' + name,
            heritage ? 'ה-interface מרחיב ' + heritage + ' – ודא שאין כבר children' : null);
          return;
        }
        if (alias && Node.isTypeLiteral(alias.getTypeNode())) {
          const lit = alias.getTypeNode();
          if (doneTypes.has(lit) || hasChildren(lit.getMembers())) return;
          doneTypes.add(lit);
          addMember(lit, lit.getMembers(), lit);
          change(alias.getStartLineNumber(), 'R18.FC_CHILDREN', 'children?: ReactNode נוסף ל-type ' + name);
          return;
        }
      }
      // imported / composed props type – wrap at the usage site
      const pwc = reactLocals.size ? Array.from(reactLocals)[0] + '.PropsWithChildren' : null;
      if (!pwc) return addManual(tr, tr.getText() + ' – טיפוס ה-props אינו מקומי; הוסף children?: ReactNode ידנית');
      edits.push({ start: arg.getStart(), end: arg.getEnd(), text: pwc + '<' + arg.getText() + '>' });
      change(tr.getStartLineNumber(), 'R18.FC_CHILDREN', arg.getText() + ' → ' + pwc + '<' + arg.getText() + '>', 'טיפוס props חיצוני – נעטף ב-PropsWithChildren; ודא שזה רצוי');
    });
  }

  const remainingRender = calls.filter((x) => (x.api === 'render' || x.api === 'hydrate') && !converted.has(x.call)).length;
  return { edits: edits, changes: changes, manual: manual, remainingRender: remainingRender };
}

// ---------------------------------------------------------------------------

function conflictMessage(rel, text, err) {
  const line = text.slice(0, err.pos).split('\n').length;
  return rel + ':' + line + ' – ' + SCRIPT + ' יצר שתי עריכות חופפות באותו מקום (באג בקודמוד). הקובץ לא שונה – יש להמיר אותו ידנית או לדווח על הבאג';
}

function run(argv, overrides) {
  const deps = Object.assign({ fs: require('fs'), cwd: process.cwd(), applyEdits: applyEdits }, overrides || {});
  const opts = parseArgs(argv || []);
  const res = { script: SCRIPT, result: 'OK', changes: [], manual: [], blockers: [], notes: [], dryRun: opts.dryRun, filesChanged: [], bootstrapFiles: [] };
  const blocked = (m) => { res.result = 'BLOCKED'; res.blockers.push({ message: m }); return res; };
  if (opts.errors.length) return blocked(opts.errors.join('; '));

  let tsm;
  try { tsm = require('ts-morph'); } catch (_) {
    return blocked('ts-morph אינו מותקן בתיקיית הסקיל – הרץ npm install ב-' + path.join(__dirname, '..'));
  }
  let files;
  try { files = listSourceFiles(deps.fs, deps.cwd); } catch (err) {
    if (err instanceof CodemodError) return blocked(err.message);
    throw err;
  }
  const bootstrap = findBootstrapFiles(tsm, deps.fs, deps.cwd, files);
  res.bootstrapFiles = Array.from(bootstrap).map((f) => toPosix(path.relative(deps.cwd, f))).sort();
  if (!res.bootstrapFiles.length) res.notes.push('לא זוהה קובץ bootstrap (entry ב-webpack או bootstrap.*)');

  const project = new tsm.Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, jsx: tsm.ts.JsxEmit.Preserve },
  });

  for (const full of files) {
    const rel = toPosix(path.relative(deps.cwd, full));
    let raw;
    try { raw = deps.fs.readFileSync(full, 'utf8'); } catch (err) { return blocked('לא ניתן לקרוא את ' + rel + ': ' + err.message); }
    const bom = raw.charCodeAt(0) === 0xfeff ? '﻿' : '';
    const text = bom ? raw.slice(1) : raw;
    const sf = project.createSourceFile('/' + rel, text, { overwrite: true });
    const r = transformFile(tsm, sf, rel, bootstrap.has(full));
    project.removeSourceFile(sf);
    res.manual.push.apply(res.manual, r.manual);
    let out = text;
    if (r.edits.length) {
      try {
        out = deps.applyEdits(text, r.edits);
      } catch (err) {
        if (!(err instanceof EditConflict)) throw err;
        res.blockers.push({ file: rel, message: conflictMessage(rel, text, err) });
        continue; // הקובץ לא נכתב, והשינויים שלו לא מדווחים
      }
    }
    res.changes.push.apply(res.changes, r.changes);
    if (out === text) continue;
    res.filesChanged.push(rel);
    if (!opts.dryRun) {
      try { deps.fs.writeFileSync(full, bom + out, 'utf8'); } catch (err) { return blocked('לא ניתן לכתוב את ' + rel + ': ' + err.message); }
    }
  }

  const reviews = res.changes.filter((c) => c.confidence === 'review');
  if (res.blockers.length) res.result = 'BLOCKED';
  else if (res.changes.length === 0 && res.manual.length === 0) res.result = 'NOOP';
  else if (res.manual.length || reviews.length) res.result = 'REVIEW';
  return res;
}

function formatText(res) {
  const L = [SCRIPT + (res.dryRun ? ' [dry-run]' : '')];
  res.blockers.forEach((b) => L.push('⛔ ' + b.message));
  // BLOCKED of a single file still has a summary of the rest; a precondition BLOCKED (no src/ …) has nothing else
  if (res.result !== 'BLOCKED' || res.changes.length || res.manual.length) {
    L.push('🚀 bootstrap: ' + (res.bootstrapFiles.join(', ') || '-'));
    const byRule = {};
    res.changes.forEach((c) => { byRule[c.rule] = (byRule[c.rule] || 0) + 1; });
    L.push('✏️ ' + res.filesChanged.length + ' קבצים ' + (res.dryRun ? 'היו משתנים' : 'שונו') +
      (Object.keys(byRule).length ? ' | ' + Object.keys(byRule).map((k) => k + ' ×' + byRule[k]).join(', ') : ''));
    res.changes.filter((c) => c.confidence === 'review').forEach((c) => L.push('🔍 ' + c.file + ':' + c.line + ' – ' + c.reason));
    res.manual.forEach((m) => L.push('✋ ' + m.file + ':' + m.line + ' – ' + m.reason));
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

module.exports = { run: run, main: main, applyEdits: applyEdits };
