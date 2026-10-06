#!/usr/bin/env node
'use strict';

// scan: full read-only inventory of a service repo. The only file it writes is the --out file.

const path = require('path');

const SCRIPT = 'scan';
const DEFAULT_OUT = '.migration/inventory.json';
const REFERENCE_DIR = path.join(__dirname, '..', 'reference');
const SCHEMA_VERSION = 1;

class ScanError extends Error {}

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const opts = { json: false, dryRun: false, out: DEFAULT_OUT, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--out') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) opts.errors.push('‎--out דורש נתיב');
      else { opts.out = v; i++; }
    } else if (a.startsWith('--out=')) opts.out = a.slice('--out='.length);
    else opts.errors.push('פרמטר לא מוכר: ' + a);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// File system helpers

const toPosix = (p) => p.split(path.sep).join('/');

function readJson(fs, file, label) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new ScanError('לא ניתן לקרוא את ' + label + ': ' + err.message);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ScanError(label + ' אינו JSON תקין: ' + err.message);
  }
}

function tryReadJson(fs, file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function installedVersion(fs, root, name) {
  const pkg = tryReadJson(fs, path.join(root, 'node_modules', name, 'package.json'));
  return pkg && typeof pkg.version === 'string' ? pkg.version : null;
}

function listSourceFiles(fs, root, rules) {
  const srcDir = path.join(root, 'src');
  let stat;
  try { stat = fs.statSync(srcDir); } catch (_) { stat = null; }
  if (!stat || !stat.isDirectory()) throw new ScanError('תיקיית src/ לא נמצאה ב-' + root);
  const skip = new Set(rules.skipDirs);
  const exts = new Set(rules.sourceExtensions);
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw new ScanError('לא ניתן לקרוא את התיקייה ' + toPosix(path.relative(root, dir)) + ': ' + err.message);
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name)) walk(full);
      } else if (e.isFile() && exts.has(path.extname(e.name))) {
        out.push(full);
      }
    }
  };
  walk(srcDir);
  return out;
}

// ---------------------------------------------------------------------------
// Version helpers (no semver dependency – only what the deny-list needs)

function parseVersion(v) {
  const m = String(v || '').match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// "^17.0.2" -> "17.0.2"; ranges that are not plain versions (git urls, "latest", "*") -> null
function minVersion(range) {
  const r = String(range || '').trim();
  if (!/^[\^~>=v\s]*\d/.test(r)) return null;
  const v = parseVersion(r);
  return v ? v.join('.') : null;
}

function exactVersion(range) {
  const v = String(range || '').trim().replace(/^[\^~=v]+/, '');
  return /^\d+\.\d+\.\d+/.test(v) ? v : null;
}

// ---------------------------------------------------------------------------
// AST helpers

function astHelpers(tsm) {
  const { Node, SyntaxKind: K } = tsm;
  const FN_KINDS = new Set([K.ArrowFunction, K.FunctionExpression, K.FunctionDeclaration, K.MethodDeclaration]);

  const lineOf = (node) => node.getStartLineNumber();

  function unwrap(node) {
    while (node && (
      Node.isParenthesizedExpression(node) || Node.isAsExpression(node) || Node.isNonNullExpression(node) ||
      Node.isTypeAssertion(node) || (Node.isSatisfiesExpression && Node.isSatisfiesExpression(node))
    )) node = node.getExpression();
    return node;
  }

  function propName(p) {
    const n = p.getNameNode ? p.getNameNode() : null;
    if (!n) return null;
    if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) return n.getLiteralText();
    if (Node.isComputedPropertyName(n)) return '[' + n.getExpression().getText() + ']';
    return n.getText();
  }

  function collectImports(sf) {
    return sf.getImportDeclarations().map((d) => {
      const def = d.getDefaultImport();
      const ns = d.getNamespaceImport();
      return {
        module: d.getModuleSpecifierValue(),
        line: lineOf(d),
        defaultLocal: def ? def.getText() : null,
        namespaceLocal: ns ? ns.getText() : null,
        named: d.getNamedImports().map((s) => ({
          name: s.getName(),
          local: s.getAliasNode() ? s.getAliasNode().getText() : s.getName(),
        })),
      };
    });
  }

  // Locals bound to a module: named (local -> exported name) and default/namespace objects.
  function bindingsFor(imports, test) {
    const named = new Map();
    const ns = new Set();
    const decls = [];
    for (const imp of imports) {
      if (!test(imp.module)) continue;
      decls.push(imp);
      imp.named.forEach((n) => named.set(n.local, n.name));
      if (imp.defaultLocal) ns.add(imp.defaultLocal);
      if (imp.namespaceLocal) ns.add(imp.namespaceLocal);
    }
    return { named, ns, decls };
  }

  // Exported name an expression refers to (`useEffect`, `React.useEffect`, `Router.Route`), or null.
  function resolveRef(expr, b) {
    expr = unwrap(expr);
    if (!expr) return null;
    if (Node.isIdentifier(expr)) return b.named.has(expr.getText()) ? b.named.get(expr.getText()) : null;
    if (Node.isPropertyAccessExpression(expr)) {
      const obj = expr.getExpression();
      if (Node.isIdentifier(obj) && b.ns.has(obj.getText())) return expr.getName();
    }
    return null;
  }

  // Identifier that reads a binding (not a declaration, property name, import or closing tag).
  function isReference(id) {
    const p = id.getParent();
    if (!p) return false;
    if (id.getFirstAncestorByKind(K.ImportDeclaration)) return false;
    if (Node.isPropertyAccessExpression(p) && p.getNameNode() === id) return false;
    if ((Node.isPropertyAssignment(p) || Node.isMethodDeclaration(p) || Node.isPropertySignature(p) ||
         Node.isPropertyDeclaration(p)) && p.getNameNode() === id) return false;
    if (Node.isJsxAttribute(p) || Node.isJsxClosingElement(p)) return false;
    if ((Node.isVariableDeclaration(p) || Node.isFunctionDeclaration(p) || Node.isParameterDeclaration(p) ||
         Node.isClassDeclaration(p)) && p.getNameNode() === id) return false;
    if (Node.isBindingElement(p)) return p.getInitializer() === id;
    if (Node.isExportSpecifier(p) || Node.isImportSpecifier(p)) return false;
    return true;
  }

  function usageKind(node) {
    const p = node.getParent();
    if ((Node.isJsxOpeningElement(p) || Node.isJsxSelfClosingElement(p)) && p.getTagNameNode() === node) return 'jsx';
    if (Node.isCallExpression(p) && p.getExpression() === node) return 'call';
    if (Node.isNewExpression(p) && p.getExpression() === node) return 'call';
    return 'reference';
  }

  // Every use of the given exported names from matching modules. Unused imports are reported as kind 'import'.
  function findUsages(sf, imports, test, names) {
    const wanted = new Set(names);
    const b = bindingsFor(imports, test);
    const out = [];
    const used = new Set();
    for (const id of sf.getDescendantsOfKind(K.Identifier)) {
      const local = id.getText();
      if (b.named.has(local) && wanted.has(b.named.get(local)) && isReference(id)) {
        out.push({ api: b.named.get(local), line: lineOf(id), kind: usageKind(id) });
        used.add(local);
      }
    }
    for (const pa of sf.getDescendantsOfKind(K.PropertyAccessExpression)) {
      const obj = pa.getExpression();
      if (Node.isIdentifier(obj) && b.ns.has(obj.getText()) && wanted.has(pa.getName())) {
        out.push({ api: pa.getName(), line: lineOf(pa), kind: usageKind(pa) });
      }
    }
    for (const imp of b.decls) {
      for (const n of imp.named) {
        if (wanted.has(n.name) && !used.has(n.local)) out.push({ api: n.name, line: imp.line, kind: 'import' });
      }
    }
    return out.sort((x, y) => x.line - y.line);
  }

  function enclosingFunction(node) {
    return node.getFirstAncestor((n) => FN_KINDS.has(n.getKind()));
  }

  // Function / object / call node a component expression ultimately points to
  // (unwraps React.memo(X), withRouter(X), connect(...)(X), identifiers).
  function resolveComponent(expr, sf, depth) {
    depth = depth || 0;
    expr = unwrap(expr);
    if (!expr || depth > 5) return null;
    if (Node.isArrowFunction(expr) || Node.isFunctionExpression(expr) || Node.isFunctionDeclaration(expr) ||
        Node.isClassDeclaration(expr) || Node.isClassExpression(expr)) return expr;
    if (Node.isIdentifier(expr)) {
      const name = expr.getText();
      const fn = sf.getFunction(name);
      if (fn) return fn;
      const cls = sf.getClass(name);
      if (cls) return cls;
      const v = sf.getVariableDeclaration(name);
      return v && v.getInitializer() ? resolveComponent(v.getInitializer(), sf, depth + 1) : null;
    }
    if (Node.isCallExpression(expr)) {
      for (const arg of expr.getArguments()) {
        const r = resolveComponent(arg, sf, depth + 1);
        if (r) return r;
      }
    }
    return null;
  }

  function resolveIdentifierInit(node, sf) {
    node = unwrap(node);
    if (node && Node.isIdentifier(node)) {
      const v = sf.getVariableDeclaration(node.getText());
      if (v && v.getInitializer()) return unwrap(v.getInitializer());
    }
    return node;
  }

  // Plain-data view of an expression for the inventory.
  function describe(node, sf) {
    node = unwrap(node);
    if (!node) return null;
    if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralText();
    if (Node.isNumericLiteral(node)) return Number(node.getLiteralText());
    const k = node.getKind();
    if (k === K.TrueKeyword) return true;
    if (k === K.FalseKeyword) return false;
    if (k === K.NullKeyword) return null;
    if (Node.isObjectLiteralExpression(node)) {
      const out = {};
      for (const p of node.getProperties()) {
        if (Node.isSpreadAssignment(p)) {
          (out['...'] = out['...'] || []).push(p.getExpression().getText());
        } else if (Node.isPropertyAssignment(p)) {
          out[propName(p)] = describe(p.getInitializer(), sf);
        } else {
          out[propName(p)] = { expression: p.getText() };
        }
      }
      return out;
    }
    return { expression: node.getText() };
  }

  return {
    Node, K, FN_KINDS, lineOf, unwrap, propName, collectImports, bindingsFor, resolveRef, isReference,
    findUsages, enclosingFunction, resolveComponent, resolveIdentifierInit, describe,
  };
}

// ---------------------------------------------------------------------------
// Analyzers

function analyzeMakeStyles(sf, file, imports, rules, h) {
  const { Node, K } = h;
  const b = h.bindingsFor(imports, (m) => rules.makeStylesModules.indexOf(m) !== -1);
  if (b.named.size === 0 && b.ns.size === 0) return [];
  const results = [];

  const isFn = (n) => Node.isArrowFunction(n) || Node.isFunctionExpression(n);

  function stylesObject(arg, depth) {
    arg = h.unwrap(arg);
    if (!arg || depth > 4) return { obj: null, theme: false };
    if (Node.isObjectLiteralExpression(arg)) return { obj: arg, theme: false };
    if (Node.isCallExpression(arg) && /(^|\.)createStyles$/.test(arg.getExpression().getText())) {
      return stylesObject(arg.getArguments()[0], depth + 1);
    }
    if (Node.isIdentifier(arg)) {
      const v = sf.getVariableDeclaration(arg.getText());
      return v && v.getInitializer() ? stylesObject(v.getInitializer(), depth + 1) : { obj: null, theme: false };
    }
    if (isFn(arg)) {
      const body = h.unwrap(arg.getBody());
      let returned = null;
      if (Node.isBlock(body)) {
        const ret = body.getDescendantsOfKind(K.ReturnStatement)
          .find((r) => h.enclosingFunction(r) === arg && r.getExpression());
        returned = ret ? ret.getExpression() : null;
      } else {
        returned = body;
      }
      const inner = stylesObject(returned, depth + 1);
      return { obj: inner.obj, theme: true };
    }
    return { obj: null, theme: false };
  }

  // JSS: a function anywhere inside a rule (also nested) is a dynamic props value
  function hasFunctionValue(init) {
    init = h.unwrap(init);
    if (!init) return false;
    if (isFn(init)) return true;
    if (Node.isObjectLiteralExpression(init)) {
      return init.getProperties().some((p) => Node.isMethodDeclaration(p) ||
        (Node.isPropertyAssignment(p) && hasFunctionValue(p.getInitializer())));
    }
    return false;
  }

  function consumerOf(node) {
    const attr = node.getFirstAncestorByKind(K.JsxAttribute);
    if (!attr) return { component: null, attribute: null, slot: null };
    const owner = attr.getParent().getParent();
    const slotPath = [];
    let cur = node;
    while (cur && cur !== attr) {
      const p = cur.getParent();
      if (Node.isPropertyAssignment(p) && p.getInitializer() === cur) slotPath.unshift(h.propName(p));
      cur = p;
    }
    return {
      component: owner.getTagNameNode().getText(),
      attribute: attr.getNameNode().getText(),
      slot: slotPath.length ? slotPath.join('.') : null,
    };
  }

  function consumers(hookName) {
    const out = [];
    const push = (key, node) => out.push(Object.assign({ key: key, line: h.lineOf(node) }, consumerOf(node)));
    for (const call of sf.getDescendantsOfKind(K.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isIdentifier(callee) || callee.getText() !== hookName) continue;
      const decl = call.getParentIfKind(K.VariableDeclaration);
      if (!decl) continue;
      const scope = h.enclosingFunction(decl) || sf;
      const nameNode = decl.getNameNode();
      if (Node.isIdentifier(nameNode)) {
        const classes = nameNode.getText();
        for (const pa of scope.getDescendantsOfKind(K.PropertyAccessExpression)) {
          const e = pa.getExpression();
          if (Node.isIdentifier(e) && e.getText() === classes) push(pa.getName(), pa);
        }
        for (const ea of scope.getDescendantsOfKind(K.ElementAccessExpression)) {
          const e = ea.getExpression();
          const arg = ea.getArgumentExpression();
          if (Node.isIdentifier(e) && e.getText() === classes && arg && Node.isStringLiteral(arg)) push(arg.getLiteralText(), ea);
        }
        // classes={classes} – all keys forwarded
        for (const id of scope.getDescendantsOfKind(K.Identifier)) {
          if (id.getText() !== classes || id === nameNode) continue;
          const p = id.getParent();
          if (Node.isJsxExpression(p) && Node.isJsxAttribute(p.getParent())) push('*', id);
        }
      } else if (Node.isObjectBindingPattern(nameNode)) {
        for (const el of nameNode.getElements()) {
          const key = el.getPropertyNameNode() ? el.getPropertyNameNode().getText() : el.getName();
          const local = el.getName();
          for (const id of scope.getDescendantsOfKind(K.Identifier)) {
            if (id.getText() === local && id !== el.getNameNode() && h.isReference(id)) push(key, id);
          }
        }
      }
    }
    return out.sort((a, c) => a.line - c.line);
  }

  for (const call of sf.getDescendantsOfKind(K.CallExpression)) {
    if (h.resolveRef(call.getExpression(), b) !== 'makeStyles') continue;
    const arg = call.getArguments()[0];
    const res = stylesObject(arg, 0);
    const keys = [];
    const emptyKeys = [];
    const propsKeys = [];
    const spreads = [];
    if (res.obj) {
      for (const p of res.obj.getProperties()) {
        if (Node.isSpreadAssignment(p)) { spreads.push(p.getExpression().getText()); continue; }
        const name = h.propName(p);
        keys.push(name);
        if (Node.isMethodDeclaration(p)) { propsKeys.push(name); continue; }
        if (!Node.isPropertyAssignment(p)) continue;
        const init = h.unwrap(p.getInitializer());
        // אובייקט בלי מאפיינים = ריק או שכל התוכן מוער (הערות אינן צמתים ב-AST)
        if (Node.isObjectLiteralExpression(init) && init.getProperties().length === 0) emptyKeys.push(name);
        if (hasFunctionValue(init)) propsKeys.push(name);
      }
    }
    let level;
    if (propsKeys.length) level = 'props';
    else if (res.theme) level = 'theme';
    else if (res.obj) level = 'static';
    else level = 'unknown';

    const decl = call.getParentIfKind(K.VariableDeclaration);
    const hook = decl && Node.isIdentifier(decl.getNameNode()) ? decl.getName() : null;
    const stmt = decl ? decl.getVariableStatement() : null;
    results.push({
      file: file,
      line: h.lineOf(call),
      level: level,
      hook: hook,
      exported: !!(stmt && stmt.isExported()),
      keys: keys,
      emptyKeys: emptyKeys,
      propsKeys: propsKeys,
      spreads: spreads,
      components: hook ? consumers(hook) : [],
    });
  }
  return results;
}

function analyzeAsyncEffects(sf, file, imports, h) {
  const { Node, K } = h;
  const b = h.bindingsFor(imports, (m) => m === 'react');
  const out = [];
  for (const call of sf.getDescendantsOfKind(K.CallExpression)) {
    const api = h.resolveRef(call.getExpression(), b);
    if (api !== 'useEffect' && api !== 'useLayoutEffect') continue;
    const fn = h.unwrap(call.getArguments()[0]);
    if (fn && (Node.isArrowFunction(fn) || Node.isFunctionExpression(fn)) && fn.isAsync()) {
      out.push({ file: file, line: h.lineOf(call), hook: api });
    }
  }
  return out;
}

function analyzeContextCrossing(sf, file, imports, srcFileSet, h) {
  const { Node, K } = h;
  const b = h.bindingsFor(imports, (m) => m === 'react');
  const out = [];

  const isInsideSrc = (spec) => {
    if (spec.startsWith('.')) return path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)).startsWith('src/');
    // baseUrl: "src" (CRA jsconfig) – "components/x" is inside src/
    return srcFileSet.has('src/' + spec);
  };

  for (const call of sf.getDescendantsOfKind(K.CallExpression)) {
    if (h.resolveRef(call.getExpression(), b) !== 'useContext') continue;
    const arg = h.unwrap(call.getArguments()[0]);
    if (!arg) continue;
    let local = null;
    let member = null;
    if (Node.isIdentifier(arg)) local = arg.getText();
    else if (Node.isPropertyAccessExpression(arg) && Node.isIdentifier(arg.getExpression())) {
      local = arg.getExpression().getText();
      member = arg.getName();
    }
    if (!local) continue;
    const imp = imports.find((i) => i.defaultLocal === local || i.namespaceLocal === local ||
      i.named.some((n) => n.local === local));
    if (!imp || isInsideSrc(imp.module)) continue;
    out.push({
      kind: 'useContext',
      file: file,
      line: h.lineOf(call),
      context: member ? local + '.' + member : local,
      module: imp.module,
    });
  }
  return out;
}

function analyzeExposedProps(sf, file, exposedAs, rules, h) {
  const { Node, K } = h;
  const out = [];
  let target = null;
  const fnDefault = sf.getFunctions().find((f) => f.isDefaultExport());
  const clsDefault = sf.getClasses().find((c) => c.isDefaultExport());
  if (fnDefault) target = fnDefault;
  else if (clsDefault) target = clsDefault;
  else {
    const ea = sf.getExportAssignments().find((e) => !e.isExportEquals());
    if (ea) target = h.resolveComponent(ea.getExpression(), sf);
  }
  if (!target) return { items: out, resolved: false };

  const componentName = (target.getName && target.getName()) ||
    (target.getParentIfKind(K.VariableDeclaration) ? target.getParent().getName() : 'default');
  const props = new Map(); // prop name -> { local, line }
  const typeOf = new Map(); // prop name -> type text
  const isClass = Node.isClassDeclaration(target) || Node.isClassExpression(target);

  const addTypeMembers = (typeNode) => {
    if (!typeNode) return;
    let members = null;
    if (Node.isTypeLiteral(typeNode)) members = typeNode.getMembers();
    else if (Node.isTypeReference(typeNode)) {
      const n = typeNode.getTypeName().getText();
      const iface = sf.getInterface(n);
      const alias = sf.getTypeAlias(n);
      if (iface) members = iface.getMembers();
      else if (alias && Node.isTypeLiteral(alias.getTypeNode())) members = alias.getTypeNode().getMembers();
    }
    (members || []).forEach((m) => {
      if (Node.isPropertySignature(m) && m.getTypeNode()) typeOf.set(m.getName(), m.getTypeNode().getText());
    });
  };

  const fromBinding = (pattern) => {
    pattern.getElements().forEach((el) => {
      if (el.getDotDotDotToken()) return;
      const name = el.getPropertyNameNode() ? el.getPropertyNameNode().getText() : el.getName();
      props.set(name, { local: el.getName(), line: h.lineOf(el) });
    });
  };

  // props.X / this.props.X and `const { a } = props`
  const fromObject = (scope, objText) => {
    scope.getDescendantsOfKind(K.PropertyAccessExpression).forEach((pa) => {
      if (pa.getExpression().getText() === objText && !props.has(pa.getName())) {
        props.set(pa.getName(), { local: null, line: h.lineOf(pa), access: objText + '.' + pa.getName() });
      }
    });
    scope.getDescendantsOfKind(K.VariableDeclaration).forEach((v) => {
      const init = v.getInitializer();
      if (init && init.getText() === objText && Node.isObjectBindingPattern(v.getNameNode())) fromBinding(v.getNameNode());
    });
  };

  if (isClass) {
    fromObject(target, 'this.props');
  } else {
    const param = target.getParameters()[0];
    if (param) {
      addTypeMembers(param.getTypeNode());
      const nameNode = param.getNameNode();
      if (Node.isObjectBindingPattern(nameNode)) fromBinding(nameNode);
      else fromObject(target, nameNode.getText());
    }
  }

  const elementType = new RegExp('(^|[^\\w.])(' + rules.reactElementTypes.map((t) => t.replace('.', '\\.')).join('|') + ')\\b');
  const jsxTags = target.getDescendants().filter((n) => Node.isJsxOpeningElement(n) || Node.isJsxSelfClosingElement(n))
    .map((n) => n.getTagNameNode().getText());
  const jsxChildExprs = target.getDescendantsOfKind(K.JsxExpression)
    .filter((e) => !Node.isJsxAttribute(e.getParent()) && e.getExpression())
    .map((e) => e.getExpression().getText());

  for (const [name, info] of props) {
    const refs = [info.local, info.access].filter(Boolean);
    let propKind = null;
    if (name === 'children') propKind = 'children';
    else if (refs.some((r) => jsxTags.indexOf(r) !== -1)) propKind = 'component';
    else if (refs.some((r) => jsxChildExprs.indexOf(r) !== -1)) propKind = 'element';
    else if (typeOf.has(name) && elementType.test(typeOf.get(name))) propKind = 'element';
    if (!propKind) continue;
    out.push({
      kind: 'exposedProp',
      file: file,
      line: info.line,
      exposedAs: exposedAs,
      component: componentName,
      prop: name,
      propKind: propKind,
      type: typeOf.get(name) || null,
    });
  }
  return { items: out, resolved: true };
}

function analyzeFederation(fs, root, project, h) {
  const { Node, K } = h;
  const configPath = path.join(root, 'webpack.config.js');
  const base = { configFile: null, configShape: null, plugin: false, role: 'standalone', name: null, filename: null, exposes: {}, remotes: {}, shared: null };
  if (!fs.existsSync(configPath)) return base;
  let text;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    throw new ScanError('לא ניתן לקרוא את webpack.config.js: ' + err.message);
  }
  const sf = project.createSourceFile('/__config__/webpack.config.js', text, { overwrite: true });
  const result = Object.assign({}, base, { configFile: 'webpack.config.js' });

  // module.exports = ... / export default ...
  let exported = null;
  for (const st of sf.getStatements()) {
    if (Node.isExpressionStatement(st)) {
      const e = st.getExpression();
      if (Node.isBinaryExpression(e) && e.getOperatorToken().getKind() === K.EqualsToken &&
          e.getLeft().getText() === 'module.exports') exported = e.getRight();
    } else if (Node.isExportAssignment(st)) exported = st.getExpression();
  }
  let shapeNode = exported ? h.unwrap(exported) : null;
  if (shapeNode && Node.isIdentifier(shapeNode)) {
    const name = shapeNode.getText();
    shapeNode = sf.getFunction(name) || (sf.getVariableDeclaration(name) && h.unwrap(sf.getVariableDeclaration(name).getInitializer())) || shapeNode;
  }
  if (!shapeNode) result.configShape = 'unknown';
  else if (Node.isArrowFunction(shapeNode) || Node.isFunctionExpression(shapeNode) || Node.isFunctionDeclaration(shapeNode)) result.configShape = 'function';
  else if (Node.isObjectLiteralExpression(shapeNode)) result.configShape = 'object';
  else if (Node.isArrayLiteralExpression(shapeNode)) result.configShape = 'array';
  else result.configShape = 'unknown';

  // Local aliases: const MFP = require(".../ModuleFederationPlugin") / { ModuleFederationPlugin: MFP } = ...
  const MFP_RE = /(^|[.\/])ModuleFederationPlugin\b/;
  const aliases = new Set(['ModuleFederationPlugin']);
  sf.getDescendantsOfKind(K.VariableDeclaration).forEach((v) => {
    const init = v.getInitializer();
    if (Node.isIdentifier(v.getNameNode()) && init && MFP_RE.test(init.getText())) aliases.add(v.getName());
  });
  sf.getDescendantsOfKind(K.BindingElement).forEach((el) => {
    const prop = el.getPropertyNameNode();
    if (prop && prop.getText() === 'ModuleFederationPlugin') aliases.add(el.getName());
  });
  const plugins = sf.getDescendantsOfKind(K.NewExpression).filter((n) => {
    const text = n.getExpression().getText();
    return aliases.has(text) || /(^|\.)ModuleFederationPlugin$/.test(text);
  });
  if (plugins.length === 0) return result;
  result.plugin = true;
  result.pluginLine = h.lineOf(plugins[0]);
  if (plugins.length > 1) result.pluginCount = plugins.length;

  const opts = h.resolveIdentifierInit(plugins[0].getArguments()[0], sf);
  if (!opts || !Node.isObjectLiteralExpression(opts)) {
    result.role = 'unknown';
    result.optionsExpression = opts ? opts.getText() : null;
    return result;
  }
  const get = (key) => {
    const p = opts.getProperties().find((x) => !Node.isSpreadAssignment(x) && h.propName(x) === key);
    if (!p) return null;
    if (Node.isShorthandPropertyAssignment(p)) return h.resolveIdentifierInit(p.getNameNode(), sf);
    return Node.isPropertyAssignment(p) ? h.resolveIdentifierInit(p.getInitializer(), sf) : null;
  };

  result.name = h.describe(get('name'), sf);
  result.filename = h.describe(get('filename'), sf);
  const exposesNode = get('exposes');
  const remotesNode = get('remotes');
  result.exposes = exposesNode ? h.describe(exposesNode, sf) : {};
  result.remotes = remotesNode ? h.describe(remotesNode, sf) : {};

  const count = (node, described) => {
    if (!node) return 0;
    if (Node.isObjectLiteralExpression(node)) return Object.keys(described).filter((k) => k !== '...').length + (described['...'] ? described['...'].length : 0);
    return 1; // identifier / call – present but opaque
  };
  const hasExposes = count(exposesNode, result.exposes) > 0;
  const hasRemotes = count(remotesNode, result.remotes) > 0;
  result.role = hasExposes && hasRemotes ? 'hybrid' : hasExposes ? 'remote' : hasRemotes ? 'host' : 'standalone';

  const sharedNode = get('shared');
  if (sharedNode) {
    if (Node.isObjectLiteralExpression(sharedNode)) {
      const d = h.describe(sharedNode, sf);
      const spreads = d['...'] || [];
      delete d['...'];
      result.shared = { kind: 'object', spreads: spreads, keys: Object.keys(d), entries: d };
    } else if (Node.isArrayLiteralExpression(sharedNode)) {
      result.shared = { kind: 'array', items: sharedNode.getElements().map((e) => h.describe(e, sf)) };
    } else if (Node.isCallExpression(sharedNode)) {
      const callee = sharedNode.getExpression().getText();
      result.shared = {
        kind: 'call',
        callee: callee,
        arguments: sharedNode.getArguments().map((a) => h.describe(a, sf)),
        buildSharedGen1: /(^|\.)buildSharedGen1$/.test(callee),
      };
    } else {
      result.shared = { kind: 'expression', expression: sharedNode.getText() };
    }
  }
  return result;
}

function resolveModuleFile(fs, root, spec) {
  const base = path.resolve(root, spec);
  const exts = ['', '.js', '.jsx', '.ts', '.tsx'];
  for (const e of exts) {
    if (fs.existsSync(base + e) && fs.statSync(base + e).isFile()) return base + e;
  }
  for (const e of exts.slice(1)) {
    const idx = path.join(base, 'index' + e);
    if (fs.existsSync(idx)) return idx;
  }
  return null;
}

function checkDenyList(fs, root, pkg, denyList) {
  const out = [];
  for (const entry of denyList.packages) {
    const sections = ['dependencies', 'devDependencies'].filter((s) => pkg[s] && pkg[s][entry.name]);
    if (sections.length === 0) continue;
    const range = pkg[sections[0]][entry.name];
    const installed = installedVersion(fs, root, entry.name);
    const checked = installed || minVersion(range);
    let incompatible;
    let uncertain = false;
    if (entry.range === '*') incompatible = true;
    else {
      const limit = parseVersion(entry.range.replace(/^</, ''));
      if (!checked) { incompatible = true; uncertain = true; }
      else incompatible = compareVersions(parseVersion(checked), limit) < 0;
    }
    if (!incompatible) continue;
    out.push({
      package: entry.name,
      sections: sections,
      range: range,
      installedVersion: installed,
      checkedVersion: checked,
      incompatibleRange: entry.range,
      fixedIn: entry.fixedIn,
      alternative: entry.alternative || null,
      reason: entry.reason,
      uncertain: uncertain,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main scan

function scan(root, deps) {
  const fs = deps.fs;
  let tsm;
  try {
    tsm = deps.tsMorph || require('ts-morph');
  } catch (_) {
    throw new ScanError('ts-morph אינו מותקן בתיקיית הסקיל – הרץ npm install ב-' + path.join(__dirname, '..'));
  }
  const h = astHelpers(tsm);
  const realFs = require('fs');
  const rules = readJson(realFs, path.join(REFERENCE_DIR, 'scan-rules.json'), 'reference/scan-rules.json');
  const denyList = readJson(realFs, path.join(REFERENCE_DIR, 'deny-list.json'), 'reference/deny-list.json');
  const targets = readJson(realFs, path.join(REFERENCE_DIR, 'versions.json'), 'reference/versions.json');

  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) throw new ScanError('package.json לא נמצא בשורש (' + root + ')');
  const pkg = readJson(fs, pkgPath, 'package.json');

  const files = listSourceFiles(fs, root, rules);
  const project = new tsm.Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, jsx: tsm.ts.JsxEmit.Preserve },
  });

  const relFiles = files.map((f) => toPosix(path.relative(root, f)));
  const srcFileSet = new Set();
  relFiles.forEach((r) => {
    srcFileSet.add(r);
    const noExt = r.replace(/\.[jt]sx?$/, '');
    srcFileSet.add(noExt);
    if (/\/index$/.test(noExt)) srcFileSet.add(noExt.replace(/\/index$/, ''));
  });

  const inv = {
    muiFiles: [], makeStyles: [], asyncEffects: [], reactDomApi: [], react18Only: [],
    routerUsages: [], routerPost602: [], pickers: [], contextCrossing: [],
  };
  const routerTest = (m) => rules.router.modules.indexOf(m) !== -1;
  const pickerTest = (m) => rules.pickerModulePrefixes.some((p) => m === p || m.startsWith(p + '/') || m.startsWith(p + '-'));
  const sourceFiles = new Map();

  files.forEach((full, i) => {
    const file = relFiles[i];
    let text;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch (err) {
      throw new ScanError('לא ניתן לקרוא את ' + file + ': ' + err.message);
    }
    const sf = project.createSourceFile('/' + file, text, { overwrite: true });
    sourceFiles.set(file, sf);
    const imports = h.collectImports(sf);

    // @material-ui imports and re-exports
    const mui = imports.filter((imp) => imp.module.startsWith('@material-ui/')).map((imp) => ({
      module: imp.module, line: imp.line, names: imp.named.map((n) => n.name),
      default: imp.defaultLocal, namespace: imp.namespaceLocal,
    }));
    sf.getExportDeclarations().forEach((ed) => {
      const m = ed.getModuleSpecifierValue();
      if (m && m.startsWith('@material-ui/')) {
        mui.push({ module: m, line: h.lineOf(ed), names: ed.getNamedExports().map((n) => n.getName()), default: null, namespace: null, reexport: true });
      }
    });
    if (mui.length) inv.muiFiles.push({ file: file, imports: mui });

    inv.makeStyles.push.apply(inv.makeStyles, analyzeMakeStyles(sf, file, imports, rules, h));
    inv.asyncEffects.push.apply(inv.asyncEffects, analyzeAsyncEffects(sf, file, imports, h));

    h.findUsages(sf, imports, (m) => m === 'react-dom', rules.reactDomLegacyApis)
      .forEach((u) => inv.reactDomApi.push(Object.assign({ file: file }, u)));
    h.findUsages(sf, imports, (m) => m === 'react', rules.react18OnlyHooks)
      .forEach((u) => inv.react18Only.push(Object.assign({ file: file }, u)));
    h.findUsages(sf, imports, routerTest, rules.router.legacyApis)
      .forEach((u) => inv.routerUsages.push(Object.assign({ file: file }, u)));
    h.findUsages(sf, imports, routerTest, rules.router.post602Apis)
      .forEach((u) => inv.routerPost602.push(Object.assign({ file: file }, u)));

    // Route props: component= / render= / exact (legacy), loader= / action= (post 6.0.2)
    const rb = h.bindingsFor(imports, routerTest);
    if (rb.named.size || rb.ns.size) {
      sf.getDescendants().forEach((n) => {
        if (!h.Node.isJsxOpeningElement(n) && !h.Node.isJsxSelfClosingElement(n)) return;
        const element = h.resolveRef(n.getTagNameNode(), rb);
        if (!element) return;
        const legacy = rules.router.legacyProps[element] || [];
        const post = rules.router.post602Props[element] || [];
        n.getAttributes().forEach((a) => {
          if (!h.Node.isJsxAttribute(a)) return;
          const name = a.getNameNode().getText();
          const entry = { file: file, line: h.lineOf(a), api: element + '[' + name + ']', kind: 'prop', element: element, prop: name };
          if (legacy.indexOf(name) !== -1) inv.routerUsages.push(entry);
          if (post.indexOf(name) !== -1) inv.routerPost602.push(entry);
        });
      });
    }

    imports.filter((imp) => pickerTest(imp.module)).forEach((imp) => inv.pickers.push({
      file: file, line: imp.line, module: imp.module, names: imp.named.map((n) => n.name), default: imp.defaultLocal,
    }));

    inv.contextCrossing.push.apply(inv.contextCrossing, analyzeContextCrossing(sf, file, imports, srcFileSet, h));
  });

  const sortByLoc = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);
  inv.routerUsages.sort(sortByLoc);
  inv.routerPost602.sort(sortByLoc);

  const federation = analyzeFederation(fs, root, project, h);
  const warnings = [];

  // Props / children on the exposed API
  Object.keys(federation.exposes || {}).forEach((key) => {
    const target = federation.exposes[key];
    if (key === '...' || typeof target !== 'string') return;
    const full = resolveModuleFile(fs, root, target);
    if (!full) {
      warnings.push({ kind: 'exposes', message: 'הקובץ החשוף ' + target + ' (' + key + ') לא נמצא' });
      return;
    }
    const rel = toPosix(path.relative(root, full));
    let sf = sourceFiles.get(rel);
    if (!sf) {
      let text;
      try { text = fs.readFileSync(full, 'utf8'); } catch (err) { throw new ScanError('לא ניתן לקרוא את ' + rel + ': ' + err.message); }
      sf = project.createSourceFile('/' + rel, text, { overwrite: true });
    }
    const res = analyzeExposedProps(sf, rel, key, rules, h);
    if (!res.resolved) warnings.push({ kind: 'exposes', file: rel, message: 'לא זוהתה קומפוננטת default ב-' + rel + ' – בדוק ידנית props של ה-API החשוף' });
    inv.contextCrossing.push.apply(inv.contextCrossing, res.items);
  });

  inv.react18Only.forEach((u) => warnings.push({
    kind: 'react18Only', file: u.file, line: u.line,
    message: u.api + ' אינו קיים ב-React 17 – תחת Host ישן הקוד ירוץ על React 17 וייכשל',
  }));
  inv.routerPost602.forEach((u) => warnings.push({
    kind: 'routerPost602', file: u.file, line: u.line,
    message: u.api + ' נוסף אחרי react-router 6.0.2 – יישבר תחת Host ישן',
  }));
  inv.makeStyles.filter((m) => m.level === 'unknown').forEach((m) => warnings.push({
    kind: 'makeStyles', file: m.file, line: m.line, message: 'לא ניתן לזהות את אובייקט הסגנונות של makeStyles',
  }));
  if (federation.configShape === 'unknown') warnings.push({ kind: 'federation', message: 'מבנה webpack.config.js לא זוהה' });
  if (federation.plugin && federation.role === 'unknown') warnings.push({ kind: 'federation', message: 'אפשרויות ModuleFederationPlugin אינן אובייקט ליטרלי' });

  const depsRange = (name) => (pkg.dependencies && pkg.dependencies[name]) || (pkg.devDependencies && pkg.devDependencies[name]) || null;
  const versionInfo = (name) => ({
    range: depsRange(name),
    installed: installedVersion(fs, root, name),
    target: exactVersion(targets.dependencies && targets.dependencies[name]),
  });

  return {
    inventory: {
      schemaVersion: SCHEMA_VERSION,
      service: { name: pkg.name || null, version: pkg.version || null },
      filesScanned: files.length,
      react: versionInfo('react'),
      deps: {
        dependencies: Object.assign({}, pkg.dependencies),
        devDependencies: Object.assign({}, pkg.devDependencies),
      },
      blockers: checkDenyList(fs, root, pkg, denyList),
      muiFiles: inv.muiFiles,
      makeStyles: inv.makeStyles,
      asyncEffects: inv.asyncEffects,
      reactDomApi: inv.reactDomApi,
      react18Only: inv.react18Only,
      routerVersion: versionInfo('react-router-dom'),
      routerUsages: inv.routerUsages,
      routerPost602: inv.routerPost602,
      federation: federation,
      pickers: inv.pickers,
      contextCrossing: inv.contextCrossing,
      scripts: Object.assign({}, pkg.scripts),
      warnings: warnings,
    },
  };
}

// ---------------------------------------------------------------------------
// Output

function countBy(list, fn) {
  const m = new Map();
  list.forEach((x) => { const k = fn(x); m.set(k, (m.get(k) || 0) + 1); });
  return m;
}

function formatText(res) {
  const L = [];
  if (res.result === 'BLOCKED') {
    L.push('⛔ הסריקה נכשלה');
    res.blockers.forEach((b) => L.push('   ' + b.message));
    L.push('RESULT: BLOCKED');
    return L.join('\n') + '\n';
  }
  const inv = res.inventory;
  const pad = '   ';
  const react = inv.react;
  L.push('📦 ' + (inv.service.name || '(ללא שם)'));
  L.push(pad + 'React ' + (react.installed || minVersion(react.range) || react.range || '?') + ' → ' + (react.target || '?'));
  L.push(pad + inv.filesScanned + ' קבצים נסרקו');

  const muiPkgs = countBy(inv.muiFiles.reduce((acc, f) => acc.concat(
    Array.from(new Set(f.imports.map((i) => i.module.split('/').slice(0, 2).join('/'))))), []), (x) => x);
  Array.from(muiPkgs.keys()).sort().forEach((p) => L.push(pad + muiPkgs.get(p) + ' קבצים עם ' + p));

  if (inv.makeStyles.length) {
    const lv = countBy(inv.makeStyles, (m) => m.level);
    const parts = ['static', 'theme', 'props', 'unknown'].filter((k) => k !== 'unknown' || lv.get(k))
      .map((k) => (lv.get(k) || 0) + ' ' + k);
    L.push(pad + inv.makeStyles.length + ' מופעי makeStyles: ' + parts.join(' | '));
    const empty = inv.makeStyles.reduce((n, m) => n + m.emptyKeys.length, 0);
    if (empty) L.push(pad + '🧹 ' + empty + ' מפתחות ריקים/מוערים ב-makeStyles');
  } else {
    L.push(pad + 'אין מופעי makeStyles');
  }
  if (inv.asyncEffects.length) L.push(pad + '⏳ ' + inv.asyncEffects.length + ' useEffect עם פונקציה async');
  if (inv.reactDomApi.length) {
    const c = countBy(inv.reactDomApi, (u) => u.api);
    L.push(pad + '🧩 ReactDOM legacy: ' + Array.from(c.keys()).map((k) => k + ' ×' + c.get(k)).join(', '));
  }

  const rv = inv.routerVersion;
  if (rv.range) {
    const c = countBy(inv.routerUsages, (u) => u.api);
    const legacy = Array.from(c.keys()).map((k) => k + ' ×' + c.get(k)).join(', ');
    L.push(pad + '🧭 react-router-dom ' + rv.range + ' → ' + (rv.target || '?') +
      (legacy ? ' | v5 API: ' + legacy : ''));
  }

  const fed = inv.federation;
  if (!fed.configFile) L.push(pad + '🔗 federation: אין webpack.config.js → standalone');
  else if (!fed.plugin) L.push(pad + '🔗 federation: standalone (אין ModuleFederationPlugin) | config: ' + fed.configShape);
  else {
    let shared = '-';
    if (fed.shared) {
      if (fed.shared.kind === 'object') shared = 'object' + (fed.shared.spreads.length ? ' (...' + fed.shared.spreads.join(', ...') + ')' : '') + (fed.shared.keys.length ? ' + ' + fed.shared.keys.join(', ') : '');
      else if (fed.shared.kind === 'call') shared = fed.shared.callee + '()';
      else shared = fed.shared.kind;
    }
    L.push(pad + '🔗 federation: ' + fed.role + ' | config: ' + fed.configShape +
      ' | exposes: ' + (Object.keys(fed.exposes).join(', ') || '-') +
      ' | remotes: ' + (Object.keys(fed.remotes).join(', ') || '-') + ' | shared: ' + shared);
  }

  if (inv.pickers.length) {
    const c = countBy(inv.pickers, (p) => p.module.split('/').slice(0, 2).join('/'));
    L.push(pad + '📅 pickers: ' + Array.from(c.keys()).map((k) => k + ' ×' + c.get(k)).join(', '));
  }
  if (inv.contextCrossing.length) {
    const ctx = inv.contextCrossing.filter((c) => c.kind === 'useContext').length;
    const props = inv.contextCrossing.filter((c) => c.kind === 'exposedProp');
    L.push(pad + '🔀 חציית גבול: ' + ctx + ' useContext חיצוני' +
      (props.length ? ' | props ב-API החשוף: ' + props.map((p) => p.prop + ' (' + p.propKind + ')').join(', ') : ''));
  }
  if (inv.blockers.length) {
    L.push(pad + '⛔ ' + inv.blockers.length + ' חבילות לא תואמות React 18:');
    inv.blockers.forEach((b) => L.push(pad + '   ' + b.package + ' ' + b.range + ' → ' +
      (b.fixedIn || b.alternative || '?') + (b.uncertain ? ' (גרסה לא ודאית)' : '')));
  }
  if (inv.warnings.length) {
    L.push(pad + '⚠️ ' + inv.warnings.length + ' אזהרות:');
    inv.warnings.forEach((w) => L.push(pad + '   ' + (w.file ? w.file + (w.line ? ':' + w.line : '') + ' – ' : '') + w.message));
  }
  L.push(pad + '💾 ' + res.outputStatus);
  res.notes.forEach((n) => L.push(pad + 'הערה: ' + n));
  L.push('RESULT: ' + res.result);
  return L.join('\n') + '\n';
}

function run(argv, overrides) {
  const deps = Object.assign({ fs: require('fs'), cwd: process.cwd(), tsMorph: null }, overrides || {});
  const opts = parseArgs(argv || []);
  const base = { script: SCRIPT, result: 'OK', changes: [], manual: [], blockers: [], notes: [] };
  const outAbs = path.resolve(deps.cwd, opts.out);
  const outRel = toPosix(path.relative(deps.cwd, outAbs));

  if (opts.errors.length) {
    return Object.assign(base, { result: 'BLOCKED', blockers: opts.errors.map((m) => ({ message: m })) });
  }

  let scanned;
  try {
    scanned = scan(deps.cwd, deps);
  } catch (err) {
    if (err instanceof ScanError) return Object.assign(base, { result: 'BLOCKED', blockers: [{ message: err.message }] });
    throw err;
  }
  const inventory = scanned.inventory;
  const content = JSON.stringify(inventory, null, 2) + '\n';

  let existing = null;
  try { existing = deps.fs.readFileSync(outAbs, 'utf8'); } catch (_) { existing = null; }
  const unchanged = existing === content;

  let outputStatus;
  if (unchanged) {
    outputStatus = outRel + ' לא השתנה';
  } else if (opts.dryRun) {
    outputStatus = '[dry-run] היה נכתב: ' + outRel;
    base.changes.push({ file: outRel, rule: 'SCAN.INVENTORY', confidence: 'auto' });
  } else {
    try {
      deps.fs.mkdirSync(path.dirname(outAbs), { recursive: true });
      deps.fs.writeFileSync(outAbs, content, 'utf8');
    } catch (err) {
      return Object.assign(base, { result: 'BLOCKED', blockers: [{ message: 'לא ניתן לכתוב את ' + outRel + ': ' + err.message }] });
    }
    outputStatus = 'נכתב: ' + outRel;
    base.changes.push({ file: outRel, rule: 'SCAN.INVENTORY', confidence: 'auto' });
  }

  inventory.warnings.filter((w) => w.file && w.line).forEach((w) => {
    base.manual.push({ file: w.file, line: w.line, reason: w.message });
  });
  return Object.assign(base, { output: outRel, outputStatus: outputStatus, inventory: inventory });
}

function main(argv, deps, io) {
  io = io || {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  };
  try {
    const opts = parseArgs(argv || []);
    const res = run(argv, deps);
    io.stdout(opts.json ? JSON.stringify(res, null, 2) + '\n' : formatText(res));
    return 0;
  } catch (err) {
    io.stderr('scan crashed: ' + ((err && err.stack) || err) + '\n');
    return 1;
  }
}

if (require.main === module) {
  const code = main(process.argv.slice(2));
  process.stdout.write('', () => process.exit(code));
}

module.exports = { run: run, main: main, scan: scan, formatText: formatText, parseArgs: parseArgs, minVersion: minVersion };
