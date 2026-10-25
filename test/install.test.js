'use strict';
// Runs install.js on temporary files and a fake platform only: the real registry, Claude configs and
// claude CLI are never touched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const crypto = require('node:crypto');
const identity = require('../identity');
const win32 = require('../platform/win32');
const { FILES, migrateData, updateDesktopConfig, desktopEntry, extensionSteps, configDefaults, install, uninstall } = require('../install');

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backdraw-test-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const backups = file => fs.readdirSync(path.dirname(file)).filter(f => f.endsWith('.bak'));

test('desktop config: removes the old entry, adds backdraw, keeps everything else', () => {
  const file = path.join(tempDir(), 'claude_desktop_config.json');
  const original = {
    mcpServers: { other: { command: 'cmd.exe', args: ['/c', 'x'] }, 'chatgpt-images': { command: 'node.exe', args: ['old.js'] } },
    preferences: { theme: 'dark' },
  };
  writeJson(file, original);
  const entry = desktopEntry('C:\\new\\mcp-server.js');

  const backup = updateDesktopConfig(file, entry);
  assert.ok(backup && fs.existsSync(backup));
  assert.deepEqual(readJson(backup), original);
  const updated = readJson(file);
  assert.deepEqual(Object.keys(updated.mcpServers).sort(), ['backdraw', 'other']);
  assert.deepEqual(updated.mcpServers.backdraw, entry);
  assert.deepEqual(updated.mcpServers.other, original.mcpServers.other);
  assert.deepEqual(updated.preferences, original.preferences);

  // Running it again changes nothing and makes no new backup.
  assert.equal(updateDesktopConfig(file, entry), null);
  assert.equal(backups(file).length, 1);
});

test('desktop config: adds mcpServers when missing', () => {
  const file = path.join(tempDir(), 'claude_desktop_config.json');
  writeJson(file, { preferences: {} });
  updateDesktopConfig(file, desktopEntry('C:\\new\\mcp-server.js'));
  assert.deepEqual(Object.keys(readJson(file).mcpServers), ['backdraw']);
});

test('desktop config: remove drops both the new and the old entry', () => {
  const file = path.join(tempDir(), 'claude_desktop_config.json');
  writeJson(file, { mcpServers: { backdraw: { command: 'node' }, 'chatgpt-images': { command: 'node' }, other: { command: 'x' } } });
  assert.ok(updateDesktopConfig(file, null, { remove: true }));
  assert.deepEqual(Object.keys(readJson(file).mcpServers), ['other']);
});

test('desktop config: unreadable JSON is left untouched', () => {
  const file = path.join(tempDir(), 'claude_desktop_config.json');
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => updateDesktopConfig(file, desktopEntry('x')));
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
  assert.equal(backups(file).length, 0);
});

test('migration copies config and jobs, never overwrites', () => {
  const root = tempDir();
  const oldDir = path.join(root, 'old');
  const newDir = path.join(root, 'new');
  writeJson(path.join(oldDir, 'data', 'config.json'), { outputDir: 'C:\\Pictures\\Old' });
  writeJson(path.join(oldDir, 'data', 'jobs.json'), [{ id: 'img_1', images: [{ path: 'C:\\Pictures\\Old\\a.png' }] }]);
  writeJson(path.join(newDir, 'data', 'jobs.json'), [{ id: 'img_new' }]);

  const report = migrateData(oldDir, newDir);
  assert.deepEqual(readJson(path.join(newDir, 'data', 'config.json')), { outputDir: 'C:\\Pictures\\Old' });
  assert.deepEqual(readJson(path.join(newDir, 'data', 'jobs.json')), [{ id: 'img_new' }]);
  assert.equal(report.length, 2);
  assert.match(report.find(r => r.includes('config.json')), /^copied/);
  assert.match(report.find(r => r.includes('jobs.json')), /^kept the existing/);
});

test('migration with no old data copies nothing', () => {
  const root = tempDir();
  assert.deepEqual(migrateData(path.join(root, 'missing'), path.join(root, 'new')), []);
  assert.equal(fs.existsSync(path.join(root, 'new')), false);
});

test('extension steps: a reloaded extension needs nothing more', () => {
  const base = { dest: path.join('C:', 'home', '.backdraw'), legacyDir: path.join('C:', 'home', 'old'), wasInstalled: true, reloaded: true };
  assert.deepEqual(extensionSteps({ ...base, hasLegacy: false }), []);
  assert.deepEqual(extensionSteps({ ...base, hasLegacy: true }), []);
});

test('extension steps: not reached after a migration: open Chrome, or swap the old extension for the new one', () => {
  const dest = path.join('C:', 'home', '.backdraw');
  const legacyDir = path.join('C:', 'home', 'old');
  for (const wasInstalled of [false, true]) {
    const text = extensionSteps({ dest, legacyDir, hasLegacy: true, wasInstalled, reloaded: false }).join('\n');
    assert.match(text, /Open Chrome, or turn Backdraw on at chrome:\/\/extensions; it connects by itself/);
    assert.ok(text.includes(`the old "Claude ChatGPT Görsel Köprüsü" extension (loaded from\n${path.join(legacyDir, 'extension')})`));
    assert.ok(text.includes(`"Load unpacked" and select ${path.join(dest, 'extension')}`));
    assert.ok(text.includes(`node "${path.join(dest, 'cli.js')}" status`));
    assert.doesNotMatch(text, /Load the Chrome extension once/);
  }
});

test('extension steps: not reached on an update: Chrome loads the new version by itself', () => {
  const dest = path.join('C:', 'home', '.backdraw');
  const text = extensionSteps({ dest, legacyDir: path.join('C:', 'home', 'old'), hasLegacy: false, wasInstalled: true, reloaded: false }).join('\n');
  assert.match(text, /Open Chrome, or turn Backdraw on at chrome:\/\/extensions: Chrome loads the new version by itself/);
  assert.ok(text.includes(`node "${path.join(dest, 'cli.js')}" status`));
  assert.ok(text.includes('If Backdraw was never loaded:') && text.includes(path.join(dest, 'extension')));
  assert.doesNotMatch(text, /Load the Chrome extension once|Görsel Köprüsü/);
});

test('extension steps: a first install explains loading the extension once, then the popup checklist', () => {
  const dest = path.join('C:', 'home', '.backdraw');
  const steps = extensionSteps({ dest, legacyDir: path.join('C:', 'home', 'old'), hasLegacy: false, wasInstalled: false, reloaded: false });
  assert.equal(steps.length, 2);
  assert.match(steps[0], /^Load the Chrome extension once: open chrome:\/\/extensions, turn on "Developer mode"/);
  assert.ok(steps[0].includes(path.join(dest, 'extension')));
  assert.match(steps[1], /^Open the Extensions menu \(the puzzle icon\) in Chrome's toolbar, pin Backdraw, click it and follow its setup checklist/);
  assert.doesNotMatch(steps.join('\n'), /Görsel Köprüsü|Check the connection/);
});

test('the deploy list covers every local file the deployed code requires', () => {
  const root = path.join(__dirname, '..');
  const jsFiles = p => (fs.statSync(p).isDirectory()
    ? fs.readdirSync(p).flatMap(f => jsFiles(path.join(p, f)))
    : p.endsWith('.js') ? [p] : []);
  const required = [];
  for (const file of FILES.flatMap(f => jsFiles(path.join(root, f)))) {
    for (const [, spec] of fs.readFileSync(file, 'utf8').matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      const target = require.resolve(path.resolve(path.dirname(file), spec));
      const top = path.relative(root, target).split(path.sep)[0];
      assert.ok(FILES.includes(top), `${path.relative(root, file)} requires ${spec}, but ${top} is not deployed`);
      required.push(path.relative(root, target).split(path.sep).join('/'));
    }
  }
  for (const f of ['lib/results.js', 'lib/protocol.js', 'platform/index.js', 'package.json']) assert.ok(required.includes(f), f);
});

test('config defaults: images and collections folders under Pictures; existing settings are kept', () => {
  let asked = 0;
  const pictures = () => { asked++; return path.join('C:', 'Pics'); };
  assert.deepEqual(configDefaults({ project: { id: 'p' } }, pictures), {
    project: { id: 'p' }, outputDir: path.join('C:', 'Pics', 'Backdraw'), collectionsDir: path.join('C:', 'Pics', 'Backdraw', 'References'),
  });
  asked = 0;
  const mine = { outputDir: path.join('D:', 'Out'), collectionsDir: path.join('D:', 'Refs'), debug: true };
  assert.deepEqual(configDefaults(mine, pictures), mine);
  assert.equal(asked, 0); // the Pictures folder (PowerShell) is only looked up when needed
  assert.deepEqual(configDefaults({ outputDir: mine.outputDir }, pictures), { outputDir: mine.outputDir, collectionsDir: path.join('C:', 'Pics', 'Backdraw', 'References') });
});

test('deployed lib files include the collection modules', () => {
  for (const f of ['limits.js', 'collections.js', 'collection-store.js']) assert.ok(fs.existsSync(path.join(__dirname, '..', 'lib', f)), f);
  assert.ok(FILES.includes('lib') && FILES.includes('extension'));
});

// ---------------------------------------------------------------- install() / uninstall() on a fake platform

const HOST = identity.HOST_NAME;
const LEGACY_HOST = identity.LEGACY.HOST_NAME;
const EXT_MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension', 'manifest.json'), 'utf8'));

// Chrome's rule for an unpacked extension's ID: sha256 of its key, the first 32 hex digits as a-p.
const expectedId = () => [...crypto.createHash('sha256').update(Buffer.from(EXT_MANIFEST.key, 'base64')).digest('hex').slice(0, 32)]
  .map(c => 'abcdefghijklmnop'[parseInt(c, 16)]).join('');

// A temporary home folder, the OS layer with every outside effect recorded instead of done (no
// registry, no PowerShell), and a claude CLI stand-in that knows which MCP entries are registered.
function setup({ registered = [], noCli = false, reloaded = false, running = false, browsers = ['chrome'] } = {}) {
  const home = tempDir();
  const calls = [];
  const cli = [];
  const out = [];
  const desktop = [];
  const known = new Set(registered);
  const platform = {
    installDir: h => win32.installDir(h),
    legacyInstallDir: h => win32.legacyInstallDir(h),
    claudeConfigFile: h => win32.claudeConfigFile(h),
    writeHostLauncher: (dir, node) => win32.writeHostLauncher(dir, node),
    registerNativeHost: (name, manifest, browser) => { calls.push(['register', name, manifest, browser]); return `HKCU\\fake\\${browser}\\${name}`; },
    unregisterNativeHost: (name, browser) => { calls.push(['unregister', name, browser]); },
    nativeHostEntry: (name, browser) => `HKCU\\fake\\${browser}\\${name}`,
    detectBrowsers: () => browsers.slice(),
    appDataDir: () => path.join(home, 'AppData', 'Roaming'),
    which: () => null,
    picturesDir: () => path.join(home, 'Pictures'),
    claudeCli: () => { throw new Error('the real claude CLI must not be looked up'); },
    desktopConfigFiles: () => desktop.slice(),
    desktopAppRunning: () => { calls.push(['desktopAppRunning']); return running; },
  };
  const claudeCli = noCli ? null : args => {
    cli.push(args);
    const [, cmd, name] = args;
    if (cmd === 'remove' && !known.delete(name)) throw new Error(`No MCP server found with name: ${name}`);
    if (cmd === 'add-json') known.add(name);
  };
  const ctx = { platform, home, claudeCli, log: text => out.push(text), reload: async dest => { calls.push(['reload', dest]); return reloaded; } };
  return { home, dest: path.join(home, '.backdraw'), calls, cli, out, desktop, known, ctx, text: () => out.join('\n') };
}

function snapshot(dir) {
  const files = {};
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else files[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return files;
}

test('install: copies the files, writes the host manifest and the config, registers the host and the MCP server', async () => {
  const t = setup();
  await install(t.ctx);
  const root = path.join(__dirname, '..');
  for (const f of FILES) assert.equal(fs.existsSync(path.join(t.dest, f)), fs.existsSync(path.join(root, f)), f);
  assert.ok(fs.existsSync(path.join(t.dest, 'extension', 'icons', 'mascot-96.png')));
  const manifestFile = path.join(t.dest, `${HOST}.json`);
  assert.deepEqual(readJson(manifestFile), {
    name: HOST, description: identity.HOST_DESCRIPTION, path: path.join(t.dest, 'host.bat'), type: 'stdio',
    allowed_origins: [`chrome-extension://${expectedId()}/`],
  });
  assert.match(fs.readFileSync(path.join(t.dest, 'host.bat'), 'utf8'), /host\.js/);
  const cfg = readJson(path.join(t.dest, 'data', 'config.json'));
  assert.deepEqual(cfg, { outputDir: path.join(t.home, 'Pictures', 'Backdraw'), collectionsDir: path.join(t.home, 'Pictures', 'Backdraw', 'References') });
  assert.ok(fs.statSync(cfg.outputDir).isDirectory());
  assert.deepEqual(t.calls, [['unregister', LEGACY_HOST, 'chrome'], ['register', HOST, manifestFile, 'chrome'], ['reload', t.dest]]);
  const entry = { type: 'stdio', command: process.execPath, args: [path.join(t.dest, 'mcp-server.js')], env: {} };
  assert.deepEqual(t.cli, [
    ['mcp', 'remove', 'chatgpt-images', '-s', 'user'], ['mcp', 'remove', 'backdraw', '-s', 'user'],
    ['mcp', 'add-json', 'backdraw', JSON.stringify(entry), '-s', 'user'],
  ]);
  const text = t.text();
  assert.match(text, /^Backdraw \d+\.\d+\.\d+ is installed\./);
  for (const v of [t.dest, cfg.outputDir, cfg.collectionsDir, expectedId(), '"backdraw" (claude mcp, user scope)']) assert.ok(text.includes(v), v);
  assert.match(text, /\nNext steps:\n {2}1\. Load the Chrome extension once: [^\n]*\n {5}click "Load unpacked"[^\n]*\n {2}2\. Open the Extensions menu \(the puzzle icon\)/);
  assert.doesNotMatch(text, /Migrated|old folder|desktop|was reloaded/i);
});

test('install: an update keeps the user\'s config; a reloaded extension leaves nothing to do', async () => {
  const t = setup({ reloaded: true });
  await install(t.ctx);
  const cfgFile = path.join(t.dest, 'data', 'config.json');
  writeJson(cfgFile, { ...readJson(cfgFile), outputDir: path.join(t.home, 'Mine'), debug: true });
  t.out.length = 0;
  await install(t.ctx);
  assert.equal(readJson(cfgFile).outputDir, path.join(t.home, 'Mine'));
  assert.equal(readJson(cfgFile).debug, true);
  assert.doesNotMatch(t.text(), /Next steps|Migrated/);
  assert.match(t.text(), /The running Chrome extension was reloaded with the new version\./);
});

test('install without the claude CLI: ~/.claude.json gets Backdraw, loses the old entry, keeps the rest', async () => {
  const t = setup({ noCli: true });
  const file = path.join(t.home, '.claude.json');
  writeJson(file, { mcpServers: { 'chatgpt-images': { command: 'old' }, other: { command: 'x' } }, theme: 'dark' });
  await install(t.ctx);
  const json = readJson(file);
  assert.deepEqual(Object.keys(json.mcpServers).sort(), ['backdraw', 'other']);
  assert.deepEqual(json.mcpServers.backdraw, { type: 'stdio', command: process.execPath, args: [path.join(t.dest, 'mcp-server.js')], env: {} });
  assert.equal(json.theme, 'dark');
  assert.ok(t.text().includes(`"backdraw" (${file})`));
  assert.match(t.text(), /removed the old "chatgpt-images" Claude Code MCP entry/);
});

test('install over an old chatgpt-image-bridge install: copies its data, removes its MCP entry, the folder can go', async () => {
  const t = setup({ registered: ['chatgpt-images'] });
  const legacy = path.join(t.home, '.claude', 'chatgpt-image-bridge');
  writeJson(path.join(legacy, 'data', 'config.json'), { outputDir: path.join(t.home, 'OldPics') });
  await install(t.ctx);
  assert.equal(readJson(path.join(t.dest, 'data', 'config.json')).outputDir, path.join(t.home, 'OldPics'));
  assert.ok(fs.existsSync(path.join(legacy, 'data', 'config.json'))); // never deleted
  const text = t.text();
  assert.match(text, /\nMigrated from the old "chatgpt-image-bridge" install:\n {2}- copied [^\n]*\n {2}- removed the old "chatgpt-images" Claude Code MCP entry\n/);
  assert.ok(text.includes(`The old folder ${legacy} is no longer used; delete it by hand once Backdraw works.`));
  assert.match(text, /Görsel Köprüsü/);
});

test('install with an old folder that had nothing to migrate: just the line about deleting it', async () => {
  const t = setup();
  const legacy = path.join(t.home, '.claude', 'chatgpt-image-bridge');
  fs.mkdirSync(legacy, { recursive: true });
  await install(t.ctx);
  assert.doesNotMatch(t.text(), /Migrated/);
  assert.ok(t.text().includes(`The old folder ${legacy} is no longer used`));
});

test('install: a Claude desktop config without Backdraw is left alone and becomes a next step', async () => {
  for (const running of [true, false]) {
    const t = setup({ running, reloaded: true });
    const file = path.join(t.home, 'claude_desktop_config.json');
    writeJson(file, { mcpServers: { other: { command: 'x' } } });
    t.desktop.push(file);
    await install(t.ctx);
    assert.deepEqual(readJson(file), { mcpServers: { other: { command: 'x' } } });
    assert.equal(backups(file).length, 0);
    const text = t.text();
    assert.ok(text.includes(`node "${path.join(t.dest, 'install.js')}" --desktop`));
    assert.match(text, running ? /Next steps:\n {2}1\. Claude desktop app \(chat\): Claude is running, so its config was left alone\.\n {5}Quit Claude completely/
      : /Next steps:\n {2}1\. Claude desktop app \(chat\): add Backdraw to its config with /);
    // The Chrome side needs nothing, and the report still says so.
    assert.match(text, /\nThe running Chrome extension was reloaded with the new version\.\n\nNext steps:\n/);
  }
});

function uninstallSetup(options) {
  const t = setup({ registered: ['backdraw', 'chatgpt-images'], ...options });
  t.cfg = { outputDir: path.join(t.home, 'Pictures', 'Backdraw'), collectionsDir: path.join(t.home, 'Pictures', 'Backdraw', 'References') };
  writeJson(path.join(t.dest, 'data', 'config.json'), t.cfg);
  writeJson(path.join(t.dest, 'data', 'jobs.json'), [{ id: 'img_1' }]);
  fs.writeFileSync(path.join(t.dest, 'install.js'), '');
  fs.mkdirSync(t.cfg.collectionsDir, { recursive: true });
  t.desktopFile = path.join(t.home, 'claude_desktop_config.json');
  writeJson(t.desktopFile, { mcpServers: { backdraw: { command: 'node' }, 'chatgpt-images': { command: 'node' }, other: { command: 'x' } } });
  t.desktop.push(t.desktopFile);
  return t;
}

test('uninstall: both host names, both MCP entries and the desktop entries (with a backup) go; the data stays', async () => {
  const t = uninstallSetup({ running: false });
  await uninstall(t.ctx);
  assert.deepEqual(t.calls, [
    ...['chrome', 'edge', 'chromium'].map(k => ['unregister', HOST, k]), ['unregister', LEGACY_HOST, 'chrome'], ['desktopAppRunning'],
  ]);
  assert.deepEqual(t.cli, [['mcp', 'remove', 'backdraw', '-s', 'user'], ['mcp', 'remove', 'chatgpt-images', '-s', 'user']]);
  assert.deepEqual(readJson(t.desktopFile), { mcpServers: { other: { command: 'x' } } });
  assert.equal(backups(t.desktopFile).length, 1);
  assert.deepEqual(readJson(path.join(t.dest, 'data', 'config.json')), t.cfg);
  assert.deepEqual(readJson(path.join(t.dest, 'data', 'jobs.json')), [{ id: 'img_1' }]);
  assert.ok(fs.existsSync(t.cfg.collectionsDir));
  const text = t.text();
  assert.match(text, /^Backdraw was uninstalled\./);
  assert.match(text, /Claude Code MCP {5}: removed "backdraw", "chatgpt-images"/);
  assert.ok(text.includes(`Claude desktop app  : updated ${t.desktopFile} (backup: `));
  assert.match(text, /\nKept:\n/);
  for (const v of [t.cfg.outputDir, t.cfg.collectionsDir, path.join(t.dest, 'data')]) assert.ok(text.includes(v), v);
  assert.match(text, /Next steps:\n {2}1\. Remove the Backdraw extension at chrome:\/\/extensions\.\n {2}2\. Optionally delete /);
});

test('uninstall while the Claude desktop app runs: its config is left alone, with the command for later', async () => {
  const t = uninstallSetup({ running: true });
  const before = fs.readFileSync(t.desktopFile, 'utf8');
  await uninstall(t.ctx);
  assert.equal(fs.readFileSync(t.desktopFile, 'utf8'), before);
  assert.equal(backups(t.desktopFile).length, 0);
  assert.ok(t.text().includes(`node "${path.join(t.dest, 'install.js')}" --uninstall`));
  assert.match(t.text(), /Claude desktop app {2}: left alone \(see the next steps\)/);
});

test('uninstall --dry-run: lists every target and changes or calls nothing', async () => {
  const t = uninstallSetup();
  const before = snapshot(t.home);
  await uninstall({ ...t.ctx, dryRun: true });
  assert.deepEqual(snapshot(t.home), before);
  assert.deepEqual(t.calls, []);
  assert.deepEqual(t.cli, []);
  const text = t.text();
  assert.match(text, /^Dry run: nothing was changed\./);
  for (const v of [`HKCU\\fake\\chrome\\${HOST}`, `HKCU\\fake\\edge\\${HOST}`, `HKCU\\fake\\chromium\\${HOST}`,
    `HKCU\\fake\\chrome\\${LEGACY_HOST}`, '"backdraw", "chatgpt-images" with "claude mcp remove <name> -s user"',
    `"backdraw", "chatgpt-images" from ${t.desktopFile}`, t.cfg.outputDir, t.cfg.collectionsDir, path.join(t.dest, 'data')]) {
    assert.ok(text.includes(v), v);
  }
});

test('uninstall and its dry run name the same folders, and only the ones that are there', async () => {
  const empty = setup();
  await uninstall({ ...empty.ctx, dryRun: true });
  await uninstall(empty.ctx);
  const [dry, real] = empty.out;
  for (const text of [dry, real]) assert.ok(!text.includes(empty.dest), text);
  assert.doesNotMatch(real, /Kept:|Optionally delete/);
  assert.match(dry, /It keeps:\n {2}The Chrome extension \(remove it at chrome:\/\/extensions\)$/);

  const t = uninstallSetup();
  const legacy = path.join(t.home, '.claude', 'chatgpt-image-bridge');
  fs.mkdirSync(legacy, { recursive: true });
  fs.rmSync(t.cfg.outputDir, { recursive: true });
  await uninstall({ ...t.ctx, dryRun: true });
  await uninstall(t.ctx);
  const [d, r] = t.out;
  for (const text of [d, r]) {
    assert.ok(text.includes(`Settings, history : ${path.join(t.dest, 'data')}`), text);
    assert.doesNotMatch(text, /Images folder|References folder/);
  }
  assert.ok(d.includes(`  The folder ${t.dest} itself (delete it by hand)\n  The folder ${legacy} itself (delete it by hand)`), d);
  assert.ok(r.includes(`Optionally delete ${t.dest} and ${legacy} by hand`), r);
});

test('uninstall --dry-run without the claude CLI names the entries ~/.claude.json has', async () => {
  const t = uninstallSetup({ noCli: true });
  const file = path.join(t.home, '.claude.json');
  writeJson(file, { mcpServers: { backdraw: { command: 'node' }, other: { command: 'x' } } });
  const before = snapshot(t.home);
  await uninstall({ ...t.ctx, dryRun: true });
  assert.deepEqual(snapshot(t.home), before);
  assert.ok(t.text().includes(`"backdraw" from ${file}`));
  await uninstall(t.ctx); // for real: only that entry goes
  assert.deepEqual(readJson(file), { mcpServers: { other: { command: 'x' } } });
});

test('install: the host is registered under the key each installed browser reads first, one manifest; Chrome when none is found', async () => {
  const t = setup({ browsers: ['chrome', 'edge', 'brave'] });
  await install(t.ctx);
  const manifestFile = path.join(t.dest, `${HOST}.json`);
  // Brave has no key of its own: it reads Chromium's, then Chrome's.
  assert.deepEqual(t.calls.filter(c => c[0] === 'register'), ['chrome', 'edge', 'chromium'].map(k => ['register', HOST, manifestFile, k]));
  assert.match(t.text(), /Browsers {10}: Google Chrome, Microsoft Edge, Brave\n/);
  const none = setup({ browsers: [] });
  await install(none.ctx);
  assert.deepEqual(none.calls.filter(c => c[0] === 'register').map(c => c[3]), ['chrome']);
});

test('install for setup: Claude Code only when selected, and the result comes back without a report', async () => {
  const t = setup();
  const r = await install({ ...t.ctx, clients: ['cursor'], report: false });
  assert.deepEqual(t.cli, []);
  assert.deepEqual(t.out, []);
  assert.equal(r.mcp, 'not selected');
  assert.equal(r.server, path.join(t.dest, 'mcp-server.js'));
  assert.deepEqual(r.registered, ['chrome']);
  await install({ ...t.ctx, clients: ['claude-code'], report: false });
  assert.equal(t.cli.at(-1)[1], 'add-json');
});

test('uninstall: the Backdraw entries of Codex, Cursor, VS Code and Gemini go too (with backups); --dry-run lists them', async () => {
  const t = uninstallSetup({ running: false });
  const env = { home: t.home, appData: path.join(t.home, 'AppData', 'Roaming'), which: () => null };
  const mcpClients = require('../lib/mcp-clients');
  for (const c of mcpClients.FILE_CLIENTS) mcpClients.addEntry(c, env, process.execPath, path.join(t.dest, 'mcp-server.js'));
  const vscode = mcpClients.byId('vscode').file(env);
  fs.writeFileSync(vscode, '{ // comments\n "servers": { "backdraw": {} } }');
  const before = snapshot(t.home);
  await uninstall({ ...t.ctx, dryRun: true });
  assert.deepEqual(snapshot(t.home), before);
  const dry = t.text();
  for (const c of ['codex', 'cursor', 'gemini']) assert.ok(dry.includes(`"backdraw" from ${mcpClients.byId(c).file(env)}`), c);
  assert.match(dry, /VS Code: "backdraw" from .*can't be changed: .*has comments/);
  t.out.length = 0;
  await uninstall(t.ctx);
  for (const c of ['codex', 'cursor', 'gemini']) assert.equal(mcpClients.readEntry(mcpClients.byId(c), env).entry, null, c);
  assert.equal(fs.readFileSync(vscode, 'utf8'), '{ // comments\n "servers": { "backdraw": {} } }');
  assert.match(t.text(), /Cursor: removed "backdraw" from .*\(backup: .*\.bak\)/);
  assert.match(t.text(), /VS Code: left alone/);
});
