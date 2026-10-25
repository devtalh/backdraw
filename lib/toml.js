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
    if ((m = /^"((?:[^"\\]|\\.)*)"/.exec(s))) parts.push(JSON.parse(`"${m[1]}"`));
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

const startsWith = (parts, prefix) => prefix.every((p, i) => parts[i] === p);
const samePath = (a, b) => a.length === b.length && startsWith(a, b);

// One entry per line: its table header path ([a.b] or [[a.b]]) or null, and the table it is in.
// Lines inside a multi-line string are never headers.
function scan(lines) {
  let table = [];
  let inString = null;
  return lines.map(line => {
    const wasInString = inString;
    for (const q of ['"""', "'''"]) {
      if (inString && inString !== q) continue;
      if (line.split(q).length % 2 === 0) inString = inString ? null : q;
    }
    if (!wasInString) {
      const m = /^\s*\[\[?([^\[\]]+)\]\]?\s*(?:#.*)?$/.exec(line);
      const header = m && keyPath(m[1]);
      if (header) { table = header; return { header, table }; }
    }
    return { header: null, table, inString: !!wasInString };
  });
}

// Ranges [start, end) of the lines that belong to the table at `parts` or one of its sub-tables.
function tableRanges(info, parts) {
  const ranges = [];
  for (let i = 0; i < info.length; i++) {
    if (!info[i].header || !startsWith(info[i].header, parts)) continue;
    let end = i + 1;
    while (end < info.length && !(info[end].header && !startsWith(info[end].header, parts))) end++;
    ranges.push([i, end]);
    i = end - 1;
  }
  return ranges;
}

// The table (or a parent of it) written some other way, as dotted keys (a.b.key = …) or as an
// inline table (a = { b = … }), can't be edited line by line: a [a.b] header next to it would even
// make the file invalid.
function assertPlainTable(lines, info, parts) {
  lines.forEach((line, i) => {
    if (info[i].header || info[i].inString || startsWith(info[i].table, parts)) return;
    const m = /^\s*([^=#]+?)\s*=/.exec(line);
    const key = m && keyPath(m[1]);
    if (!key) return;
    const full = [...info[i].table, ...key];
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

// Removes `key = value` (a value may be an array over several lines) from lines[from..to); returns
// the index where it was, or -1.
function dropKey(lines, info, from, to, key) {
  for (let i = from; i < to; i++) {
    if (info[i].inString) continue;
    const m = /^\s*([^=#]+?)\s*=\s*(.*)$/.exec(lines[i]);
    const k = m && keyPath(m[1]);
    if (!k || k.length !== 1 || k[0] !== key) continue;
    let end = i + 1;
    let depth = bracketDepth(m[2]);
    while (depth > 0 && end < to) depth += bracketDepth(lines[end++]);
    lines.splice(i, end - i);
    info.splice(i, end - i);
    return i;
  }
  return -1;
}

// The text before a comment, and its open minus closed square brackets (strings skipped).
function code(text) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') return { text: text.slice(0, i).trimEnd(), depth };
    else if (c === '[') depth++;
    else if (c === ']') depth--;
  }
  return { text: text.trimEnd(), depth };
}

const bracketDepth = text => code(text).depth;

function splitLines(text) {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return { lines, eol };
}

const joinLines = (lines, eol) => (lines.length ? lines.join(eol) + eol : '');

// Sets `values` (key -> string/array/number/boolean) in the table at `parts`, creating the table at
// the end of the file if it isn't there. Other keys and sub-tables of the table stay as they are.
function setTable(text, parts, values) {
  const { lines, eol } = splitLines(text);
  const info = scan(lines);
  assertPlainTable(lines, info, parts);
  const own = tableRanges(info, parts).find(([start]) => samePath(info[start].header, parts));
  const assignments = Object.entries(values).map(([k, v]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k)} = ${tomlValue(v)}`);
  if (!own) {
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push(`[${parts.map(p => (/^[A-Za-z0-9_-]+$/.test(p) ? p : tomlString(p))).join('.')}]`, ...assignments);
    return joinLines(lines, eol);
  }
  const [start] = own;
  let end = start + 1;
  while (end < info.length && !info[end].header) end++;
  for (const key of Object.keys(values)) {
    if (dropKey(lines, info, start + 1, end, key) >= 0) {
      end = start + 1;
      while (end < info.length && !info[end].header) end++;
    }
  }
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
  const own = tableRanges(info, parts).find(([start]) => samePath(info[start].header, parts));
  if (!own) return null;
  const out = {};
  for (let i = own[0] + 1; i < lines.length && !info[i].header; i++) {
    if (info[i].inString) continue;
    const m = /^\s*([^=#]+?)\s*=\s*(.*)$/.exec(lines[i]);
    const key = m && keyPath(m[1]);
    if (!key || key.length !== 1) continue;
    let { text: raw, depth } = code(m[2]);
    while (depth > 0 && i + 1 < lines.length) {
      const next = code(lines[++i]);
      raw += ` ${next.text.trim()}`;
      depth += next.depth;
    }
    out[key[0]] = parseValue(raw.trim());
  }
  return out;
}

function parseString(s) {
  if (s.startsWith('"')) return JSON.parse(s);
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
