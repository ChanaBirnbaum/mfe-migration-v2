#!/usr/bin/env node
'use strict';

// codemod-pickers: @mui/x-date-pickers v5 → v9 (React 18, @mui/material 7.3, Hebrew / RTL apps).
//   step 0  config: pickers-migration.config.json in the service root (or --config <path>). Invalid → BLOCKED, nothing written
//   step 1  the official codemods, in order: npx @mui/x-codemod@latest v6…v9 pickers/preset-safe, on every file that
//           imports @mui/x-date-pickers or @mui/lab. A run with "errors" > 0 changed nothing → "failed"; step 2 still runs
//   step 2  this script's rules – D (deterministic), C (conditional), R1 (RTL alignment of the v9 field)
//   step 3  M (marking only) and migration-report.json
// Every rule is its own transformation with an id. Code that does not match a pattern exactly is left as it is; a rule
// whose condition does not hold leaves "// MIGRATION-TODO: <rule> <reason>" instead (in JSX children: {/* … */}).
// ts-morph only, like every codemod in this skill: edits are position-based, so lines no rule touched stay
// byte-for-byte identical. The file is re-parsed after every edit, so each rule sees the result of the previous one.

const path = require('path');
const stubMode = require('./stub-mode');

const SCRIPT = 'codemod-pickers';
const SOURCE_EXTS = ['.js', '.jsx', '.ts', '.tsx'];
const SKIP_DIRS = new Set(['node_modules', 'build', 'dist']);
const CONFIG_FILE = 'pickers-migration.config.json';
const REPORT_FILE = 'migration-report.json';
const DEFAULT_CONFIG = { rtlSxPlacement: 'auto', rtlSxSharedPath: 'src/utils/pickersRtlSx.js', invalidDateBehavior: 'null' };
const CONFIG_ENUMS = { rtlSxPlacement: ['auto', 'inline', 'shared'], invalidDateBehavior: ['null', 'keep'] };
const OFFICIAL = ['v6', 'v7', 'v8', 'v9'];
const OFFICIAL_TIMEOUT_MS = 10 * 60 * 1000;
const PICKERS_MODULE = /^@mui\/x-date-pickers(-pro)?(\/|$)/;
const LAB_MODULE = /^@mui\/lab(\/|$)/;
const NOT_PICKER_ELEMENT = /^(LocalizationProvider|Adapter\w*|\w*Context)$/;
const R1_PICKERS = new Set(['DatePicker', 'DesktopDatePicker', 'MobileDatePicker', 'DateTimePicker', 'DesktopDateTimePicker',
  'MobileDateTimePicker', 'TimePicker', 'DesktopTimePicker', 'MobileTimePicker']);
const RULE_ORDER = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'R1', 'R1.3', 'M2', 'M3', 'M4', 'M5'];
const RULE_LABEL = {
  D1: 'components / componentsProps → slots / slotProps', D2: 'inputFormat → format', D3: 'PaperProps → slotProps.desktopPaper + mobilePaper',
  D4: 'OpenPickerButtonProps → slotProps.openPickerButton', D5: 'textField Input*Props → textField.slotProps', D6: 'enableAccessibleFieldDOMStructure removed',
  D7: 'unstable*FieldRef → *FieldRef', D8: 'picker CSS class names / theme key', D9: 'action bar → usePickerActionsContext',
  C1: 'renderInput → slotProps.textField', C2: 'moment() around value / minDate / maxDate', C3: 'onChange: invalid date → null',
  C4: 'slot component moved to module level', C5: 'custom "today" → setValueToToday', C6: 'external FormHelperText → slotProps.textField',
  R1: 'RTL alignment of the field (pickersRtlSx)', 'R1.3': 'local RTL ThemeProvider removed',
};
const ACTIONS = { onClear: 'clearValue', onSetToday: 'setValueToToday', onAccept: 'acceptValueChanges', onCancel: 'cancelValueChanges' };
const ACTION_ORDER = ['clearValue', 'setValueToToday', 'acceptValueChanges', 'cancelValueChanges'];
const HOOKS_MODULE = '@mui/x-date-pickers/hooks';
const D5_KEYS = { InputProps: 'input', inputProps: 'htmlInput', InputLabelProps: 'inputLabel', FormHelperTextProps: 'formHelperText' };
const D7_ATTRS = { unstableFieldRef: 'fieldRef', unstableStartFieldRef: 'startFieldRef', unstableEndFieldRef: 'endFieldRef' };
const D8_STRINGS = [
  ['button.MuiButtonBase-root.MuiIconButton-root.MuiIconButton-sizeSmall.MuiPickersArrowSwitcher-button', '.MuiPickersArrowSwitcher-button'],
  ['MuiCalendarPicker-root', 'MuiDateCalendar-root'],
];
const M5_KEYS = new Set(['MuiTextField', 'MuiOutlinedInput', 'MuiInputBase', 'MuiInputLabel', 'MuiFormHelperText']);
const SUSPICIOUS = /^\s*(test|todo|tmp|temp|xxx|asdf|fixme|dummy)\s*$/i;
const RTL_NAMES = ['pickersRtlSxSmall', 'pickersRtlSxMedium'];
const TODO_TAG = 'MIGRATION-TODO:';
const TODO_LINE = /MIGRATION-TODO: (\S+) (.*?)(?:\s*\*\/\})?\s*$/;

const REASON = {
  spread: 'spread may contain old prop names',
  c1Custom: 'custom text field: v9 accepts only PickersTextField-compatible components. Move its props to slotProps.textField and its styles to slotProps.textField.sx',
  c4Inline: 'slot component defined inline: move it to module level',
  c5: 'replaced custom today logic: verify',
  c6: 'duplicate helperText',
  r1Dynamic: 'dynamic size, pick Small/Medium manually',
  r13: 'removed local ThemeProvider RTL wrapper, replaced by pickersRtlSx',
  m2: 'leftover value',
  m3: 'check if theme direction rtl makes this redundant',
  m4: 'unmigrated v5 API',
  m5: 'theme overrides no longer apply to the pickers field; duplicate under MuiPickersTextField / MuiPickersOutlinedInput / ' +
    'MuiPickersInputBase if needed (MuiInputLabel and MuiFormHelperText still apply – check they do not conflict with R1)',
};

// R1.1 – the exact content. "shared" writes it as is; "inline" drops the word export.
const RTL_SX_SOURCE = [
  "// יישור RTL לשדות של @mui/x-date-pickers v9 שלא תלוי ב-theme.",
  "// עובד בלי direction:'rtl' ב-theme, איתו, ועם stylis-plugin-rtl.",
  'const base = {',
  '    // כיוון השדה',
  "    '& .MuiPickersInputBase-root': { direction: 'rtl /*! @noflip */' },",
  '    // טקסט התאריך: מיושר לימין',
  "    '& .MuiPickersInputBase-sectionsContainer, & .MuiPickersSectionList-root': {",
  "        justifyContent: 'flex-end',",
  '    },',
  '    // אייקון התאריכון: רווח מהטקסט, בלי לעלות עליו',
  "    '& .MuiInputAdornment-positionEnd': { margin: 0, marginInlineStart: '8px' },",
  "    '& .MuiIconButton-edgeEnd': { margin: 0, marginInlineEnd: '-12px' },",
  '    // label בצד ימין',
  "    '& .MuiInputLabel-root': {",
  "        left: 'auto /*! @noflip */',",
  "        right: '0 /*! @noflip */',",
  "        transformOrigin: 'top right /*! @noflip */',",
  '    },',
  "    '& .MuiInputLabel-root.MuiInputLabel-shrink': {",
  "        transform: 'translate(-14px, -9px) scale(0.75)',",
  '    },',
  '    // הרווח במסגרת עבור ה-label: בצד ימין',
  "    '& .MuiPickersOutlinedInput-notchedOutline': {",
  "        textAlign: 'right /*! @noflip */',",
  '    },',
  "    '& .MuiPickersOutlinedInput-notchedOutline > legend': {",
  "        marginLeft: 'auto /*! @noflip */',",
  "        marginRight: '0 /*! @noflip */',",
  '    },',
  '    // טקסט השגיאה מתחת לשדה: מיושר לימין',
  "    '& .MuiFormHelperText-root': {",
  "        textAlign: 'right /*! @noflip */',",
  '    },',
  '};',
  '',
  'export const pickersRtlSxSmall = {',
  '    ...base,',
  "    '& .MuiInputLabel-root': {",
  "        ...base['& .MuiInputLabel-root'],",
  "        transform: 'translate(-14px, 9px) scale(1)',",
  '    },',
  '};',
  '',
  'export const pickersRtlSxMedium = {',
  '    ...base,',
  "    '& .MuiInputLabel-root': {",
  "        ...base['& .MuiInputLabel-root'],",
  "        transform: 'translate(-14px, 16px) scale(1)',",
  '    },',
  '};',
].join('\n');

class CodemodError extends Error {}
class ConfigError extends Error {}
// a bug in this codemod (two edits on the same range) – reported as BLOCKED for that file, not a crash
class EditConflict extends Error {
  constructor(pos) { super('overlapping edits at ' + pos); this.pos = pos; }
}

let N; // ts-morph Node
let K; // ts-morph SyntaxKind

function parseArgs(argv) {
  const opts = { dryRun: false, json: false, config: null, skipOfficial: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--skip-official-codemods') opts.skipOfficial = true;
    else if (a === '--config') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) opts.errors.push('--config needs a path');
      else opts.config = argv[++i];
    } else opts.errors.push('Unknown argument: ' + a);
  }
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
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full); } else if (e.isFile() && SOURCE_EXTS.indexOf(path.extname(e.name)) !== -1) out.push(full);
    }
  };
  walk(srcDir);
  return out;
}

// ---------------------------------------------------------------------------
// Config (step 0)

function loadConfig(fs, root, explicit) {
  const file = explicit ? path.resolve(root, explicit) : path.join(root, CONFIG_FILE);
  let raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) {
    if (explicit) throw new ConfigError('Config file not found: ' + explicit);
  }
  const cfg = Object.assign({}, DEFAULT_CONFIG);
  const shown = explicit || CONFIG_FILE;
  if (raw !== null) {
    let data;
    try { data = JSON.parse(raw.replace(/^﻿/, '')); } catch (err) { throw new ConfigError(shown + ' is not valid JSON: ' + err.message); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ConfigError(shown + ' must contain a JSON object');
    Object.keys(data).forEach((k) => {
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, k)) throw new ConfigError(shown + ': unknown key "' + k + '" (known: ' + Object.keys(DEFAULT_CONFIG).join(', ') + ')');
      cfg[k] = data[k];
    });
  }
  Object.keys(CONFIG_ENUMS).forEach((k) => {
    if (CONFIG_ENUMS[k].indexOf(cfg[k]) === -1) {
      throw new ConfigError(shown + ': invalid ' + k + ' ' + JSON.stringify(cfg[k]) + ' – expected one of ' + CONFIG_ENUMS[k].map((v) => '"' + v + '"').join(' | '));
    }
  });
  const p = cfg.rtlSxSharedPath;
  if (typeof p !== 'string' || !p.trim() || path.isAbsolute(p) || /(^|[\\/])\.\.([\\/]|$)/.test(p) || SOURCE_EXTS.indexOf(path.extname(p)) === -1) {
    throw new ConfigError(shown + ': invalid rtlSxSharedPath ' + JSON.stringify(p) + ' – expected a relative path inside the project ending in ' + SOURCE_EXTS.join(' / '));
  }
  cfg.rtlSxSharedPath = toPosix(path.normalize(p));
  return { config: cfg, source: raw === null ? 'defaults' : toPosix(path.relative(root, file)) };
}

// ---------------------------------------------------------------------------
// Step 1 – official codemods

function defaultOfficialRunner(deps) {
  return (version, files) => {
    const args = ['--yes', '@mui/x-codemod@latest', version + '.0.0/pickers/preset-safe'].concat(files);
    const quote = (s) => (/[\s"&|<>^()]/.test(s) ? '"' + s.replace(/"/g, '\\"') + '"' : s);
    const opts = { cwd: deps.cwd, env: deps.env, encoding: 'utf8', timeout: OFFICIAL_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 * 1024 };
    // npx.cmd needs a shell on Windows; the command is fixed and the arguments are file paths from src/
    const r = deps.platform === 'win32'
      ? deps.cp.spawnSync(['npx'].concat(args).map(quote).join(' '), [], Object.assign({ shell: true }, opts))
      : deps.cp.spawnSync('npx', args, opts);
    return { status: r.status, output: (r.stdout || '') + '\n' + (r.stderr || ''), error: r.error ? r.error.message : null };
  };
}

// jscodeshift summary: "N errors". Per-file: " ERR <file> Transformation error …"
function interpretOfficial(out, files) {
  // jscodeshift colors its output (ESC[31m0 errors)
  out = Object.assign({}, out, { output: (out.output || '').replace(/\u001b\[[0-9;]*m/g, '') });
  const m = /(\d+)\s+errors?\b/i.exec(out.output);
  if (!m) {
    const line = (out.error || (out.output || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-1)[0] || 'no output');
    return { all: 'failed', reason: 'the codemod did not run: ' + line.slice(0, 200) };
  }
  const errors = Number(m[1]);
  if (errors === 0) return { all: 'ok' };
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const failed = files.filter((f) => new RegExp('ERR\\s+' + esc(f) + '(\\s|$)', 'm').test(out.output) ||
    new RegExp('ERR\\s+' + esc(toPosix(f)) + '(\\s|$)', 'm').test(out.output));
  if (failed.length === errors) return { failed: failed };
  return { unattributed: errors };
}

function runOfficial(runner, versions, files) {
  // files: absolute paths. → { [file]: { v6: 'ok'|'failed', … }, reasons: [{file, version, reason}] }
  const status = {};
  const reasons = [];
  files.forEach((f) => { status[f] = {}; });
  versions.forEach((v) => {
    const one = (batch) => {
      const r = interpretOfficial(runner(v, batch), batch);
      if (r.all) {
        batch.forEach((f) => {
          status[f][v] = r.all;
          if (r.all === 'failed') reasons.push({ file: f, version: v, reason: r.reason });
        });
        return true;
      }
      if (r.failed) {
        batch.forEach((f) => { status[f][v] = r.failed.indexOf(f) === -1 ? 'ok' : 'failed'; });
        r.failed.forEach((f) => reasons.push({ file: f, version: v, reason: 'errors > 0 – the codemod crashed on this file and changed nothing' }));
        return true;
      }
      return false;
    };
    if (one(files)) return;
    // errors that cannot be attributed: each file on its own (a single file is the failed one)
    files.forEach((f) => {
      if (files.length > 1 && one([f])) return;
      status[f][v] = 'failed';
      reasons.push({ file: f, version: v, reason: 'errors > 0 – the codemod crashed on this file and changed nothing' });
    });
  });
  return { status: status, reasons: reasons };
}

// ---------------------------------------------------------------------------
// Text helpers

function applyEdits(text, edits) {
  const sorted = edits.slice().sort((a, b) => b.start - a.start || b.end - a.end);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].end > sorted[i - 1].start) throw new EditConflict(sorted[i - 1].start);
  }
  return sorted.reduce((t, e) => t.slice(0, e.start) + e.text + t.slice(e.end), text);
}

const lineStartAt = (text, pos) => text.lastIndexOf('\n', pos - 1) + 1;
const lineIndent = (text, pos) => /^[ \t]*/.exec(text.slice(lineStartAt(text, pos)))[0];
const lineOf = (text, pos) => text.slice(0, pos).split('\n').length;
function lineEndAt(text, pos) {
  let e = text.indexOf('\n', pos);
  if (e === -1) return text.length;
  if (text[e - 1] === '\r') e--;
  return e;
}

function indentUnit(text) {
  let best = 0;
  const lines = text.split('\n').slice(0, 400);
  for (const l of lines) {
    if (l[0] === '\t') return '\t';
    const m = /^( +)\S/.exec(l);
    if (m && (best === 0 || m[1].length < best)) best = m[1].length;
  }
  return ' '.repeat(best >= 2 && best <= 8 ? best : 4);
}

function reindent(s, from, to) {
  if (from === to || s.indexOf('\n') === -1) return s;
  return s.split('\n').map((l, i) => (i && l.startsWith(from) ? to + l.slice(from.length) : l)).join('\n');
}

// A node's range, widened to whole line(s) when nothing else is on them (incl. the line break)
function removalRange(text, start, end) {
  const ls = lineStartAt(text, start);
  let le = text.indexOf('\n', end);
  if (le === -1) le = text.length;
  const before = text.slice(ls, start);
  const after = text.slice(end, le).replace(/\r$/, '');
  if (/^[ \t]*$/.test(before) && /^[ \t]*$/.test(after)) return { start: ls, end: le === text.length ? le : le + 1, text: '' };
  // starts its own line, but code follows it (`)} />`) → that code joins the previous line
  if (/^[ \t]*$/.test(before) && ls > 0) {
    let s = ls - 1;
    if (text[s - 1] === '\r') s--;
    while (s > 0 && (text[s - 1] === ' ' || text[s - 1] === '\t')) s--;
    return { start: s, end: end, text: '' };
  }
  let s = start;
  while (s > ls && (text[s - 1] === ' ' || text[s - 1] === '\t')) s--;
  return { start: s, end: end, text: '' };
}

// Comment lines directly above the line that starts at ls
function commentBlockAbove(text, ls) {
  const out = [];
  let p = ls;
  while (p > 0) {
    const prevEnd = p - 1; // the '\n' that ends the previous line
    const pls = text.lastIndexOf('\n', prevEnd - 1) + 1;
    const line = text.slice(pls, prevEnd).replace(/\r$/, '').trim();
    if (line.startsWith('//') || (line.startsWith('{/*') && line.endsWith('*/}'))) { out.push(line); p = pls; } else break;
  }
  return out;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

// ---------------------------------------------------------------------------
// AST helpers

function unwrapParens(e) {
  while (e && (N.isParenthesizedExpression(e) || N.isAsExpression(e))) e = e.getExpression();
  return e;
}
const isObj = (n) => !!n && N.isObjectLiteralExpression(n);
const isFn = (n) => !!n && (N.isArrowFunction(n) || N.isFunctionExpression(n) || N.isFunctionDeclaration(n) || N.isMethodDeclaration(n));
const tagOf = (el) => el.getTagNameNode().getText();

function jsxOpenings(sf) {
  const out = [];
  sf.forEachDescendant((n) => { if (N.isJsxOpeningElement(n) || N.isJsxSelfClosingElement(n)) out.push(n); });
  return out;
}
function getAttr(el, name) {
  return el.getAttributes().find((a) => N.isJsxAttribute(a) && a.getNameNode().getText() === name) || null;
}
// null = no initializer (boolean shorthand); StringLiteral; or the expression inside {…}
function attrValue(a) {
  const init = a.getInitializer();
  if (!init) return null;
  if (N.isJsxExpression(init)) return init.getExpression() || null;
  return init;
}
function propName(p) {
  if (!(N.isPropertyAssignment(p) || N.isShorthandPropertyAssignment(p) || N.isMethodDeclaration(p))) return null;
  const n = p.getNameNode();
  if (N.isIdentifier(n) || N.isNumericLiteral(n)) return n.getText();
  if (N.isStringLiteral(n) || N.isNoSubstitutionTemplateLiteral(n)) return n.getLiteralText();
  return null;
}
const getProp = (obj, name) => obj.getProperties().find((p) => propName(p) === name) || null;
function propValue(p) {
  if (N.isPropertyAssignment(p)) return p.getInitializer();
  if (N.isShorthandPropertyAssignment(p)) return p.getNameNode();
  return null;
}
function keyText(k) { return IDENT.test(k) ? k : "'" + k.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"; }

function stringValue(n) {
  n = unwrapParens(n);
  if (n && (N.isStringLiteral(n) || N.isNoSubstitutionTemplateLiteral(n))) return n.getLiteralText();
  return undefined;
}

function nearestFunction(node) {
  return node.getAncestors().find(isFn) || null;
}

// Identifiers that are bound by a declaration name (incl. destructuring)
function bindingNames(nameNode) {
  if (!nameNode) return [];
  if (N.isIdentifier(nameNode)) return [nameNode.getText()];
  const out = [];
  nameNode.forEachDescendant((d) => { if (N.isBindingElement(d) && N.isIdentifier(d.getNameNode())) out.push(d.getName()); });
  return out;
}
function isReference(id) {
  const p = id.getParent();
  if (!p) return false;
  if (N.isPropertyAccessExpression(p) && p.getNameNode() === id) return false;
  if ((N.isPropertyAssignment(p) || N.isMethodDeclaration(p) || N.isPropertySignature(p)) && p.getNameNode() === id) return false;
  if (N.isJsxAttribute(p)) return false;
  if ((N.isVariableDeclaration(p) || N.isParameterDeclaration(p) || N.isFunctionDeclaration(p) || N.isFunctionExpression(p) || N.isClassDeclaration(p) || N.isBindingElement(p)) && p.getNameNode() === id) return false;
  if (N.isBindingElement(p) && p.getPropertyNameNode() === id) return false;
  if (N.isImportSpecifier(p) || N.isImportClause(p) || N.isNamespaceImport(p)) return false;
  if (N.isJsxOpeningElement(p) || N.isJsxSelfClosingElement(p) || N.isJsxClosingElement(p)) return /^[A-Z]/.test(id.getText());
  return true;
}
function refsName(node, name) {
  if (N.isIdentifier(node) && node.getText() === name) return true;
  return node.getDescendantsOfKind(K.Identifier).some((id) => id.getText() === name && isReference(id));
}

// ---------------------------------------------------------------------------
// Imports

function importsOf(sf, test) {
  return sf.getImportDeclarations().filter((d) => test(d.getModuleSpecifierValue()));
}
function quoteFor(doc) {
  const d = doc.sf.getImportDeclarations()[0];
  return d && d.getModuleSpecifier().getText()[0] === '"' ? '"' : "'";
}
function semiFor(doc) {
  const d = doc.sf.getImportDeclarations()[0];
  return !d || /;\s*$/.test(d.getText()) ? ';' : '';
}
function insertImportLine(doc, line, rule) {
  const imps = doc.sf.getImportDeclarations();
  if (imps.length) {
    const e = lineEndAt(doc.text, imps[imps.length - 1].getEnd());
    doc.edit([{ start: e, end: e, text: doc.eol + line }], rule);
  } else {
    doc.edit([{ start: 0, end: 0, text: line + doc.eol }], rule);
  }
}
function ensureNamedImport(doc, module, names, rule) {
  const have = new Set();
  let target = null;
  importsOf(doc.sf, (m) => m === module).forEach((d) => {
    if (!target && d.getNamedImports().length) target = d;
    d.getNamedImports().forEach((s) => have.add(s.getAliasNode() ? s.getAliasNode().getText() : s.getName()));
  });
  const missing = names.filter((n) => !have.has(n));
  if (!missing.length) return;
  if (target) {
    const last = target.getNamedImports().slice(-1)[0];
    doc.edit([{ start: last.getEnd(), end: last.getEnd(), text: ', ' + missing.join(', ') }], rule);
    return;
  }
  const q = quoteFor(doc);
  insertImportLine(doc, 'import { ' + missing.join(', ') + ' } from ' + q + module + q + semiFor(doc), rule);
}
function hasLocalBinding(doc, name) {
  return doc.sf.getImportDeclarations().some((d) => {
    if (d.getDefaultImport() && d.getDefaultImport().getText() === name) return true;
    if (d.getNamespaceImport() && d.getNamespaceImport().getText() === name) return true;
    return d.getNamedImports().some((s) => (s.getAliasNode() ? s.getAliasNode().getText() : s.getName()) === name);
  }) || doc.sf.getVariableDeclaration(name) !== undefined;
}
function removeImportIfUnused(doc, local) {
  const used = doc.sf.getDescendantsOfKind(K.Identifier).some((id) => id.getText() === local && !id.getFirstAncestorByKind(K.ImportDeclaration) && isReference(id));
  if (used) return;
  for (const d of doc.sf.getImportDeclarations()) {
    const named = d.getNamedImports();
    const idx = named.findIndex((s) => (s.getAliasNode() ? s.getAliasNode().getText() : s.getName()) === local);
    const isDefault = d.getDefaultImport() && d.getDefaultImport().getText() === local;
    if (idx === -1 && !isDefault) continue;
    if ((isDefault && !named.length && !d.getNamespaceImport()) || (idx !== -1 && named.length === 1 && !d.getDefaultImport() && !d.getNamespaceImport())) {
      doc.edit([removalRange(doc.text, d.getStart(), d.getEnd())]);
    } else if (idx !== -1 && named.length > 1) {
      const s = named[idx];
      doc.edit([idx < named.length - 1 ? { start: s.getStart(), end: named[idx + 1].getStart(), text: '' } : { start: named[idx - 1].getEnd(), end: s.getEnd(), text: '' }]);
    }
    return;
  }
}

// local name → imported name, for every picker component imported from @mui/x-date-pickers (or a *Picker from @mui/lab)
function pickerLocals(sf) {
  const m = new Map();
  sf.getImportDeclarations().forEach((d) => {
    const mod = d.getModuleSpecifierValue();
    const isP = PICKERS_MODULE.test(mod);
    const isLab = LAB_MODULE.test(mod);
    if (!isP && !isLab) return;
    const ok = (name) => /^[A-Z]/.test(name) && !NOT_PICKER_ELEMENT.test(name) && (isP || /Picker$/.test(name));
    const def = d.getDefaultImport();
    if (def) { const name = mod.split('/').pop(); if (ok(name)) m.set(def.getText(), name); }
    d.getNamedImports().forEach((s) => {
      const name = s.getName();
      if (ok(name)) m.set(s.getAliasNode() ? s.getAliasNode().getText() : name, name);
    });
  });
  return m;
}
function isMuiImport(doc, local, name) {
  return doc.sf.getImportDeclarations().some((d) => {
    const mod = d.getModuleSpecifierValue();
    if (mod === '@mui/material/' + name && d.getDefaultImport() && d.getDefaultImport().getText() === local) return true;
    if (mod !== '@mui/material') return false;
    return d.getNamedImports().some((s) => s.getName() === name && (s.getAliasNode() ? s.getAliasNode().getText() : name) === local);
  });
}
function localsOf(doc, name, modules) {
  const out = new Set();
  doc.sf.getImportDeclarations().forEach((d) => {
    const mod = d.getModuleSpecifierValue();
    if (modules.indexOf(mod) !== -1) d.getNamedImports().forEach((s) => { if (s.getName() === name) out.add(s.getAliasNode() ? s.getAliasNode().getText() : name); });
    if (mod === '@mui/material/' + name && d.getDefaultImport()) out.add(d.getDefaultImport().getText());
  });
  return out;
}

// ---------------------------------------------------------------------------
// The document being transformed

class Doc {
  constructor(env, rel, text) {
    this.env = env;
    this.rel = rel;
    this.text = text;
    this.eol = text.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
    this.unit = indentUnit(text);
    this.applied = new Set();
    this.edits = 0;
    this.parse();
  }
  parse() { this.sf = this.env.project.createSourceFile('/' + this.rel, this.text, { overwrite: true }); }
  edit(edits, rule) {
    edits = (edits || []).filter(Boolean);
    if (!edits.length) return false;
    const next = applyEdits(this.text, edits);
    if (next === this.text) return false;
    if (++this.edits > 2000) throw new Error(SCRIPT + ': too many edits in ' + this.rel + ' (a rule does not converge)');
    this.text = next;
    this.parse();
    if (rule) this.applied.add(rule);
    return true;
  }
  pickers(filter) {
    const locals = pickerLocals(this.sf);
    return jsxOpenings(this.sf).filter((el) => locals.has(tagOf(el)) && (!filter || filter(locals.get(tagOf(el)))));
  }
  // Re-fetches the i-th picker after every edit – positions move, the order does not
  forEachPicker(fn, filter) {
    for (let i = 0; ; i++) {
      if (i >= this.pickers(filter).length) break;
      fn(() => this.pickers(filter)[i]);
    }
  }
  hasTodoAbove(node) {
    return commentBlockAbove(this.text, lineStartAt(this.text, node.getStart())).some((l) => l.indexOf(TODO_TAG) !== -1);
  }
  todo(node, rule, reason) {
    const text = this.text;
    const ls = lineStartAt(text, node.getStart());
    const indent = /^[ \t]*/.exec(text.slice(ls))[0];
    const msg = TODO_TAG + ' ' + rule + ' ' + reason;
    if (commentBlockAbove(text, ls).some((l) => l.indexOf(msg) !== -1)) return;
    const jsx = isJsxChildAt(this.sf, ls + indent.length);
    this.edit([{ start: ls, end: ls, text: indent + (jsx ? '{/* ' + msg + ' */}' : '// ' + msg) + this.eol }]);
  }
}

// Is the first token of a line a JSX child (where only {/* */} is a comment)?
function isJsxChildAt(sf, pos) {
  let n = sf.getDescendantAtPos(pos);
  if (!n) return false;
  while (n.getParent() && !N.isSourceFile(n.getParent()) && n.getParent().getStart() === pos) n = n.getParent();
  if (N.isJsxClosingElement(n) || N.isJsxClosingFragment(n) || N.isJsxText(n)) return true;
  const p = n.getParent();
  return !!p && (N.isJsxElement(p) || N.isJsxFragment(p)) && !N.isJsxOpeningElement(n) && !N.isJsxOpeningFragment(n);
}

// ---------------------------------------------------------------------------
// Object literal / attribute edits

const INLINE_OBJECT_MAX = 80;
const LINE_MAX = 120;

// ind: the indentation of the line the entry starts on
function fmtEntry(doc, e, ind) {
  if (e.nested) return keyText(e.key) + ': ' + nestedText(doc, e.nested.path, e.nested.entries, ind);
  if (e.raw !== undefined) return e.from !== undefined ? reindent(e.raw, e.from, ind) : e.raw;
  return keyText(e.key) + ': ' + (e.from !== undefined ? reindent(e.value, e.from, ind) : e.value);
}
// { a: { b: { entries } } } – inline when short, otherwise one entry per line
function nestedText(doc, pathArr, entries, ind) {
  const list = pathArr.length ? [{ key: pathArr[0], nested: { path: pathArr.slice(1), entries: entries } }] : entries;
  const inline = '{ ' + list.map((e) => fmtEntry(doc, e, ind)).join(', ') + ' }';
  if (inline.length <= INLINE_OBJECT_MAX && inline.indexOf('\n') === -1) return inline;
  return blockText(doc, list.map((e) => (inner) => fmtEntry(doc, e, inner)), ind);
}
// parts: functions of the inner indentation
function blockText(doc, parts, ind) {
  const inner = ind + doc.unit;
  return '{' + parts.map((p) => doc.eol + inner + p(inner) + ',').join('') + doc.eol + ind + '}';
}
function hasComments(text, obj) {
  let rest = obj.getText();
  obj.getProperties().forEach((p) => { rest = rest.replace(p.getText(), ''); });
  return /\/[/*]/.test(rest);
}

// Edits that add entries at the end of an object literal, keeping its layout (one per line / inline, trailing comma).
// An inline object that would get a multi-line entry or a too long line becomes one entry per line.
function insertPropsEdits(doc, obj, entries) {
  const text = doc.text;
  const props = obj.getProperties();
  const objIndent = lineIndent(text, obj.getStart());
  const inlineParts = entries.map((e) => fmtEntry(doc, e, objIndent + doc.unit));
  const lineLen = lineEndAt(text, obj.getEnd()) - lineStartAt(text, obj.getStart());
  const single = lineOf(text, obj.getStart()) === lineOf(text, obj.getEnd());
  if (single && !hasComments(text, obj) &&
    (inlineParts.some((p) => p.indexOf('\n') !== -1) || lineLen + inlineParts.join(', ').length + 2 > LINE_MAX)) {
    const parts = props.map((p) => () => p.getText()).concat(entries.map((e) => (inner) => fmtEntry(doc, e, inner)));
    return [{ start: obj.getStart(), end: obj.getEnd(), text: blockText(doc, parts, objIndent) }];
  }
  if (!props.length) {
    return [{ start: obj.getStart(), end: obj.getEnd(), text: '{ ' + inlineParts.join(', ') + ' }' }];
  }
  const last = props[props.length - 1];
  let i = last.getEnd();
  while (i < text.length && /[ \t\r\n]/.test(text[i])) i++;
  const hasComma = text[i] === ',';
  const multiline = lineOf(text, obj.getStart()) !== lineOf(text, props[0].getStart());
  if (multiline) {
    const ind = lineIndent(text, last.getStart());
    const parts = entries.map((e) => doc.eol + ind + fmtEntry(doc, e, ind));
    if (hasComma) {
      const at = lineEndAt(text, i);
      return [{ start: at, end: at, text: parts.join(',') + ',' }];
    }
    // after a trailing // comment on the same line, not before it
    const le = lineEndAt(text, last.getEnd());
    const rest = text.slice(last.getEnd(), le);
    if (/^\s*(\/\/.*)?$/.test(rest) && rest.trim()) {
      return [{ start: last.getEnd(), end: last.getEnd(), text: ',' }, { start: le, end: le, text: parts.join(',') }];
    }
    return [{ start: last.getEnd(), end: last.getEnd(), text: ',' + parts.join(',') }];
  }
  if (hasComma) return [{ start: i + 1, end: i + 1, text: ' ' + inlineParts.join(', ') + ',' }];
  return [{ start: last.getEnd(), end: last.getEnd(), text: ', ' + inlineParts.join(', ') }];
}

function removePropEdit(text, obj, prop) {
  const props = obj.getProperties();
  const idx = props.indexOf(prop);
  if (props.length === 1) return { start: obj.getStart() + 1, end: obj.getEnd() - 1, text: '' };
  if (idx < props.length - 1) {
    const ls = lineStartAt(text, prop.getStart());
    const own = /^[ \t]*$/.test(text.slice(ls, prop.getStart()));
    const nextLs = lineStartAt(text, props[idx + 1].getStart());
    if (own && nextLs !== ls) return { start: ls, end: nextLs, text: '' };
    return { start: prop.getStart(), end: props[idx + 1].getStart(), text: '' };
  }
  return { start: props[idx - 1].getEnd(), end: prop.getEnd(), text: '' };
}

// New attribute: before the first {...spread} (the spread keeps precedence), else after the last attribute.
// attr: the attribute text, or (indent, ownLine) => text
function insertAttrEdit(doc, el, attr) {
  const text = doc.text;
  const build = typeof attr === 'function' ? attr : () => attr;
  const attrs = el.getAttributes();
  if (!attrs.length) {
    const t = el.getTagNameNode();
    return { start: t.getEnd(), end: t.getEnd(), text: ' ' + build(lineIndent(text, el.getStart()), false) };
  }
  const elLine = lineOf(text, el.getStart());
  const multiline = attrs.some((a) => lineOf(text, a.getStart()) !== elLine);
  const spread = attrs.find((a) => N.isJsxSpreadAttribute(a));
  if (spread) {
    let ls = lineStartAt(text, spread.getStart());
    if (/^[ \t]*$/.test(text.slice(ls, spread.getStart()))) {
      const ind = lineIndent(text, spread.getStart());
      // above the comments that belong to the spread
      for (let n = commentBlockAbove(text, ls).length; n > 0; n--) ls = text.lastIndexOf('\n', ls - 2) + 1;
      return { start: ls, end: ls, text: ind + build(ind, true) + doc.eol };
    }
    return { start: spread.getStart(), end: spread.getStart(), text: build(lineIndent(text, el.getStart()), false) + ' ' };
  }
  const last = attrs[attrs.length - 1];
  if (multiline) {
    const ind = lineIndent(text, last.getStart());
    return { start: last.getEnd(), end: last.getEnd(), text: doc.eol + ind + build(ind, true) };
  }
  return { start: last.getEnd(), end: last.getEnd(), text: ' ' + build(lineIndent(text, el.getStart()), false) };
}

function slotPropsObj(el, pathArr) {
  const a = getAttr(el, 'slotProps');
  if (!a) return null;
  let obj = unwrapParens(attrValue(a));
  for (const key of pathArr) {
    if (!isObj(obj)) return null;
    const p = getProp(obj, key);
    obj = p && N.isPropertyAssignment(p) ? unwrapParens(p.getInitializer()) : null;
  }
  return isObj(obj) ? obj : null;
}

// Plan for putting entries at slotProps.<path> of el:
//   { edits } | { todo: reason } | { conflict: [keys], obj }
function slotPlan(doc, el, pathArr, entries) {
  const a = getAttr(el, 'slotProps');
  if (!a) {
    // one entry per line when the element's attributes are one per line
    const top = pathArr.length ? [{ key: pathArr[0], nested: { path: pathArr.slice(1), entries: entries } }] : entries;
    return {
      edits: [insertAttrEdit(doc, el, (ind, ownLine) => {
        if (!ownLine) return 'slotProps={' + nestedText(doc, pathArr, entries, ind) + '}';
        return 'slotProps={' + blockText(doc, top.map((e) => (inner) => fmtEntry(doc, e, inner)), ind) + '}';
      })],
    };
  }
  let obj = unwrapParens(attrValue(a));
  if (!isObj(obj)) return { todo: 'slotProps is not an object literal' };
  for (let i = 0; i < pathArr.length; i++) {
    const p = getProp(obj, pathArr[i]);
    if (!p) {
      return { edits: insertPropsEdits(doc, obj, [{ key: pathArr[i], nested: { path: pathArr.slice(i + 1), entries: entries } }]) };
    }
    const v = N.isPropertyAssignment(p) ? unwrapParens(p.getInitializer()) : null;
    if (!isObj(v)) return { todo: 'slotProps.' + pathArr.slice(0, i + 1).join('.') + ' is not an object literal' };
    obj = v;
  }
  const clash = entries.filter((e) => e.key !== undefined && getProp(obj, e.key)).map((e) => e.key);
  if (clash.length) return { conflict: clash, obj: obj };
  return { edits: insertPropsEdits(doc, obj, entries) };
}
const slotPath = (pathArr, key) => 'slotProps.' + pathArr.concat([key]).join('.');

// Moves attribute `name` of the picker into slotProps.<path>.<key> for each key; removes the attribute
function moveAttrToSlot(doc, get, name, rule, pathArr, keys) {
  const a = getAttr(get(), name);
  if (!a) return;
  const v = attrValue(a);
  const entries = keys.map((k) => ({ key: k, value: v ? v.getText() : 'true', from: v ? lineIndent(doc.text, v.getStart()) : undefined }));
  const plan = slotPlan(doc, get(), pathArr, entries);
  if (plan.todo) return doc.todo(a, rule, plan.todo);
  if (plan.conflict) return doc.todo(a, rule, slotPath(pathArr, plan.conflict[0]) + ' is already set: merge ' + name + ' into it manually');
  const r = removalRange(doc.text, a.getStart(), a.getEnd());
  doc.edit([r], rule);
  doc.edit(slotPlan(doc, get(), pathArr, entries).edits, rule);
}

function renameAttr(doc, get, from, to, rule) {
  const a = getAttr(get(), from);
  if (!a) return;
  if (getAttr(get(), to)) return doc.todo(a, rule, from + ' and ' + to + ' are both set: keep one');
  const n = a.getNameNode();
  doc.edit([{ start: n.getStart(), end: n.getEnd(), text: to }], rule);
}

// ---------------------------------------------------------------------------
// D rules

function lowercaseKeyEdits(obj) {
  const edits = [];
  obj.getProperties().forEach((p) => {
    const name = propName(p);
    if (!name || !/^[A-Z]/.test(name)) return;
    const lower = name[0].toLowerCase() + name.slice(1);
    if (getProp(obj, lower)) return; // both spellings – leave it to a human
    if (N.isShorthandPropertyAssignment(p)) edits.push({ start: p.getStart(), end: p.getEnd(), text: lower + ': ' + name });
    else edits.push({ start: p.getNameNode().getStart(), end: p.getNameNode().getEnd(), text: keyText(lower) });
  });
  return edits;
}

function ruleD1(doc) {
  doc.forEachPicker((get) => {
    get().getAttributes().filter((a) => N.isJsxSpreadAttribute(a)).forEach((_, i) => {
      doc.todo(get().getAttributes().filter((x) => N.isJsxSpreadAttribute(x))[i], 'D1', REASON.spread);
    });
    [['components', 'slots'], ['componentsProps', 'slotProps']].forEach(([from, to]) => {
      // keys left in v5 case inside an existing slots / slotProps (the official codemod renames the prop, not always its keys)
      const existing = getAttr(get(), to);
      if (existing && isObj(unwrapParens(attrValue(existing)))) doc.edit(lowercaseKeyEdits(unwrapParens(attrValue(existing))), 'D1');
      let a = getAttr(get(), from);
      if (!a) return;
      let v = unwrapParens(attrValue(a));
      if (isObj(v)) {
        doc.edit(lowercaseKeyEdits(v), 'D1');
        const spreads = () => unwrapParens(attrValue(getAttr(get(), from))).getProperties().filter((p) => N.isSpreadAssignment(p));
        for (let i = 0; i < spreads().length; i++) doc.todo(spreads()[i], 'D1', REASON.spread);
      }
      a = getAttr(get(), from);
      v = unwrapParens(attrValue(a));
      const target = getAttr(get(), to);
      if (!target) {
        const literal = isObj(v);
        doc.edit([{ start: a.getNameNode().getStart(), end: a.getNameNode().getEnd(), text: to }], 'D1');
        if (!literal) doc.todo(getAttr(get(), to), 'D1', to + ' is not an object literal: lowercase the first letter of each key');
        return;
      }
      const tv = unwrapParens(attrValue(target));
      if (!isObj(v) || !isObj(tv)) return doc.todo(a, 'D1', from + ' and ' + to + ' are both set: merge them manually');
      const clash = v.getProperties().map(propName).filter((k) => k && getProp(tv, k));
      if (clash.length) return doc.todo(a, 'D1', to + '.' + clash[0] + ' is set twice: merge ' + from + ' manually');
      const entries = v.getProperties().map((p) => ({ raw: p.getText(), from: lineIndent(doc.text, p.getStart()) }));
      doc.edit([removalRange(doc.text, a.getStart(), a.getEnd())], 'D1');
      const t2 = unwrapParens(attrValue(getAttr(get(), to)));
      doc.edit(insertPropsEdits(doc, t2, entries), 'D1');
    });
  });
}

function ruleD2(doc) {
  doc.forEachPicker((get) => renameAttr(doc, get, 'inputFormat', 'format', 'D2'));
}
function ruleD3(doc) {
  doc.forEachPicker((get) => moveAttrToSlot(doc, get, 'PaperProps', 'D3', [], ['desktopPaper', 'mobilePaper']));
}
function ruleD4(doc) {
  doc.forEachPicker((get) => moveAttrToSlot(doc, get, 'OpenPickerButtonProps', 'D4', [], ['openPickerButton']));
}

function ruleD5(doc) {
  doc.forEachPicker((get) => {
    Object.keys(D5_KEYS).forEach((oldKey) => {
      const tf = slotPropsObj(get(), ['textField']);
      const p = tf && getProp(tf, oldKey);
      if (!p) return;
      const v = propValue(p);
      const entries = [{ key: D5_KEYS[oldKey], value: v.getText(), from: lineIndent(doc.text, v.getStart()) }];
      const plan = slotPlan(doc, get(), ['textField', 'slotProps'], entries);
      if (plan.todo) return doc.todo(p, 'D5', plan.todo);
      if (plan.conflict) return doc.todo(p, 'D5', 'slotProps.textField.slotProps.' + D5_KEYS[oldKey] + ' is already set: merge ' + oldKey + ' into it manually');
      doc.edit([removePropEdit(doc.text, tf, p)], 'D5');
      doc.edit(slotPlan(doc, get(), ['textField', 'slotProps'], entries).edits, 'D5');
    });
  });
}

function ruleD6(doc) {
  doc.forEachPicker((get) => {
    const a = getAttr(get(), 'enableAccessibleFieldDOMStructure');
    if (a) doc.edit([removalRange(doc.text, a.getStart(), a.getEnd())], 'D6');
    const field = slotPropsObj(get(), ['field']);
    const p = field && getProp(field, 'enableAccessibleFieldDOMStructure');
    if (!p) return;
    if (field.getProperties().length === 1) {
      const sp = slotPropsObj(get(), []);
      const fp = getProp(sp, 'field');
      doc.edit([removePropEdit(doc.text, sp, fp)], 'D6');
    } else {
      doc.edit([removePropEdit(doc.text, field, p)], 'D6');
    }
  });
}

function ruleD7(doc) {
  doc.forEachPicker((get) => Object.keys(D7_ATTRS).forEach((k) => renameAttr(doc, get, k, D7_ATTRS[k], 'D7')));
}

// D8 – CSS class names in strings (sx, styled, theme files) and the theme key MuiPickersDay
function ruleD8(doc) {
  const edits = [];
  doc.sf.forEachDescendant((n) => {
    const k = n.getKind();
    if (k !== K.StringLiteral && k !== K.NoSubstitutionTemplateLiteral && k !== K.TemplateHead && k !== K.TemplateMiddle && k !== K.TemplateTail) return;
    const t = n.getText();
    let r = t;
    D8_STRINGS.forEach(([from, to]) => { r = r.split(from).join(to); });
    if (r !== t) edits.push({ start: n.getStart(), end: n.getEnd(), text: r });
  });
  doc.sf.getDescendantsOfKind(K.PropertyAssignment).forEach((p) => {
    if (propName(p) !== 'MuiPickersDay') return;
    const owner = p.getParent() && p.getParent().getParent();
    if (!owner || !N.isPropertyAssignment(owner) || propName(owner) !== 'components') return;
    const n = p.getNameNode();
    edits.push({ start: n.getStart(), end: n.getEnd(), text: N.isIdentifier(n) ? 'MuiPickerDay' : n.getText().replace('MuiPickersDay', 'MuiPickerDay') });
  });
  doc.edit(edits, 'D8');
}

// ---------------------------------------------------------------------------
// Slot components (D9, C4, C5)

// { fn, stmt, inline } for a slots.<key> value
function resolveComponent(doc, valueNode) {
  const v = unwrapParens(valueNode);
  if (!v) return null;
  if (N.isArrowFunction(v) || N.isFunctionExpression(v)) return { fn: v, stmt: null, inline: true };
  if (!N.isIdentifier(v)) return null;
  const name = v.getText();
  const cands = [];
  doc.sf.forEachDescendant((n) => {
    if (N.isVariableDeclaration(n) && n.getName() === name) {
      const init = unwrapParens(n.getInitializer());
      if (init && (N.isArrowFunction(init) || N.isFunctionExpression(init))) cands.push({ fn: init, stmt: n.getFirstAncestorByKind(K.VariableStatement) || null });
    } else if (N.isFunctionDeclaration(n) && n.getName() === name) {
      cands.push({ fn: n, stmt: n });
    }
  });
  // the declaration in a scope that encloses the use wins over a module-level one
  const enclosing = cands.filter((c) => c.stmt && c.stmt.getParent() && !N.isSourceFile(c.stmt.getParent()) &&
    nearestFunction(c.stmt) && nearestFunction(c.stmt).containsRange(v.getStart(), v.getEnd()));
  const pick = enclosing[enclosing.length - 1] || cands.find((c) => c.stmt && N.isSourceFile(c.stmt.getParent())) || null;
  return pick ? Object.assign({ inline: false }, pick) : null;
}
function slotEntries(el) {
  const a = getAttr(el, 'slots');
  const obj = a && unwrapParens(attrValue(a));
  if (!isObj(obj)) return [];
  return obj.getProperties().filter((p) => propName(p) && propValue(p)).map((p) => ({ key: propName(p), prop: p, value: propValue(p) }));
}

const isTodayExpr = (e) => {
  e = unwrapParens(e);
  if (!e) return false;
  if (N.isCallExpression(e)) return /^(moment|dayjs)$/.test(e.getExpression().getText()) && e.getArguments().length === 0;
  if (N.isNewExpression(e)) return e.getExpression().getText() === 'Date' && (e.getArguments() || []).length === 0;
  return false;
};

// C5 + D9: the component passed to slots.actionBar
function ruleActionBar(doc) {
  doc.forEachPicker((get) => {
    const locate = () => {
      const s = slotEntries(get()).find((x) => x.key === 'actionBar');
      return s ? resolveComponent(doc, s.value) : null;
    };
    let comp = locate();
    if (!comp) return;
    const p0 = comp.fn.getParameters()[0];
    if (!p0) return;
    if (!N.isIdentifier(p0.getNameNode())) {
      const names = bindingNames(p0.getNameNode());
      if (names.some((n) => ACTIONS[n])) doc.todo(comp.stmt || comp.fn, 'D9', 'action bar destructures its props: read the actions from usePickerActionsContext()');
      return;
    }
    const pn = p0.getName();
    const accesses = () => locate().fn.getDescendantsOfKind(K.PropertyAccessExpression)
      .filter((pa) => N.isIdentifier(pa.getExpression()) && pa.getExpression().getText() === pn && ACTIONS[pa.getName()]);
    const todayCalls = () => locate().fn.getDescendantsOfKind(K.CallExpression).filter((c) => !isTodayExpr(c) &&
      c.getArguments().some(isTodayExpr) && !c.getExpression().getText().startsWith(pn + '.'));
    const needed = new Set(accesses().map((pa) => ACTIONS[pa.getName()]));
    const nToday = todayCalls().length;
    if (!needed.size && !nToday) return;

    // C5: TODO first (lines are stable), then the replacement
    for (let i = 0; i < nToday; i++) doc.todo(todayCalls()[i], 'C5', REASON.c5);
    if (nToday) {
      doc.edit(todayCalls().map((c) => ({ start: c.getStart(), end: c.getEnd(), text: 'setValueToToday()' })), 'C5');
      needed.add('setValueToToday');
    }
    doc.edit(accesses().map((pa) => ({ start: pa.getStart(), end: pa.getEnd(), text: ACTIONS[pa.getName()] })), 'D9');

    // params.className → DialogActions
    comp = locate();
    const da = jsxOpeningsIn(comp.fn).find((el) => tagOf(el) === 'DialogActions');
    if (da && !getAttr(da, 'className')) doc.edit([insertAttrEdit(doc, da, 'className={' + pn + '.className}')], 'D9');

    // const { … } = usePickerActionsContext();
    comp = locate();
    const names = ACTION_ORDER.filter((n) => needed.has(n));
    const existing = comp.fn.getDescendantsOfKind(K.VariableDeclaration).find((d) => {
      const init = unwrapParens(d.getInitializer());
      return init && N.isCallExpression(init) && init.getExpression().getText() === 'usePickerActionsContext' && N.isObjectBindingPattern(d.getNameNode());
    });
    if (existing) {
      const have = bindingNames(existing.getNameNode());
      const add = names.filter((n) => have.indexOf(n) === -1);
      const els = existing.getNameNode().getElements();
      if (add.length && els.length) doc.edit([{ start: els[els.length - 1].getEnd(), end: els[els.length - 1].getEnd(), text: ', ' + add.join(', ') }], 'D9');
    } else {
      const hook = 'const { ' + names.join(', ') + ' } = usePickerActionsContext();';
      const body = comp.fn.getBody();
      if (N.isBlock(body)) {
        const first = body.getStatements()[0];
        const ind = first ? lineIndent(doc.text, first.getStart()) : lineIndent(doc.text, comp.fn.getStart()) + doc.unit;
        doc.edit([{ start: body.getStart() + 1, end: body.getStart() + 1, text: doc.eol + ind + hook }], 'D9');
      } else {
        const base = lineIndent(doc.text, comp.fn.getStart());
        const ind = base + doc.unit;
        const bodyText = reindent(body.getText(), base, ind);
        doc.edit([{
          start: body.getStart(), end: body.getEnd(),
          text: '{' + doc.eol + ind + hook + doc.eol + ind + 'return ' + bodyText + ';' + doc.eol + base + '}',
        }], 'D9');
      }
    }
    ensureNamedImport(doc, HOOKS_MODULE, ['usePickerActionsContext'], 'D9');
  });
}
function jsxOpeningsIn(node) {
  const out = [];
  node.forEachDescendant((n) => { if (N.isJsxOpeningElement(n) || N.isJsxSelfClosingElement(n)) out.push(n); });
  return out;
}

// Names a statement uses from the functions around it (closure); module-level names are not closure
function closureNames(stmt) {
  const outer = stmt.getAncestors().filter(isFn);
  const declared = new Set();
  outer.forEach((f) => {
    f.getParameters().forEach((p) => bindingNames(p.getNameNode()).forEach((n) => declared.add(n)));
    f.forEachDescendant((d) => {
      if (stmt.containsRange(d.getStart(), d.getEnd())) return;
      if ((N.isVariableDeclaration(d) || N.isFunctionDeclaration(d) || N.isClassDeclaration(d)) && nearestFunction(d) === f && d.getNameNode()) {
        bindingNames(d.getNameNode()).forEach((n) => declared.add(n));
      }
    });
  });
  const own = new Set();
  stmt.forEachDescendant((d) => {
    if ((N.isVariableDeclaration(d) || N.isParameterDeclaration(d) || N.isFunctionDeclaration(d) || N.isBindingElement(d)) && d.getNameNode()) bindingNames(d.getNameNode()).forEach((n) => own.add(n));
  });
  if (N.isFunctionDeclaration(stmt) && stmt.getName()) own.add(stmt.getName());
  const out = [];
  stmt.getDescendantsOfKind(K.Identifier).forEach((id) => {
    const t = id.getText();
    if (declared.has(t) && !own.has(t) && isReference(id) && out.indexOf(t) === -1) out.push(t);
  });
  return out;
}

// Line range of a statement incl. // comment lines directly above it
function statementBlock(text, stmt) {
  let ls = lineStartAt(text, stmt.getStart(true));
  while (ls > 0) {
    const pls = text.lastIndexOf('\n', ls - 2) + 1;
    if (text.slice(pls, ls).trim().startsWith('//')) ls = pls; else break;
  }
  const r = removalRange(text, stmt.getStart(true), stmt.getEnd());
  return { start: Math.min(ls, r.start), end: r.end };
}

// C4: slot components defined inside a component
function ruleC4(doc) {
  doc.forEachPicker((get) => {
    for (let i = 0; ; i++) {
      const entries = slotEntries(get());
      if (i >= entries.length) break;
      const comp = resolveComponent(doc, entries[i].value);
      if (!comp) continue;
      if (comp.inline) { doc.todo(entries[i].prop, 'C4', REASON.c4Inline); continue; }
      if (!comp.stmt || N.isSourceFile(comp.stmt.getParent())) continue;
      const names = closureNames(comp.stmt);
      if (names.length) { doc.todo(comp.stmt, 'C4', 'slot component defined inside render: uses closure (' + names.join(', ') + ')'); continue; }
      const top = comp.stmt.getAncestors().find((a) => a.getParent() && N.isSourceFile(a.getParent()));
      if (!top) continue;
      const text = doc.text;
      const blk = statementBlock(text, comp.stmt);
      const ind = lineIndent(text, comp.stmt.getStart());
      let moved = text.slice(blk.start, blk.end).split('\n').map((l) => (l.startsWith(ind) ? l.slice(ind.length) : l)).join('\n');
      if (!moved.endsWith('\n')) moved += doc.eol;
      const at = statementBlock(text, top).start;
      // removing the inner statement must not leave two blank lines behind
      let end = blk.end;
      const before = text.slice(0, blk.start);
      if (/(\n[ \t]*\r?\n|[{(][ \t]*\r?\n)$/.test(before)) { const m = /^[ \t]*\r?\n/.exec(text.slice(end)); if (m) end += m[0].length; }
      doc.edit([{ start: at, end: at, text: moved + doc.eol }, { start: blk.start, end: end, text: '' }], 'C4');
    }
  });
}

// ---------------------------------------------------------------------------
// C rules

// The <X {...params} …/> that renderInput returns, or null
function renderInputJsx(fn) {
  if (!fn || !(N.isArrowFunction(fn) || N.isFunctionExpression(fn))) return null;
  let body = fn.getBody();
  if (N.isBlock(body)) {
    const st = body.getStatements();
    body = st.length === 1 && N.isReturnStatement(st[0]) ? st[0].getExpression() : null;
  }
  body = unwrapParens(body);
  return body && N.isJsxSelfClosingElement(body) ? body : null;
}

function isSimple(e) {
  e = unwrapParens(e);
  if (!e) return false;
  if (N.isIdentifier(e) || N.isStringLiteral(e) || N.isNumericLiteral(e) || N.isNoSubstitutionTemplateLiteral(e) ||
    N.isTrueLiteral(e) || N.isFalseLiteral(e) || N.isNullLiteral(e)) return true;
  if (N.isPropertyAccessExpression(e)) return isSimple(e.getExpression());
  if (N.isPrefixUnaryExpression(e)) return isSimple(e.getOperand());
  if (N.isTemplateExpression(e)) return e.getTemplateSpans().every((s) => isSimple(s.getExpression()));
  if (N.isObjectLiteralExpression(e)) return e.getProperties().every((p) => (N.isPropertyAssignment(p) && isSimple(p.getInitializer())) || N.isShorthandPropertyAssignment(p));
  if (N.isArrayLiteralExpression(e)) return e.getElements().every(isSimple);
  if (N.isConditionalExpression(e)) return [e.getCondition(), e.getWhenTrue(), e.getWhenFalse()].every(isSimple);
  if (N.isBinaryExpression(e)) return isSimple(e.getLeft()) && isSimple(e.getRight());
  return false;
}
const isParamProp = (e, pn, name) => { e = unwrapParens(e); return !!e && N.isPropertyAccessExpression(e) && e.getExpression().getText() === pn && e.getName() === name; };

function ruleC1(doc) {
  doc.forEachPicker((get) => {
    const a = getAttr(get(), 'renderInput');
    if (!a) return;
    const fn = unwrapParens(attrValue(a));
    const jsx = renderInputJsx(fn);
    const p0 = fn && isFn(fn) ? fn.getParameters()[0] : null;
    const pn = p0 && N.isIdentifier(p0.getNameNode()) ? p0.getName() : null;
    if (!jsx || !pn) return doc.todo(a, 'C1', 'renderInput is not a single <TextField {...params} /> element: move its props to slotProps.textField');
    if (!isMuiImport(doc, tagOf(jsx), 'TextField')) return doc.todo(a, 'C1', REASON.c1Custom);
    const entries = [];
    let spreadOk = false;
    for (const at of jsx.getAttributes()) {
      if (N.isJsxSpreadAttribute(at)) {
        if (at.getExpression().getText() === pn && !spreadOk) { spreadOk = true; continue; }
        return doc.todo(a, 'C1', 'renderInput has another spread (' + at.getText() + '): move its props to slotProps.textField manually');
      }
      const name = at.getNameNode().getText();
      const v = attrValue(at);
      let value = null;
      if (!v) value = 'true';
      else if (N.isStringLiteral(v)) value = v.getText();
      else {
        const e = unwrapParens(v);
        if (N.isBinaryExpression(e) && e.getOperatorToken().getKind() === K.BarBarToken) {
          if (isParamProp(e.getLeft(), pn, name) && !refsName(e.getRight(), pn)) value = e.getRight().getText();
          else if (isParamProp(e.getRight(), pn, name) && !refsName(e.getLeft(), pn)) value = e.getLeft().getText();
        }
        if (value === null && isSimple(e) && !refsName(e, pn)) value = v.getText();
      }
      if (value === null) return doc.todo(a, 'C1', 'renderInput prop ' + name + ' is not a plain value: move it to slotProps.textField manually');
      entries.push({ key: name, value: value, from: v ? lineIndent(doc.text, v.getStart()) : undefined });
    }
    if (!spreadOk) return doc.todo(a, 'C1', 'renderInput does not spread {...' + pn + '}: move its props to slotProps.textField manually');
    if (entries.length) {
      const plan = slotPlan(doc, get(), ['textField'], entries);
      if (plan.todo) return doc.todo(a, 'C1', plan.todo);
      if (plan.conflict) return doc.todo(a, 'C1', 'slotProps.textField.' + plan.conflict[0] + ' is already set: merge renderInput manually');
    }
    doc.edit([removalRange(doc.text, a.getStart(), a.getEnd())], 'C1');
    if (entries.length) doc.edit(slotPlan(doc, get(), ['textField'], entries).edits, 'C1');
  });
}

// C2 – moment() around value / minDate / maxDate under AdapterMoment
function adaptersIn(sf) {
  return jsxOpenings(sf).filter((el) => tagOf(el) === 'LocalizationProvider').map((el) => {
    const a = getAttr(el, 'dateAdapter');
    const v = a && attrValue(a);
    return v ? v.getText() : '?';
  });
}
const allMoment = (list) => list.length > 0 && list.every((n) => /Moment/.test(n));

function ruleC2(doc) {
  const local = adaptersIn(doc.sf);
  const project = doc.env.projectAdapters;
  const mode = local.length ? (allMoment(local) ? 'moment' : 'other') : project.length ? (allMoment(project) ? 'moment' : 'other') : 'unknown';
  if (mode === 'other') return;
  let wrapped = false;
  doc.forEachPicker((get) => {
    ['value', 'minDate', 'maxDate'].forEach((name) => {
      const a = getAttr(get(), name);
      const v = a && attrValue(a);
      if (!v || N.isStringLiteral(v)) return;
      const e = unwrapParens(v);
      const t = e.getText();
      if (N.isNullLiteral(e) || t === 'undefined' || /\b(moment|dayjs)\s*\(/.test(t)) return;
      if (mode === 'unknown') return doc.todo(a, 'C2', 'dateAdapter not found: if it is AdapterMoment, wrap ' + name + ' with moment()');
      const empty = name === 'value' ? 'null' : 'undefined';
      let next = null;
      if (N.isIdentifier(e) || N.isPropertyAccessExpression(e)) next = t + ' ? moment(' + t + ') : ' + empty;
      else if (N.isConditionalExpression(e)) {
        const wt = unwrapParens(e.getWhenTrue());
        const wf = unwrapParens(e.getWhenFalse());
        if ((N.isNullLiteral(wf) || wf.getText() === 'undefined') && !N.isNullLiteral(wt)) {
          next = e.getCondition().getText() + ' ? moment(' + wt.getText() + ') : ' + wf.getText();
        }
      }
      if (next === null) return doc.todo(a, 'C2', name + ' is an expression: wrap it with moment() manually');
      doc.edit([{ start: v.getStart(), end: v.getEnd(), text: next }], 'C2');
      wrapped = true;
    });
  });
  if (wrapped && !hasLocalBinding(doc, 'moment')) {
    const q = quoteFor(doc);
    insertImportLine(doc, 'import moment from ' + q + 'moment' + q + semiFor(doc), 'C2');
  }
}

// C3 – onChange: dateValue?.toDate() || null → dateValue?.isValid() ? dateValue.toDate() : null
function onChangeFunction(doc, el) {
  const a = getAttr(el, 'onChange');
  const v = a && unwrapParens(attrValue(a));
  if (!v) return null;
  if (N.isArrowFunction(v) || N.isFunctionExpression(v)) return v;
  if (!N.isIdentifier(v)) return null;
  const c = resolveComponent(doc, v);
  return c ? c.fn : null;
}
function ruleC3(doc) {
  if (doc.env.config.invalidDateBehavior !== 'null') return;
  doc.forEachPicker((get) => {
    const fn = onChangeFunction(doc, get());
    const p0 = fn && fn.getParameters()[0];
    if (!p0 || !N.isIdentifier(p0.getNameNode())) return;
    const pn = p0.getName();
    const hits = fn.getDescendantsOfKind(K.BinaryExpression).filter((b) => {
      if (b.getOperatorToken().getKind() !== K.BarBarToken || !N.isNullLiteral(unwrapParens(b.getRight()))) return false;
      const l = unwrapParens(b.getLeft());
      if (!N.isCallExpression(l) || l.getArguments().length) return false;
      const callee = l.getExpression();
      return N.isPropertyAccessExpression(callee) && callee.getName() === 'toDate' && callee.getExpression().getText() === pn && !!callee.getQuestionDotTokenNode();
    });
    doc.edit(hits.map((b) => {
      const p = b.getParent();
      const bare = N.isCallExpression(p) || N.isReturnStatement(p) || N.isArrowFunction(p) || N.isVariableDeclaration(p) ||
        N.isPropertyAssignment(p) || N.isJsxExpression(p) || N.isParenthesizedExpression(p) || N.isBinaryExpression(p) && p.getOperatorToken().getKind() === K.EqualsToken;
      const t = pn + '?.isValid() ? ' + pn + '.toDate() : null';
      return { start: b.getStart(), end: b.getEnd(), text: bare ? t : '(' + t + ')' };
    }), 'C3');
  });
}

// C6 – an external FormHelperText that repeats the field's helperText
function nearestTag(node, tag) {
  return node.getAncestors().find((n) => N.isJsxElement(n) && tagOf(n.getOpeningElement()) === tag) || null;
}
function helperSources(doc, el) {
  const out = [];
  const direct = getAttr(el, 'helperText');
  if (direct && attrValue(direct)) out.push({ via: 'direct', text: unwrapParens(attrValue(direct)).getText() });
  const ri = getAttr(el, 'renderInput');
  const jsx = ri && renderInputJsx(unwrapParens(attrValue(ri)));
  const h = jsx && getAttr(jsx, 'helperText');
  if (h && attrValue(h)) out.push({ via: 'renderInput', text: unwrapParens(attrValue(h)).getText() });
  const tf = slotPropsObj(el, ['textField']);
  const tp = tf && getProp(tf, 'helperText');
  if (tp && propValue(tp)) out.push({ via: 'textField', text: unwrapParens(propValue(tp)).getText() });
  return out;
}
function ruleC6(doc) {
  doc.forEachPicker((get) => {
    for (;;) {
      const el = get();
      const sources = helperSources(doc, el);
      if (!sources.length) return;
      const fc = nearestTag(el, 'FormControl');
      if (!fc) return;
      const fhtLocals = localsOf(doc, 'FormHelperText', ['@mui/material']);
      const fht = jsxOpeningsIn(fc).find((o) => fhtLocals.has(tagOf(o)) && nearestTag(o, 'FormControl') === fc && !doc.hasTodoAbove(o));
      if (!fht) return;
      const node = N.isJsxOpeningElement(fht) ? fht.getParent() : fht;
      const attrs = fht.getAttributes();
      const children = N.isJsxElement(node) ? node.getJsxChildren().filter((c) => !(N.isJsxText(c) && !c.getText().trim())) : [];
      const shown = children.length === 1 && N.isJsxExpression(children[0]) && children[0].getExpression() ? children[0].getExpression().getText() : null;
      const match = sources.find((s) => s.text === shown);
      const onlyStyle = attrs.every((x) => N.isJsxAttribute(x) && ['style', 'sx'].indexOf(x.getNameNode().getText()) !== -1);
      if (!match || !onlyStyle || !N.isJsxElement(node.getParent())) { doc.todo(fht, 'C6', REASON.c6); continue; }

      const style = getAttr(fht, 'style');
      const sx = getAttr(fht, 'sx');
      const sv = style && unwrapParens(attrValue(style));
      const xv = sx && unwrapParens(attrValue(sx));
      const ind = lineIndent(doc.text, fht.getStart());
      let combined = null;
      if (sv && xv) combined = N.isArrayLiteralExpression(xv) ? '[' + [sv.getText()].concat(xv.getElements().map((x) => x.getText())).join(', ') + ']' : '[' + sv.getText() + ', ' + xv.getText() + ']';
      else if (sv || xv) combined = (sv || xv).getText();
      const sxEntries = combined ? [{ key: 'sx', value: combined, from: ind }] : null;
      // v9 shows helperText only from slotProps.textField (renderInput is ignored, a picker prop is not forwarded)
      const needHelper = !sources.some((s) => s.via === 'textField');
      if (sxEntries) {
        const plan = slotPlan(doc, el, ['textField', 'slotProps', 'formHelperText'], sxEntries);
        if (plan.todo || plan.conflict) { doc.todo(fht, 'C6', plan.todo || 'slotProps.textField.slotProps.formHelperText.sx is already set: merge manually'); continue; }
      }
      const tag = tagOf(fht);
      doc.edit([removalRange(doc.text, node.getStart(), node.getEnd())], 'C6');
      if (sxEntries) doc.edit(slotPlan(doc, get(), ['textField', 'slotProps', 'formHelperText'], sxEntries).edits, 'C6');
      // the value reached the field only through renderInput, which v9 ignores – keep it visible
      if (needHelper) {
        const plan = slotPlan(doc, get(), ['textField'], [{ key: 'helperText', value: match.text }]);
        if (plan.edits) doc.edit(plan.edits, 'C6');
      }
      removeImportIfUnused(doc, tag);
    }
  });
}

// ---------------------------------------------------------------------------
// R1 – RTL alignment of the field

function isRtlThemeFn(e) {
  e = unwrapParens(e);
  if (!e || !(N.isArrowFunction(e) || N.isFunctionExpression(e))) return false;
  const p0 = e.getParameters()[0];
  const body = unwrapParens(e.getBody());
  if (!p0 || !isObj(body)) return false;
  const pn = p0.getName();
  const props = body.getProperties();
  return props.some((p) => N.isSpreadAssignment(p) && p.getExpression().getText() === pn) &&
    props.some((p) => propName(p) === 'direction' && stringValue(propValue(p)) === 'rtl');
}

function ruleR13(doc) {
  for (;;) {
    const tp = localsOf(doc, 'ThemeProvider', ['@mui/material', '@mui/material/styles', '@mui/system', '@emotion/react']);
    const pickers = doc.pickers();
    const wrap = jsxOpenings(doc.sf).find((o) => N.isJsxOpeningElement(o) && tp.has(tagOf(o)) && getAttr(o, 'theme') &&
      isRtlThemeFn(attrValue(getAttr(o, 'theme'))) && pickers.some((p) => o.getParent().containsRange(p.getStart(), p.getEnd())));
    if (!wrap) return;
    const el = wrap.getParent();
    const tag = tagOf(wrap);
    const picker = pickers.find((p) => el.containsRange(p.getStart(), p.getEnd()));
    const pickerIdx = pickers.indexOf(picker);
    const kids = el.getJsxChildren().filter((c) => !(N.isJsxText(c) && !c.getText().trim()));
    const elInd = lineIndent(doc.text, el.getStart());
    let text;
    if (kids.length === 1) text = reindent(kids[0].getText(), lineIndent(doc.text, kids[0].getStart()), elInd);
    else text = '<>' + doc.text.slice(wrap.getEnd(), el.getClosingElement().getStart()) + '</>';
    doc.edit([{ start: el.getStart(), end: el.getEnd(), text: text }], 'R1.3');
    doc.todo(doc.pickers()[pickerIdx], 'R1.3', REASON.r13);
    removeImportIfUnused(doc, tag);
  }
}

function sizeOfValue(n) {
  const s = stringValue(n);
  if (s === undefined) return 'dynamic';
  return s === 'small' ? 'small' : 'medium';
}
function pickerSize(el) {
  const tf = slotPropsObj(el, ['textField']);
  const p = tf && getProp(tf, 'size');
  if (p) return N.isPropertyAssignment(p) ? sizeOfValue(p.getInitializer()) : 'dynamic';
  const a = getAttr(el, 'size');
  if (a) return attrValue(a) ? sizeOfValue(attrValue(a)) : 'dynamic';
  const fc = nearestTag(el, 'FormControl');
  const fa = fc && getAttr(fc.getOpeningElement(), 'size');
  if (fa) return attrValue(fa) ? sizeOfValue(attrValue(fa)) : 'dynamic';
  return 'medium';
}

function ruleR1(doc) {
  const used = new Set();
  doc.forEachPicker((get) => {
    const size = pickerSize(get());
    if (size === 'dynamic') return doc.todo(get(), 'R1', REASON.r1Dynamic);
    const name = size === 'small' ? 'pickersRtlSxSmall' : 'pickersRtlSxMedium';
    const plan = slotPlan(doc, get(), ['textField'], [{ key: 'sx', value: name }]);
    if (plan.todo) return doc.todo(get(), 'R1', plan.todo + ': add sx: ' + name + ' to slotProps.textField manually');
    if (plan.edits) { doc.edit(plan.edits, 'R1'); used.add(name); return; }
    const p = getProp(plan.obj, 'sx');
    if (/\bpickersRtlSx(Small|Medium)\b/.test(p.getText())) { used.add(/\bpickersRtlSxSmall\b/.test(p.getText()) ? 'pickersRtlSxSmall' : 'pickersRtlSxMedium'); return; }
    if (N.isShorthandPropertyAssignment(p)) {
      doc.edit([{ start: p.getStart(), end: p.getEnd(), text: 'sx: [' + name + ', sx]' }], 'R1');
    } else {
      const v = unwrapParens(p.getInitializer());
      if (N.isArrayLiteralExpression(v)) {
        const els = v.getElements();
        doc.edit([els.length ? { start: els[0].getStart(), end: els[0].getStart(), text: name + ', ' } : { start: v.getStart(), end: v.getEnd(), text: '[' + name + ']' }], 'R1');
      } else {
        doc.edit([{ start: v.getStart(), end: v.getEnd(), text: '[' + name + ', ' + v.getText() + ']' }], 'R1');
      }
    }
    used.add(name);
  }, (imported) => R1_PICKERS.has(imported));
  if (!used.size) return;

  if (doc.env.rtlMode === 'inline') {
    if (/\b(const|let|var)\s+pickersRtlSx(Small|Medium)\b/.test(doc.text)) return;
    let src = RTL_SX_SOURCE.replace(/^export /gm, '');
    const clash = doc.sf.getStatements().some((s) => N.isVariableStatement(s) && s.getDeclarations().some((d) => bindingNames(d.getNameNode()).indexOf('base') !== -1)) ||
      doc.sf.getFunction('base') || hasLocalBinding(doc, 'base');
    if (clash) src = src.replace(/\bbase\b/g, 'pickersRtlSxBase');
    src = src.split('\n').join(doc.eol);
    const imps = doc.sf.getImportDeclarations();
    if (imps.length) {
      const e = lineEndAt(doc.text, imps[imps.length - 1].getEnd());
      doc.edit([{ start: e, end: e, text: doc.eol + doc.eol + src }], 'R1');
    } else {
      doc.edit([{ start: 0, end: 0, text: src + doc.eol + doc.eol }], 'R1');
    }
    return;
  }
  doc.env.needShared = true;
  const names = RTL_NAMES.filter((n) => used.has(n) && !hasLocalBinding(doc, n));
  if (!names.length) return;
  const abs = path.join(doc.env.root, doc.env.config.rtlSxSharedPath);
  let spec = toPosix(path.relative(path.dirname(path.join(doc.env.root, doc.rel)), abs)).replace(/\.(js|jsx|ts|tsx)$/, '');
  if (!spec.startsWith('.')) spec = './' + spec;
  ensureNamedImport(doc, spec, names, 'R1');
}

// ---------------------------------------------------------------------------
// M rules – marking only

// A TODO above each node of `kind` that starts at one of the positions – bottom-up, so the positions above stay valid
function todoAt(doc, positions, kind, rule, reason) {
  positions.slice().sort((a, b) => b - a).forEach((pos) => {
    const n = doc.sf.getDescendantAtPos(pos);
    const node = n && (n.getKind() === kind ? n : n.getFirstAncestorByKind(kind));
    if (node) doc.todo(node, rule, reason);
  });
}

function ruleM2(doc) {
  doc.forEachPicker((get) => {
    const el = get();
    const attrs = el.getAttributes().concat(el.getDescendantsOfKind(K.JsxAttribute));
    const hits = attrs.filter((a) => N.isJsxAttribute(a) && a.getInitializer() && N.isStringLiteral(a.getInitializer()) && SUSPICIOUS.test(a.getInitializer().getLiteralText()));
    todoAt(doc, hits.map((a) => a.getStart()), K.JsxAttribute, 'M2', REASON.m2);
  });
}
function ruleM3(doc) {
  const hits = doc.sf.getDescendantsOfKind(K.PropertyAssignment).filter((p) => {
    const k = propName(p) || '';
    const v = p.getInitializer();
    if (!v) return false;
    if (/Mui(DateCalendar|CalendarPicker)-root/.test(k)) return /\bdirection\s*:\s*['"`]rtl['"`]/.test(v.getText());
    if (/MuiPickersArrowSwitcher/.test(k)) return /rotate\(\s*180deg\s*\)/.test(v.getText());
    return false;
  });
  todoAt(doc, hits.map((p) => p.getStart()), K.PropertyAssignment, 'M3', REASON.m3);
}
function ruleM4(doc) {
  doc.forEachPicker((get) => {
    ['renderInput', 'components', 'componentsProps', 'inputFormat'].forEach((name) => {
      const a = getAttr(get(), name);
      if (a && !doc.hasTodoAbove(a)) doc.todo(a, 'M4', REASON.m4);
    });
  });
  for (;;) {
    const d = importsOf(doc.sf, (m) => LAB_MODULE.test(m)).find((x) => x.getNamedImports().some((s) => /Picker$/.test(s.getName())) && !doc.hasTodoAbove(x));
    if (!d) break;
    doc.todo(d, 'M4', REASON.m4 + ': picker imported from @mui/lab – import it from @mui/x-date-pickers');
  }
}
function ruleM5(doc) {
  const starts = [];
  doc.sf.getDescendantsOfKind(K.PropertyAssignment).forEach((p) => {
    if (propName(p) !== 'components' || !isObj(unwrapParens(p.getInitializer()))) return;
    unwrapParens(p.getInitializer()).getProperties().forEach((c) => {
      const v = N.isPropertyAssignment(c) && unwrapParens(c.getInitializer());
      if (M5_KEYS.has(propName(c)) && isObj(v) && (getProp(v, 'styleOverrides') || getProp(v, 'defaultProps'))) starts.push(c.getStart());
    });
  });
  todoAt(doc, starts, K.PropertyAssignment, 'M5', REASON.m5);
}

// ---------------------------------------------------------------------------

function collectTodos(text) {
  const lines = text.split('\n');
  const out = [];
  lines.forEach((l, i) => {
    const m = TODO_LINE.exec(l);
    if (!m) return;
    let j = i + 1;
    while (j < lines.length && lines[j].indexOf(TODO_TAG) !== -1) j++;
    out.push({ rule: m[1], line: j + 1, reason: m[2] });
  });
  return out;
}

function importsPickers(sf) {
  return sf.getImportDeclarations().some((d) => PICKERS_MODULE.test(d.getModuleSpecifierValue()) || LAB_MODULE.test(d.getModuleSpecifierValue()));
}

function transform(env, rel, text, isPickerFile) {
  const doc = new Doc(env, rel, text);
  if (isPickerFile) {
    [ruleD1, ruleD2, ruleD3, ruleD4, ruleD6, ruleD7, ruleR13, ruleC1, ruleD5, ruleC2, ruleC3, ruleActionBar, ruleC4, ruleC6].forEach((r) => r(doc));
  }
  ruleD8(doc);
  if (isPickerFile) ruleR1(doc);
  if (isPickerFile) { ruleM2(doc); ruleM4(doc); }
  ruleM3(doc);
  if (env.hasPickers) ruleM5(doc);
  return doc;
}

function conflictMessage(rel, text, err) {
  const line = text.slice(0, err.pos).split('\n').length;
  return rel + ':' + line + ' – ' + SCRIPT + ' produced two overlapping edits at the same place (a bug in the codemod). The file was not changed by step 2 – migrate it manually or report the bug';
}

function run(argv, overrides) {
  const deps = Object.assign({ fs: require('fs'), cwd: process.cwd(), env: process.env, platform: process.platform, cp: require('child_process'), runOfficial: null }, overrides || {});
  const opts = parseArgs(argv || []);
  const res = { script: SCRIPT, result: 'OK', changes: [], manual: [], blockers: [], notes: [], dryRun: opts.dryRun, filesChanged: [], config: null, report: null };
  const blocked = (m) => { res.result = 'BLOCKED'; res.blockers.push({ message: m }); return res; };
  if (opts.errors.length) return blocked(opts.errors.join('; '));

  // step 0 – before any file is touched
  let loaded;
  try { loaded = loadConfig(deps.fs, deps.cwd, opts.config); } catch (err) {
    if (err instanceof ConfigError) return blocked(err.message);
    throw err;
  }
  const cfg = loaded.config;

  let tsm;
  try { tsm = require('ts-morph'); } catch (_) {
    return blocked('ts-morph is not installed in the skill folder – run npm install in ' + path.join(__dirname, '..'));
  }
  N = tsm.Node;
  K = tsm.SyntaxKind;
  let files;
  try { files = listSourceFiles(deps.fs, deps.cwd); } catch (err) {
    if (err instanceof CodemodError) return blocked(err.message);
    throw err;
  }
  const project = new tsm.Project({
    useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, jsx: tsm.ts.JsxEmit.Preserve },
  });
  const sharedRel = cfg.rtlSxSharedPath;
  const read = (full) => {
    const raw = deps.fs.readFileSync(full, 'utf8');
    const bom = raw.charCodeAt(0) === 0xfeff ? '﻿' : '';
    return { bom: bom, text: bom ? raw.slice(1) : raw };
  };
  const parseQuick = (rel, text) => project.createSourceFile('/__probe/' + rel, text, { overwrite: true });

  const entries = [];
  for (const full of files) {
    const rel = toPosix(path.relative(deps.cwd, full));
    if (rel === sharedRel) continue;
    let f;
    try { f = read(full); } catch (err) { return blocked('Cannot read ' + rel + ': ' + err.message); }
    const maybe = f.text.indexOf('@mui/x-date-pickers') !== -1 || f.text.indexOf('@mui/lab') !== -1;
    const picker = maybe && importsPickers(parseQuick(rel, f.text));
    entries.push({ full: full, rel: rel, original: f.text, bom: f.bom, picker: picker });
  }
  const pickerEntries = entries.filter((e) => e.picker);

  // step 1 – official codemods
  const codemod = {};
  entries.forEach((e) => { codemod[e.rel] = { v6: 'skipped', v7: 'skipped', v8: 'skipped', v9: 'skipped' }; });
  const codemodFailures = [];
  if (pickerEntries.length && !opts.dryRun && !opts.skipOfficial) {
    const runner = deps.runOfficial || defaultOfficialRunner(deps);
    const r = runOfficial(runner, OFFICIAL, pickerEntries.map((e) => e.full));
    pickerEntries.forEach((e) => { Object.assign(codemod[e.rel], r.status[e.full]); });
    r.reasons.forEach((x) => {
      const rel = toPosix(path.relative(deps.cwd, x.file));
      codemodFailures.push({ file: rel, version: x.version, reason: x.reason });
    });
  } else if (pickerEntries.length) {
    res.notes.push('Official codemods skipped (' + (opts.dryRun ? '--dry-run' : '--skip-official-codemods') + ')');
  }
  const afterStep1 = {};
  for (const e of entries) {
    let t = e.original;
    if (e.picker && !opts.dryRun && !opts.skipOfficial) {
      try { t = read(e.full).text; } catch (err) { return blocked('Cannot read ' + e.rel + ': ' + err.message); }
    }
    afterStep1[e.rel] = t;
  }

  // R1.1 – inline or shared
  const countFiles = entries.filter((e) => e.picker).filter((e) => parseQuick(e.rel, afterStep1[e.rel]).getImportDeclarations()
    .some((d) => PICKERS_MODULE.test(d.getModuleSpecifierValue()) && (d.getNamedImports().some((s) => /Picker$/.test(s.getName())) ||
      (d.getDefaultImport() && /Picker$/.test(d.getModuleSpecifierValue().split('/').pop()))))).length;
  const rtlMode = cfg.rtlSxPlacement !== 'auto' ? cfg.rtlSxPlacement : countFiles > 1 ? 'shared' : 'inline';
  const projectAdapters = [];
  entries.forEach((e) => { if (afterStep1[e.rel].indexOf('LocalizationProvider') !== -1) projectAdapters.push.apply(projectAdapters, adaptersIn(parseQuick(e.rel, afterStep1[e.rel]))); });
  const env = { project: project, root: deps.cwd, config: cfg, rtlMode: rtlMode, projectAdapters: projectAdapters, hasPickers: pickerEntries.length > 0, needShared: false };

  // steps 2 + 3
  const reportFiles = [];
  for (const e of entries) {
    const text = afterStep1[e.rel];
    const relevant = e.picker || D8_STRINGS.some(([s]) => text.indexOf(s) !== -1) || /MuiPickersDay|MuiDateCalendar-root|MuiPickersArrowSwitcher/.test(text) ||
      (env.hasPickers && /Mui(TextField|OutlinedInput|InputBase|InputLabel|FormHelperText)\b/.test(text));
    if (!relevant) continue;
    let doc;
    try { doc = transform(env, e.rel, text, e.picker); } catch (err) {
      if (!(err instanceof EditConflict)) throw err;
      res.blockers.push({ file: e.rel, message: conflictMessage(e.rel, text, err) });
      continue;
    }
    const todos = collectTodos(doc.text);
    const applied = RULE_ORDER.filter((r) => doc.applied.has(r));
    const changedByOfficial = text !== e.original;
    if (changedByOfficial) res.changes.push({ file: e.rel, line: null, rule: 'codemod', confidence: 'auto', detail: 'official @mui/x-codemod pickers/preset-safe' });
    applied.forEach((r) => res.changes.push({ file: e.rel, line: null, rule: r, confidence: 'auto', detail: RULE_LABEL[r] || r }));
    if (doc.text !== e.original) {
      res.filesChanged.push(e.rel);
      if (!opts.dryRun && doc.text !== text) {
        try { deps.fs.writeFileSync(e.full, e.bom + doc.text, 'utf8'); } catch (err) { return blocked('Cannot write ' + e.rel + ': ' + err.message); }
      }
    }
    todos.forEach((t) => res.manual.push({ file: e.rel, line: t.line, reason: t.rule + ' ' + t.reason }));
    const failed = codemodFailures.filter((f) => f.file === e.rel);
    failed.forEach((f) => res.manual.push({ file: e.rel, line: null, reason: 'codemod-failed: ' + f.version + ' pickers/preset-safe – ' + f.reason }));
    if (!e.picker && !applied.length && !todos.length) continue;
    reportFiles.push({
      file: e.rel, codemod: codemod[e.rel], applied: applied,
      todos: todos.map((t) => ({ rule: t.rule, line: t.line, reason: t.reason })),
      status: todos.length || failed.length ? 'needs-review' : 'done',
    });
  }
  // a codemod failure on a file step 2 did not report on (e.g. no longer relevant)
  codemodFailures.filter((f) => !reportFiles.some((r) => r.file === f.file)).forEach((f) => {
    res.manual.push({ file: f.file, line: null, reason: 'codemod-failed: ' + f.version + ' pickers/preset-safe – ' + f.reason });
  });

  // the shared constants file (R1.1 shared)
  if (env.needShared) {
    const abs = path.join(deps.cwd, sharedRel);
    let exists = false;
    try { exists = deps.fs.statSync(abs).isFile(); } catch (_) { exists = false; }
    if (!exists) {
      res.changes.push({ file: sharedRel, line: null, rule: 'R1', confidence: 'auto', detail: 'pickersRtlSxSmall / pickersRtlSxMedium (shared)' });
      res.filesChanged.push(sharedRel);
      if (!opts.dryRun) {
        try {
          deps.fs.mkdirSync(path.dirname(abs), { recursive: true });
          deps.fs.writeFileSync(abs, RTL_SX_SOURCE + '\n', 'utf8');
        } catch (err) { return blocked('Cannot write ' + sharedRel + ': ' + err.message); }
      }
    }
  }

  const report = {
    config: { rtlSxPlacement: cfg.rtlSxPlacement, rtlSxPlacementResolved: rtlMode, rtlSxSharedPath: cfg.rtlSxSharedPath, invalidDateBehavior: cfg.invalidDateBehavior },
    configSource: loaded.source,
    files: reportFiles,
  };
  res.config = report.config;
  res.report = REPORT_FILE;
  res.reportWritten = false;
  // a run that changed nothing keeps the report of the run that did the migration
  const reportPath = path.join(deps.cwd, REPORT_FILE);
  let hadReport = false;
  try { hadReport = deps.fs.statSync(reportPath).isFile(); } catch (_) { hadReport = false; }
  if (reportFiles.length && !opts.dryRun && (res.filesChanged.length || !hadReport)) {
    try { deps.fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8'); res.reportWritten = true; } catch (err) {
      return blocked('Cannot write ' + REPORT_FILE + ': ' + err.message);
    }
  }
  res.reportData = report;

  if (res.blockers.length) res.result = 'BLOCKED';
  else if (!res.filesChanged.length) {
    res.result = 'NOOP';
    if (res.manual.length) res.notes.push(res.manual.length + ' MIGRATION-TODO item(s) remain from an earlier run – see ' + REPORT_FILE);
    res.manual = [];
  } else if (res.manual.length) res.result = 'REVIEW';
  if (res.filesChanged.length) {
    res.notes.push('Check every picker visually in 4 states – empty, focused (label floats up), with a date, with an error: date, label and ' +
      'error text aligned right, not over the icon, and the notch in the outline exactly under the label');
  }
  return res;
}

function formatText(res) {
  const L = [SCRIPT + (res.dryRun ? ' [dry-run]' : '')];
  res.blockers.forEach((b) => L.push('⛔ ' + b.message));
  if (res.config) L.push('⚙ rtlSxPlacement=' + res.config.rtlSxPlacement + ' → ' + res.config.rtlSxPlacementResolved + ', invalidDateBehavior=' + res.config.invalidDateBehavior);
  if (res.result !== 'BLOCKED' || res.changes.length || res.manual.length) {
    const byRule = {};
    res.changes.forEach((c) => { byRule[c.rule] = (byRule[c.rule] || 0) + 1; });
    L.push('📅 ' + res.filesChanged.length + ' files ' + (res.dryRun ? 'would change' : 'changed') +
      (Object.keys(byRule).length ? ' | ' + Object.keys(byRule).map((k) => k + ' ×' + byRule[k]).join(', ') : ''));
    res.manual.forEach((m) => L.push('✋ ' + m.file + (m.line ? ':' + m.line : '') + ' – ' + m.reason));
    res.notes.forEach((n) => L.push('ℹ ' + n));
    if (res.reportWritten) L.push('📄 ' + REPORT_FILE);
  }
  L.push('RESULT: ' + res.result);
  return L.join('\n') + '\n';
}

function main(argv, deps, io) {
  io = io || { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) };
  try {
    const opts = parseArgs(argv || []);
    const res = stubMode.annotate(run(argv, deps), stubMode.modeFor(deps));
    const out = Object.assign({}, res);
    delete out.reportData;
    io.stdout(opts.json ? JSON.stringify(out, null, 2) + '\n' : stubMode.banner(res) + formatText(res));
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

module.exports = { run: run, main: main, loadConfig: loadConfig, interpretOfficial: interpretOfficial, runOfficial: runOfficial, RTL_SX_SOURCE: RTL_SX_SOURCE };
