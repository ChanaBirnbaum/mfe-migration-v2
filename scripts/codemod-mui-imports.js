#!/usr/bin/env node
'use strict';

// codemod-mui-imports: @material-ui/* imports -> @mui/* (ts-morph only – commented code is never touched).
// Mapping, renames and manual names come from reference/mui-mapping.json.

const path = require('path');

const SCRIPT = 'codemod-mui-imports';
const MAPPING_FILE = path.join(__dirname, '..', 'reference', 'mui-mapping.json');
const SOURCE_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', 'build', 'dist']);
const OLD_PREFIX = '@material-ui/';

class CodemodError extends Error {}

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
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full); } else if (e.isFile() && SOURCE_EXTS.has(path.extname(e.name))) out.push(full);
    }
  };
  walk(srcDir);
  return out;
}

// ---------------------------------------------------------------------------
// Mapping

function analyzeModule(module, mapping) {
  const parts = module.split('/');
  const pkg = parts.slice(0, 2).join('/');
  const segs = parts.slice(2);
  const conf = mapping.packages[pkg];
  if (!conf) return { kind: 'unknown', pkg: pkg };
  if (!conf.target) return { kind: 'manual', pkg: pkg, reason: conf.manual, packageLevel: true };
  const applyNames = conf.applyRenames !== false;
  const moved = (name) => !!(conf.moved && conf.moved.indexOf(name) !== -1);
  if (segs.length === 0) {
    return {
      kind: 'root', pkg: pkg, conf: conf, applyNames: applyNames,
      moduleFor: (name) => (moved(name) ? conf.movedTo : conf.target),
      wholeTarget: conf.target,
    };
  }
  const seg0 = segs[0];
  // גם נתיב עמוק: @material-ui/core/styles/withStyles
  const manualSeg = applyNames ? segs.find((s) => mapping.manual[s]) : null;
  if (manualSeg) return { kind: 'manual', pkg: pkg, reason: mapping.manual[manualSeg] };
  const newSeg0 = (applyNames && mapping.renames[seg0]) || seg0;
  const target = [moved(seg0) ? conf.movedTo : conf.target, newSeg0].concat(segs.slice(1)).join('/');
  return {
    kind: 'path', pkg: pkg, conf: conf, applyNames: applyNames, seg0: seg0, newSeg0: newSeg0,
    moduleFor: () => target, wholeTarget: target, deep: segs.length > 1,
  };
}

function classifyName(info, name, mapping) {
  if (info.applyNames && mapping.manual[name]) return { manual: mapping.manual[name] };
  return { module: info.moduleFor(name), newName: (info.applyNames && mapping.renames[name]) || name };
}

function reviewReason(info, targetModule) {
  const conf = info.conf;
  if (conf.movedTo && targetModule.split('/').slice(0, 2).join('/') === conf.movedTo) return null;
  if (conf.review) return conf.review;
  if (info.deep) return 'ייבוא עמוק (' + targetModule + ') – ייתכן שהנתיב אינו קיים ב-MUI v7';
  return null;
}

// ---------------------------------------------------------------------------
// Per-file transform

function transformFile(tsm, sf, file, mapping) {
  const { Node, SyntaxKind: K } = tsm;
  const changes = [];
  const manual = [];
  const pendingRenames = [];

  const change = (line, rule, detail, review) => changes.push({
    file: file, line: line, rule: rule, confidence: review ? 'review' : 'auto', detail: detail, reason: review || undefined,
  });
  const addManual = (line, reason) => manual.push({ file: file, line: line, reason: reason });

  // local name -> { module, name } for imports; plus other top-level bindings
  const bound = new Map();
  sf.getImportDeclarations().forEach((d) => {
    const m = d.getModuleSpecifierValue();
    if (d.getDefaultImport()) bound.set(d.getDefaultImport().getText(), { module: m, name: 'default' });
    if (d.getNamespaceImport()) bound.set(d.getNamespaceImport().getText(), { module: m, name: '*' });
    d.getNamedImports().forEach((s) => bound.set(s.getAliasNode() ? s.getAliasNode().getText() : s.getName(), { module: m, name: s.getName() }));
  });
  sf.getVariableStatements().forEach((vs) => vs.getDeclarations().forEach((v) => {
    if (Node.isIdentifier(v.getNameNode())) bound.set(v.getName(), { module: null });
  }));
  sf.getFunctions().concat(sf.getClasses()).forEach((d) => { if (d.getName()) bound.set(d.getName(), { module: null }); });

  // Returns the local name to use: newName (usages will be renamed) or oldName on conflict.
  function planRename(oldName, newName, targetModule) {
    if (oldName === newName) return oldName;
    const b = bound.get(newName);
    const sameBinding = b && b.module === targetModule && b.name === newName;
    if (b && !sameBinding) return oldName;
    pendingRenames.push({ from: oldName, to: newName });
    bound.set(newName, { module: targetModule, name: newName });
    return newName;
  }

  const specText = (e) => (e.isTypeOnly ? 'type ' : '') + e.name + (e.alias && e.alias !== e.name ? ' as ' + e.alias : '');

  function findExisting(module, typeOnly, self) {
    return sf.getImportDeclarations().find((d) => d !== self && d.getModuleSpecifierValue() === module &&
      !d.getNamespaceImport() && d.isTypeOnly() === typeOnly);
  }

  function mergeInto(existing, named) {
    named.forEach((e) => {
      const local = e.alias || e.name;
      const dup = existing.getNamedImports().some((s) => s.getName() === e.name &&
        (s.getAliasNode() ? s.getAliasNode().getText() : s.getName()) === local);
      if (!dup) existing.addNamedImport(e.alias && e.alias !== e.name ? { name: e.name, alias: e.alias } : e.name);
    });
  }

  const eol = sf.getFullText().indexOf('\r\n') !== -1 ? '\r\n' : '\n';

  // ---- import declarations ----
  // Returns how many statements to advance: insertText forgets wrapped nodes, so the caller re-queries by index.
  function processImport(decl) {
    const module = decl.getModuleSpecifierValue();
    if (!module.startsWith(OLD_PREFIX)) return 1;
    const line = decl.getStartLineNumber();
    const info = analyzeModule(module, mapping);
    if (info.kind === 'unknown') { addManual(line, module + ': חבילה ללא מיפוי ב-mui-mapping.json'); return 1; }
    if (info.kind === 'manual') {
      // חבילה ללא יעד (@material-ui/styles): פריט לכל שם מוכר בשורה שלו, והודעת החבילה לכל השאר
      const specs = info.packageLevel ? decl.getNamedImports() : [];
      const known = specs.filter((s) => mapping.manual[s.getName()]);
      known.forEach((s) => addManual(s.getStartLineNumber(), mapping.manual[s.getName()]));
      if (!known.length || known.length < specs.length || decl.getDefaultImport() || decl.getNamespaceImport()) addManual(line, info.reason);
      return 1;
    }

    const typeOnly = decl.isTypeOnly();
    const groups = new Map();
    const group = (m) => {
      if (!groups.has(m)) groups.set(m, { module: m, defaultLocal: null, namespaceLocal: null, named: [] });
      return groups.get(m);
    };
    const staying = [];

    const def = decl.getDefaultImport();
    if (def) {
      let local = def.getText();
      if (info.kind === 'path' && local === info.seg0 && info.newSeg0 !== info.seg0) local = planRename(local, info.newSeg0, info.wholeTarget);
      group(info.wholeTarget).defaultLocal = local;
    }
    const ns = decl.getNamespaceImport();
    if (ns) {
      group(info.wholeTarget).namespaceLocal = ns.getText();
      if (info.conf.moved) change(line, 'MUI.IMPORT', 'namespace import', 'ייבוא namespace מ-' + module + ' – חלק מהרכיבים עברו ל-' + info.conf.movedTo);
    }
    decl.getNamedImports().forEach((spec) => {
      const name = spec.getName();
      const alias = spec.getAliasNode() ? spec.getAliasNode().getText() : null;
      const c = classifyName(info, name, mapping);
      if (c.manual) { staying.push(spec); addManual(spec.getStartLineNumber(), c.manual); return; }
      let newAlias = alias;
      if (c.newName !== name && !alias) {
        const local = planRename(name, c.newName, c.module);
        if (local !== c.newName) newAlias = local; // conflict → `newName as oldName`
      }
      group(c.module).named.push({ spec: spec, name: c.newName, alias: newAlias, isTypeOnly: spec.isTypeOnly() });
    });
    if (groups.size === 0) return 1;

    groups.forEach((g) => {
      const review = reviewReason(info, g.module);
      change(line, 'MUI.IMPORT', module + ' → ' + g.module, review);
    });

    // apply
    const semi = decl.getLastToken().getKind() === K.SemicolonToken ? ';' : '';
    const quote = decl.getModuleSpecifier().getText().charAt(0);
    const newTexts = [];
    let reused = false;
    const rewrite = (g) => {
      decl.getNamedImports().forEach((s) => {
        const e = g.named.find((x) => x.spec === s);
        if (!e) s.remove();
        else if (e.name !== s.getName() || (e.alias || null) !== (s.getAliasNode() ? s.getAliasNode().getText() : null)) s.replaceWithText(specText(e));
      });
      if (decl.getDefaultImport()) {
        if (!g.defaultLocal) decl.removeDefaultImport();
        else if (g.defaultLocal !== decl.getDefaultImport().getText()) decl.getDefaultImport().replaceWithText(g.defaultLocal);
      }
      if (decl.getNamespaceImport() && !g.namespaceLocal) decl.removeNamespaceImport();
      decl.getModuleSpecifier().setLiteralValue(g.module);
    };

    groups.forEach((g) => {
      const onlyNamed = !g.defaultLocal && !g.namespaceLocal;
      const existing = onlyNamed ? findExisting(g.module, typeOnly, decl) : null;
      if (existing) { mergeInto(existing, g.named); return; }
      if (!reused && staying.length === 0) { rewrite(g); reused = true; return; }
      const parts = [];
      if (g.defaultLocal) parts.push(g.defaultLocal);
      if (g.namespaceLocal) parts.push('* as ' + g.namespaceLocal);
      if (g.named.length) parts.push('{ ' + g.named.map(specText).join(', ') + ' }');
      newTexts.push('import ' + (typeOnly ? 'type ' : '') + parts.join(', ') + ' from ' + quote + g.module + quote + semi);
    });

    if (staying.length) {
      decl.getNamedImports().filter((s) => staying.indexOf(s) === -1).forEach((s) => s.remove());
      if (decl.getDefaultImport()) decl.removeDefaultImport();
    } else if (!reused) {
      decl.remove();
      return 0;
    }
    // new declarations go right after the original one, one per line
    if (newTexts.length) sf.insertText(decl.getEnd(), newTexts.map((t) => eol + t).join(''));
    return 1 + newTexts.length;
  }

  for (let i = 0; i < sf.getImportDeclarations().length;) {
    i += processImport(sf.getImportDeclarations()[i]);
  }

  // ---- re-exports: not one of the supported patterns ----
  sf.getExportDeclarations().forEach((ed) => {
    const m = ed.getModuleSpecifierValue();
    if (m && m.startsWith(OLD_PREFIX)) addManual(ed.getStartLineNumber(), 'export ... from \'' + m + '\' – re-export, יש להמיר ידנית');
  });

  // ---- require('@material-ui/...') ----
  const requires = sf.getDescendantsOfKind(K.CallExpression).filter((c) => {
    const callee = c.getExpression();
    const arg = c.getArguments()[0];
    return Node.isIdentifier(callee) && callee.getText() === 'require' && c.getArguments().length === 1 &&
      arg && Node.isStringLiteral(arg) && arg.getLiteralText().startsWith(OLD_PREFIX);
  }).reverse();

  requires.forEach((call) => {
    const lit = call.getArguments()[0];
    const module = lit.getLiteralText();
    const line = call.getStartLineNumber();
    const info = analyzeModule(module, mapping);
    if (info.kind === 'unknown') return addManual(line, module + ': חבילה ללא מיפוי ב-mui-mapping.json');
    if (info.kind === 'manual') return addManual(line, info.reason);
    const parent = call.getParent();

    // require('x').Name
    if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === call) {
      const name = parent.getName();
      const c = classifyName(info, name, mapping);
      if (c.manual) return addManual(line, c.manual);
      lit.setLiteralValue(c.module);
      if (c.newName !== name) parent.getNameNode().replaceWithText(c.newName);
      change(line, 'MUI.REQUIRE', module + ' → ' + c.module, reviewReason(info, c.module));
      return;
    }

    // const { A, B } = require('x')
    if (Node.isVariableDeclaration(parent) && Node.isObjectBindingPattern(parent.getNameNode())) {
      const pattern = parent.getNameNode();
      const elements = pattern.getElements();
      if (elements.some((el) => el.getDotDotDotToken())) {
        return addManual(line, 'require עם rest (...) מ-' + module + ' – יש להמיר ידנית');
      }
      const groups = new Map();
      const stayingTexts = [];
      elements.forEach((el) => {
        const propNode = el.getPropertyNameNode();
        const name = propNode ? propNode.getText() : el.getName();
        const c = classifyName(info, name, mapping);
        if (c.manual) { stayingTexts.push(el.getText()); addManual(el.getStartLineNumber(), c.manual); return; }
        let local = el.getName();
        if (!propNode && c.newName !== name) local = planRename(name, c.newName, c.module);
        const init = el.getInitializer() ? ' = ' + el.getInitializer().getText() : '';
        const text = (local === c.newName ? c.newName : c.newName + ': ' + local) + init;
        if (!groups.has(c.module)) groups.set(c.module, []);
        groups.get(c.module).push(text);
      });
      if (groups.size === 0) return;
      groups.forEach((_, m) => change(line, 'MUI.REQUIRE', module + ' → ' + m, reviewReason(info, m)));

      const entries = Array.from(groups.entries());
      if (stayingTexts.length === 0 && entries.length === 1) {
        pattern.replaceWithText('{ ' + entries[0][1].join(', ') + ' }');
        call.getArguments()[0].setLiteralValue(entries[0][0]);
        return;
      }
      const stmt = parent.getVariableStatement();
      if (!stmt || stmt.getDeclarations().length !== 1) {
        changes.pop();
        return addManual(line, 'require מ-' + module + ' בהצהרה מרובת משתנים – יש לפצל ידנית');
      }
      const kind = stmt.getDeclarationKind();
      const quote = lit.getText().charAt(0);
      const semi = /;\s*$/.test(stmt.getText()) ? ';' : '';
      const extra = [];
      if (stayingTexts.length) {
        pattern.replaceWithText('{ ' + stayingTexts.join(', ') + ' }');
        entries.forEach((e) => extra.push(kind + ' { ' + e[1].join(', ') + ' } = require(' + quote + e[0] + quote + ')' + semi));
      } else {
        pattern.replaceWithText('{ ' + entries[0][1].join(', ') + ' }');
        call.getArguments()[0].setLiteralValue(entries[0][0]);
        entries.slice(1).forEach((e) => extra.push(kind + ' { ' + e[1].join(', ') + ' } = require(' + quote + e[0] + quote + ')' + semi));
      }
      stmt.getParent().insertStatements(stmt.getChildIndex() + 1, extra);
      return;
    }

    // const Core = require('x') / other whole-module use
    if (info.conf.moved && info.kind === 'root') {
      change(line, 'MUI.REQUIRE', module + ' → ' + info.wholeTarget, 'require של כל ' + module + ' – חלק מהרכיבים עברו ל-' + info.conf.movedTo);
    } else {
      change(line, 'MUI.REQUIRE', module + ' → ' + info.wholeTarget, reviewReason(info, info.wholeTarget));
    }
    lit.setLiteralValue(info.wholeTarget);
  });

  // ---- usages of renamed bindings ----
  const renameable = (id) => {
    const p = id.getParent();
    if (!p || id.getFirstAncestorByKind(K.ImportDeclaration)) return false;
    if (Node.isPropertyAccessExpression(p) && p.getNameNode() === id) return false;
    if ((Node.isPropertyAssignment(p) || Node.isMethodDeclaration(p) || Node.isPropertySignature(p) ||
         Node.isPropertyDeclaration(p) || Node.isJsxAttribute(p)) && p.getNameNode() === id) return false;
    if ((Node.isVariableDeclaration(p) || Node.isParameterDeclaration(p) || Node.isFunctionDeclaration(p) ||
         Node.isClassDeclaration(p)) && p.getNameNode() === id) return false;
    if (Node.isBindingElement(p) && p.getInitializer() !== id) return false;
    if (Node.isExportSpecifier(p) && p.getAliasNode() === id) return false;
    if (Node.isQualifiedName(p) && p.getRight() === id) return false;
    return true;
  };
  pendingRenames.forEach((r) => {
    const ids = sf.getDescendantsOfKind(K.Identifier).filter((id) => id.getText() === r.from && renameable(id));
    if (!ids.length) return;
    const firstLine = ids[0].getStartLineNumber();
    // מהסוף להתחלה, כדי שהחלפה לא תזיז מיקומים של צמתים שעוד לא טופלו
    ids.slice().reverse().forEach((id) => {
      const p = id.getParent();
      if (Node.isShorthandPropertyAssignment(p)) p.replaceWithText(r.from + ': ' + r.to);
      else if (Node.isExportSpecifier(p)) p.replaceWithText(r.to + ' as ' + r.from);
      else id.replaceWithText(r.to);
    });
    change(firstLine, 'MUI.RENAME', r.from + ' → ' + r.to + ' (' + ids.length + ' שימושים)');
  });

  // ---- theme.palette.type → theme.palette.mode ----
  const pal = mapping.palette;
  const isPalette = (expr) => (Node.isPropertyAccessExpression(expr) && expr.getName() === 'palette') ||
    (Node.isIdentifier(expr) && expr.getText() === 'palette');
  sf.getDescendantsOfKind(K.PropertyAccessExpression)
    .filter((pa) => pa.getName() === pal.from && isPalette(pa.getExpression()))
    .reverse()
    .forEach((pa) => {
      pa.getNameNode().replaceWithText(pal.to);
      change(pa.getStartLineNumber(), 'MUI.PALETTE_MODE', 'palette.' + pal.from + ' → palette.' + pal.to);
    });
  // createTheme({ palette: { type: 'dark' } })
  sf.getDescendantsOfKind(K.PropertyAssignment)
    .filter((p) => {
      if (p.getName() !== pal.from) return false;
      const obj = p.getParent();
      const owner = obj && obj.getParent();
      return Node.isObjectLiteralExpression(obj) && owner && Node.isPropertyAssignment(owner) && owner.getName() === 'palette';
    })
    .reverse()
    .forEach((p) => {
      const inTheme = !!p.getFirstAncestor((a) => Node.isCallExpression(a) && /(^|\.)(createTheme|createMuiTheme)$/.test(a.getExpression().getText()));
      p.getNameNode().replaceWithText(pal.to);
      change(p.getStartLineNumber(), 'MUI.PALETTE_MODE', 'palette: { ' + pal.from + ' } → { ' + pal.to + ' }',
        inTheme ? null : 'palette.' + pal.from + ' באובייקט שאינו ארגומנט ישיר של createTheme – ודא שזה theme של MUI');
    });

  const remaining = sf.getImportDeclarations().filter((d) => d.getModuleSpecifierValue().startsWith(OLD_PREFIX)).length +
    sf.getDescendantsOfKind(K.CallExpression).filter((c) => {
      const a = c.getArguments()[0];
      return Node.isIdentifier(c.getExpression()) && c.getExpression().getText() === 'require' && a && Node.isStringLiteral(a) && a.getLiteralText().startsWith(OLD_PREFIX);
    }).length;

  return { changes: changes, manual: manual, remaining: remaining };
}

// ---------------------------------------------------------------------------

// Style for newly generated code: line endings of the file, quote style of its first import.
function detectSettings(tsm, sf, text) {
  const first = sf.getImportDeclarations()[0];
  const quote = first ? first.getModuleSpecifier().getText().charAt(0) : "'";
  return {
    newLineKind: text.indexOf('\r\n') !== -1 ? tsm.NewLineKind.CarriageReturnLineFeed : tsm.NewLineKind.LineFeed,
    quoteKind: quote === '"' ? tsm.QuoteKind.Double : tsm.QuoteKind.Single,
  };
}

async function formatWithPrettier(root, files, fs, res) {
  let prettier;
  try {
    prettier = require(require.resolve('prettier', { paths: [root] }));
  } catch (_) {
    if (files.length) res.notes.push('prettier לא מותקן בשירות – הקבצים לא עוצבו');
    return;
  }
  for (const full of files) {
    const rel = toPosix(path.relative(root, full));
    // prettier של השירות: קונפיג שבור, parser חסר או תחביר שהוא לא מכיר – צפוי, לא קריסה
    try {
      const config = await prettier.resolveConfig(full);
      if (!config) continue; // אין קונפיגורציה בריפו – לא מעצבים, כדי לא לייצר diff ענק
      const text = fs.readFileSync(full, 'utf8');
      const out = await prettier.format(text, Object.assign({}, config, { filepath: full }));
      if (out !== text) fs.writeFileSync(full, out, 'utf8');
    } catch (err) {
      const why = String((err && err.message) || err).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] || 'שגיאה לא ידועה';
      res.blockers.push({ file: rel, message: rel + ': prettier נכשל – ' + why + '. שינויי הייבוא נכתבו לקובץ, אך הוא לא עוצב. הרץ prettier ידנית על הקובץ ובדוק את השגיאה' });
    }
  }
}

async function run(argv, overrides) {
  const deps = Object.assign({ fs: require('fs'), cwd: process.cwd(), prettier: true }, overrides || {});
  const opts = parseArgs(argv || []);
  const res = { script: SCRIPT, result: 'OK', changes: [], manual: [], blockers: [], notes: [], dryRun: opts.dryRun, filesChanged: [] };
  const blocked = (m) => { res.result = 'BLOCKED'; res.blockers.push({ message: m }); return res; };
  if (opts.errors.length) return blocked(opts.errors.join('; '));

  let tsm;
  try { tsm = require('ts-morph'); } catch (_) {
    return blocked('ts-morph אינו מותקן בתיקיית הסקיל – הרץ npm install ב-' + path.join(__dirname, '..'));
  }
  let mapping;
  try { mapping = JSON.parse(require('fs').readFileSync(MAPPING_FILE, 'utf8')); } catch (err) {
    return blocked('לא ניתן לטעון את reference/mui-mapping.json: ' + err.message);
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

  let remaining = 0;
  const written = [];
  for (const full of files) {
    const rel = toPosix(path.relative(deps.cwd, full));
    let raw;
    try { raw = deps.fs.readFileSync(full, 'utf8'); } catch (err) { return blocked('לא ניתן לקרוא את ' + rel + ': ' + err.message); }
    // סינון ביצועים בלבד: קובץ שאין בו אף אחת מהמחרוזות לא יכול להכיל מה להמיר.
    // ההחלטה מה להמיר מתקבלת אך ורק מה-AST (מופע בתוך הערה לא ישנה דבר)
    if (raw.indexOf(OLD_PREFIX) === -1 && raw.indexOf('palette') === -1) continue;
    const bom = raw.charCodeAt(0) === 0xfeff ? '﻿' : '';
    const text = bom ? raw.slice(1) : raw;
    const sf = project.createSourceFile('/' + rel, text, { overwrite: true });
    project.manipulationSettings.set(detectSettings(tsm, sf, text));
    const r = transformFile(tsm, sf, rel, mapping);
    remaining += r.remaining;
    res.changes.push.apply(res.changes, r.changes);
    res.manual.push.apply(res.manual, r.manual);
    const out = sf.getFullText();
    if (out !== text) {
      res.filesChanged.push(rel);
      if (!opts.dryRun) {
        try { deps.fs.writeFileSync(full, bom + out, 'utf8'); } catch (err) { return blocked('לא ניתן לכתוב את ' + rel + ': ' + err.message); }
        written.push(full);
      }
    }
    project.removeSourceFile(sf);
  }

  if (deps.prettier && written.length) await formatWithPrettier(deps.cwd, written, deps.fs, res);

  const reviews = res.changes.filter((c) => c.confidence === 'review');
  if (res.blockers.length) res.result = 'BLOCKED';
  else if (res.changes.length === 0 && remaining === 0) res.result = 'NOOP';
  else if (res.manual.length || reviews.length) res.result = 'REVIEW';
  if (remaining) res.notes.push(remaining + ' ייבואים מ-@material-ui נשארו (ראה manual)');
  return res;
}

function formatText(res) {
  const L = [SCRIPT + (res.dryRun ? ' [dry-run]' : '')];
  res.blockers.forEach((b) => L.push('⛔ ' + b.message));
  // a prettier BLOCKED comes after the files were written – the summary of what changed still matters
  if (res.result !== 'BLOCKED' || res.changes.length || res.manual.length) {
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

async function main(argv, deps, io) {
  io = io || { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) };
  try {
    const opts = parseArgs(argv || []);
    const res = await run(argv, deps);
    io.stdout(opts.json ? JSON.stringify(res, null, 2) + '\n' : formatText(res));
    return 0;
  } catch (err) {
    io.stderr(SCRIPT + ' crashed: ' + ((err && err.stack) || err) + '\n');
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.stdout.write('', () => process.exit(code)));
}

module.exports = { run: run, main: main, analyzeModule: analyzeModule };
