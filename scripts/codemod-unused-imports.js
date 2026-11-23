#!/usr/bin/env node
'use strict';

// codemod-unused-imports: removes import bindings that are never referenced in the file (ts-morph only).
// Why: an unused import is still evaluated at runtime (Babel keeps it in .js/.jsx), and under React 18 / MUI v7
// an import of an API that no longer exists breaks the service even though nothing uses it.
// Conservative: a binding stays whenever its name appears anywhere else in the file as an identifier.
// Never touched: side-effect imports (import './x.css'), import x = require(), .d.ts files,
// React default/namespace import in a file with JSX (classic runtime), names from @jsx / @jsxFrag pragmas.
// Removing a whole import also stops the module from being evaluated, so:
// - a stylesheet (.css/.scss/.sass/.less) keeps loading as a side-effect import (it may be global CSS);
// - a removed import of a local module (./, ../) is a 'review' change – it may hold top-level setup code.
// Changes are position-based text edits – everything else in the file stays byte-for-byte identical.

const path = require('path');
const stubMode = require('./stub-mode');

const SCRIPT = 'codemod-unused-imports';
const SOURCE_EXTS = ['.js', '.jsx', '.ts', '.tsx'];
const SKIP_DIRS = new Set(['node_modules', 'build', 'dist']);
const PRAGMA_RE = /@jsx(?:Frag)?\s+([A-Za-z_$][\w$]*)/g;
const STYLE_RE = /\.(css|scss|sass|less)(\?.*)?$/i;
const LOCAL_RE = /^\.\.?(\/|$)/;

class CodemodError extends Error {}
class EditConflict extends Error {
  constructor(pos) { super('overlapping edits at ' + pos); this.pos = pos; }
}

function parseArgs(argv) {
  const opts = { dryRun: false, json: false, errors: [] };
  argv.forEach((a) => {
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else opts.errors.push('Unknown argument: ' + a);
  });
  return opts;
}

const toPosix = (p) => p.split(path.sep).join('/');

function listSourceFiles(fs, root) {
  const srcDir = path.join(root, 'src');
  let stat = null;
  try { stat = fs.statSync(srcDir); } catch (_) { /* missing */ }
  if (!stat || !stat.isDirectory()) throw new CodemodError('No src/ folder found in ' + root);
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) {
      throw new CodemodError('Cannot read ' + toPosix(path.relative(root, dir)) + ': ' + err.message);
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full); }
      else if (e.isFile() && SOURCE_EXTS.indexOf(path.extname(e.name)) !== -1 && !/\.d\.ts$/.test(e.name)) out.push(full);
    }
  };
  walk(srcDir);
  return out;
}

function applyEdits(text, edits) {
  const sorted = edits.slice().sort((a, b) => b.start - a.start || b.end - a.end);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].end > sorted[i - 1].start) throw new EditConflict(sorted[i - 1].start);
  }
  return sorted.reduce((t, e) => t.slice(0, e.start) + e.text + t.slice(e.end), text);
}

// Range of a whole statement line(s): from line start (if only whitespace precedes) through the line break.
function wholeLineRange(text, start, end) {
  const ls = text.lastIndexOf('\n', start - 1) + 1;
  const s = /^[ \t]*$/.test(text.slice(ls, start)) ? ls : start;
  let e = end;
  while (e < text.length && (text[e] === ' ' || text[e] === '\t')) e++;
  if (text[e] === '\r') e++;
  if (text[e] === '\n') e++;
  if (s === ls && /\n[ \t]*\r?\n$/.test(text.slice(0, s))) {
    const m = /^[ \t]*\r?\n/.exec(text.slice(e));
    if (m) e += m[0].length;
  }
  return { start: s, end: e };
}

// ---------------------------------------------------------------------------

function transformFile(tsm, sf, file) {
  const { SyntaxKind: K } = tsm;
  const text = sf.getFullText();
  const edits = [];
  const changes = [];
  const manual = [];

  // every identifier outside import declarations counts as a use (JSX tags, types, exports, shorthand properties …)
  const used = new Set();
  sf.getDescendantsOfKind(K.Identifier).forEach((id) => {
    if (!id.getFirstAncestorByKind(K.ImportDeclaration)) used.add(id.getText());
  });
  let m;
  PRAGMA_RE.lastIndex = 0;
  while ((m = PRAGMA_RE.exec(text))) used.add(m[1]);
  const hasJsx = sf.getDescendantsOfKind(K.JsxElement).length > 0 || sf.getDescendantsOfKind(K.JsxSelfClosingElement).length > 0 ||
    sf.getDescendantsOfKind(K.JsxFragment).length > 0;

  const decls = sf.getImportDeclarations();
  let removedDecls = 0;
  decls.forEach((d) => {
    const clause = d.getImportClause();
    if (!clause) return; // side-effect import
    const module = d.getModuleSpecifierValue();
    const keepReact = hasJsx && module === 'react';
    const isUsed = (name) => used.has(name);

    const def = d.getDefaultImport();
    const ns = d.getNamespaceImport();
    const named = d.getNamedImports();
    const local = (s) => (s.getAliasNode() ? s.getAliasNode().getText() : s.getName());

    const defDead = !!def && !isUsed(def.getText()) && !keepReact;
    const nsDead = !!ns && !isUsed(ns.getText()) && !keepReact;
    const deadNamed = named.filter((s) => !isUsed(local(s)));
    const removedNames = [].concat(defDead ? [def.getText()] : [], nsDead ? [ns.getText()] : [], deadNamed.map(local));
    if (!removedNames.length) return;

    const line = d.getStartLineNumber();
    const allNamedDead = deadNamed.length === named.length;
    const defKept = !!def && !defDead;
    const nsKept = !!ns && !nsDead;
    const anyKept = defKept || nsKept || (named.length > 0 && !allNamedDead);
    const detail = removedNames.join(', ') + " from '" + module + "'";

    if (!anyKept) {
      if (STYLE_RE.test(module)) {
        // a stylesheet may be global CSS – keep loading it: "import styles from './a.css'" → "import './a.css'"
        edits.push({ start: d.getStart(), end: d.getModuleSpecifier().getStart(), text: 'import ' });
        changes.push({ file: file, line: line, rule: 'UNUSED.IMPORT', confidence: 'auto', detail: 'unused binding removed, stylesheet still loaded: ' + detail });
        return;
      }
      const r = wholeLineRange(text, d.getStart(), d.getEnd());
      edits.push({ start: r.start, end: r.end, text: '' });
      removedDecls++;
      changes.push({ file: file, line: line, rule: 'UNUSED.IMPORT', confidence: LOCAL_RE.test(module) ? 'review' : 'auto', detail: 'import removed: ' + detail,
        reason: LOCAL_RE.test(module) ? "Unused import of the local module '" + module + "' removed – the module is no longer loaded from this file; check that it has no top-level setup code (interceptors, i18n, registration)" : undefined });
      return;
    }

    const bindings = clause.getNamedBindings(); // NamedImports | NamespaceImport | undefined
    if (defDead) {
      // "A, { b }" / "A, * as ns" → drop "A, "
      edits.push({ start: def.getStart(), end: bindings.getStart(), text: '' });
    }
    if (nsDead) {
      // "A, * as ns" → "A"
      edits.push({ start: def.getEnd(), end: bindings.getEnd(), text: '' });
    }
    if (named.length && allNamedDead) {
      // "A, { b, c }" → "A"
      edits.push({ start: def.getEnd(), end: bindings.getEnd(), text: '' });
    } else if (deadNamed.length) {
      // runs of dead specifiers: followed by a kept one → remove up to its start ("a, b, c" → "c");
      // the trailing run → remove from the end of the last kept one ("a, b, c" → "a")
      const dead = new Set(deadNamed);
      for (let i = 0; i < named.length; i++) {
        if (!dead.has(named[i])) continue;
        let j = i;
        while (j + 1 < named.length && dead.has(named[j + 1])) j++;
        if (j + 1 < named.length) edits.push({ start: named[i].getStart(), end: named[j + 1].getStart(), text: '' });
        else edits.push({ start: named[i - 1].getEnd(), end: named[j].getEnd(), text: '' });
        i = j;
      }
    }
    changes.push({ file: file, line: line, rule: 'UNUSED.IMPORT', confidence: 'auto', detail: 'unused binding removed: ' + detail });
  });

  // a .ts/.tsx file that loses its last import and has no export becomes a script (global scope)
  if (removedDecls && /\.tsx?$/.test(file) && removedDecls === decls.length &&
      !/^[ \t]*export\b/m.test(text)) {
    manual.push({ file: file, line: 1, reason: 'All imports were unused and removed; the file has no export, so TypeScript now treats it as a script – add export {} if needed' });
  }
  return { edits: edits, changes: changes, manual: manual };
}

// ---------------------------------------------------------------------------

function run(argv, overrides) {
  const deps = Object.assign({ fs: require('fs'), cwd: process.cwd(), applyEdits: applyEdits }, overrides || {});
  const opts = parseArgs(argv || []);
  const res = { script: SCRIPT, result: 'OK', changes: [], manual: [], blockers: [], notes: [], dryRun: opts.dryRun, filesChanged: [] };
  const blocked = (msg) => { res.result = 'BLOCKED'; res.blockers.push({ message: msg }); return res; };
  if (opts.errors.length) return blocked(opts.errors.join('; '));

  let tsm;
  try { tsm = require('ts-morph'); } catch (_) {
    return blocked('ts-morph is not installed in the skill folder – run npm install in ' + path.join(__dirname, '..'));
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
    try { raw = deps.fs.readFileSync(full, 'utf8'); } catch (err) { return blocked('Cannot read ' + rel + ': ' + err.message); }
    const bom = raw.charCodeAt(0) === 0xfeff ? '﻿' : '';
    const text = bom ? raw.slice(1) : raw;
    const sf = project.createSourceFile('/' + rel, text, { overwrite: true });
    const r = transformFile(tsm, sf, rel);
    project.removeSourceFile(sf);
    let out = text;
    if (r.edits.length) {
      try {
        out = deps.applyEdits(text, r.edits);
      } catch (err) {
        if (!(err instanceof EditConflict)) throw err;
        const line = text.slice(0, err.pos).split('\n').length;
        res.blockers.push({ file: rel, message: rel + ':' + line + ' – ' + SCRIPT + ' produced two overlapping edits (a bug in the codemod). The file was not changed – remove the unused imports manually or report the bug' });
        continue;
      }
    }
    res.manual.push.apply(res.manual, r.manual);
    res.changes.push.apply(res.changes, r.changes);
    if (out === text) continue;
    res.filesChanged.push(rel);
    if (!opts.dryRun) {
      try { deps.fs.writeFileSync(full, bom + out, 'utf8'); } catch (err) { return blocked('Cannot write ' + rel + ': ' + err.message); }
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
  if (res.result !== 'BLOCKED' || res.changes.length || res.manual.length) {
    L.push('✏️ ' + res.filesChanged.length + ' files ' + (res.dryRun ? 'would change' : 'changed') +
      (res.changes.length ? ' | UNUSED.IMPORT ×' + res.changes.length : ''));
    res.changes.filter((c) => c.confidence === 'review').forEach((c) => L.push('🔍 ' + c.file + ':' + c.line + ' – ' + c.reason));
    res.manual.forEach((x) => L.push('✋ ' + x.file + ':' + x.line + ' – ' + x.reason));
    res.notes.forEach((n) => L.push('ℹ ' + n));
  }
  L.push('RESULT: ' + res.result);
  return L.join('\n') + '\n';
}

function main(argv, deps, io) {
  io = io || { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) };
  try {
    const opts = parseArgs(argv || []);
    const res = stubMode.annotate(run(argv, deps), stubMode.modeFor(deps));
    io.stdout(opts.json ? JSON.stringify(res, null, 2) + '\n' : stubMode.banner(res) + formatText(res));
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
