'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { keyPath, setTable, removeTable, readTable } = require('../lib/toml');

const P = ['mcp_servers', 'backdraw'];
const V = { command: String.raw`C:\Program Files\nodejs\node.exe`, args: [String.raw`C:\Users\you\.backdraw\mcp-server.js`] };
const BLOCK = String.raw`[mcp_servers.backdraw]
command = "C:\\Program Files\\nodejs\\node.exe"
args = ["C:\\Users\\you\\.backdraw\\mcp-server.js"]
`;

test('keyPath splits bare, quoted and spaced keys', () => {
  assert.deepEqual(keyPath('mcp_servers.backdraw'), ['mcp_servers', 'backdraw']);
  assert.deepEqual(keyPath(' mcp_servers . "backdraw" '), ['mcp_servers', 'backdraw']);
  assert.deepEqual(keyPath("a.'b.c'"), ['a', 'b.c']);
  assert.equal(keyPath('a..b'), null);
  assert.equal(keyPath('a b'), null);
});

test('setTable: an empty file gets just the table, with escaped Windows paths', () => {
  assert.equal(setTable('', P, V), BLOCK);
});

test('setTable: appends after the other servers, and a second run changes nothing', () => {
  const before = 'model = "gpt-5"\n\n[mcp_servers.context7]\ncommand = "npx"\nargs = ["-y", "@upstash/context7-mcp"]\n';
  const after = setTable(before, P, V);
  assert.equal(after, `${before}\n${BLOCK}`);
  assert.equal(setTable(after, P, V), after);
  assert.deepEqual(readTable(after, P), V);
  assert.deepEqual(readTable(after, ['mcp_servers', 'context7']), { command: 'npx', args: ['-y', '@upstash/context7-mcp'] });
});

test('setTable: replaces command and args (also a multi-line array), keeps other keys, comments and sub-tables', () => {
  const before = '[mcp_servers.backdraw]\n# mine\nstartup_timeout_sec = 30\nargs = [\n  "old.js", # old\n]\ncommand = "node"\n\n[mcp_servers.backdraw.env]\nX = "1"\n\n[other]\nk = 1\n';
  const after = setTable(before, P, V);
  assert.equal(after, `${BLOCK}# mine\nstartup_timeout_sec = 30\n\n[mcp_servers.backdraw.env]\nX = "1"\n\n[other]\nk = 1\n`);
  assert.equal(setTable(after, P, V), after);
});

test('setTable: keeps CRLF line endings and a header with a quoted key', () => {
  const before = '[mcp_servers."backdraw"]\r\ncommand = "old"\r\n';
  assert.equal(setTable(before, P, V), `[mcp_servers."backdraw"]\r\n${BLOCK.split('\n').slice(1).join('\r\n')}`);
});

test('setTable: a header inside a multi-line string is not a table', () => {
  const before = 'note = """\n[mcp_servers.backdraw]\n"""\n';
  assert.equal(setTable(before, P, V), `${before}\n${BLOCK}`);
});

test('setTable and removeTable refuse dotted keys and inline tables instead of guessing', () => {
  for (const text of [
    'mcp_servers.backdraw.command = "x"\n',
    '[mcp_servers]\nbackdraw = { command = "x" }\n',
    '[mcp_servers]\nbackdraw.command = "x"\n',
    'mcp_servers = { other = { command = "x" } }\n',
  ]) {
    assert.throws(() => setTable(text, P, V), /form Backdraw doesn't edit/, text);
    assert.throws(() => removeTable(text, P), /form Backdraw doesn't edit/, text);
  }
});

test('removeTable: drops the table and its sub-tables, leaves the rest as it was', () => {
  const rest = 'model = "gpt-5"\n\n[mcp_servers.context7]\ncommand = "npx"\n';
  assert.equal(removeTable(`${rest}\n${BLOCK}`, P), rest);
  assert.equal(removeTable(`${BLOCK}\n[mcp_servers.backdraw.env]\nX = "1"\n\n[other]\nk = 1\n`, P), '[other]\nk = 1\n');
  assert.equal(removeTable(`${rest}\n${BLOCK}\n[other]\nk = 1\n`, P), `${rest}\n[other]\nk = 1\n`);
  assert.equal(removeTable(rest, P), rest);
});

test('readTable: literal strings, comments, and null without the table', () => {
  assert.deepEqual(readTable("[mcp_servers.backdraw]\ncommand = 'node' # comment\nargs = ['C:\\x\\mcp-server.js']\n", P),
    { command: 'node', args: ['C:\\x\\mcp-server.js'] });
  assert.equal(readTable('[mcp_servers.other]\ncommand = "x"\n', P), null);
});
