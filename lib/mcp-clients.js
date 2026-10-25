'use strict';
// The MCP clients `backdraw setup` can add Backdraw to by editing their config file, in the formats
// of their official docs (the same as the README's manual setup). Claude Code and the Claude desktop
// app are handled in install.js. Every change to an existing file is preceded by a timestamped .bak
// copy; only the "backdraw" entry is added, updated or removed, everything else stays as it was.
// env: { home, appData, which(cmd) -> path or null }
const fs = require('fs');
const path = require('path');
const toml = require('./toml');

const NAME = 'backdraw';

const exists = p => { try { return fs.existsSync(p); } catch { return false; } };

const FILE_CLIENTS = [
  {
    id: 'codex', label: 'Codex', format: 'toml',
    file: env => path.join(env.home, '.codex', 'config.toml'),
    detect: env => exists(path.join(env.home, '.codex')) || !!env.which('codex'),
    entry: (node, server) => ({ command: node, args: [server] }),
  },
  {
    id: 'cursor', label: 'Cursor', format: 'json', key: 'mcpServers',
    file: env => path.join(env.home, '.cursor', 'mcp.json'),
    detect: env => exists(path.join(env.home, '.cursor')),
    entry: (node, server) => ({ type: 'stdio', command: node, args: [server] }),
  },
  {
    id: 'vscode', label: 'VS Code', format: 'json', key: 'servers',
    file: env => path.join(env.appData, 'Code', 'User', 'mcp.json'),
    detect: env => exists(path.join(env.appData, 'Code', 'User')),
    entry: (node, server) => ({ type: 'stdio', command: node, args: [server] }),
  },
  {
    id: 'gemini', label: 'Gemini CLI', format: 'json', key: 'mcpServers',
    file: env => path.join(env.home, '.gemini', 'settings.json'),
    detect: env => exists(path.join(env.home, '.gemini')) || !!env.which('gemini'),
    entry: (node, server) => ({ command: node, args: [server] }),
  },
];

const byId = id => FILE_CLIENTS.find(c => c.id === id);

function backupFile(file, now = new Date()) {
  const backup = `${file}.${now.toISOString().replace(/[:.]/g, '-')}.bak`;
  fs.copyFileSync(file, backup);
  return backup;
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// JSON with comments and trailing commas (VS Code's and Gemini CLI's files allow both) as plain JSON.
// Both are only looked for outside strings.
function stripJsonc(text) {
  const pass = (src, onChar) => {
    let out = '';
    for (let i = 0; i < src.length; i++) {
      if (src[i] === '"') {
        let j = i + 1;
        while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
        out += src.slice(i, j + 1);
        i = j;
      } else {
        const r = onChar(src, i);
        out += r.text;
        i = r.next;
      }
    }
    return out;
  };
  const noComments = pass(text, (s, i) => {
    if (s[i] === '/' && s[i + 1] === '/') {
      let j = i;
      while (j < s.length && s[j] !== '\n') j++;
      return { text: '\n', next: j };
    }
    if (s[i] === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      return { text: '', next: end < 0 ? s.length : end + 1 };
    }
    return { text: s[i], next: i };
  });
  return pass(noComments, (s, i) => ({ text: s[i] === ',' && /^\s*[}\]]/.test(s.slice(i + 1)) ? '' : s[i], next: i }));
}

// The parsed JSON config ({} for a missing or empty file). Throws, without touching the file, when it
// isn't a JSON object. Comments are read (tolerant: doctor and uninstall's listing), but a file with
// comments is never rewritten (strict: add/remove), since Backdraw would drop them.
function readJsonConfig(file, { tolerant = false } = {}) {
  if (!exists(file)) return {};
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  if (!text.trim()) return {};
  let json;
  try { json = JSON.parse(text); } catch {
    let commented = false;
    try { json = JSON.parse(stripJsonc(text)); commented = true; } catch {}
    if (!commented) throw new Error(`${file} is not valid JSON, so it was left alone; fix it or add Backdraw by hand (see the README)`);
    if (!tolerant) throw new Error(`${file} has comments, so it was left alone (Backdraw would remove them); add Backdraw by hand (see the README)`);
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error(`${file} does not hold a JSON object, so it was left alone`);
  return json;
}

function servers(json, key, file) {
  const s = json[key];
  if (s === undefined) return {};
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error(`"${key}" in ${file} is not an object, so the file was left alone`);
  return s;
}

function writeText(file, text, existed, now) {
  const backup = existed ? backupFile(file, now) : null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return backup;
}

// The Backdraw entry a client's config has now: { file, entry } (entry null without one). Throws on a
// file it can't read.
function readEntry(client, env) {
  const file = client.file(env);
  if (client.format === 'toml') {
    return { file, entry: exists(file) ? toml.readTable(fs.readFileSync(file, 'utf8'), ['mcp_servers', NAME]) : null };
  }
  return { file, entry: servers(readJsonConfig(file, { tolerant: true }), client.key, file)[NAME] || null };
}

// Adds or updates the entry. Returns { status: 'added' | 'updated' | 'unchanged', file, backup }.
function addEntry(client, env, node, server, now = new Date()) {
  const file = client.file(env);
  const existed = exists(file);
  const entry = client.entry(node, server);
  if (client.format === 'toml') {
    const before = existed ? fs.readFileSync(file, 'utf8') : '';
    const had = toml.readTable(before, ['mcp_servers', NAME]);
    const after = toml.setTable(before, ['mcp_servers', NAME], entry);
    if (after === before) return { status: 'unchanged', file, backup: null };
    return { status: had ? 'updated' : 'added', file, backup: writeText(file, after, existed, now) };
  }
  const json = readJsonConfig(file);
  const list = servers(json, client.key, file);
  const old = list[NAME];
  const next = { ...(old && typeof old === 'object' ? old : {}), ...entry };
  if (old && sameJson(old, next)) return { status: 'unchanged', file, backup: null };
  json[client.key] = { ...list, [NAME]: next };
  return { status: old ? 'updated' : 'added', file, backup: writeText(file, `${JSON.stringify(json, null, 2)}\n`, existed, now) };
}

// Removes the entry. Returns { status: 'removed' | 'absent', file, backup }.
function removeEntry(client, env, now = new Date()) {
  const file = client.file(env);
  if (!exists(file)) return { status: 'absent', file, backup: null };
  if (client.format === 'toml') {
    const before = fs.readFileSync(file, 'utf8');
    if (!toml.readTable(before, ['mcp_servers', NAME])) return { status: 'absent', file, backup: null };
    return { status: 'removed', file, backup: writeText(file, toml.removeTable(before, ['mcp_servers', NAME]), true, now) };
  }
  const json = readJsonConfig(file);
  const list = servers(json, client.key, file);
  if (!(NAME in list)) return { status: 'absent', file, backup: null };
  const { [NAME]: _gone, ...rest } = list;
  json[client.key] = rest;
  return { status: 'removed', file, backup: writeText(file, `${JSON.stringify(json, null, 2)}\n`, true, now) };
}

// Whether an entry starts this install's server: the right script, and a command that exists
// ("node" on PATH counts). Returns null when it does, or what is wrong.
function entryProblem(entry, server, commandExists) {
  if (!entry) return 'no Backdraw entry';
  const args = Array.isArray(entry.args) ? entry.args : [];
  if (!args.some(a => typeof a === 'string' && path.resolve(a).toLowerCase() === path.resolve(server).toLowerCase())) {
    return `points to ${args.find(a => /mcp-server\.js$/i.test(String(a))) || 'another script'}, not ${server}`;
  }
  if (typeof entry.command !== 'string' || !commandExists(entry.command)) return `its command ${entry.command || '(none)'} was not found`;
  return null;
}

module.exports = { NAME, FILE_CLIENTS, byId, backupFile, stripJsonc, readJsonConfig, readEntry, addEntry, removeEntry, entryProblem };
