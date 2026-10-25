'use strict';
// Just enough TOML to keep one MCP server table up to date in Codex's config.toml without a parser
// dependency: find the [a.b] table (and its [a.b.*] sub-tables), set or replace a few single keys in
// it, or drop it, and leave every other line of the file exactly as it was. Forms this can't edit
// safely (the table written as dotted keys or as an inline table) are refused instead of guessed at.

// Splits a key path such as  mcp_servers . "backdraw"  into its parts; null if it isn't one.
function keyPath(text) {
  const parts = [];
  let s = text.trim();
  while (s) {
    let m;
    if ((m = /^"((?:[^"\\]|\\.)*)"/.exec(s))) parts.push(unescapeBasic(m[1]));
    else if ((m = /^'([^']*)'/.exec(s))) parts.push(m[1]);
    else if ((m = /^[A-Za-z0-9_-]+/.exec(s))) parts.push(m[0]);
    else return null;
    s = s.slice(m[0].length).trim();
    if (!s) break;
    if (s[0] !== '.') return null;
    s = s.slice(1).trim();
    if (!s) return null;
  }
  return parts.length ? parts : null;
}

// The escapes of a TOML basic string ("…").
function unescapeBasic(body) {
  const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
  return body.replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/g, (all, e) => {
    if (e.length > 1) return String.fromCodePoint(parseInt(e.slice(1), 16));
    return e in simple ? simple[e] : all;
  });
}

const startsWith = (parts, prefix) => prefix.every((p, i) => parts[i] === p);
const samePath = (a, b) => a.length === b.length && startsWith(a, b);

// Reads one line from `state` ({ ml: open multi-line string quote or null, depth: open [ and { of a
// value }), skipping strings and comments. Returns the state at the end of the line and the text
// before any comment.
function tokenize(line, state) {
  let { ml, depth } = state;
  let i = 0;
  let codeEnd = line.length;
  while (i < line.length) {
    if (ml) {
      if (ml === '"""' && line[i] === '\\') { i += 2; continue; }
      if (line.startsWith(ml, i)) {
        i += 3;
        while (line[i] === ml[0]) i++; // up to two quotes may end the content
        ml = null;
        continue;
      }
      i++;
      continue;
    }
    const c = line[i];
    if (c === '#') { codeEnd = i; break; }
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) { ml = line.slice(i, i + 3); i += 3; continue; }
    if (c === '"' || c === "'") {
      i++;
      while (i < line.length && line[i] !== c) i += c === '"' && line[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth = Math.max(0, depth - 1);
    i++;
  }
  return { state: { ml, depth }, code: line.slice(0, codeEnd).trimEnd() };
}

// One entry per line:
//   header  its table path, when the line is a [a.b] or [[a.b]] header
//   table   the table the line is in
//   cont    the line continues a value from the line before (a multi-line string or array)
//   blank / comment  nothing but whitespace / only a comment
function scan(lines) {
  let table = [];
  let state = { ml: null, depth: 0 };
  return lines.map(line => {
    const cont = !!state.ml || state.depth > 0;
    if (!cont) {
      const m = /^\s*\[\[?([^\[\]]+)\]\]?\s*(?:#.*)?$/.exec(line);
      const header = m && keyPath(m[1]);
      if (header) { table = header; return { header, table, cont: false }; }
    }
    const t = tokenize(line, state);
    state = t.state;
    return { header: null, table, cont, blank: !cont && !line.trim(), comment: !cont && /^\s*#/.test(line) };
  });
}

// Ranges [start, end) of the lines that belong to the table at `parts` or one of its sub-tables.
// Comments and blank lines right before the next header belong to that next table.
function tableRanges(info, parts) {
  const ranges = [];
  for (let i = 0; i < info.length; i++) {
    if (!info[i].header || !startsWith(info[i].header, parts)) continue;
    let end = i + 1;
    while (end < info.length && !(info[end].header && !startsWith(info[end].header, parts))) end++;
    let last = end;
    if (end < info.length) while (last > i + 1 && (info[last - 1].blank || info[last - 1].comment)) last--;
    ranges.push([i, last]);
    i = end - 1;
  }
  return ranges;
}

// The key path and value text of a `key = value` line, or null.
function assignment(line) {
  const m = /^\s*((?:"(?:[^"\\]|\\.)*"|'[^']*'|[^=#"'])+?)\s*=\s*(.*)$/.exec(line);
  const key = m && keyPath(m[1]);
  return key ? { key, value: m[2] } : null;
}

// The table (or a parent of it) written some other way, as dotted keys (a.b.key = …) or as an
// inline table (a = { b = … }), can't be edited line by line: a [a.b] header next to it would even
// make the file invalid.
function assertPlainTable(lines, info, parts) {
  lines.forEach((line, i) => {
    if (info[i].header || info[i].cont || startsWith(info[i].table, parts)) return;
    const a = assignment(line);
    if (!a) return;
    const full = [...info[i].table, ...a.key];
    if (startsWith(full, parts) || startsWith(parts, full)) {
      throw new Error(`${parts.join('.')} is written in a form Backdraw doesn't edit (line ${i + 1}); change it by hand`);
    }
  });
}

const tomlString = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function tomlValue(v) {
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(', ')}]`;
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  return tomlString(v);
}

// The line after a key's value (a value may go on over continuation lines).
function valueEnd(info, i) {
  let end = i + 1;
  while (end < info.length && info[end].cont) end++;
  return end;
}

// Removes `key = value` from the table's own lines starting at `from`; returns whether it was there.
function dropKey(lines, info, from, key) {
  for (let i = from; i < lines.length && !info[i].header; i++) {
    if (info[i].cont) continue;
    const a = assignment(lines[i]);
    if (!a || a.key.length !== 1 || a.key[0] !== key) continue;
    const end = valueEnd(info, i);
    lines.splice(i, end - i);
    info.splice(i, end - i);
    return true;
  }
  return false;
}

function splitLines(text) {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return { lines, eol };
}

const joinLines = (lines, eol) => (lines.length ? lines.join(eol) + eol : '');

const ownTable = (info, parts) => tableRanges(info, parts).find(([start]) => samePath(info[start].header, parts));

// Sets `values` (key -> string/array/number/boolean) in the table at `parts`, creating the table at
// the end of the file if it isn't there. Other keys and sub-tables of the table stay as they are.
function setTable(text, parts, values) {
  const { lines, eol } = splitLines(text);
  const info = scan(lines);
  assertPlainTable(lines, info, parts);
  const own = ownTable(info, parts);
  const assignments = Object.entries(values).map(([k, v]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k)} = ${tomlValue(v)}`);
  if (!own) {
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push(`[${parts.map(p => (/^[A-Za-z0-9_-]+$/.test(p) ? p : tomlString(p))).join('.')}]`, ...assignments);
    return joinLines(lines, eol);
  }
  const [start] = own;
  for (const key of Object.keys(values)) dropKey(lines, info, start + 1, key);
  lines.splice(start + 1, 0, ...assignments);
  return joinLines(lines, eol);
}

// Drops the table at `parts` with its sub-tables (and the blank lines left in front of it).
function removeTable(text, parts) {
  const { lines, eol } = splitLines(text);
  const info = scan(lines);
  assertPlainTable(lines, info, parts);
  for (const [start, end] of tableRanges(info, parts).reverse()) {
    let from = start;
    while (from > 0 && lines[from - 1].trim() === '') from--;
    lines.splice(from, end - from);
    while (from < lines.length && lines[from].trim() === '') lines.splice(from, 1);
    if (from > 0 && from < lines.length) lines.splice(from, 0, '');
  }
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return joinLines(lines, eol);
}

// Reads the plain string / array-of-strings values of the table at `parts`, or null without it.
// Only what Backdraw itself writes is understood; other values come back as their raw text.
function readTable(text, parts) {
  const { lines } = splitLines(text);
  const info = scan(lines);
  const own = ownTable(info, parts);
  if (!own) return null;
  const out = {};
  for (let i = own[0] + 1; i < lines.length && !info[i].header; i++) {
    if (info[i].cont) continue;
    const a = assignment(lines[i]);
    if (!a || a.key.length !== 1) continue;
    const end = valueEnd(info, i);
    let state = { ml: null, depth: 0 };
    const parts2 = [];
    for (const l of [a.value, ...lines.slice(i + 1, end)]) {
      const t = tokenize(l, state);
      state = t.state;
      parts2.push(t.code.trim());
    }
    out[a.key[0]] = parseValue(parts2.join(' ').trim());
  }
  return out;
}

function parseString(s) {
  if (s.startsWith('"')) return unescapeBasic(s.slice(1, -1));
  if (s.startsWith("'")) return s.slice(1, -1);
  return s;
}

function parseValue(raw) {
  if (/^("(?:[^"\\]|\\.)*"|'[^']*')$/.test(raw)) return parseString(raw);
  const arr = /^\[(.*)\]$/s.exec(raw);
  if (arr) {
    const items = arr[1].match(/"(?:[^"\\]|\\.)*"|'[^']*'/g) || [];
    return items.map(parseString);
  }
  return raw;
}

module.exports = { keyPath, setTable, removeTable, readTable };
