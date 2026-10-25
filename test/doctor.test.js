'use strict';
// backdraw doctor: the checks and their printout from given facts, the masking, and gather/--fix on
// a temporary install with a fake platform (a registry in memory) and a fake bridge.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const identity = require('../identity');
const win32 = require('../platform/win32');
const report = require('../lib/doctor');
const { install } = require('../install');
const { gather, fix, doctor } = require('../doctor');
const mcpClients = require('../lib/mcp-clients');

const HOME = 'C:\\Users\\Jane Doe';
const MANIFEST = `${HOME}\\.backdraw\\${identity.HOST_NAME}.json`;
const SERVER = `${HOME}\\.backdraw\\mcp-server.js`;

function healthy() {
  return {
    node: 'v22.11.0', self: { version: '2.1.0' }, hostName: identity.HOST_NAME,
    install: { dir: `${HOME}\\.backdraw`, exists: true, missing: [], version: '2.1.0', extensionVersion: '2.1.0' },
    hostManifest: { file: MANIFEST, exists: true, problem: null },
    browsers: [
      { id: 'chrome', name: 'Google Chrome', installed: true, registration: { key: 'chrome', path: MANIFEST }, policies: { blocklist: [], allowlist: [] } },
      { id: 'edge', name: 'Microsoft Edge', installed: false, registration: { key: 'chrome', path: MANIFEST }, policies: {} },
    ],
    bridge: { ok: true, status: { hostVersion: '2.1.0', extension: { version: '2.1.0' }, project: { id: 'g-p-1', name: 'Private name' } } },
    chatgpt: { loggedIn: true, challenge: null },
    clients: [
      { id: 'claude-code', label: 'Claude Code', detected: true, entry: { command: 'node', args: [SERVER] }, problem: null },
      { id: 'cursor', label: 'Cursor', detected: false, entry: null },
    ],
    desktop: { files: [], running: false },
  };
}

test('a healthy install: every line is ✓ and nothing private is printed', () => {
  const checks = report.evaluate(healthy());
  assert.deepEqual(checks.map(c => [c.status, c.label]), [
    ['ok', 'Node.js'], ['ok', 'Install folder'], ['ok', 'Version'], ['ok', 'Host manifest'], ['ok', 'Google Chrome'],
    ['ok', 'Bridge'], ['ok', 'Extension'], ['ok', 'ChatGPT'], ['ok', 'Project'], ['ok', 'Claude Code'],
  ]);
  const text = report.mask(report.format(checks, { header: 'Backdraw doctor 2.1.0' }), HOME);
  assert.match(text, /^Backdraw doctor 2\.1\.0\n\n✓ Node\.js {8}v22\.11\.0\n/);
  assert.match(text, /✓ Install folder ~\\\.backdraw \(2\.1\.0\)\n✓ Version {8}2\.1\.0\n/);
  assert.match(text, /\n\nEverything looks good\.$/);
  assert.doesNotMatch(text, /Jane|Private name|g-p-1|\x1b\[/);
});

test('problems: one line each with its fix, and the summary counts what --fix can repair', () => {
  const f = healthy();
  f.node = 'v18.19.0';
  f.self.version = '2.2.0';
  f.browsers[0].registration = null;
  f.browsers[1] = { id: 'edge', name: 'Microsoft Edge', installed: true, registration: { key: 'edge', path: 'C:\\old\\host.json' }, policies: { userLevelHosts: false } };
  f.clients[0].problem = 'points to C:\\old\\mcp-server.js, not x';
  f.clients[1].detected = true;
  f.chatgpt = { loggedIn: false };
  f.bridge.status.project = null;
  const checks = report.evaluate(f);
  const by = label => checks.filter(c => c.label === label);
  assert.equal(by('Node.js')[0].status, 'fail');
  assert.deepEqual([by('Version')[0].status, by('Version')[0].fix], ['warn', 'Update: npx backdraw@latest setup']);
  assert.deepEqual(by('Google Chrome').map(c => [c.status, c.fixable]), [['fail', true]]);
  assert.match(by('Microsoft Edge')[0].detail, /points to C:\\old\\host\.json/);
  assert.match(by('Microsoft Edge policy')[0].detail, /NativeMessagingUserLevelHosts/);
  assert.equal(by('Claude Code')[0].fix, 'npx backdraw@latest doctor --fix');
  assert.deepEqual([by('Cursor')[0].status, by('Cursor')[0].fix], ['warn', 'Run: npx backdraw@latest setup --clients=cursor']);
  assert.match(by('ChatGPT')[0].fix, /Sign in at chatgpt\.com/);
  assert.equal(by('Project')[0].status, 'fail');
  const text = report.format(checks);
  assert.match(text, /✗ Google Chrome +the native host is not registered\n +→ npx backdraw@latest doctor --fix\n/);
  assert.match(text, /\n7 problems, 2 warnings\. "npx backdraw@latest doctor --fix" can repair 3 of them\.$/);
});

test('a bridge that is not running: the extension, ChatGPT and project are not checked', () => {
  const f = healthy();
  f.bridge = { ok: false, code: 'NOT_RUNNING', error: 'x' };
  const checks = report.evaluate(f);
  assert.match(checks.find(c => c.label === 'Bridge').detail, /^not running: the browser is closed/);
  assert.deepEqual(checks.filter(c => c.status === 'info').map(c => c.label), ['Extension', 'ChatGPT', 'Project']);
});

test('colour only when asked; the plain text keeps the symbols', () => {
  const checks = report.evaluate(healthy());
  assert.match(report.format(checks, { color: true }), /\x1b\[32m✓\x1b\[0m Node\.js/);
  assert.doesNotMatch(report.format(checks), /\x1b/);
});

test('mask: the home folder in every printed form, case-insensitive, and the pipe tag; other names stay', () => {
  const text = 'C:\\Users\\Jane Doe\\x c:\\users\\jane doe\\y C:/Users/Jane Doe/z "C:\\\\Users\\\\Jane Doe\\\\w" \\\\.\\pipe\\backdraw-Jane_Doe io.github.janedoe.host';
  assert.equal(report.mask(text, HOME, 'Jane_Doe'), '~\\x ~\\y ~/z "~\\\\w" \\\\.\\pipe\\backdraw-~ io.github.janedoe.host');
});

test('compareVersions', () => {
  assert.ok(report.compareVersions('2.1.0', '2.0.1') > 0);
  assert.ok(report.compareVersions('2.0.10', '2.0.9') > 0);
  assert.equal(report.compareVersions('2.1.0', '2.1.0'), 0);
  assert.ok(report.compareVersions('1.9.9', '2.0.0') < 0);
});

// ---------------------------------------------------------------- gather and --fix

function fakeSystem() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'backdraw-doctor-'));
  test.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const registry = { chrome: null, edge: null, chromium: null };
  const calls = [];
  const platform = {
    installDir: h => win32.installDir(h), legacyInstallDir: h => win32.legacyInstallDir(h), claudeConfigFile: h => win32.claudeConfigFile(h),
    writeHostLauncher: (dir, node) => win32.writeHostLauncher(dir, node),
    registerNativeHost: (name, manifest, key) => { calls.push(['register', key]); registry[key] = manifest; return key; },
    unregisterNativeHost: () => {}, nativeHostEntry: (n, k) => k,
    readBrowserRegistry: () => JSON.stringify({ hosts: registry, policies: { chrome: { hklm: {}, hkcu: {} } } }),
    parseBrowserRegistry: win32.parseBrowserRegistry,
    detectBrowsers: () => ['chrome'], appDataDir: () => path.join(home, 'AppData', 'Roaming'), which: cmd => (cmd === 'node' ? process.execPath : null),
    picturesDir: () => path.join(home, 'Pictures'), claudeCli: () => null,
    desktopConfigFiles: () => [], desktopAppRunning: () => false, pipePath: () => '\\\\.\\pipe\\backdraw-tester',
  };
  const ctx = { platform, home, claudeCli: null, log: () => {}, reload: async () => false };
  const call = async method => {
    if (method === 'status') return { hostVersion: '2.1.0', extension: { version: require('../package.json').version }, project: { id: 'p' } };
    if (method === 'chatgpt_state') return { loggedIn: true, challenge: null };
    throw new Error(method);
  };
  return { home, registry, calls, ctx, call };
}

test('gather and --fix: a stale registry key and a client pointing elsewhere are repaired, then all is well', async () => {
  const s = fakeSystem();
  await install(s.ctx);
  const env = { home: s.home, appData: path.join(s.home, 'AppData', 'Roaming'), which: () => null };
  mcpClients.addEntry(mcpClients.byId('cursor'), env, process.execPath, 'C:\\old\\mcp-server.js');
  s.registry.chrome = 'C:\\old\\host.json';

  const c = require('../install').context({ ...s.ctx, report: false });
  const before = report.evaluate(await gather(c, s.call));
  assert.deepEqual(before.filter(x => x.status !== 'ok').map(x => [x.status, x.label]), [['fail', 'Google Chrome'], ['fail', 'Cursor']]);

  s.calls.length = 0;
  const { fixed, failed } = fix(c, await gather(c, s.call));
  assert.deepEqual(failed, []);
  assert.equal(fixed.length, 2);
  assert.deepEqual(s.calls, [['register', 'chrome']]);
  const after = report.evaluate(await gather(c, s.call));
  assert.deepEqual(after.filter(x => x.status !== 'ok'), []);
  assert.equal(mcpClients.readEntry(mcpClients.byId('cursor'), env).entry.args[0], path.join(s.home, '.backdraw', 'mcp-server.js'));
});

test('doctor prints masked text; --fix says what it did; nothing to fix on a missing install', async () => {
  const s = fakeSystem();
  const out = [];
  const checks = await doctor({ fix: true }, { ctx: s.ctx, call: s.call, log: t => out.push(t), color: false });
  const text = out.join('\n');
  assert.match(text, /^✗ Not fixed: The install folder is incomplete; run: npx backdraw@latest setup\n/);
  assert.ok(!text.includes(s.home), 'the home folder is masked');
  assert.match(text, /✗ Install folder +~\\\.backdraw is missing/);
  assert.ok(checks.some(x => x.status === 'fail'));
});
