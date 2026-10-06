#!/usr/bin/env node
'use strict';

// codemod-anti-patterns: useEffect(async () => …) → sync effect that runs an inner async function,
// with a `cancelled` guard on every setState that happens after an await (React 18 StrictMode mounts twice).
// ts-morph only; edits are position-based so the rest of the file is untouched.

const path = require('path');

const SCRIPT = 'codemod-anti-patterns';
const SOURCE_EXTS = ['.js', '.jsx', '.ts', '.tsx'];
const SKIP_DIRS = new Set(['node_modules', 'build', 'dist']);
const EFFECT_HOOKS = ['useEffect', 'useLayoutEffect'];
const STATE_HOOKS = ['useState', 'useReducer'];
// משמש רק לסימון review של פונקציה שהגיעה כ-prop – לעולם לא כדי להחליט מה לעטוף
const PROP_SETTER_NAME = /^set[A-Z]\w*$/;

class CodemodError extends Error {}
class Manual extends Error {}
// a bug in this codemod (two edits on the same range) – expected enough to report as BLOCKED, not crash
class EditConflict extends Error {
  constructor(pos) { super('overlapping edits at ' + pos); this.pos = pos; }
}

function parseArgs(argv) {
  const opts = { dryRun: false, json: false, guard: true, errors: [] };
  argv.forEach((a) => {
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--no-cancel-guard') opts.guard = false;
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

function lineIndent(text, pos) {
  const ls = text.lastIndexOf('\n', pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(ls))[0];
}

// ---------------------------------------------------------------------------

function transformFile(tsm, sf, file, opts) {
  const { Node, SyntaxKind: K } = tsm;
  const text = sf.getFullText();
  const eol = text.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  const edits = [];
  const changes = [];
  const manual = [];

  const FN_KINDS = new Set([K.ArrowFunction, K.FunctionExpression, K.FunctionDeclaration, K.MethodDeclaration,
    K.GetAccessor, K.SetAccessor, K.Constructor]);
  const LOOP_KINDS = new Set([K.ForStatement, K.ForInStatement, K.ForOfStatement, K.WhileStatement, K.DoStatement]);
  const ownerFn = (n) => n.getFirstAncestor((a) => FN_KINDS.has(a.getKind()));
  const own = (root, fn, kind) => root.getDescendantsOfKind(kind).filter((d) => ownerFn(d) === fn);
  const unwrap = (n) => { while (n && Node.isParenthesizedExpression(n)) n = n.getExpression(); return n; };

  // react bindings
  const named = new Map();
  const ns = new Set();
  sf.getImportDeclarations().filter((d) => d.getModuleSpecifierValue() === 'react').forEach((d) => {
    if (d.getDefaultImport()) ns.add(d.getDefaultImport().getText());
    if (d.getNamespaceImport()) ns.add(d.getNamespaceImport().getText());
    d.getNamedImports().forEach((s) => named.set(s.getAliasNode() ? s.getAliasNode().getText() : s.getName(), s.getName()));
  });
  const reactApi = (callee) => {
    if (Node.isIdentifier(callee)) return named.get(callee.getText()) || null;
    if (Node.isPropertyAccessExpression(callee) && Node.isIdentifier(callee.getExpression()) && ns.has(callee.getExpression().getText())) return callee.getName();
    return null;
  };

  const effects = sf.getDescendantsOfKind(K.CallExpression).filter((c) => {
    if (EFFECT_HOOKS.indexOf(reactApi(c.getExpression())) === -1) return false;
    const fn = unwrap(c.getArguments()[0]);
    return fn && (Node.isArrowFunction(fn) || Node.isFunctionExpression(fn)) && fn.isAsync();
  });

  for (const effect of effects) {
    const fn = unwrap(effect.getArguments()[0]);
    const line = effect.getStartLineNumber();
    try {
      const edit = transformEffect(effect, fn);
      edits.push(edit);
      changes.push({ file: file, line: line, rule: 'EFFECT.ASYNC', confidence: edit.review ? 'review' : 'auto',
        detail: reactApi(effect.getExpression()) + '(async …) → ' + (opts.guard ? 'run() + cancelled guard' : 'run()'),
        reason: edit.review || undefined });
    } catch (err) {
      if (!(err instanceof Manual)) throw err;
      manual.push({ file: file, line: line, reason: 'useEffect אסינכרוני לא הומר: ' + err.message });
    }
  }

  function transformEffect(effect, fn) {
    if (fn.isGenerator && fn.isGenerator()) throw new Manual('generator');
    if (Node.isFunctionExpression(fn)) {
      const usesThis = fn.getDescendantsOfKind(K.ThisKeyword).some((t) => ownerFn(t) === fn) ||
        fn.getDescendantsOfKind(K.Identifier).some((i) => i.getText() === 'arguments' && ownerFn(i) === fn);
      if (usesThis) throw new Manual('function עם this / arguments – המרה לפונקציית חץ תשנה התנהגות');
    }
    if (fn.getDescendantsOfKind(K.ForOfStatement).some((f) => f.isAwaited && f.isAwaited())) throw new Manual('for await');
    const awaits = own(fn, fn, K.AwaitExpression);
    // ancestors of the await that belong to this effect function (not to an outer function)
    if (awaits.some((a) => a.getAncestors().some((x) => LOOP_KINDS.has(x.getKind()) && ownerFn(x) === fn))) {
      throw new Manual('await בתוך לולאה');
    }

    // component scope – names in use and state setters
    const component = ownerFn(effect) || sf;
    const scopeNames = new Set(component.getDescendantsOfKind(K.Identifier).map((i) => i.getText()));
    sf.getStatements().forEach((s) => {
      if (Node.isVariableStatement(s)) s.getDeclarations().forEach((d) => scopeNames.add(d.getName()));
      else if (s.getName && s.getName()) scopeNames.add(s.getName());
    });
    const pick = (cands) => {
      const n = cands.find((c) => !scopeNames.has(c));
      if (!n) throw new Manual('אין שם פנוי ל-' + cands[0]);
      scopeNames.add(n);
      return n;
    };
    // setters = only identifiers declared as `const [x, setX] = useState(...)` / useReducer in the component itself
    const declaredInComponent = (n) => (ownerFn(n) || sf) === component;
    const setters = new Set();
    component.getDescendantsOfKind(K.VariableDeclaration).filter(declaredInComponent).forEach((v) => {
      const init = unwrap(v.getInitializer());
      const nameNode = v.getNameNode();
      if (!init || !Node.isCallExpression(init) || !Node.isArrayBindingPattern(nameNode)) return;
      if (STATE_HOOKS.indexOf(reactApi(init.getExpression())) === -1) return;
      const el = nameNode.getElements()[1];
      if (el && Node.isBindingElement(el) && Node.isIdentifier(el.getNameNode())) setters.add(el.getName());
    });
    // setter מ-useState הוא תמיד מזהה פשוט – x.setY(...) לעולם אינו נעטף
    const isSetState = (call) => {
      const c = call.getExpression();
      return Node.isIdentifier(c) && setters.has(c.getText());
    };

    // props: ({ a, setB }) / (props) + props.setB / const { setB } = props
    const propLocals = new Set();
    let propsName = null;
    const param = component !== sf && component.getParameters ? component.getParameters()[0] : null;
    if (param) {
      const pn = param.getNameNode();
      if (Node.isObjectBindingPattern(pn)) pn.getElements().forEach((el) => propLocals.add(el.getName()));
      else if (Node.isIdentifier(pn)) propsName = pn.getText();
    }
    if (propsName) {
      component.getDescendantsOfKind(K.VariableDeclaration).filter(declaredInComponent).forEach((v) => {
        const init = unwrap(v.getInitializer());
        if (init && Node.isIdentifier(init) && init.getText() === propsName && Node.isObjectBindingPattern(v.getNameNode())) {
          v.getNameNode().getElements().forEach((el) => propLocals.add(el.getName()));
        }
      });
    }
    // setter שהגיע כ-prop – אי אפשר לדעת אם הוא מעדכן state; לא עוטפים, מסמנים review
    const propSetterCalls = opts.guard && awaits.length ? fn.getDescendantsOfKind(K.CallExpression).filter((call) => {
      const c = call.getExpression();
      if (Node.isIdentifier(c)) return propLocals.has(c.getText()) && !setters.has(c.getText()) && PROP_SETTER_NAME.test(c.getText());
      return Node.isPropertyAccessExpression(c) && !!propsName && Node.isIdentifier(c.getExpression()) &&
        c.getExpression().getText() === propsName && PROP_SETTER_NAME.test(c.getName());
    }).map((call) => call.getExpression().getText()) : [];
    const review = propSetterCalls.length
      ? 'קריאה ל-' + Array.from(new Set(propSetterCalls)).join(', ') + ' – פונקציה שהגיעה כ-prop ולא מ-useState מקומי, ולכן לא נעטפה ב-cancelled guard. ודא ידנית אם היא מעדכנת state אחרי await'
      : null;

    // body → statements
    const body = fn.getBody();
    const isBlock = Node.isBlock(body);
    const statements = isBlock ? body.getStatements() : [];
    if (!isBlock && opts.guard && Node.isCallExpression(unwrap(body)) && isSetState(unwrap(body)) && awaits.length) {
      throw new Manual('גוף ביטוי עם setState אחרי await – יש להמיר ידנית');
    }

    // returns
    const returns = own(fn, fn, K.ReturnStatement);
    let cleanup = null;
    if (returns.length > 1) throw new Manual(returns.length + ' פקודות return');
    if (returns.length === 1) {
      const ret = returns[0];
      const expr = unwrap(ret.getExpression());
      const isLast = statements.length && statements[statements.length - 1] === ret;
      const fnLike = expr && (Node.isArrowFunction(expr) || Node.isFunctionExpression(expr) || Node.isIdentifier(expr));
      if (fnLike && !isLast) throw new Manual('cleanup מוחזר מתוך תנאי / לא בסוף ה-effect');
      if (fnLike) {
        // cleanup ירוץ ב-scope של ה-effect, מחוץ ל-run – אסור שיפנה למשתנים שהוגדרו בגוף
        const declared = new Set();
        own(fn, fn, K.VariableDeclaration).forEach((v) => v.getNameNode().getDescendantsOfKind(K.Identifier).concat(
          Node.isIdentifier(v.getNameNode()) ? [v.getNameNode()] : []).forEach((i) => declared.add(i.getText())));
        own(fn, fn, K.FunctionDeclaration).forEach((f) => f.getName() && declared.add(f.getName()));
        const refs = (Node.isIdentifier(expr) ? [expr] : expr.getDescendantsOfKind(K.Identifier)).map((i) => i.getText());
        const leaked = refs.filter((r) => declared.has(r));
        if (leaked.length) throw new Manual('ה-cleanup משתמש במשתנים מגוף ה-effect (' + Array.from(new Set(leaked)).join(', ') + ')');
        cleanup = { ret: ret, expr: expr };
      }
    }

    const cancelled = opts.guard ? pick(['cancelled', 'isCancelled', 'effectCancelled']) : null;
    const runName = pick(['run', 'runEffect', 'runEffect2']);

    // ---- guard edits inside the body ----
    const inner = [];
    const hasAwait = (n) => own(n, fn, K.AwaitExpression).length > 0 || (Node.isAwaitExpression(n) && ownerFn(n) === fn);

    function guardStatement(st, seen, braceless) {
      const call = unwrap(st.getExpression());
      const awaitInside = hasAwait(st);
      const indent = lineIndent(text, st.getStart());
      let replacement = null;
      if (awaitInside) {
        const args = call.getArguments();
        const arg = args.length === 1 ? unwrap(args[0]) : null;
        if (!arg || !Node.isAwaitExpression(arg) || own(call.getExpression(), fn, K.AwaitExpression).length) {
          throw new Manual('setState עם await בארגומנטים במבנה מורכב (שורה ' + st.getStartLineNumber() + ')');
        }
        // setX(await f()) – הבדיקה חייבת לקרות אחרי ה-await, לכן מפצלים
        const tmp = pick(['result', 'awaitedValue', 'effectResult']);
        const sep = braceless ? ' ' : eol + indent;
        replacement = 'const ' + tmp + ' = ' + arg.getText() + ';' + sep + 'if (!' + cancelled + ') ' + call.getExpression().getText() + '(' + tmp + ');';
        if (braceless) replacement = '{ ' + replacement + ' }';
      } else if (seen) {
        replacement = 'if (!' + cancelled + ') ' + st.getText();
        if (braceless) replacement = '{ ' + replacement + ' }';
      }
      if (replacement !== null) inner.push({ start: st.getStart(), end: st.getEnd(), text: replacement });
      return seen || awaitInside;
    }

    const isSetStateStatement = (st) => Node.isExpressionStatement(st) && Node.isCallExpression(unwrap(st.getExpression())) && isSetState(unwrap(st.getExpression()));

    function branch(st, seen) {
      if (!st) return seen;
      if (Node.isBlock(st)) return walk(st.getStatements(), seen);
      if (isSetStateStatement(st)) return guardStatement(st, seen, true);
      return visit(st, seen);
    }
    function walk(list, seen) {
      list.forEach((st) => { seen = visit(st, seen); });
      return seen;
    }
    function visit(st, seen) {
      if (isSetStateStatement(st)) return guardStatement(st, seen, false);
      if (Node.isBlock(st)) return walk(st.getStatements(), seen);
      if (Node.isIfStatement(st)) {
        const s = seen || hasAwait(st.getExpression());
        branch(st.getThenStatement(), s);
        branch(st.getElseStatement(), s);
        return seen || hasAwait(st);
      }
      if (Node.isTryStatement(st)) {
        const tryAwait = hasAwait(st.getTryBlock());
        walk(st.getTryBlock().getStatements(), seen);
        const cc = st.getCatchClause();
        if (cc) walk(cc.getBlock().getStatements(), seen || tryAwait);
        const fin = st.getFinallyBlock();
        if (fin) walk(fin.getStatements(), seen || tryAwait || (cc ? hasAwait(cc) : false));
        return seen || hasAwait(st);
      }
      if (LOOP_KINDS.has(st.getKind())) { branch(st.getStatement(), seen); return seen || hasAwait(st); }
      if (Node.isSwitchStatement(st)) {
        const s = seen || hasAwait(st.getExpression());
        st.getClauses().forEach((c) => walk(c.getStatements(), s));
        return seen || hasAwait(st);
      }
      if (Node.isLabeledStatement(st)) return visit(st.getStatement(), seen);
      return seen || hasAwait(st);
    }
    if (opts.guard && isBlock) walk(statements.filter((s) => !cleanup || s !== cleanup.ret), false);

    // ---- assemble ----
    const base = lineIndent(text, isBlock ? body.getEnd() - 1 : effect.getStart());
    let unit = '  ';
    if (isBlock && statements.length) {
      const first = lineIndent(text, statements[0].getStart());
      if (first.startsWith(base) && first.length > base.length) unit = first.slice(base.length);
    }
    const i1 = base + unit;
    const i2 = i1 + unit;

    let runBody;
    if (isBlock) {
      const start = body.getStart() + 1;
      const end = body.getEnd() - 1;
      if (cleanup) {
        // remove "return () => …" together with the line break before it
        const prev = statements.indexOf(cleanup.ret) > 0 ? statements[statements.indexOf(cleanup.ret) - 1].getEnd() : start;
        inner.push({ start: prev, end: cleanup.ret.getEnd(), text: '' });
      }
      const shifted = inner.map((e) => ({ start: e.start - start, end: e.end - start, text: e.text }));
      const content = applyEdits(text.slice(start, end), shifted, start);
      const multilineTemplate = fn.getDescendants().some((d) =>
        (Node.isTemplateExpression(d) || Node.isNoSubstitutionTemplateLiteral(d)) && d.getStartLineNumber() !== d.getEndLineNumber());
      let lines = content.split(/\r?\n/);
      if (lines.length === 1) lines = [i1 + lines[0].trim()];
      while (lines.length && lines[0].trim() === '') lines.shift();
      while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
      // תבנית מחרוזת רב-שורתית: הזחה נוספת תשנה את התוכן שלה – משאירים כמו שהוא
      runBody = lines.map((l) => (l.trim() === '' || multilineTemplate ? l : unit + l)).join(eol);
    } else {
      runBody = i2 + body.getText() + ';';
    }

    const out = ['() => {'];
    if (opts.guard) out.push(i1 + 'let ' + cancelled + ' = false;');
    out.push(i1 + 'const ' + runName + ' = async () => {');
    if (runBody) out.push(runBody);
    out.push(i1 + '};');
    out.push(i1 + runName + '();');

    if (cleanup) {
      const e = cleanup.expr;
      if (!opts.guard) {
        out.push(i1 + 'return ' + e.getText() + ';');
      } else if ((Node.isArrowFunction(e) || Node.isFunctionExpression(e)) && Node.isBlock(e.getBody())) {
        const b = e.getBody();
        const cl = text.slice(b.getStart() + 1, b.getEnd() - 1).split(/\r?\n/);
        while (cl.length && cl[0].trim() === '') cl.shift();
        while (cl.length && cl[cl.length - 1].trim() === '') cl.pop();
        out.push(i1 + 'return () => {');
        out.push(i2 + cancelled + ' = true;');
        // אם ה-cleanup היה בשורה אחת – מוסיפים הזחה; אחרת השורות כבר בעומק הנכון
        cl.forEach((l) => out.push(b.getStartLineNumber() === b.getEndLineNumber() ? i2 + l.trim() : l));
        out.push(i1 + '};');
      } else if (Node.isArrowFunction(e) || Node.isFunctionExpression(e)) {
        out.push(i1 + 'return () => { ' + cancelled + ' = true; ' + e.getBody().getText() + '; };');
      } else {
        out.push(i1 + 'return () => { ' + cancelled + ' = true; ' + e.getText() + '(); };');
      }
    } else if (opts.guard) {
      out.push(i1 + 'return () => { ' + cancelled + ' = true; };');
    }
    out.push(base + '}');
    return { start: fn.getStart(), end: fn.getEnd(), text: out.join(eol), review: review };
  }

  return { edits: edits, changes: changes, manual: manual };
}

// ---------------------------------------------------------------------------

function conflictMessage(rel, text, err) {
  const line = text.slice(0, err.pos).split('\n').length;
  return rel + ':' + line + ' – ' + SCRIPT + ' יצר שתי עריכות חופפות באותו מקום (באג בקודמוד). הקובץ לא שונה – יש להמיר אותו ידנית או לדווח על הבאג';
}

function run(argv, overrides) {
  const deps = Object.assign({ fs: require('fs'), cwd: process.cwd(), applyEdits: applyEdits }, overrides || {});
  const opts = parseArgs(argv || []);
  const res = { script: SCRIPT, result: 'OK', changes: [], manual: [], blockers: [], notes: [], dryRun: opts.dryRun, cancelGuard: opts.guard, filesChanged: [] };
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
    let r;
    let out = text;
    try {
      r = transformFile(tsm, sf, rel, opts);
      if (r.edits.length) out = deps.applyEdits(text, r.edits);
    } catch (err) {
      if (!(err instanceof EditConflict)) throw err;
      res.blockers.push({ file: rel, message: conflictMessage(rel, text, err) });
      continue; // הקובץ לא נכתב, והשינויים שלו לא מדווחים
    } finally {
      project.removeSourceFile(sf);
    }
    res.changes.push.apply(res.changes, r.changes);
    res.manual.push.apply(res.manual, r.manual);
    if (!r.edits.length) continue;
    res.filesChanged.push(rel);
    if (!opts.dryRun) {
      try { deps.fs.writeFileSync(full, bom + out, 'utf8'); } catch (err) { return blocked('לא ניתן לכתוב את ' + rel + ': ' + err.message); }
    }
  }

  if (!opts.guard && res.changes.length) res.notes.push('הומר ללא cancelled guard (--no-cancel-guard)');
  if (res.blockers.length) res.result = 'BLOCKED';
  else if (res.changes.length === 0 && res.manual.length === 0) res.result = 'NOOP';
  else if (res.manual.length || res.changes.some((c) => c.confidence === 'review')) res.result = 'REVIEW';
  return res;
}

function formatText(res) {
  const L = [SCRIPT + (res.dryRun ? ' [dry-run]' : '') + (res.cancelGuard ? '' : ' [--no-cancel-guard]')];
  res.blockers.forEach((b) => L.push('⛔ ' + b.message));
  // BLOCKED of a single file still has a summary of the rest; a precondition BLOCKED (no src/ …) has nothing else
  if (res.result !== 'BLOCKED' || res.changes.length || res.manual.length) {
    L.push('⏳ ' + res.changes.length + ' useEffect אסינכרוניים הומרו ב-' + res.filesChanged.length + ' קבצים' + (res.dryRun ? ' (dry-run)' : ''));
    res.changes.forEach((c) => L.push((c.confidence === 'review' ? '   🔍 ' : '   ✓ ') + c.file + ':' + c.line + (c.reason ? ' – ' + c.reason : '')));
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
