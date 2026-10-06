#!/usr/bin/env node
'use strict';

// use-shared-state: install useSharedState v2.0.0 (bundled asset) into the service and verify its call-sites.
// The asset is copied byte-for-byte – this script never edits the hook itself.

const path = require('path');
const crypto = require('crypto');

const SCRIPT = 'use-shared-state';
const ASSET = path.join(__dirname, '..', 'assets', 'useSharedState.v2.0.0.js');
const HOOK_NAME = 'useSharedState';
const HOOK_FILE_RE = /^useSharedState\.(js|jsx|ts|tsx)$/;
const DEFAULT_TARGET = 'src/services/hooks/useSharedState.js';
const BACKUP_DIR = '.migration/backup';
const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', '.git', '.migration']);
const SOURCE_EXTS = ['.js', '.jsx', '.ts', '.tsx'];

class StateError extends Error {}

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
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
// השוואה ללא תלות בסופי שורות (autocrlf ב-Windows לא אמור להיחשב כשינוי)
const normalizedSha = (buf) => sha256(Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'));

function walk(fs, root, dir, filter, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) {
    throw new StateError('לא ניתן לקרוא את ' + (toPosix(path.relative(root, dir)) || '.') + ': ' + err.message);
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(fs, root, full, filter, out); } else if (e.isFile() && filter(e.name)) out.push(full);
  }
  return out;
}

function resolveRelative(fs, fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const e of [''].concat(SOURCE_EXTS)) {
    try { if (fs.statSync(base + e).isFile()) return base + e; } catch (_) { /* next */ }
  }
  for (const e of SOURCE_EXTS) {
    try { if (fs.statSync(path.join(base, 'index' + e)).isFile()) return path.join(base, 'index' + e); } catch (_) { /* next */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Call-sites

function scanCallSites(tsm, fs, root, hookFiles) {
  const { Node, SyntaxKind: K } = tsm;
  const srcDir = path.join(root, 'src');
  let files = [];
  try { if (fs.statSync(srcDir).isDirectory()) files = walk(fs, root, srcDir, (n) => SOURCE_EXTS.indexOf(path.extname(n)) !== -1, []); } catch (_) { /* no src */ }
  const hookSet = new Set(hookFiles.map((f) => path.resolve(f)));
  const project = new tsm.Project({
    useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, jsx: tsm.ts.JsxEmit.Preserve },
  });

  // import that points at the hook: relative path resolving to it, or a bare/alias path ending in /useSharedState
  const pointsAtHook = (full, spec) => {
    if (spec.startsWith('.')) {
      const r = resolveRelative(fs, full, spec);
      return r ? hookSet.has(path.resolve(r)) : false;
    }
    return path.posix.basename(spec).replace(/\.(js|jsx|ts|tsx)$/, '') === HOOK_NAME;
  };

  const sites = [];
  for (const full of files) {
    if (hookSet.has(path.resolve(full))) continue;
    const rel = toPosix(path.relative(root, full));
    let text;
    try { text = fs.readFileSync(full, 'utf8'); } catch (err) { throw new StateError('לא ניתן לקרוא את ' + rel + ': ' + err.message); }
    if (text.indexOf(HOOK_NAME) === -1) continue; // סינון ביצועים בלבד
    const sf = project.createSourceFile('/' + rel, text.replace(/^﻿/, ''), { overwrite: true });
    const locals = []; // { name, line }
    const site = (line, ok, reason) => sites.push({ file: rel, line: line, ok: ok, reason: reason || undefined });

    sf.getImportDeclarations().forEach((d) => {
      if (!pointsAtHook(full, d.getModuleSpecifierValue())) return;
      const line = d.getStartLineNumber();
      if (d.getDefaultImport()) locals.push(d.getDefaultImport().getText());
      d.getNamedImports().forEach((s) => {
        if (s.getName() === 'default') locals.push(s.getAliasNode() ? s.getAliasNode().getText() : s.getName());
        else site(line, false, 'import { ' + s.getName() + ' } – גרסה 2.0.0 מייצאת export default בלבד');
      });
      if (d.getNamespaceImport()) site(line, false, 'import * as ' + d.getNamespaceImport().getText() + ' – יש לייבא את ה-default');
    });
    // const useSharedState = require('…/useSharedState')
    sf.getDescendantsOfKind(K.CallExpression).forEach((c) => {
      const arg = c.getArguments()[0];
      if (!Node.isIdentifier(c.getExpression()) || c.getExpression().getText() !== 'require' || !arg || !Node.isStringLiteral(arg)) return;
      if (!pointsAtHook(full, arg.getLiteralText())) return;
      const parent = c.getParent();
      if (Node.isVariableDeclaration(parent) && Node.isIdentifier(parent.getNameNode())) locals.push(parent.getName());
      else if (Node.isPropertyAccessExpression(parent) && parent.getName() === 'default' && Node.isVariableDeclaration(parent.getParent())) locals.push(parent.getParent().getName());
      else site(c.getStartLineNumber(), false, 'require של useSharedState בצורה לא נתמכת');
    });

    for (const local of locals) {
      sf.getDescendantsOfKind(K.Identifier).forEach((id) => {
        if (id.getText() !== local || id.getFirstAncestorByKind(K.ImportDeclaration)) return;
        const p = id.getParent();
        if (Node.isVariableDeclaration(p) && p.getNameNode() === id) return; // const X = require(...)
        if (Node.isPropertyAccessExpression(p) && p.getNameNode() === id) return;
        const line = id.getStartLineNumber();
        if (!Node.isCallExpression(p) || p.getExpression() !== id) return site(line, false, local + ' בשימוש שאינו קריאה ישירה');
        const args = p.getArguments();
        const problems = [];
        if (args.some((a) => Node.isSpreadElement(a))) problems.push('ארגומנט spread');
        else if (args.length < 1 || args.length > 2) problems.push(args.length + ' ארגומנטים (צפוי 1 או 2)');
        const decl = p.getParent();
        const pattern = Node.isVariableDeclaration(decl) ? decl.getNameNode() : null;
        if (!pattern || !Node.isArrayBindingPattern(pattern)) {
          problems.push('התוצאה אינה מפורקת ל-[value, setter]');
        } else {
          const els = pattern.getElements();
          if (els.length !== 2 || els.some((e) => Node.isBindingElement(e) && e.getDotDotDotToken())) problems.push('פירוק ל-' + els.length + ' איברים במקום זוג');
        }
        site(line, problems.length === 0, problems.join('; '));
      });
    }
    project.removeSourceFile(sf);
  }
  return sites;
}

// ---------------------------------------------------------------------------

function run(argv, overrides) {
  const deps = Object.assign({ fs: require('fs'), cwd: process.cwd(), assetPath: ASSET }, overrides || {});
  const opts = parseArgs(argv || []);
  const fs = deps.fs;
  const root = deps.cwd;
  const res = {
    script: SCRIPT, result: 'OK', changes: [], manual: [], blockers: [], notes: [], dryRun: opts.dryRun,
    hookPath: null, replaced: false, created: false, previousSha: null, assetSha: null, backup: null, callSites: [],
  };
  const blocked = (m) => { res.result = 'BLOCKED'; res.blockers.push({ message: m }); return res; };
  if (opts.errors.length) return blocked(opts.errors.join('; '));

  let tsm;
  try { tsm = require('ts-morph'); } catch (_) {
    return blocked('ts-morph אינו מותקן בתיקיית הסקיל – הרץ npm install ב-' + path.join(__dirname, '..'));
  }

  // asset
  let asset;
  try {
    asset = require('fs').readFileSync(deps.assetPath);
  } catch (err) {
    return blocked('קובץ ה-asset לא נמצא: ' + toPosix(path.relative(path.join(__dirname, '..'), deps.assetPath)) +
      ' – יש להוסיף לסקיל את useSharedState בגרסה 2.0.0 (' + err.code + ')');
  }
  res.assetSha = sha256(asset);
  {
    const p = new tsm.Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
    const asf = p.createSourceFile('/asset.js', asset.toString('utf8').replace(/^﻿/, ''));
    if (!asf.getDefaultExportSymbol() && !asf.getExportAssignments().length) {
      return blocked('ה-asset אינו מכיל export default – אינו תואם ל-API של 2.0.0');
    }
  }

  // existing hook files, found by name anywhere in the repo
  let found;
  try { found = walk(fs, root, root, (n) => HOOK_FILE_RE.test(n), []); } catch (err) {
    if (err instanceof StateError) return blocked(err.message);
    throw err;
  }
  const rels = found.map((f) => toPosix(path.relative(root, f)));

  if (found.length > 1) {
    res.result = 'REVIEW';
    res.manual.push({ file: null, line: null, reason: 'נמצאו ' + found.length + ' קבצי useSharedState: ' + rels.join(', ') + ' – לא ידוע איזה להחליף' });
  } else if (found.length === 1) {
    const full = found[0];
    res.hookPath = rels[0];
    let current;
    try { current = fs.readFileSync(full); } catch (err) { return blocked('לא ניתן לקרוא את ' + rels[0] + ': ' + err.message); }
    res.previousSha = sha256(current);
    if (normalizedSha(current) === normalizedSha(asset)) {
      res.notes.push(rels[0] + ' כבר בגרסה 2.0.0');
    } else if (!/\.jsx?$/.test(full)) {
      res.result = 'REVIEW';
      res.manual.push({ file: rels[0], line: null, reason: 'הקובץ הקיים הוא TypeScript וה-asset הוא JavaScript – החלפה ידנית (או הוספת טיפוסים) נדרשת' });
    } else {
      const backupRel = toPosix(path.join(BACKUP_DIR, rels[0] + '.' + res.previousSha.slice(0, 12) + '.bak'));
      res.backup = backupRel;
      if (!opts.dryRun) {
        try {
          const backupFull = path.join(root, backupRel);
          fs.mkdirSync(path.dirname(backupFull), { recursive: true });
          if (!fs.existsSync(backupFull)) fs.writeFileSync(backupFull, current);
          fs.writeFileSync(full, asset);
        } catch (err) {
          return blocked('לא ניתן להחליף את ' + rels[0] + ': ' + err.message);
        }
      }
      res.replaced = true;
      res.changes.push({ file: rels[0], rule: 'SHARED_STATE.REPLACE', confidence: 'auto', detail: 'הוחלף ב-2.0.0, גיבוי ב-' + backupRel });
    }
  } else {
    res.hookPath = DEFAULT_TARGET;
    if (!opts.dryRun) {
      try {
        const full = path.join(root, DEFAULT_TARGET);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, asset);
      } catch (err) {
        return blocked('לא ניתן ליצור את ' + DEFAULT_TARGET + ': ' + err.message);
      }
    }
    res.created = true;
    res.changes.push({ file: DEFAULT_TARGET, rule: 'SHARED_STATE.CREATE', confidence: 'auto', detail: 'נוצר מ-asset 2.0.0' });
  }

  // call-sites
  const hookFiles = found.length ? found : [path.join(root, DEFAULT_TARGET)];
  try {
    res.callSites = scanCallSites(tsm, fs, root, hookFiles);
  } catch (err) {
    if (err instanceof StateError) return blocked(err.message);
    throw err;
  }
  const bad = res.callSites.filter((s) => !s.ok);
  bad.forEach((s) => res.manual.push({ file: s.file, line: s.line, reason: s.reason }));
  if (bad.length) res.result = 'REVIEW';

  if (res.result === 'OK' && !res.changes.length) res.result = 'NOOP';
  return res;
}

function formatText(res) {
  const L = [SCRIPT + (res.dryRun ? ' [dry-run]' : '')];
  if (res.result === 'BLOCKED') res.blockers.forEach((b) => L.push('⛔ ' + b.message));
  else {
    if (res.created) L.push('🆕 ' + res.hookPath + ' ' + (res.dryRun ? 'היה נוצר' : 'נוצר') + ' (asset ' + res.assetSha.slice(0, 12) + ')');
    else if (res.replaced) L.push('🔁 ' + res.hookPath + ' ' + (res.dryRun ? 'היה מוחלף' : 'הוחלף') + ' (' + res.previousSha.slice(0, 12) + ' → ' + res.assetSha.slice(0, 12) + '), גיבוי: ' + res.backup);
    else if (res.hookPath && res.previousSha) L.push('✓ ' + res.hookPath + ' זהה לגרסה 2.0.0');
    const ok = res.callSites.filter((s) => s.ok).length;
    L.push('📞 ' + res.callSites.length + ' call-sites' + (res.callSites.length ? ' (' + ok + ' תקינים)' : ''));
    res.manual.forEach((m) => L.push('✋ ' + (m.file ? m.file + (m.line ? ':' + m.line : '') + ' – ' : '') + m.reason));
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
