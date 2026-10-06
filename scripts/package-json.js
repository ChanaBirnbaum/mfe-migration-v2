#!/usr/bin/env node
'use strict';

// package-json: point edits to package.json for the migration.
// Never JSON.stringify the whole file: positions come from the TypeScript JSON parser and only the
// touched members are spliced, so key order, indentation and line endings are preserved.

const path = require('path');

const SCRIPT = 'package-json';
const VERSIONS_FILE = path.join(__dirname, '..', 'reference', 'versions.json');
const SCAN_RULES_FILE = path.join(__dirname, '..', 'reference', 'scan-rules.json');
const PICKERS_REASON = 'מעבר מ-pickers v3/v5 ל-x-date-pickers v9 — שינויי API נרחבים, דורש בדיקה ידנית';
const DEFAULT_INVENTORY = '.migration/inventory.json';
const NPM_TIMEOUT_MS = 15000;

class PkgError extends Error {}

function parseArgs(argv) {
  const opts = { dryRun: false, json: false, inventory: DEFAULT_INVENTORY, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--inventory') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) opts.errors.push('‎--inventory דורש נתיב');
      else { opts.inventory = v; i++; }
    } else if (a.startsWith('--inventory=')) opts.inventory = a.slice('--inventory='.length);
    else opts.errors.push('פרמטר לא מוכר: ' + a);
  }
  return opts;
}

const dataKeys = (map) => Object.keys(map || {}).filter((k) => k.charAt(0) !== '_');

// ---------------------------------------------------------------------------
// JSON point editor

function createEditor(ts, original) {
  const bom = original.charCodeAt(0) === 0xfeff ? '﻿' : '';
  let text = bom ? original.slice(1) : original;
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';

  function parse() {
    const sf = ts.parseJsonText('package.json', text);
    const diags = sf.parseDiagnostics || [];
    if (diags.length) {
      throw new PkgError('package.json אינו JSON תקין: ' + ts.flattenDiagnosticMessageText(diags[0].messageText, '\n'));
    }
    const st = sf.statements[0];
    const root = st && st.expression;
    if (!root || root.kind !== ts.SyntaxKind.ObjectLiteralExpression) throw new PkgError('package.json אינו אובייקט JSON');
    return { sf: sf, root: root };
  }

  function members(obj, sf) {
    return obj.properties.map((p) => ({
      key: p.name.text,
      start: p.getStart(sf),
      end: p.end,
      keyEnd: p.name.end,
      valueStart: p.initializer.getStart(sf),
      valueEnd: p.initializer.end,
      init: p.initializer,
    }));
  }

  // JSON.parse keeps the last duplicate key – so do we
  const find = (ms, key) => { for (let i = ms.length - 1; i >= 0; i--) if (ms[i].key === key) return i; return -1; };

  function locate(block) {
    const p = parse();
    if (!block) return { sf: p.sf, obj: p.root, root: p.root };
    const ms = members(p.root, p.sf);
    const i = find(ms, block);
    if (i === -1 || ms[i].init.kind !== ts.SyntaxKind.ObjectLiteralExpression) return null;
    return { sf: p.sf, obj: ms[i].init, root: p.root };
  }

  const splice = (start, end, insert) => { text = text.slice(0, start) + insert + text.slice(end); };

  function lineIndent(pos) {
    const ls = text.lastIndexOf('\n', pos - 1) + 1;
    return /^[ \t]*/.exec(text.slice(ls))[0];
  }
  // whitespace-only prefix before pos on its line, or null if the member shares its line with other tokens
  function ownIndent(pos) {
    const ls = text.lastIndexOf('\n', pos - 1) + 1;
    const prefix = text.slice(ls, pos);
    return /^[ \t]*$/.test(prefix) ? prefix : null;
  }
  function indentUnit() {
    const p = parse();
    const ms = members(p.root, p.sf);
    const ind = ms.length ? ownIndent(ms[0].start) : null;
    return ind || '  ';
  }

  function insert(obj, sf, key, valueJson, opts) {
    opts = opts || {};
    const ms = members(obj, sf);
    const sep = ms.length ? text.slice(ms[0].keyEnd, ms[0].valueStart) : ': ';
    const entry = JSON.stringify(key) + sep + valueJson;
    if (ms.length === 0) {
      const start = obj.getStart(sf);
      const outer = lineIndent(start);
      splice(start, obj.end, '{' + eol + outer + indentUnit() + entry + eol + outer + '}');
      return;
    }
    const indent = ownIndent(ms[0].start);
    const gap = indent === null ? ' ' : eol + indent;
    const keys = ms.map((m) => m.key);
    let after = ms.length - 1;
    if (opts.afterKey && find(ms, opts.afterKey) !== -1) after = find(ms, opts.afterKey);
    else if (opts.sorted && keys.every((k, i) => i === 0 || keys[i - 1].localeCompare(k, 'en') <= 0)) {
      // npm sorts with localeCompare(…, 'en'); keep a sorted block sorted
      after = -1;
      keys.forEach((k, i) => { if (k.localeCompare(key, 'en') < 0) after = i; });
    }
    if (after === -1) splice(ms[0].start, ms[0].start, entry + ',' + gap);
    else splice(ms[after].end, ms[after].end, ',' + gap + entry);
  }

  return {
    eol: eol,
    text: () => bom + text,
    has: (block) => locate(block) !== null,
    get(block, key) {
      const loc = locate(block);
      if (!loc) return undefined;
      const ms = members(loc.obj, loc.sf);
      const i = find(ms, key);
      return i === -1 ? undefined : JSON.parse(text.slice(ms[i].valueStart, ms[i].valueEnd));
    },
    keys(block) {
      const loc = locate(block);
      return loc ? members(loc.obj, loc.sf).map((m) => m.key) : [];
    },
    // returns 'add' | 'update' | null (already equal)
    set(block, key, value, opts) {
      const loc = locate(block);
      if (!loc) throw new Error('block ' + block + ' missing');
      const valueJson = JSON.stringify(value);
      const ms = members(loc.obj, loc.sf);
      const i = find(ms, key);
      if (i !== -1) {
        if (JSON.parse(text.slice(ms[i].valueStart, ms[i].valueEnd)) === value) return null;
        splice(ms[i].valueStart, ms[i].valueEnd, valueJson);
        return 'update';
      }
      insert(loc.obj, loc.sf, key, valueJson, opts);
      return 'add';
    },
    remove(block, key) {
      const loc = locate(block);
      if (!loc) return false;
      const ms = members(loc.obj, loc.sf);
      const i = find(ms, key);
      if (i === -1) return false;
      if (ms.length === 1) splice(loc.obj.getStart(loc.sf), loc.obj.end, '{}');
      else if (i > 0) splice(ms[i - 1].end, ms[i].end, ''); // removes ",<eol><indent>"key": "v""
      else splice(ms[0].start, ms[1].start, '');
      return true;
    },
    addBlock(block, opts) {
      const loc = locate(null);
      insert(loc.obj, loc.sf, block, '{}', opts);
    },
  };
}

// ---------------------------------------------------------------------------

function defaultNpmView(name) {
  const cp = require('child_process');
  const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: NPM_TIMEOUT_MS, windowsHide: true };
  // npm.cmd דורש shell ב-Windows; השם מגיע מ-reference/versions.json ולא מקלט משתמש
  const out = process.platform === 'win32'
    ? cp.execFileSync('npm view ' + name + ' version', [], Object.assign({ shell: true }, opts))
    : cp.execFileSync('npm', ['view', name, 'version'], opts);
  const v = String(out).trim().split(/\s+/).pop().replace(/^'|'$/g, '');
  if (!/^\d+\.\d+\.\d+/.test(v)) throw new Error('תשובה לא צפויה מ-npm view: ' + out);
  return v;
}

function readInventory(fs, invPath) {
  try { return JSON.parse(fs.readFileSync(invPath, 'utf8')); } catch (_) { return null; }
}

function iconsUsage(inv) {
  if (!inv) return null; // unknown
  return (inv.muiFiles || []).some((f) => (f.imports || []).some((i) => /^@material-ui\/icons(\/|$)/.test(i.module)));
}

function run(argv, overrides) {
  const deps = Object.assign({ fs: require('fs'), cwd: process.cwd(), npmView: defaultNpmView, ts: null }, overrides || {});
  const opts = parseArgs(argv || []);
  const res = { script: SCRIPT, result: 'OK', changes: [], manual: [], blockers: [], notes: [], dryRun: opts.dryRun };
  const blocked = (msg) => { res.result = 'BLOCKED'; res.blockers.push({ message: msg }); return res; };

  if (opts.errors.length) return blocked(opts.errors.join('; '));

  let ts;
  try {
    ts = deps.ts || require('ts-morph').ts;
  } catch (_) {
    return blocked('ts-morph אינו מותקן בתיקיית הסקיל – הרץ npm install ב-' + path.join(__dirname, '..'));
  }

  let versions;
  let pickerPrefixes;
  try {
    versions = JSON.parse(require('fs').readFileSync(VERSIONS_FILE, 'utf8'));
    pickerPrefixes = JSON.parse(require('fs').readFileSync(SCAN_RULES_FILE, 'utf8')).pickerModulePrefixes;
  } catch (err) {
    return blocked('לא ניתן לטעון את reference/versions.json / scan-rules.json: ' + err.message);
  }
  const isPicker = (name) => pickerPrefixes.some((p) => name === p || name.startsWith(p + '/'));
  const inventory = readInventory(deps.fs, path.resolve(deps.cwd, opts.inventory));

  const pkgPath = path.join(deps.cwd, 'package.json');
  let original;
  try {
    original = deps.fs.readFileSync(pkgPath, 'utf8');
  } catch (err) {
    return blocked('לא ניתן לקרוא את package.json: ' + err.message);
  }

  let ed;
  try {
    ed = createEditor(ts, original);
    ed.keys(null);
  } catch (err) {
    if (err instanceof PkgError) return blocked(err.message);
    throw err;
  }

  const D = 'dependencies';
  const DEV = 'devDependencies';
  // שדרוג / הסרה של חבילת pickers – החלטה סגורה: review. הוספה בלבד (לא הוצהר קודם) אינה מעבר של קוד קיים
  const change = (rule, detail, name) => {
    const review = !!name && isPicker(name) && (rule === 'PKG.UPDATE' || rule === 'PKG.REMOVE');
    res.changes.push({ file: 'package.json', rule: rule, confidence: review ? 'review' : 'auto', detail: detail, reason: review ? PICKERS_REASON : undefined });
  };
  const inDeps = (name) => ed.get(D, name) !== undefined;
  const inDev = (name) => ed.get(DEV, name) !== undefined;

  if (!ed.has(D)) {
    ed.addBlock(D, { afterKey: ed.keys(null).indexOf('version') !== -1 ? 'version' : 'name' });
    change('PKG.ADD_BLOCK', 'נוצר בלוק dependencies');
  }

  const iconsV4Declared = inDeps('@material-ui/icons') || inDev('@material-ui/icons');

  // 1. remove @material-ui/*
  versions.remove.forEach((name) => {
    if (ed.remove(D, name)) change('PKG.REMOVE', name, name);
    if (inDev(name)) res.notes.push(name + ' נמצא ב-devDependencies – לא הוסר (מחוץ להיקף)');
  });

  const setDep = (name, range, why) => {
    const wasOnlyDev = !inDeps(name) && inDev(name);
    const action = ed.set(D, name, range, { sorted: true });
    if (!action) return;
    change(action === 'add' ? 'PKG.ADD' : 'PKG.UPDATE', name + ' ' + range + (why ? ' (' + why + ')' : ''), name);
    // buildSharedGen1 מתעלמת מ-devDependencies – בלי הצהרה ב-dependencies הבנייה תיכשל
    if (wasOnlyDev) res.notes.push(name + ' היה רק ב-devDependencies – נוסף ל-dependencies (buildSharedGen1 מתעלמת מ-devDependencies)');
  };

  // 2 + 8. target versions (adds to dependencies also when only in devDependencies)
  // usageGated (react-router-dom): קיים → מעודכן ולעולם לא מוסר; לא קיים → נוסף רק אם המלאי מראה שימוש.
  // אין צורך "ליתר ביטחון": buildSharedGen1 מכניסה את react-router לקטלוג גם בלי הצהרה, אם הוא מותקן
  const gated = versions.usageGated || {};
  dataKeys(versions.dependencies).forEach((name) => {
    const range = versions.dependencies[name];
    if (!gated[name] || inDeps(name) || inDev(name)) return setDep(name, range);
    const used = inventory && inventory[gated[name]];
    if (!Array.isArray(used)) {
      res.notes.push(name + ' לא נוסף – אינו מוצהר ב-package.json ואין inventory עדכני לאימות שימוש (הרץ scan.js)');
    } else if (!used.length) {
      res.notes.push(name + ' לא נוסף – אינו מוצהר ב-package.json והמלאי לא מראה בו שימוש');
    } else {
      setDep(name, range, 'בשימוש לפי inventory');
    }
  });

  // 3. icons – only when used or already declared
  dataKeys(versions.conditionalDependencies).forEach((name) => {
    const range = versions.conditionalDependencies[name];
    if (inDeps(name)) return setDep(name, range);
    const usage = iconsUsage(inventory);
    if (usage === true) setDep(name, range, 'בשימוש לפי inventory');
    else if (usage === null && iconsV4Declared) {
      setDep(name, range, 'אין inventory');
      res.result = 'REVIEW';
      res.manual.push({ file: 'package.json', line: null, reason: name + ' נוסף כי @material-ui/icons הוצהר ואין inventory לאימות שימוש. הרץ scan.js או ודא ידנית' });
    }
  });

  // 4. required packages – dependencies only
  for (const name of dataKeys(versions.requiredDependencies)) {
    if (inDeps(name)) {
      if (versions.requiredDependencies[name]) setDep(name, versions.requiredDependencies[name]);
      continue;
    }
    let range = versions.requiredDependencies[name];
    if (!range) {
      try {
        range = '^' + deps.npmView(name);
      } catch (err) {
        return blocked('לא ניתן לקבוע גרסה ל-' + name + ' (' + (err.message || err) + '). קבע אותה ב-reference/versions.json או בדוק גישה ל-registry');
      }
    }
    setDep(name, range);
  }

  // 5. version
  const vAction = ed.set(null, 'version', versions.packageVersion, { afterKey: 'name' });
  if (vAction) change('PKG.VERSION', versions.packageVersion);

  // 6. @types – wherever they already are
  dataKeys(versions.types).forEach((name) => {
    [D, DEV].forEach((block) => {
      if (ed.get(block, name) === undefined) return;
      const a = ed.set(block, name, versions.types[name]);
      if (a) change('PKG.UPDATE', block + ': ' + name + ' ' + versions.types[name]);
    });
  });

  // 7. react / react-dom in devDependencies → same version; never removed
  versions.mirrorInDevDependencies.forEach((name) => {
    if (!inDev(name)) return;
    const a = ed.set(DEV, name, ed.get(D, name));
    if (a) change('PKG.UPDATE', 'devDependencies: ' + name + ' ' + ed.get(D, name));
  });

  // 9. build tools – reported only
  const tools = versions.buildTools.filter((t) => inDeps(t));
  if (tools.length) res.notes.push('כלי build ב-dependencies (לא הוזזו): ' + tools.join(', '));

  // 10. pickers – one manual item per file that uses them (first import line in the file)
  if (res.changes.some((c) => c.confidence === 'review' && c.reason === PICKERS_REASON)) {
    res.result = 'REVIEW';
    if (!inventory) {
      res.manual.push({ file: 'package.json', line: null, reason: PICKERS_REASON + '. אין inventory – הרץ scan.js כדי לאתר את הקבצים שמשתמשים ב-pickers' });
    } else {
      const seen = new Set();
      (inventory.pickers || []).filter((p) => isPicker(p.module || '')).forEach((p) => {
        if (seen.has(p.file)) return;
        seen.add(p.file);
        res.manual.push({ file: p.file, line: p.line || null, reason: PICKERS_REASON });
      });
    }
  }

  const updated = ed.text();
  if (updated === original) {
    if (res.result === 'OK') res.result = 'NOOP';
    return res;
  }
  // sanity: the result must still be valid JSON. The TS parser accepts comments and trailing commas,
  // JSON.parse (and npm) do not – so this fails on such a file even when the edit itself is fine.
  try {
    JSON.parse(updated.replace(/^﻿/, ''));
  } catch (err) {
    let originalError = null;
    try { JSON.parse(original.replace(/^﻿/, '')); } catch (e) { originalError = e.message; }
    res.changes = [];
    res.manual = []; // describe edits that were not written
    return blocked(originalError
      ? 'package.json: הקובץ המקורי אינו JSON תקין (' + originalError + ') – כנראה הערה או פסיק מיותר, ש-npm לא יקרא. תקן ידנית והרץ שוב. הקובץ לא נכתב'
      : 'package.json: העריכה יצרה JSON לא תקין (' + err.message + ') – באג ב-' + SCRIPT + '. הקובץ לא נכתב');
  }
  if (!opts.dryRun) {
    try {
      deps.fs.writeFileSync(pkgPath, updated, 'utf8');
    } catch (err) {
      return blocked('לא ניתן לכתוב את package.json: ' + err.message);
    }
  }
  return res;
}

function formatText(res) {
  const L = ['package-json' + (res.dryRun ? ' [dry-run]' : '')];
  const sym = { 'PKG.REMOVE': '−', 'PKG.ADD': '+', 'PKG.UPDATE': '↑', 'PKG.VERSION': '↑', 'PKG.ADD_BLOCK': '+' };
  res.changes.forEach((c) => L.push('  ' + (sym[c.rule] || '•') + ' ' + c.detail + (c.confidence === 'review' ? ' 🔍' : '')));
  if (!res.changes.length && res.result !== 'BLOCKED') L.push('  אין שינויים');
  res.manual.forEach((m) => L.push('  ⚠ ' + (m.file && m.file !== 'package.json' ? m.file + (m.line ? ':' + m.line : '') + ' – ' : '') + m.reason));
  res.notes.forEach((n) => L.push('  ℹ ' + n));
  res.blockers.forEach((b) => L.push('  ⛔ ' + b.message));
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
    io.stderr('package-json crashed: ' + ((err && err.stack) || err) + '\n');
    return 1;
  }
}

if (require.main === module) {
  const code = main(process.argv.slice(2));
  process.stdout.write('', () => process.exit(code));
}

module.exports = { run: run, main: main, createEditor: createEditor, parseArgs: parseArgs };
