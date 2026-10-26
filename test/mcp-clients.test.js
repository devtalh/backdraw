'use strict';
// Every client config writer on temporary files: a missing or empty file, a file with other
// servers, broken JSON, and running twice.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const clients = require('../lib/mcp-clients');

const NODE = String.raw`C:\Program Files\nodejs\node.exe`;
const SERVER = String.raw`C:\Users\you\.backdraw\mcp-server.js`;

function env() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'backdraw-clients-'));
  test.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, appData: path.join(home, 'AppData', 'Roaming'), which: () => null };
}

const backups = file => (fs.existsSync(path.dirname(file)) ? fs.readdirSync(path.dirname(file)).filter(f => f.endsWith('.bak')) : []);
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

const EXPECTED = {
  codex: { command: NODE, args: [SERVER] },
  cursor: { type: 'stdio', command: NODE, args: [SERVER] },
  vscode: { type: 'stdio', command: NODE, args: [SERVER] },
  gemini: { command: NODE, args: [SERVER] },
};

test('config file locations follow each client\'s docs', () => {
  const e = { home: 'C:\\Users\\you', appData: 'C:\\Users\\you\\AppData\\Roaming', which: () => null };
  assert.deepEqual(Object.fromEntries(clients.FILE_CLIENTS.map(c => [c.id, c.file(e)])), {
    codex: path.join('C:\\Users\\you', '.codex', 'config.toml'),
    cursor: path.join('C:\\Users\\you', '.cursor', 'mcp.json'),
    vscode: path.join('C:\\Users\\you\\AppData\\Roaming', 'Code', 'User', 'mcp.json'),
    gemini: path.join('C:\\Users\\you', '.gemini', 'settings.json'),
  });
  assert.deepEqual(clients.FILE_CLIENTS.filter(c => c.format === 'json').map(c => [c.id, c.key]),
    [['cursor', 'mcpServers'], ['vscode', 'servers'], ['gemini', 'mcpServers']]);
});

test('detection: a client counts when its folder is there (or its CLI is on PATH)', () => {
  const e = env();
  assert.deepEqual(clients.FILE_CLIENTS.filter(c => c.detect(e)).map(c => c.id), []);
  fs.mkdirSync(path.join(e.home, '.cursor'));
  fs.mkdirSync(path.join(e.appData, 'Code', 'User'), { recursive: true });
  assert.deepEqual(clients.FILE_CLIENTS.filter(c => c.detect(e)).map(c => c.id), ['cursor', 'vscode']);
  const withCli = { ...e, which: cmd => (cmd === 'gemini' || cmd === 'codex' ? `C:\\bin\\${cmd}.cmd` : null) };
  assert.deepEqual(clients.FILE_CLIENTS.filter(c => c.detect(withCli)).map(c => c.id), ['codex', 'cursor', 'vscode', 'gemini']);
});

for (const client of clients.FILE_CLIENTS) {
  test(`${client.id}: a missing file is created with only Backdraw; a second run changes nothing`, () => {
    const e = env();
    const r = clients.addEntry(client, e, NODE, SERVER);
    assert.equal(r.status, 'added');
    assert.equal(r.backup, null);
    assert.deepEqual(clients.readEntry(client, e).entry, EXPECTED[client.id]);
    const text = fs.readFileSync(r.file, 'utf8');
    assert.deepEqual(clients.addEntry(client, e, NODE, SERVER), { status: 'unchanged', file: r.file, backup: null });
    assert.equal(fs.readFileSync(r.file, 'utf8'), text);
    assert.equal(backups(r.file).length, 0);
  });

  test(`${client.id}: other servers and settings are kept, a backup is made, an old path is updated`, () => {
    const e = env();
    const file = client.file(e);
    const original = client.format === 'toml'
      ? 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "npx"\nargs = ["other"]\n'
      : `${JSON.stringify({ theme: 'dark', [client.key]: { other: { command: 'npx', args: ['other'] } } }, null, 2)}\n`;
    write(file, original);
    const r = clients.addEntry(client, e, NODE, SERVER);
    assert.equal(r.status, 'added');
    assert.equal(fs.readFileSync(r.backup, 'utf8'), original);
    if (client.format === 'toml') {
      assert.equal(fs.readFileSync(file, 'utf8').startsWith(original), true);
    } else {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(json.theme, 'dark');
      assert.deepEqual(Object.keys(json[client.key]), ['other', 'backdraw']);
    }
    const moved = String.raw`D:\elsewhere\mcp-server.js`;
    assert.equal(clients.addEntry(client, e, NODE, moved, new Date(Date.now() + 1000)).status, 'updated');
    assert.deepEqual(clients.readEntry(client, e).entry.args, [moved]);
    assert.equal(backups(file).length, 2);
  });

  test(`${client.id}: remove drops only Backdraw (with a backup); absent when there is none`, () => {
    const e = env();
    const file = client.file(e);
    assert.equal(clients.removeEntry(client, e).status, 'absent');
    write(file, client.format === 'toml' ? '[mcp_servers.other]\ncommand = "npx"\n' : JSON.stringify({ [client.key]: { other: { command: 'npx' } } }));
    clients.addEntry(client, e, NODE, SERVER);
    const r = clients.removeEntry(client, e, new Date(Date.now() + 1000));
    assert.equal(r.status, 'removed');
    assert.ok(fs.existsSync(r.backup));
    assert.equal(clients.readEntry(client, e).entry, null);
    if (client.format === 'toml') assert.equal(fs.readFileSync(file, 'utf8'), '[mcp_servers.other]\ncommand = "npx"\n');
    else assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8'))[client.key], { other: { command: 'npx' } });
    assert.equal(clients.removeEntry(client, e).status, 'absent');
  });
}

for (const client of clients.FILE_CLIENTS.filter(c => c.format === 'json')) {
  test(`${client.id}: broken JSON or JSON with comments is left untouched`, () => {
    const e = env();
    const file = client.file(e);
    for (const text of ['{ "servers": { } ', '{\n  // my servers\n  "mcpServers": {}\n}\n', '[]', `{ "${client.key}": [] }`]) {
      write(file, text);
      assert.throws(() => clients.addEntry(client, e, NODE, SERVER), /left alone/);
      assert.throws(() => clients.removeEntry(client, e), /left alone/);
      assert.equal(fs.readFileSync(file, 'utf8'), text);
    }
    assert.equal(backups(file).length, 0);
  });

  test(`${client.id}: an empty file or one with a BOM is read; extra keys of the entry are kept`, () => {
    const e = env();
    const file = client.file(e);
    write(file, '');
    assert.equal(clients.addEntry(client, e, NODE, SERVER).status, 'added');
    write(file, `\uFEFF${JSON.stringify({ [client.key]: { backdraw: { command: 'node', args: ['old.js'], env: { A: '1' } } } })}`);
    assert.equal(clients.addEntry(client, e, NODE, SERVER).status, 'updated');
    assert.deepEqual(clients.readEntry(client, e).entry, { ...EXPECTED[client.id], env: { A: '1' }, command: NODE });
  });
}

test('codex: a config.toml form Backdraw can\'t edit safely is left untouched', () => {
  const e = env();
  const client = clients.byId('codex');
  const text = '[mcp_servers]\nbackdraw = { command = "node", args = ["x.js"] }\n';
  write(client.file(e), text);
  assert.throws(() => clients.addEntry(client, e, NODE, SERVER), /form Backdraw doesn't edit/);
  assert.equal(fs.readFileSync(client.file(e), 'utf8'), text);
});

// The README's "Install from your client" entries, as Cursor, VS Code, Codex and Gemini CLI keep them.
test('npxSpec: npx and cmd /c npx entries, latest or pinned; anything else is not one', () => {
  const npx = (command, ...args) => clients.npxSpec({ command, args });
  assert.equal(npx('npx', 'backdraw@latest', 'mcp'), 'backdraw@latest');
  assert.equal(npx('cmd', '/c', 'npx', '-y', 'backdraw@latest', 'mcp'), 'backdraw@latest');
  assert.equal(npx('cmd.exe', '/d', '/C', 'npx.cmd', '--yes', 'backdraw@2.1.2', 'mcp'), 'backdraw@2.1.2');
  assert.equal(npx(String.raw`C:\Program Files\nodejs\npx.cmd`, '-y', 'backdraw@2.2.0-beta.1', 'mcp'), 'backdraw@2.2.0-beta.1');
  assert.equal(npx('npx', '-y', 'backdraw', 'mcp'), 'backdraw');
  for (const args of [['backdraw@latest'], ['backdraw@latest', 'setup'], ['backdraw@latest', 'mcp', 'extra'], ['backdraw@2.1', 'mcp'],
    ['backdrawx@latest', 'mcp'], ['other-server', 'mcp'], ['-y']]) assert.equal(npx('npx', ...args), null, args.join(' '));
  assert.equal(npx('cmd', 'npx', 'backdraw@latest', 'mcp'), null); // no /c
  assert.equal(npx('cmd', '/k', 'x', '/c', 'npx', 'backdraw@latest', 'mcp'), null);
  assert.equal(npx(NODE, SERVER), null);
  assert.equal(clients.npxSpec(null), null);
  assert.equal(clients.npxSpec({ args: ['npx'] }), null);
});

test('checkEntry: npx is fine and never fixable; only a local entry that cannot work is', () => {
  const opts = { commandExists: () => true, fileExists: p => !/gone/i.test(p), staleDirs: [String.raw`C:\Users\you\.claude\chatgpt-image-bridge`] };
  const check = (entry, o = opts) => clients.checkEntry(entry, SERVER, o);
  assert.deepEqual(check({ command: 'cmd', args: ['/c', 'npx', '-y', 'backdraw@latest', 'mcp'] }),
    { kind: 'npx', spec: 'backdraw@latest', problem: null, fixable: false });
  assert.deepEqual(check({ command: 'npx', args: ['backdraw@2.1.1', 'mcp'] }, { ...opts, commandExists: () => false }),
    { kind: 'npx', spec: 'backdraw@2.1.1', problem: 'its command npx was not found', fixable: false });
  assert.deepEqual(check({ command: NODE, args: [SERVER] }), { kind: 'local', script: SERVER, problem: null, fixable: false });
  assert.equal(check({ command: NODE, args: [SERVER.toLowerCase()] }).problem, null);
  const gone = String.raw`C:\gone\mcp-server.js`;
  assert.deepEqual(check({ command: NODE, args: [gone] }), { kind: 'local', script: gone, problem: `points to ${gone}, which does not exist`, fixable: true });
  const legacy = check({ command: 'node', args: [String.raw`C:\Users\you\.claude\chatgpt-image-bridge\mcp-server.js`] });
  assert.equal(legacy.fixable, true);
  assert.match(legacy.problem, /points to the old install/);
  const noNode = check({ command: String.raw`C:\gone\node.exe`, args: [SERVER] }, { ...opts, commandExists: () => false });
  assert.deepEqual([noNode.problem, noNode.fixable], [String.raw`its command C:\gone\node.exe was not found`, true]);
  // Another working copy (e.g. a source checkout) is reported, not rewritten.
  const other = check({ command: NODE, args: [String.raw`D:\src\backdraw\mcp-server.js`] });
  assert.deepEqual([other.kind, other.fixable], ['local', false]);
  assert.match(other.problem, /starts another copy of Backdraw \(D:\\src\\backdraw\\mcp-server\.js\)/);
  assert.deepEqual(check({ command: 'uvx', args: ['something'] }), { kind: 'unknown', problem: 'it does not start a Backdraw mcp-server.js', fixable: false });
});

test('stripJsonc: comments and trailing commas go, strings with // and /* stay', () => {
  const text = '{\n  // servers\n  "a": "http://x/*y*/", /* note */\n  "b": [1, 2,],\n}\n';
  assert.deepEqual(JSON.parse(clients.stripJsonc(text)), { a: 'http://x/*y*/', b: [1, 2] });
});

test('a JSON file with comments is read (doctor sees the entry) but never rewritten', () => {
  const e = env();
  const client = clients.byId('vscode');
  const text = '{\n  // mine\n  "servers": { "backdraw": { "type": "stdio", "command": "node", "args": ["x.js"] }, },\n}\n';
  write(client.file(e), text);
  assert.deepEqual(clients.readEntry(client, e).entry, { type: 'stdio', command: 'node', args: ['x.js'] });
  assert.throws(() => clients.addEntry(client, e, NODE, SERVER), /has comments, so it was left alone/);
  assert.throws(() => clients.removeEntry(client, e), /has comments/);
  assert.equal(fs.readFileSync(client.file(e), 'utf8'), text);
});

test('stripJsonc: a comma before } or ] inside a string stays', () => {
  assert.deepEqual(JSON.parse(clients.stripJsonc('{ "a": "x,}", "b": "y, ]", }')), { a: 'x,}', b: 'y, ]' });
});
