#!/usr/bin/env node
'use strict';

// codemod-makestyles: makeStyles (JSS) → plain style objects consumed through sx / slotProps.
//   A static  makeStyles({...})            → const styles = {...}
//   B theme   makeStyles(theme => ({...})) → const styles = { key: (theme) => ({...}) }  (theme.spacing(n) → sx shorthand)
//   C props   any rule depends on props    → not converted (manual)
// Call-sites are rewritten per reference/mui-slots.json. Each makeStyles instance is all-or-nothing, and the whole
// file is validated (parses, same number of CSS keys, every styles.<key> exists) before it is written.
// ts-morph only; edits are position-based so everything else in the file stays byte-for-byte identical.

const path = require('path');

const SCRIPT = 'codemod-makestyles';
const REFERENCE_DIR = path.join(__dirname, '..', 'reference');
const SOURCE_EXTS = ['.js', '.jsx', '.ts', '.tsx'];
const SKIP_DIRS = new Set(['node_modules', 'build', 'dist']);
const MAKESTYLES_MODULES = ['@material-ui/core', '@material-ui/core/styles', '@material-ui/styles', '@mui/styles'];
const MUI_MODULE = /^@(mui\/(material|lab)|material-ui\/(core|lab))(\/|$)/;
const BOX_MODULES = ['@mui/material', '@mui/material/Box'];

class CodemodError extends Error {}
class Manual extends Error {
  constructor(message, line) { super(message); this.line = line; }
}
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

// base: offset of `text` inside the file, so a conflict in a slice still reports a file position
function applyEdits(text, edits, base) {
  const sorted = edits.slice().sort((a, b) => b.start - a.start || b.end - a.end);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].end > sorted[i - 1].start) throw new EditConflict((base || 0) + sorted[i - 1].start);
  }
  return sorted.reduce((t, e) => t.slice(0, e.start) + e.text + t.slice(e.end), text);
}

// Whole line(s) of a statement incl. a trailing // comment on the same line and the line break.
function wholeLineRange(text, start, end) {
  const ls = text.lastIndexOf('\n', start - 1) + 1;
  const s = /^[ \t]*$/.test(text.slice(ls, start)) ? ls : start;
  let e = end;
  while (e < text.length && (text[e] === ' ' || text[e] === '\t')) e++;
  if (text.startsWith('//', e)) while (e < text.length && text[e] !== '\n' && text[e] !== '\r') e++;
  if (text[e] === '\r') e++;
  if (text[e] === '\n') e++;
  return { start: s, end: e };
}

const quoteKey = (s) => "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";

// ---------------------------------------------------------------------------

function transformFile(tsm, sf, file, table, rules, apply) {
  apply = apply || applyEdits;
  const { Node, SyntaxKind: K } = tsm;
  const text = sf.getFullText();
  const eol = text.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  const changes = [];
  const manual = [];
  const FN_KINDS = new Set([K.ArrowFunction, K.FunctionExpression, K.FunctionDeclaration, K.MethodDeclaration]);
  const ownerFn = (n) => n.getFirstAncestor((a) => FN_KINDS.has(a.getKind()));
  const unwrap = (n) => {
    while (n && (Node.isParenthesizedExpression(n) || Node.isAsExpression(n) || Node.isTypeAssertion(n) ||
      (Node.isSatisfiesExpression && Node.isSatisfiesExpression(n)))) n = n.getExpression();
    return n;
  };
  const propName = (p) => {
    const n = p.getNameNode && p.getNameNode();
    if (!n) return null;
    if (Node.isIdentifier(n)) return n.getText();
    if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) return n.getLiteralText();
    if (Node.isNumericLiteral(n)) return n.getText();
    return null; // computed
  };
  const isReference = (id) => {
    const p = id.getParent();
    if (!p || id.getFirstAncestorByKind(K.ImportDeclaration)) return false;
    if (Node.isPropertyAccessExpression(p) && p.getNameNode() === id) return false;
    if ((Node.isPropertyAssignment(p) || Node.isMethodDeclaration(p) || Node.isPropertySignature(p)) && p.getNameNode() === id) return false;
    if (Node.isJsxAttribute(p) || Node.isJsxClosingElement(p)) return false;
    if ((Node.isVariableDeclaration(p) || Node.isFunctionDeclaration(p) || Node.isParameterDeclaration(p) || Node.isClassDeclaration(p)) && p.getNameNode() === id) return false;
    if (Node.isBindingElement(p)) return p.getInitializer() === id;
    return true;
  };

  // ---- imports ----
  const imports = sf.getImportDeclarations();
  const msNamed = new Map(); // local -> exported (makeStyles / createStyles)
  const msNs = new Set();
  imports.filter((d) => MAKESTYLES_MODULES.indexOf(d.getModuleSpecifierValue()) !== -1).forEach((d) => {
    if (d.getDefaultImport()) msNs.add(d.getDefaultImport().getText());
    if (d.getNamespaceImport()) msNs.add(d.getNamespaceImport().getText());
    d.getNamedImports().forEach((s) => msNamed.set(s.getAliasNode() ? s.getAliasNode().getText() : s.getName(), s.getName()));
  });
  const msApi = (callee) => {
    if (Node.isIdentifier(callee)) return msNamed.get(callee.getText()) || null;
    if (Node.isPropertyAccessExpression(callee) && Node.isIdentifier(callee.getExpression()) && msNs.has(callee.getExpression().getText())) return callee.getName();
    return null;
  };
  const calls = sf.getDescendantsOfKind(K.CallExpression).filter((c) => msApi(c.getExpression()) === 'makeStyles');
  if (!calls.length) return { text: null, changes: changes, manual: manual, found: 0 };

  // JSX tag → MUI component name (via its import), or null
  const muiComponentOf = (tagText) => {
    const local = tagText.split('.')[0];
    for (const d of imports) {
      const m = d.getModuleSpecifierValue();
      if (!MUI_MODULE.test(m)) continue;
      const named = d.getNamedImports().find((s) => (s.getAliasNode() ? s.getAliasNode().getText() : s.getName()) === local);
      if (named) return named.getName();
      if (d.getDefaultImport() && d.getDefaultImport().getText() === local) {
        const seg = m.split('/')[2];
        return seg || null;
      }
    }
    return null;
  };
  const isV4Import = (tagText) => imports.some((d) => /^@material-ui\//.test(d.getModuleSpecifierValue()) &&
    (d.getNamedImports().some((s) => (s.getAliasNode() ? s.getAliasNode().getText() : s.getName()) === tagText) ||
     (d.getDefaultImport() && d.getDefaultImport().getText() === tagText)));

  const usedNames = new Set(sf.getDescendantsOfKind(K.Identifier).map((i) => i.getText()));
  const uniqueName = (base) => { let n = base; for (let i = 2; usedNames.has(n); i++) n = base + i; usedNames.add(n); return n; };

  const deepKeyCount = (obj) => obj.getDescendants().filter((n) => Node.isPropertyAssignment(n) || Node.isShorthandPropertyAssignment(n) ||
    Node.isSpreadAssignment(n) || Node.isMethodDeclaration(n)).length;

  const isJssOnly = (name) => name !== null && (rules.jssOnly.contains.some((c) => name.indexOf(c) !== -1) ||
    rules.jssOnly.startsWith.some((c) => name.startsWith(c)) || rules.jssOnly.exact.indexOf(name) !== -1);

  // =========================================================================
  // 1. analyse every makeStyles instance
  function analyse(call) {
    const line = call.getStartLineNumber();
    const decl = call.getParentIfKind(K.VariableDeclaration);
    if (!decl || !Node.isIdentifier(decl.getNameNode())) throw new Manual('makeStyles שאינו מוצב ב-const useX = makeStyles(...)', line);
    const stmt = decl.getVariableStatement();
    if (!stmt || stmt.getDeclarations().length !== 1 || stmt.getParent() !== sf) throw new Manual('makeStyles שאינו הצהרה עצמאית ברמת המודול', line);
    if (stmt.isExported()) throw new Manual(decl.getName() + ' מיוצא – ייתכן שימוש מקבצים אחרים', line);

    const args = call.getArguments();
    let styleArg = unwrap(args[0]);
    if (styleArg && Node.isCallExpression(styleArg) && msApi(styleArg.getExpression()) === 'createStyles') styleArg = unwrap(styleArg.getArguments()[0]);
    let obj = null;
    let themeFn = null;
    if (styleArg && Node.isObjectLiteralExpression(styleArg)) obj = styleArg;
    else if (styleArg && (Node.isArrowFunction(styleArg) || Node.isFunctionExpression(styleArg))) {
      themeFn = styleArg;
      const params = styleArg.getParameters();
      if (params.length !== 1 || !Node.isIdentifier(params[0].getNameNode())) throw new Manual('פונקציית theme עם פרמטר מפורק / ללא פרמטר', line);
      let body = Node.isArrowFunction(styleArg) ? unwrap(styleArg.getBody()) : null;
      if (body && Node.isCallExpression(body) && msApi(body.getExpression()) === 'createStyles') body = unwrap(body.getArguments()[0]);
      if (!body || !Node.isObjectLiteralExpression(body)) throw new Manual('פונקציית theme עם גוף בלוק / חישובים מקומיים', line);
      obj = body;
    } else {
      throw new Manual('הארגומנט של makeStyles אינו אובייקט או פונקציית theme', line);
    }

    const keys = [];
    const emptyKeys = new Set();
    const propsKeys = [];
    const issues = [];
    const scanRule = (o, top) => {
      o.getProperties().forEach((p) => {
        if (!Node.isPropertyAssignment(p)) {
          if (Node.isMethodDeclaration(p)) propsKeys.push(top);
          else issues.push(p.getKindName() + ' בתוך ' + top);
          return;
        }
        const name = propName(p);
        if (isJssOnly(name)) issues.push("מפתח JSS '" + name + "' ב-" + top);
        const v = unwrap(p.getInitializer());
        if (Node.isArrowFunction(v) || Node.isFunctionExpression(v)) propsKeys.push(top);
        else if (Node.isArrayLiteralExpression(v)) issues.push('מערך ערכים (fallback של JSS) ב-' + top + '.' + name + ' – ב-sx מערך הוא ערך רספונסיבי');
        else if (Node.isObjectLiteralExpression(v)) scanRule(v, top);
      });
    };
    for (const p of obj.getProperties()) {
      const name = Node.isPropertyAssignment(p) ? propName(p) : null;
      if (!name) throw new Manual('מפתח עליון מסוג ' + p.getKindName() + ' (spread / מחושב / method)', line);
      if (isJssOnly(name)) throw new Manual("מפתח JSS '" + name + "'", line);
      const v = unwrap(p.getInitializer());
      if (Node.isArrowFunction(v) || Node.isFunctionExpression(v)) { propsKeys.push(name); keys.push({ name: name, prop: p, value: v }); continue; }
      if (!Node.isObjectLiteralExpression(v)) throw new Manual('הערך של ' + name + ' אינו אובייקט', line);
      if (v.getProperties().length === 0) emptyKeys.add(name);
      scanRule(v, name);
      keys.push({ name: name, prop: p, value: v });
    }
    if (propsKeys.length) {
      const uniq = Array.from(new Set(propsKeys));
      throw new Manual('רמה C – המפתחות ' + uniq.join(', ') + ' תלויים ב-props (ערך שהוא פונקציה). דורש המרה ידנית ל-sx עם ערכים מחושבים או ל-styled', line);
    }
    if (issues.length) throw new Manual(issues[0], line);

    const hookName = decl.getName();
    const m = /^use(\w*)Styles$/.exec(hookName);
    const base = m ? (m[1] ? m[1].charAt(0).toLowerCase() + m[1].slice(1) + 'Styles' : 'styles') : hookName.replace(/^use/, '').replace(/^./, (c) => c.toLowerCase()) || 'styles';
    return {
      call: call, line: line, stmt: stmt, decl: decl, obj: obj, themeFn: themeFn, keys: keys, emptyKeys: emptyKeys,
      hookName: hookName, stylesBase: base, options: args.length > 1 ? args[1] : null,
      level: themeFn ? 'theme' : 'static', beforeCount: deepKeyCount(obj),
    };
  }

  // 2. find the call-sites of an instance: const classes = useStyles() and every classes.<key>
  function collectUsages(inst) {
    const usages = [];
    const classesStmts = [];
    const refs = sf.getDescendantsOfKind(K.Identifier).filter((id) => id.getText() === inst.hookName && id !== inst.decl.getNameNode() && isReference(id));
    for (const id of refs) {
      const call = id.getParent();
      if (!Node.isCallExpression(call) || call.getExpression() !== id) throw new Manual(inst.hookName + ' בשימוש שאינו קריאה (שורה ' + id.getStartLineNumber() + ')', inst.line);
      const vd = call.getParentIfKind(K.VariableDeclaration);
      const vs = vd && vd.getVariableStatement();
      if (!vd || !vs || vs.getDeclarations().length !== 1) throw new Manual('תוצאת ' + inst.hookName + '() אינה מוצבת ב-const classes (שורה ' + call.getStartLineNumber() + ')', inst.line);
      classesStmts.push(vs);
      const scope = ownerFn(vd) || sf;
      const nameNode = vd.getNameNode();
      const bindings = [];
      if (Node.isIdentifier(nameNode)) bindings.push({ local: nameNode.getText(), key: null, decl: nameNode });
      else if (Node.isObjectBindingPattern(nameNode)) {
        nameNode.getElements().forEach((el) => {
          if (el.getDotDotDotToken()) throw new Manual('...rest מתוך ' + inst.hookName + '()', inst.line);
          bindings.push({ local: el.getName(), key: el.getPropertyNameNode() ? el.getPropertyNameNode().getText() : el.getName(), decl: el.getNameNode() });
        });
      } else throw new Manual('תבנית פירוק לא נתמכת', inst.line);

      for (const b of bindings) {
        const ids = scope.getDescendantsOfKind(K.Identifier).filter((x) => x.getText() === b.local && x !== b.decl && isReference(x));
        for (const x of ids) {
          let node = x;
          let key = b.key;
          if (key === null) {
            const p = x.getParent();
            if (Node.isPropertyAccessExpression(p) && p.getExpression() === x) { node = p; key = p.getName(); }
            else if (Node.isElementAccessExpression(p) && p.getExpression() === x && Node.isStringLiteral(p.getArgumentExpression())) { node = p; key = p.getArgumentExpression().getLiteralText(); }
            else throw new Manual(b.local + ' מועבר כאובייקט שלם (שורה ' + x.getStartLineNumber() + ') – לא ניתן להמיר', inst.line);
          }
          if (!inst.keys.some((k) => k.name === key)) throw new Manual(b.local + '.' + key + ' אינו מוגדר ב-makeStyles (שורה ' + x.getStartLineNumber() + ')', inst.line);
          usages.push(classifyUsage(inst, node, key));
        }
      }
    }
    return { usages: usages, classesStmts: classesStmts };
  }

  function classifyUsage(inst, node, key) {
    const line = node.getStartLineNumber();
    const parent = node.getParent();
    if (Node.isJsxExpression(parent) && Node.isJsxAttribute(parent.getParent())) {
      const attr = parent.getParent();
      if (attr.getNameNode().getText() === 'className') return { inst: inst, key: key, kind: 'className', attr: attr, element: attr.getParent().getParent(), line: line };
    }
    if (Node.isPropertyAssignment(parent) && parent.getInitializer() === node) {
      const o = parent.getParent();
      const jx = o && o.getParent();
      const attr = jx && jx.getParent();
      if (Node.isObjectLiteralExpression(o) && Node.isJsxExpression(jx) && Node.isJsxAttribute(attr) && attr.getNameNode().getText() === 'classes') {
        return { inst: inst, key: key, kind: 'classes', entry: propName(parent), entryNode: parent, attr: attr, element: attr.getParent().getParent(), line: line };
      }
    }
    throw new Manual('classes.' + key + ' בשימוש שאינו className={classes.x} או classes={{ slot: classes.x }} (שורה ' + line + ')', inst.line);
  }

  // =========================================================================
  let instances = [];
  calls.forEach((call) => {
    try { instances.push(analyse(call)); } catch (err) {
      if (!(err instanceof Manual)) throw err;
      manual.push({ file: file, line: err.line, reason: err.message });
    }
  });
  instances.forEach((inst) => {
    try { Object.assign(inst, collectUsages(inst)); } catch (err) {
      if (!(err instanceof Manual)) throw err;
      inst.failed = err;
    }
  });

  // per-element plans; an instance fails if any of its elements cannot be converted
  let elementPlans = new Map();
  const planElements = () => {
    elementPlans = new Map();
    const live = instances.filter((i) => !i.failed);
    live.forEach((inst) => inst.usages.forEach((u) => {
      if (!elementPlans.has(u.element)) elementPlans.set(u.element, { element: u.element, usages: [] });
      elementPlans.get(u.element).usages.push(u);
    }));
    let changed = false;
    elementPlans.forEach((plan) => {
      try {
        buildElementPlan(plan);
      } catch (err) {
        if (!(err instanceof Manual)) throw err;
        plan.usages.forEach((u) => { if (!u.inst.failed) { u.inst.failed = new Manual(err.message, u.inst.line); changed = true; } });
      }
    });
    return changed;
  };

  let boxLocal = null;
  let boxImportEdit = null;
  const ensureBox = () => {
    if (boxLocal) return boxLocal;
    for (const d of imports) {
      const m = d.getModuleSpecifierValue();
      const named = d.getNamedImports().find((s) => s.getName() === 'Box');
      if (BOX_MODULES.indexOf(m) !== -1 && named) { boxLocal = named.getAliasNode() ? named.getAliasNode().getText() : 'Box'; return boxLocal; }
      if (m === '@mui/material/Box' && d.getDefaultImport()) { boxLocal = d.getDefaultImport().getText(); return boxLocal; }
    }
    if (usedNames.has('Box')) throw new Manual("השם Box כבר תפוס בקובץ – לא ניתן להוסיף Box מ-@mui/material");
    const root = imports.find((d) => d.getModuleSpecifierValue() === '@mui/material' && d.getNamedImports().length && !d.isTypeOnly());
    if (root) {
      const last = root.getNamedImports()[root.getNamedImports().length - 1];
      boxImportEdit = { start: last.getEnd(), end: last.getEnd(), text: ', Box' };
    } else {
      const anchor = imports[imports.length - 1];
      const q = anchor.getModuleSpecifier().getText().charAt(0);
      const semi = anchor.getLastToken().getKind() === K.SemicolonToken ? ';' : '';
      boxImportEdit = { start: anchor.getEnd(), end: anchor.getEnd(), text: eol + 'import Box from ' + q + '@mui/material/Box' + q + semi };
    }
    boxLocal = 'Box';
    return boxLocal;
  };

  function buildElementPlan(plan) {
    const el = plan.element;
    const tag = el.getTagNameNode().getText();
    const attrs = el.getAttributes();
    const attrNames = attrs.filter((a) => Node.isJsxAttribute(a)).map((a) => a.getNameNode().getText());
    const line = el.getStartLineNumber();
    const ref = (u) => u.inst.stylesName + '.' + u.key;
    const isEmpty = (u) => u.inst.emptyKeys.has(u.key);
    plan.rootRefs = [];
    plan.rootSelectors = [];
    plan.slots = new Map(); // slot -> { refs: [], selectors: [] }
    plan.removeAttrs = new Set();
    plan.rename = null;
    plan.details = [];
    const slot = (name) => { if (!plan.slots.has(name)) plan.slots.set(name, { refs: [], selectors: [] }); return plan.slots.get(name); };

    const classNameUsages = plan.usages.filter((u) => u.kind === 'className');
    const classesUsages = plan.usages.filter((u) => u.kind === 'classes');
    const isHtml = /^[a-z][\w-]*$/.test(tag);

    if (classNameUsages.length) {
      const u = classNameUsages[0];
      plan.removeAttrs.add(u.attr);
      if (!isEmpty(u)) {
        if (attrNames.indexOf('sx') !== -1) throw new Manual('<' + tag + '> כבר מכיל sx – מיזוג עם className דורש המרה ידנית (שורה ' + line + ')');
        if (isHtml) {
          if (attrNames.indexOf('component') !== -1) throw new Manual('<' + tag + ' component=...> – לא ניתן להמיר ל-Box (שורה ' + line + ')');
          plan.rename = { box: ensureBox(), tag: tag };
          plan.details.push({ rule: 'MS.BOX', detail: '<' + tag + ' className={classes.' + u.key + '}> → <Box sx>' });
        } else {
          if (isV4Import(tag)) throw new Manual('<' + tag + '> מיובא מ-@material-ui (v4) – הרץ קודם את codemod-mui-imports (שורה ' + line + ')');
          if (!muiComponentOf(tag)) throw new Manual('className={classes.' + u.key + '} על <' + tag + '> שאינו רכיב MUI – לא ידוע אם הוא תומך ב-sx (שורה ' + line + ')');
          plan.details.push({ rule: 'MS.SX', detail: '<' + tag + ' className={classes.' + u.key + '}> → sx' });
        }
        plan.rootRefs.push(ref(u));
      } else {
        plan.details.push({ rule: 'MS.EMPTY', detail: 'className={classes.' + u.key + '} (מפתח ריק) הוסר' });
      }
    }

    if (classesUsages.length) {
      const attr = classesUsages[0].attr;
      const entries = attr.getInitializer().getExpression().getProperties();
      if (entries.length !== classesUsages.length) throw new Manual('classes על <' + tag + '> מכיל ערכים שאינם classes.x מ-makeStyles (שורה ' + line + ')');
      if (isHtml) throw new Manual('classes על אלמנט HTML <' + tag + '> (שורה ' + line + ')');
      if (isV4Import(tag)) throw new Manual('<' + tag + '> מיובא מ-@material-ui (v4) – הרץ קודם את codemod-mui-imports (שורה ' + line + ')');
      const comp = muiComponentOf(tag);
      const conf = comp && table.components[comp];
      if (!conf) throw new Manual('classes על <' + tag + '>: הרכיב ' + (comp || tag) + ' אינו מופיע ב-reference/mui-slots.json (שורה ' + line + ')');
      if (conf.classesProp === false) {
        const extra = comp === 'Popper' && classesUsages.some((u) => u.entry === 'paper') ? ' – ל-Popper אין slot בשם paper; זו כנראה טעות בקוד המקורי' : '';
        throw new Manual('ל-' + comp + ' אין prop בשם classes ב-v7' + extra + ' (שורה ' + line + ')');
      }
      if (attrNames.indexOf('slotProps') !== -1) throw new Manual('<' + tag + '> כבר מכיל slotProps – מיזוג דורש המרה ידנית (שורה ' + line + ')');
      if (attrNames.indexOf('sx') !== -1) throw new Manual('<' + tag + '> כבר מכיל sx – מיזוג דורש המרה ידנית (שורה ' + line + ')');
      plan.removeAttrs.add(attr);
      for (const u of classesUsages) {
        const entry = u.entry;
        if (isEmpty(u)) { plan.details.push({ rule: 'MS.EMPTY', detail: comp + ' classes.' + entry + ' (מפתח ריק) הוסר' }); continue; }
        if (entry === 'root' && conf.root) {
          plan.rootRefs.push(ref(u));
          plan.details.push({ rule: 'MS.SX', detail: comp + ' classes.root → sx' });
        } else if (conf.slots[entry]) {
          slot(conf.slots[entry]).refs.push(ref(u));
          plan.details.push({ rule: 'MS.SLOT', detail: comp + ' classes.' + entry + ' → slotProps.' + conf.slots[entry] + '.sx' });
        } else if (conf.hooks[entry]) {
          const h = conf.hooks[entry];
          if (h.manual) throw new Manual(comp + '.' + entry + ': ' + h.manual + ' (שורה ' + line + ')');
          const sel = { selector: h.selector, ref: ref(u) };
          if (h.host === 'root') plan.rootSelectors.push(sel); else slot(h.host).selectors.push(sel);
          plan.details.push({
            rule: 'MS.HOOK', detail: comp + ' classes.' + entry + " → '" + h.selector + "' ב-" + (h.host === 'root' ? 'sx' : 'slotProps.' + h.host + '.sx'),
            review: h.inferred ? 'מיקום ה-selector של ' + comp + '.' + entry + ' נגזר ממבנה ה-DOM – ודא ויזואלית' : null,
          });
        } else {
          const extra = comp === 'Popper' && entry === 'paper' ? ' – ל-Popper אין slot בשם paper' : '';
          throw new Manual(comp + ': אין slot או class hook בשם ' + entry + extra + ' (שורה ' + line + ')');
        }
      }
    }
  }

  // iterate until no element failure knocks out another instance
  for (let i = 0; i < 10 && planElements(); i++) { /* fixpoint */ }
  instances.forEach((inst) => {
    if (inst.failed) manual.push({ file: file, line: inst.line, reason: inst.failed.message });
  });
  instances = instances.filter((i) => !i.failed);
  if (!instances.length) return { text: null, changes: changes, manual: manual, found: calls.length };
  instances.forEach((inst) => { inst.stylesName = uniqueName(inst.stylesBase); });
  // element plans were built before the names were final – rebuild with the final names
  planElements();

  // =========================================================================
  // 3. edits
  const edits = [];
  const sxValue = (refs, selectors) => {
    const items = refs.slice();
    if (selectors.length) items.push('{ ' + selectors.map((s) => quoteKey(s.selector) + ': ' + s.ref).join(', ') + ' }');
    if (!items.length) return null;
    return items.length === 1 ? items[0] : '[' + items.join(', ') + ']';
  };

  elementPlans.forEach((plan) => {
    const el = plan.element;
    const newAttrs = [];
    if (plan.slots.size) {
      const parts = [];
      plan.slots.forEach((v, k) => parts.push(k + ': { sx: ' + sxValue(v.refs, v.selectors) + ' }'));
      newAttrs.push('slotProps={{ ' + parts.join(', ') + ' }}');
    }
    const sx = sxValue(plan.rootRefs, plan.rootSelectors);
    if (sx) newAttrs.push('sx={' + sx + '}');

    const remove = Array.from(plan.removeAttrs).sort((a, b) => a.getStart() - b.getStart());
    const all = el.getAttributes();
    remove.forEach((attr, i) => {
      if (i === 0 && newAttrs.length) {
        edits.push({ start: attr.getStart(), end: attr.getEnd(), text: newAttrs.join(' ') });
      } else {
        const idx = all.indexOf(attr);
        const prevEnd = idx > 0 ? all[idx - 1].getEnd() : el.getTagNameNode().getEnd();
        edits.push({ start: prevEnd, end: attr.getEnd(), text: '' });
      }
    });
    if (plan.rename) {
      const tn = el.getTagNameNode();
      edits.push({ start: tn.getStart(), end: tn.getEnd(), text: plan.rename.box + (plan.rename.tag === 'div' ? '' : ' component="' + plan.rename.tag + '"') });
      if (Node.isJsxOpeningElement(el)) {
        const close = el.getParent().getClosingElement().getTagNameNode();
        edits.push({ start: close.getStart(), end: close.getEnd(), text: plan.rename.box });
      }
    }
    plan.details.forEach((d) => changes.push({ file: file, line: el.getStartLineNumber(), rule: d.rule, confidence: d.review ? 'review' : 'auto', detail: d.detail, reason: d.review || undefined }));
  });
  if (boxImportEdit) edits.push(boxImportEdit);

  instances.forEach((inst) => {
    const obj = inst.obj;
    const base = obj.getStart();
    const local = [];
    const props = obj.getProperties();
    // remove empty keys – per run of consecutive empty keys, so ranges never overlap
    for (let i = 0; i < props.length; i++) {
      if (!inst.emptyKeys.has(propName(props[i]))) continue;
      let j = i;
      while (j + 1 < props.length && inst.emptyKeys.has(propName(props[j + 1]))) j++;
      if (j + 1 < props.length) local.push({ start: props[i].getStart(), end: props[j + 1].getStart(), text: '' });
      else if (i > 0) local.push({ start: props[i - 1].getEnd(), end: props[j].getEnd(), text: '' });
      else local.push({ start: base + 1, end: obj.getEnd() - 1, text: '' });
      i = j;
    }
    const themeName = inst.themeFn ? inst.themeFn.getParameters()[0].getName() : null;
    const themeParamText = inst.themeFn ? inst.themeFn.getParameters()[0].getText() : null;
    let converted = 0;

    inst.keys.forEach((k) => {
      if (inst.emptyKeys.has(k.name)) return;
      const spacingCalls = new Set();
      const walk = (o) => o.getProperties().forEach((p) => {
        if (!Node.isPropertyAssignment(p)) return;
        const name = propName(p);
        const v = unwrap(p.getInitializer());
        if (Node.isObjectLiteralExpression(v)) return walk(v);
        // theme.spacing(n) → sx shorthand (only with a single numeric literal)
        if (themeName && name && rules.spacingShorthands[name] && Node.isCallExpression(v)) {
          const callee = v.getExpression();
          const a = v.getArguments();
          const numeric = a.length === 1 && (Node.isNumericLiteral(a[0]) || (Node.isPrefixUnaryExpression(a[0]) && Node.isNumericLiteral(a[0].getOperand())));
          if (numeric && Node.isPropertyAccessExpression(callee) && callee.getName() === 'spacing' && callee.getExpression().getText() === themeName) {
            local.push({ start: p.getNameNode().getStart(), end: p.getNameNode().getEnd(), text: rules.spacingShorthands[name] });
            local.push({ start: v.getStart(), end: v.getEnd(), text: a[0].getText() });
            spacingCalls.add(callee.getExpression());
            converted++;
            return;
          }
        }
        // bare numbers that sx would reinterpret → explicit px
        const isNum = Node.isNumericLiteral(v) || (Node.isPrefixUnaryExpression(v) && Node.isNumericLiteral(v.getOperand()));
        if (name && isNum && rules.numericPx.indexOf(name) !== -1 && Number(v.getText()) !== 0) {
          local.push({ start: v.getStart(), end: v.getEnd(), text: "'" + Number(v.getText()) + "px'" });
        }
      });
      walk(k.value);
      if (themeName) {
        const stillUsesTheme = k.prop.getDescendantsOfKind(K.Identifier).some((id) => id.getText() === themeName && !spacingCalls.has(id) && isReference(id));
        if (stillUsesTheme) {
          local.push({ start: k.value.getStart(), end: k.value.getStart(), text: '(' + themeParamText + ') => (' });
          local.push({ start: k.value.getEnd(), end: k.value.getEnd(), text: ')' });
        }
      }
    });

    const objText = applyEdits(text.slice(base, obj.getEnd()), local.map((e) => ({ start: e.start - base, end: e.end - base, text: e.text })), base);
    edits.push({ start: inst.stmt.getStart(), end: inst.stmt.getEnd(), text: 'const ' + inst.stylesName + ' = ' + objText + ';' });
    inst.classesStmts.forEach((vs) => { const r = wholeLineRange(text, vs.getStart(), vs.getEnd()); edits.push({ start: r.start, end: r.end, text: '' }); });
    changes.push({
      file: file, line: inst.line, rule: inst.level === 'theme' ? 'MS.THEME' : 'MS.STATIC',
      detail: inst.hookName + ' → const ' + inst.stylesName + (converted ? ' (' + converted + ' × theme.spacing → sx)' : '') +
        (inst.emptyKeys.size ? ' | מפתחות ריקים הוסרו: ' + Array.from(inst.emptyKeys).join(', ') : ''),
      confidence: inst.options ? 'review' : 'auto',
      reason: inst.options ? 'האפשרויות של makeStyles (' + inst.options.getText() + ') הושמטו' : undefined,
    });
  });

  // makeStyles / createStyles imports that are no longer referenced
  const convertedRanges = instances.map((i) => [i.stmt.getStart(), i.stmt.getEnd()]);
  const inConverted = (n) => convertedRanges.some((r) => n.getStart() >= r[0] && n.getEnd() <= r[1]);
  imports.filter((d) => MAKESTYLES_MODULES.indexOf(d.getModuleSpecifierValue()) !== -1).forEach((d) => {
    const specs = d.getNamedImports();
    const dead = specs.filter((s) => {
      const local = s.getAliasNode() ? s.getAliasNode().getText() : s.getName();
      if (['makeStyles', 'createStyles'].indexOf(s.getName()) === -1) return false;
      return !sf.getDescendantsOfKind(K.Identifier).some((id) => id.getText() === local && isReference(id) && !inConverted(id));
    });
    if (!dead.length) return;
    if (dead.length === specs.length && !d.getDefaultImport() && !d.getNamespaceImport()) {
      const r = wholeLineRange(text, d.getStart(), d.getEnd());
      edits.push({ start: r.start, end: r.end, text: '' });
      return;
    }
    dead.forEach((s) => {
      const i = specs.indexOf(s);
      if (i > 0) edits.push({ start: specs[i - 1].getEnd(), end: s.getEnd(), text: '' });
      else edits.push({ start: s.getStart(), end: specs[1].getStart(), text: '' });
    });
  });

  const out = apply(text, edits);

  // =========================================================================
  // 4. validation – on any failure the file is left untouched
  const fail = (why) => {
    manual.push({ file: file, line: instances[0].line, reason: 'ולידציה נכשלה, הקובץ לא שונה: ' + why });
    return { text: null, changes: [], manual: manual, found: calls.length };
  };
  const check = sf.getProject().createSourceFile('/__validate__' + path.extname(file), out, { overwrite: true });
  try {
    const diags = check.compilerNode.parseDiagnostics || [];
    if (diags.length) return fail('שגיאת תחביר אחרי ההמרה: ' + tsm.ts.flattenDiagnosticMessageText(diags[0].messageText, ' '));
    for (const inst of instances) {
      const v = check.getVariableDeclaration(inst.stylesName);
      const o = v && unwrap(v.getInitializer());
      if (!o || !Node.isObjectLiteralExpression(o)) return fail('const ' + inst.stylesName + ' לא נמצא');
      const expected = inst.beforeCount - inst.emptyKeys.size;
      const actual = deepKeyCount(o);
      if (actual !== expected) return fail('מספר מפתחות ה-CSS ב-' + inst.stylesName + ' השתנה (' + expected + ' → ' + actual + ')');
      const defined = new Set(o.getProperties().map(propName));
      const bad = check.getDescendantsOfKind(K.PropertyAccessExpression).filter((pa) => pa.getExpression().getText() === inst.stylesName && !defined.has(pa.getName()));
      if (bad.length) return fail(inst.stylesName + '.' + bad[0].getName() + ' אינו מוגדר');
      if (check.getDescendantsOfKind(K.Identifier).some((id) => id.getText() === inst.hookName)) return fail(inst.hookName + ' עדיין בשימוש');
    }
  } finally {
    check.getProject().removeSourceFile(check);
  }
  return { text: out, changes: changes, manual: manual, found: calls.length };
}

// ---------------------------------------------------------------------------

function conflictMessage(rel, text, err) {
  const line = text.slice(0, err.pos).split('\n').length;
  return rel + ':' + line + ' – ' + SCRIPT + ' יצר שתי עריכות חופפות באותו מקום (באג בקודמוד). הקובץ לא שונה – יש להמיר אותו ידנית או לדווח על הבאג';
}

function run(argv, overrides) {
  const deps = Object.assign({ fs: require('fs'), cwd: process.cwd(), applyEdits: applyEdits }, overrides || {});
  const opts = parseArgs(argv || []);
  const res = { script: SCRIPT, result: 'OK', changes: [], manual: [], blockers: [], notes: [], dryRun: opts.dryRun, filesChanged: [] };
  const blocked = (m) => { res.result = 'BLOCKED'; res.blockers.push({ message: m }); return res; };
  if (opts.errors.length) return blocked(opts.errors.join('; '));

  let tsm;
  try { tsm = require('ts-morph'); } catch (_) {
    return blocked('ts-morph אינו מותקן בתיקיית הסקיל – הרץ npm install ב-' + path.join(__dirname, '..'));
  }
  let table;
  let rules;
  try {
    table = deps.table || JSON.parse(require('fs').readFileSync(path.join(REFERENCE_DIR, 'mui-slots.json'), 'utf8'));
    rules = deps.rules || JSON.parse(require('fs').readFileSync(path.join(REFERENCE_DIR, 'sx-rules.json'), 'utf8'));
  } catch (err) {
    return blocked('לא ניתן לטעון את reference/mui-slots.json / sx-rules.json: ' + err.message);
  }
  let files;
  try { files = listSourceFiles(deps.fs, deps.cwd); } catch (err) {
    if (err instanceof CodemodError) return blocked(err.message);
    throw err;
  }
  const project = new tsm.Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, jsx: tsm.ts.JsxEmit.Preserve },
  });

  let found = 0;
  for (const full of files) {
    const rel = toPosix(path.relative(deps.cwd, full));
    let raw;
    try { raw = deps.fs.readFileSync(full, 'utf8'); } catch (err) { return blocked('לא ניתן לקרוא את ' + rel + ': ' + err.message); }
    if (raw.indexOf('makeStyles') === -1) continue; // סינון ביצועים בלבד – ההחלטה מתקבלת מה-AST
    const bom = raw.charCodeAt(0) === 0xfeff ? '﻿' : '';
    const text = bom ? raw.slice(1) : raw;
    const sf = project.createSourceFile('/' + rel, text, { overwrite: true });
    let r;
    try {
      r = transformFile(tsm, sf, rel, table, rules, deps.applyEdits);
    } catch (err) {
      if (!(err instanceof EditConflict)) throw err;
      found++;
      res.blockers.push({ file: rel, message: conflictMessage(rel, text, err) });
      continue; // הקובץ לא נכתב, והשינויים שלו לא מדווחים
    } finally {
      project.removeSourceFile(sf);
    }
    found += r.found;
    res.changes.push.apply(res.changes, r.changes);
    res.manual.push.apply(res.manual, r.manual);
    if (r.text === null || r.text === text) continue;
    res.filesChanged.push(rel);
    if (!opts.dryRun) {
      try { deps.fs.writeFileSync(full, bom + r.text, 'utf8'); } catch (err) { return blocked('לא ניתן לכתוב את ' + rel + ': ' + err.message); }
    }
  }

  const reviews = res.changes.filter((c) => c.confidence === 'review');
  if (res.blockers.length) res.result = 'BLOCKED';
  else if (found === 0) res.result = 'NOOP';
  else if (res.manual.length || reviews.length) res.result = 'REVIEW';
  if (res.filesChanged.length) res.notes.push('הרץ build ובדוק ויזואלית את הרכיבים שהומרו – סדר העדיפויות של sx שונה מזה של JSS');
  return res;
}

function formatText(res) {
  const L = [SCRIPT + (res.dryRun ? ' [dry-run]' : '')];
  res.blockers.forEach((b) => L.push('⛔ ' + b.message));
  // BLOCKED of a single file still has a summary of the rest; a precondition BLOCKED (no src/ …) has nothing else
  if (res.result !== 'BLOCKED' || res.changes.length || res.manual.length) {
    const byRule = {};
    res.changes.forEach((c) => { byRule[c.rule] = (byRule[c.rule] || 0) + 1; });
    L.push('🎨 ' + res.filesChanged.length + ' קבצים ' + (res.dryRun ? 'היו משתנים' : 'שונו') +
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
