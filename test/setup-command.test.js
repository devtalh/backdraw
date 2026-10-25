'use strict';
// backdraw setup on a temporary home folder with a fake platform and a fake bridge: client choice,
// the client configs, the extension step and the wait for it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const win32 = require('../platform/win32');
const mcpClients = require('../lib/mcp-clients');
const { setup, parseChoice, parseClientList, CLIENT_IDS } = require('../setup');

function system({ desktopRunning = false, connectAfter = 1, reloaded = false, cli = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'backdraw-setup-'));
  test.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const appData = path.join(home, 'AppData', 'Roaming');
  const events = [];
  const desktopFile = path.join(appData, 'Claude', 'claude_desktop_config.json');
  const platform = {
    installDir: h => win32.installDir(h), legacyInstallDir: h => win32.legacyInstallDir(h), claudeConfigFile: h => win32.claudeConfigFile(h),
    writeHostLauncher: (dir, node) => win32.writeHostLauncher(dir, node),
    registerNativeHost: (name, manifest, key) => { events.push(['register', key]); return key; },
    unregisterNativeHost: () => {}, nativeHostEntry: (n, k) => k,
    detectBrowsers: () => ['chrome'], appDataDir: () => appData, which: () => null,
    picturesDir: () => path.join(home, 'Pictures'), claudeCli: () => null,
    desktopConfigFiles: () => (fs.existsSync(desktopFile) ? [desktopFile] : []),
    desktopAppRunning: () => desktopRunning,
    openFolder: dir => events.push(['openFolder', dir]),
    copyToClipboard: text => { events.push(['clipboard', text]); return true; },
    openInBrowser: (b, url) => { events.push(['open', b, url]); return true; },
  };
  const claudeAdds = [];
  const claudeCli = cli ? args => { if (args[1] === 'add-json') claudeAdds.push(args[2]); else throw new Error('No MCP server found'); } : null;
  let polls = 0;
  const call = async method => {
    assert.equal(method, 'status');
    if (++polls < connectAfter) throw Object.assign(new Error('not running'), { code: 'NOT_RUNNING' });
    return { hostVersion: '2.1.0', extension: { version: '2.1.0' }, project: null };
  };
  const out = [];
  const deps = {
    ctx: { platform, home, claudeCli, reload: async () => reloaded }, call, log: t => out.push(t), color: false,
    waitMs: 300, intervalMs: 5, reloadWaitMs: 50,
  };
  return { home, appData, desktopFile, events, claudeAdds, deps, out, text: () => out.join('\n'), polls: () => polls };
}

const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };

test('parseClientList and parseChoice', () => {
  assert.deepEqual(CLIENT_IDS, ['claude-code', 'claude-desktop', 'codex', 'cursor', 'vscode', 'gemini']);
  assert.deepEqual(parseClientList('claude-code, Cursor,cursor'), ['claude-code', 'cursor']);
  assert.throws(() => parseClientList('cursor,zed'), /Unknown client zed/);
  assert.throws(() => parseClientList(true), /needs a list/);
  const found = [{ id: 'a', detected: true }, { id: 'b', detected: false }, { id: 'c', detected: true }];
  assert.deepEqual(parseChoice('', found), ['a', 'c']);
  assert.deepEqual(parseChoice(' none ', found), []);
  assert.deepEqual(parseChoice('0', found), []);
  assert.deepEqual(parseChoice('2, 3 2', found), ['b', 'c']);
  assert.equal(parseChoice('4', found), null);
  assert.equal(parseChoice('x', found), null);
});

test('no terminal: installs, adds the found clients, walks through loading the extension and waits for it', async () => {
  const s = system({ connectAfter: 4, cli: true });
  fs.mkdirSync(path.join(s.home, '.cursor'));
  write(s.desktopFile, { mcpServers: { other: { command: 'x' } } });
  const { chosen, status } = await setup({}, s.deps);
  assert.deepEqual(chosen, ['claude-code', 'claude-desktop', 'cursor']);
  assert.ok(status && status.extension);
  const dest = path.join(s.home, '.backdraw');
  assert.ok(fs.existsSync(path.join(dest, 'bin', 'backdraw.js')));
  assert.deepEqual(s.claudeAdds, ['backdraw']);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(s.desktopFile, 'utf8')).mcpServers), ['other', 'backdraw']);
  assert.equal(mcpClients.readEntry(mcpClients.byId('cursor'), { home: s.home, appData: s.appData, which: () => null }).entry.args[0], path.join(dest, 'mcp-server.js'));
  const folder = path.join(dest, 'extension');
  assert.deepEqual(s.events.filter(e => e[0] !== 'register'), [['openFolder', folder], ['clipboard', folder], ['open', 'chrome', 'chrome://extensions']]);
  const text = s.text();
  assert.match(text, /^Backdraw \d+\.\d+\.\d+ setup\n\n✓ Installed {12}/);
  assert.match(text, /✓ Native host {10}registered for Google Chrome/);
  assert.match(text, /✓ Claude desktop app {3}added \(/);
  assert.match(text, /✓ Cursor {15}added \(/);
  assert.match(text, /Load the extension in Google Chrome \(once\):\n {2}1\. chrome:\/\/extensions is opening; turn on "Developer mode" \(top right\)\.\n {2}2\. Click "Load unpacked"\.\n {2}3\. Pick the folder .*\(the path is on your clipboard/);
  assert.match(text, /✓ Extension {12}2\.1\.0 connected\n\n✓ Ready\.\nOne more step: click the Backdraw icon/);
  assert.match(text, /say:\n {2}"Generate an image with ChatGPT: /);
});

test('--clients picks exactly those; the Claude desktop app is left alone while it runs', async () => {
  const s = system({ desktopRunning: true, connectAfter: Infinity });
  write(s.desktopFile, { mcpServers: {} });
  const before = fs.readFileSync(s.desktopFile, 'utf8');
  const { chosen } = await setup({ clients: 'claude-desktop,gemini', wait: false }, s.deps);
  assert.deepEqual(chosen, ['claude-desktop', 'gemini']);
  assert.deepEqual(s.claudeAdds, []);
  assert.equal(fs.readFileSync(s.desktopFile, 'utf8'), before);
  assert.match(s.text(), /⚠ Claude desktop app {3}Claude is running, so its config was left alone\. Quit Claude completely .* npx backdraw@latest setup --clients=claude-desktop/);
  assert.match(s.text(), /✓ Gemini CLI {11}added \(.*settings\.json\)/);
  assert.match(s.text(), /· Extension {12}not waiting \(--no-wait\)/);
  await assert.rejects(setup({ clients: 'nope' }, system().deps), /Unknown client nope/);
});

test('on a terminal the user picks by number; a second run changes nothing', async () => {
  const s = system({ connectAfter: 1, cli: false });
  fs.mkdirSync(path.join(s.home, '.codex'));
  fs.mkdirSync(path.join(s.home, '.gemini'));
  const asked = [];
  const answers = ['7', '3'];
  const deps = { ...s.deps, ask: async q => { asked.push(q); return answers.shift(); } };
  const { chosen } = await setup({}, deps);
  assert.deepEqual(chosen, ['codex']);
  assert.equal(asked.length, 2);
  assert.match(asked[0], /Enter = the found ones \(3, 6\)/);
  assert.match(s.text(), /MCP clients on this PC:\n {2}1\. Claude Code {10}not found\n.*\n {2}3\. Codex {16}found\n/s);
  assert.match(s.text(), /Please answer with numbers from 1 to 6, or "none"\./);
  // Already connected: no extension steps.
  assert.doesNotMatch(s.text(), /Load the extension/);
  const config = path.join(s.home, '.codex', 'config.toml');
  const first = fs.readFileSync(config, 'utf8');
  s.out.length = 0;
  await setup({ clients: 'codex' }, s.deps);
  assert.equal(fs.readFileSync(config, 'utf8'), first);
  assert.match(s.text(), /✓ Codex {16}already set up/);
});

test('an extension reloaded by the update: setup waits for it to reconnect and shows no load steps', async () => {
  const s = system({ reloaded: true, connectAfter: 3, cli: false });
  const { status } = await setup({ yes: true }, s.deps);
  assert.ok(status);
  assert.match(s.text(), /✓ Extension {12}2\.1\.0 connected \(reloaded with the new files\)/);
  assert.doesNotMatch(s.text(), /Load the extension/);
  assert.match(s.text(), /⚠ MCP clients {10}none chosen/);
});

test('an extension that never connects: setup stops waiting and points to doctor', async () => {
  const s = system({ connectAfter: Infinity });
  const { status } = await setup({ clients: 'cursor' }, s.deps);
  assert.equal(status, null);
  assert.match(s.text(), /⚠ Extension {12}not connected yet; once it is loaded, check with: npx backdraw@latest doctor/);
  assert.doesNotMatch(s.text(), /Ready/);
});

test('--browser: registered even when not found, its page is opened; an unknown one is refused', async () => {
  const s = system({ connectAfter: Infinity });
  await setup({ clients: 'cursor', browser: 'Brave', wait: false }, s.deps);
  assert.deepEqual(s.events.filter(e => e[0] === 'register').map(e => e[1]), ['chrome', 'chromium']);
  assert.deepEqual(s.events.find(e => e[0] === 'open'), ['open', 'brave', 'brave://extensions']);
  await assert.rejects(setup({ browser: 'opera' }, system().deps), /--browser takes one of: chrome, edge, brave, chromium/);
  await assert.rejects(setup({ browser: true }, system().deps), /--browser takes one of/);
});

test('waitForExtension: after Ctrl+C nothing polls again, even with a call still out', async () => {
  const { waitForExtension } = require('../setup');
  let calls = 0;
  let release;
  const call = () => { calls++; return new Promise((resolve, reject) => { release = () => reject(new Error('down')); }); };
  const waiting = waitForExtension(call, { timeoutMs: 5000, intervalMs: 5 });
  process.emit('SIGINT');
  assert.equal(await waiting, null);
  release();
  await new Promise(r => setTimeout(r, 50));
  assert.equal(calls, 1);
  assert.equal(process.listenerCount('SIGINT'), 0);
});

test('after a reload, setup waits for the new version, not the old host that still answers', async () => {
  const version = require('../package.json').version;
  const s = system({ reloaded: true, cli: false });
  let polls = 0;
  const call = async () => ({ hostVersion: 'x', extension: { version: ++polls < 4 ? '2.0.1' : version }, project: { id: 'p' } });
  await setup({ clients: 'cursor' }, { ...s.deps, call });
  assert.ok(s.text().includes(`✓ Extension            ${version} connected (reloaded with the new files)`), s.text());
  assert.ok(polls >= 4);
  const stuck = system({ reloaded: true, cli: false });
  await setup({ clients: 'cursor' }, { ...stuck.deps, call: async () => ({ extension: { version: '2.0.1' }, project: null }) });
  assert.match(stuck.text(), /⚠ Extension {12}2\.0\.1 is still running; reload Backdraw at chrome:\/\/extensions/);
});
