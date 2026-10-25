'use strict';
// Installs Backdraw for the current user (no admin rights needed). Windows only for now; the
// OS-specific steps live in platform/.
//   node install.js                        install or update; migrates an older chatgpt-image-bridge install
//   node install.js --desktop              add Backdraw to the Claude desktop app's chat config (quit Claude first)
//   node install.js --uninstall            remove the Chrome host registration and the MCP entries
//   node install.js --uninstall --dry-run  only show what --uninstall would remove
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const identity = require('./identity');
const platform = require('./platform');
const browsers = require('./lib/browsers');
const mcpClients = require('./lib/mcp-clients');

const { LEGACY } = identity;
const SRC = __dirname;
const FILES = ['package.json', 'LICENSE', 'identity.js', 'shared.js', 'host.js', 'mcp-server.js', 'cli.js', 'install.js', 'setup.js', 'doctor.js',
  'README.md', 'README.tr.md', 'SECURITY.md', 'CHANGELOG.md', 'bin', 'extension', 'platform', 'lib'];
const NODE = process.execPath;
const MCP_NAMES = [identity.MCP_NAME, LEGACY.MCP_NAME];

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function samePath(a, b) { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); }

const quoted = names => names.map(n => `"${n}"`).join(', ');

function extensionId(manifest) {
  const hex = crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

// Everything install() and uninstall() reach outside their own folder; the tests pass a fake platform,
// a temporary home folder and a recording claudeCli instead.
//   platform   the OS layer (platform/)        home    the user's home folder
//   src        the folder that is installed    log     prints the report
//   claudeCli  runs `claude <args>`, or null when the Claude Code CLI is not installed
//   reload     asks a running extension to reload itself (resolves to true when it did)
//   clients    (setup) the MCP clients to register in; without it, Claude Code only, as before
//   report     false: install() returns its result without printing the report (setup prints its own)
//   browsers   (setup --browser) browser ids to register for even when they aren't found
function context(ctx = {}) {
  const p = ctx.platform || platform;
  let claudeCli = ctx.claudeCli;
  if (claudeCli === undefined) {
    const exe = p.claudeCli();
    claudeCli = exe ? args => execFileSync(exe, args, { stdio: 'ignore' }) : null;
  }
  const home = ctx.home || os.homedir();
  return {
    platform: p, home, src: ctx.src || SRC, log: ctx.log || (text => console.log(text)),
    claudeCli, reload: ctx.reload || reloadRunningExtension, dryRun: !!ctx.dryRun,
    clients: ctx.clients || null, report: ctx.report !== false, browsers: ctx.browsers || [],
    clientEnv: { home, appData: p.appDataDir(home), which: cmd => p.which(cmd) },
  };
}

// The browsers to register the native host for: Chrome always (every Chrome channel and a copy the
// check can't see read its key, and the others fall back to it), the installed ones, and any the
// user named (setup --browser).
function targetBrowsers(p, extra = []) {
  return [...new Set(['chrome', ...p.detectBrowsers(), ...extra])];
}

// Copies the settings and job history of an older install. Never overwrites; returns a report.
function migrateData(fromDir, toDir) {
  const report = [];
  for (const name of ['config.json', 'jobs.json']) {
    const from = path.join(fromDir, 'data', name);
    const to = path.join(toDir, 'data', name);
    if (!fs.existsSync(from)) continue;
    if (fs.existsSync(to)) { report.push(`kept the existing ${to} (did not overwrite it with ${from})`); continue; }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    report.push(`copied ${from} -> ${to}`);
  }
  return report;
}

// Folders a config without them gets; the user's own settings are kept. pictures() is only asked
// when needed (it starts PowerShell).
function configDefaults(cfg, pictures) {
  const out = { ...cfg };
  if (!out.outputDir) out.outputDir = path.join(pictures(), identity.IMAGES_DIR_NAME);
  if (!out.collectionsDir) out.collectionsDir = path.join(pictures(), identity.IMAGES_DIR_NAME, identity.COLLECTIONS_DIR_NAME);
  return out;
}

// ---------------------------------------------------------------- Claude Code

function removeLegacyMcpFromFile(file) {
  const json = readJson(file, null);
  if (!json || !json.mcpServers || !(LEGACY.MCP_NAME in json.mcpServers)) return false;
  delete json.mcpServers[LEGACY.MCP_NAME];
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
  return true;
}

// Returns [where Backdraw was registered, whether the old entry was removed].
function registerMcp(c, serverPath) {
  const entry = { type: 'stdio', command: NODE, args: [serverPath], env: {} };
  if (c.claudeCli) {
    let legacyRemoved = false;
    try { c.claudeCli(['mcp', 'remove', LEGACY.MCP_NAME, '-s', 'user']); legacyRemoved = true; } catch {}
    try { c.claudeCli(['mcp', 'remove', identity.MCP_NAME, '-s', 'user']); } catch {}
    c.claudeCli(['mcp', 'add-json', identity.MCP_NAME, JSON.stringify(entry), '-s', 'user']);
    return [`"${identity.MCP_NAME}" (claude mcp, user scope)`, legacyRemoved];
  }
  const file = c.platform.claudeConfigFile(c.home);
  const legacyRemoved = removeLegacyMcpFromFile(file);
  const json = readJson(file, {});
  json.mcpServers = { ...(json.mcpServers || {}), [identity.MCP_NAME]: entry };
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
  return [`"${identity.MCP_NAME}" (${file})`, legacyRemoved];
}

// Without the CLI: the entries ~/.claude.json has.
function mcpEntriesInFile(c) {
  const json = readJson(c.platform.claudeConfigFile(c.home), null);
  return json && json.mcpServers ? MCP_NAMES.filter(n => n in json.mcpServers) : [];
}

// Returns the entries that were removed (with the CLI: the ones it could remove).
function unregisterMcp(c) {
  if (c.claudeCli) {
    return MCP_NAMES.filter(name => { try { c.claudeCli(['mcp', 'remove', name, '-s', 'user']); return true; } catch { return false; } });
  }
  const found = mcpEntriesInFile(c);
  if (found.length) {
    const file = c.platform.claudeConfigFile(c.home);
    const json = readJson(file, {});
    for (const name of found) delete json.mcpServers[name];
    fs.writeFileSync(file, JSON.stringify(json, null, 2));
  }
  return found;
}

// ---------------------------------------------------------------- Claude desktop app (chat)

const desktopEntry = serverPath => ({ command: NODE, args: [serverPath] });

function desktopServers(file, entry, remove) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const before = json.mcpServers || {};
  const servers = { ...before };
  delete servers[LEGACY.MCP_NAME];
  if (remove) delete servers[identity.MCP_NAME];
  else servers[identity.MCP_NAME] = entry;
  return { json, servers, changed: JSON.stringify(servers) !== JSON.stringify(before) };
}

// Drops the old entry and adds Backdraw (or, with remove, drops both) in one desktop config file.
// A timestamped .bak copy is written first. Returns the backup path, or null if nothing changed.
// Throws on unreadable JSON without touching the file.
function updateDesktopConfig(file, entry, { remove = false } = {}) {
  const { json, servers, changed } = desktopServers(file, entry, remove);
  if (!changed) return null;
  const backup = `${file}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
  fs.copyFileSync(file, backup);
  json.mcpServers = servers;
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
  return backup;
}

function desktopNeedsUpdate(file, entry, remove = false) {
  try { return desktopServers(file, entry, remove).changed; } catch { return false; }
}

// The Backdraw entries (new and old name) in a desktop config file.
function desktopEntriesIn(file) {
  const servers = (readJson(file, {}) || {}).mcpServers || {};
  return MCP_NAMES.filter(n => n in servers);
}

function desktopCommand(dest, flag) {
  return `node "${path.join(dest, 'install.js')}" ${flag}`;
}

function desktop() {
  const dest = platform.installDir();
  const server = path.join(dest, 'mcp-server.js');
  if (!fs.existsSync(server)) throw new Error(`Backdraw is not installed in ${dest} yet; run node install.js first.`);
  const files = platform.desktopConfigFiles();
  if (!files.length) return console.log('No Claude desktop app config was found; nothing to change.');
  const running = platform.desktopAppRunning();
  if (running !== false) {
    console.log(`${running === null
      ? 'Could not tell whether the Claude desktop app is running (PowerShell failed), so its config was not changed.'
      : 'The Claude desktop app is running, so its config was not changed (Claude rewrites it on exit).'}
Quit Claude completely (also from the system tray), then run this from PowerShell:
  ${desktopCommand(dest, '--desktop')}`);
    process.exitCode = 1;
    return;
  }
  for (const file of files) {
    try {
      const backup = updateDesktopConfig(file, desktopEntry(server));
      console.log(backup ? `Updated ${file}\n  backup: ${backup}` : `Already up to date: ${file}`);
    } catch (e) {
      console.log(`Skipped ${file}: ${e.message}`);
    }
  }
  console.log(`"${identity.MCP_NAME}" is available in new Claude desktop chats after Claude starts again.`);
}

// ---------------------------------------------------------------- install

async function reloadRunningExtension(dest) {
  try {
    const shared = require(path.join(dest, 'shared.js'));
    await shared.call('reload_extension', {}, 3000);
    return true;
  } catch { return false; }
}

// What is left to do about the Chrome extension after the files were copied: nothing when the
// running extension was reloaded. An unpacked extension is read from disk when Chrome starts or when
// it is turned on; one that can't be reached is not running, or (after a migration) may still be
// loaded from the old folder.
function extensionSteps({ dest, legacyDir, hasLegacy, wasInstalled, reloaded }) {
  const folder = path.join(dest, 'extension');
  const check = `Check the connection: node "${path.join(dest, 'cli.js')}" status`;
  if (reloaded) return [];
  if (hasLegacy) {
    return [`Open Chrome, or turn Backdraw on at chrome://extensions; it connects by itself.
If chrome://extensions still shows the old "Claude ChatGPT Görsel Köprüsü" extension (loaded from
${path.join(legacyDir, 'extension')}), remove it, click "Load unpacked" and select ${folder}`, check];
  }
  if (wasInstalled) {
    return [`Open Chrome, or turn Backdraw on at chrome://extensions: Chrome loads the new version by itself.
If Backdraw was never loaded: turn on "Developer mode" there, click "Load unpacked" and select ${folder}`, check];
  }
  return [`Load the Chrome extension once: open chrome://extensions, turn on "Developer mode" (top right),
click "Load unpacked" and select ${folder}`,
  'Open the Extensions menu (the puzzle icon) in Chrome\'s toolbar, pin Backdraw, click it and follow its setup checklist (ChatGPT sign-in, project).'];
}

function desktopStep(dest, running) {
  const command = desktopCommand(dest, '--desktop');
  if (running === false) return `Claude desktop app (chat): add Backdraw to its config with ${command}`;
  return `Claude desktop app (chat): ${running ? 'Claude is running' : 'could not tell whether Claude is running'}, so its config was left alone.
Quit Claude completely (also from the system tray), then run this from PowerShell: ${command}`;
}

const numbered = steps => steps.map((s, i) => `  ${i + 1}. ${s.replace(/\n/g, '\n     ')}`);

function installReport(r) {
  const lines = [`Backdraw ${r.version} is installed.`,
    `  Folder            : ${r.dest}`,
    `  Images folder     : ${r.cfg.outputDir}`,
    `  References folder : ${r.cfg.collectionsDir}`,
    `  Extension ID      : ${r.id}`,
    `  Browsers          : ${r.registered.map(b => browsers.byId(b).name).join(', ')}`,
    `  Claude Code MCP   : ${r.mcp}`];
  const migrated = [...r.migration.filter(m => m.startsWith('copied ')),
    ...(r.legacyMcpRemoved ? [`removed the old "${LEGACY.MCP_NAME}" Claude Code MCP entry`] : [])];
  if (migrated.length) lines.push('', `Migrated from the old "${LEGACY.INSTALL_DIR[LEGACY.INSTALL_DIR.length - 1]}" install:`, ...migrated.map(m => `  - ${m}`));
  if (r.hasLegacy) lines.push('', `The old folder ${r.legacyDir} is no longer used; delete it by hand once Backdraw works.`);
  const steps = extensionSteps(r);
  if (r.desktopStale) steps.push(desktopStep(r.dest, r.desktopRunning));
  if (r.reloaded) lines.push('', 'The running Chrome extension was reloaded with the new version.');
  if (steps.length) lines.push('', 'Next steps:', ...numbered(steps));
  lines.push('', `The "${identity.MCP_NAME}" tools are ready in new Claude Code sessions.`);
  return lines.join('\n');
}

async function install(ctx) {
  const c = context(ctx);
  const p = c.platform;
  const dest = p.installDir(c.home);
  const legacyDir = p.legacyInstallDir(c.home);
  const hasLegacy = fs.existsSync(legacyDir) && !samePath(legacyDir, dest);
  const wasInstalled = fs.existsSync(path.join(dest, 'extension', 'manifest.json'));
  if (!samePath(c.src, dest)) {
    fs.mkdirSync(dest, { recursive: true });
    for (const f of FILES) {
      if (fs.existsSync(path.join(c.src, f))) fs.cpSync(path.join(c.src, f), path.join(dest, f), { recursive: true, force: true });
    }
  }
  const migration = hasLegacy ? migrateData(legacyDir, dest) : [];
  const { id, browsers: registered } = registerHost(c, dest);

  const cfgFile = path.join(dest, 'data', 'config.json');
  let pictures = null;
  const cfg = configDefaults(readJson(cfgFile, {}), () => pictures || (pictures = p.picturesDir()));
  fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  fs.mkdirSync(cfg.outputDir, { recursive: true });

  const server = path.join(dest, 'mcp-server.js');
  const claudeCode = !c.clients || c.clients.includes('claude-code');
  const [mcp, legacyMcpRemoved] = claudeCode ? registerMcp(c, server) : ['not selected', false];
  const reloaded = await c.reload(dest);
  const desktopStale = p.desktopConfigFiles().some(f => desktopNeedsUpdate(f, desktopEntry(server)));
  const result = {
    version: readJson(path.join(dest, 'package.json'), {}).version || '?', dest, cfg, id, mcp, legacyDir, hasLegacy, migration,
    legacyMcpRemoved, wasInstalled, reloaded, desktopStale, desktopRunning: desktopStale ? p.desktopAppRunning() : false,
    server, registered,
  };
  if (c.report) c.log(installReport(result));
  return result;
}

// Writes the launcher and the host manifest, and registers the host under the key each installed
// browser reads first (all of them load the same unpacked extension, so they share one extension
// ID and one manifest). Also what `backdraw doctor --fix` repairs.
// Returns { id, manifest, browsers: [ids], keys: [registry keys written] }.
function registerHost(c, dest) {
  const p = c.platform;
  const id = extensionId(readJson(path.join(dest, 'extension', 'manifest.json'), {}));
  const launcher = p.writeHostLauncher(dest, NODE);
  const manifest = path.join(dest, `${identity.HOST_NAME}.json`);
  fs.writeFileSync(manifest, JSON.stringify({
    name: identity.HOST_NAME, description: identity.HOST_DESCRIPTION, path: launcher, type: 'stdio',
    allowed_origins: [`chrome-extension://${id}/`],
  }, null, 2));
  p.unregisterNativeHost(LEGACY.HOST_NAME, 'chrome');
  const targets = targetBrowsers(p, c.browsers);
  const keys = browsers.keysFor(targets).map(key => p.registerNativeHost(identity.HOST_NAME, manifest, key));
  return { id, manifest, browsers: targets, keys };
}

// ---------------------------------------------------------------- uninstall

// What --uninstall leaves alone (the folders that are there): the user's pictures and the settings/history folder.
function keptLines(dest, cfg) {
  return [['Images folder     ', cfg.outputDir], ['References folder ', cfg.collectionsDir], ['Settings, history ', path.join(dest, 'data')]]
    .filter(([, dir]) => dir && fs.existsSync(dir)).map(([label, dir]) => `  ${label}: ${dir}`);
}

// Every registry key a host registration can have: Backdraw's under each browser key, and 1.x's
// under Chrome's.
const hostEntries = () => [...Object.keys(browsers.HOST_KEYS).map(key => [identity.HOST_NAME, key]), [LEGACY.HOST_NAME, 'chrome']];

// The other MCP clients that have a Backdraw entry: [{ client, file }]. A file Backdraw can't read
// is listed with its error.
function fileClientEntries(c) {
  return mcpClients.FILE_CLIENTS.map(client => {
    try {
      const { file, entry } = mcpClients.readEntry(client, c.clientEnv);
      if (!entry) return null;
      if (client.format === 'json') mcpClients.readJsonConfig(file); // one with comments can't be rewritten
      return { client, file };
    } catch (e) { return { client, file: client.file(c.clientEnv), error: e.message }; }
  }).filter(Boolean);
}

// Lists the targets without changing anything (no registry, CLI or file writes).
function dryRunReport(c, { dest, folders, desktopFiles, cfg, others }) {
  const configFile = c.platform.claudeConfigFile(c.home);
  const inFile = c.claudeCli ? [] : mcpEntriesInFile(c);
  return ['Dry run: nothing was changed. "backdraw uninstall" would remove:',
    '  Browser host entries (where present):',
    ...hostEntries().map(([n, b]) => `    ${c.platform.nativeHostEntry(n, b)}`),
    '  Claude Code MCP entries:',
    c.claudeCli ? `    ${quoted(MCP_NAMES)} with "claude mcp remove <name> -s user" (where registered)`
      : inFile.length ? `    ${quoted(inFile)} from ${configFile}` : `    none (${configFile} has no Backdraw entry)`,
    '  Claude desktop app chat config (a backup is made first; only while Claude is closed):',
    ...(desktopFiles.length ? desktopFiles.map(f => `    ${quoted(desktopEntriesIn(f))} from ${f}`) : ['    none (no Backdraw entry)']),
    '  Other MCP clients (a backup is made first):',
    ...(others.length ? others.map(o => `    ${o.client.label}: "${mcpClients.NAME}" from ${o.file}${o.error ? ` (can't be changed: ${o.error})` : ''}`)
      : ['    none (no Backdraw entry)']),
    'It keeps:', ...keptLines(dest, cfg),
    ...folders.map(d => `  The folder ${d} itself (delete it by hand)`),
    '  The Chrome extension (remove it at chrome://extensions)',
  ].join('\n');
}

async function uninstall(ctx) {
  const c = context(ctx);
  const p = c.platform;
  const dest = p.installDir(c.home);
  const legacyDir = p.legacyInstallDir(c.home);
  const cfg = readJson(path.join(dest, 'data', 'config.json'), {}) || {};
  const desktopFiles = p.desktopConfigFiles().filter(f => desktopEntriesIn(f).length);
  const folders = [dest, legacyDir].filter(d => fs.existsSync(d));
  const others = fileClientEntries(c);
  if (c.dryRun) return c.log(dryRunReport(c, { dest, folders, desktopFiles, cfg, others }));

  for (const [name, browser] of hostEntries()) p.unregisterNativeHost(name, browser);
  const mcpRemoved = unregisterMcp(c);
  const otherLines = others.map(({ client, file, error }) => {
    if (error) return `${client.label}: left alone (${error})`;
    try { return `${client.label}: removed "${mcpClients.NAME}" from ${file} (backup: ${mcpClients.removeEntry(client, c.clientEnv).backup})`; } catch (e) { return `${client.label}: left alone (${e.message})`; }
  });
  const desktopRunning = desktopFiles.length ? p.desktopAppRunning() : false;
  const desktopLines = [];
  if (desktopRunning === false) {
    for (const file of desktopFiles) {
      try { desktopLines.push(`updated ${file} (backup: ${updateDesktopConfig(file, null, { remove: true })})`); } catch (e) { desktopLines.push(`skipped ${file}: ${e.message}`); }
    }
  }
  const steps = ['Remove the Backdraw extension at chrome://extensions.'];
  if (desktopRunning !== false) {
    steps.push(`Claude desktop app (chat): ${desktopRunning ? 'Claude is running' : 'could not tell whether Claude is running'}, so its config was left alone.
Quit Claude completely (also from the system tray), then run this again from PowerShell: ${desktopCommand(fs.existsSync(path.join(dest, 'install.js')) ? dest : c.src, '--uninstall')}`);
  }
  if (folders.length) steps.push(`Optionally delete ${folders.join(' and ')} by hand (that deletes the settings and job history too).`);
  const kept = keptLines(dest, cfg);
  c.log(['Backdraw was uninstalled.',
    `  Browser host entries: removed ${identity.HOST_NAME} (Chrome, Edge and Chromium keys; Brave reads the last two) and ${LEGACY.HOST_NAME} (where present)`,
    `  Claude Code MCP     : ${mcpRemoved.length ? `removed ${quoted(mcpRemoved)}` : 'no entry was registered'}`,
    ...(desktopLines.length ? desktopLines.map(l => `  Claude desktop app  : ${l}`)
      : [`  Claude desktop app  : ${desktopFiles.length ? 'left alone (see the next steps)' : 'no Backdraw entry'}`]),
    ...otherLines.map(l => `  ${l}`),
    ...(kept.length ? ['Kept:', ...kept] : []),
    '', 'Next steps:', ...numbered(steps)].join('\n'));
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const run = args.includes('--uninstall') ? () => uninstall({ dryRun })
    : dryRun ? () => { throw new Error('--dry-run only works together with --uninstall.'); }
      : args.includes('--desktop') ? desktop : () => install();
  Promise.resolve().then(run).catch(e => { console.error(`Setup failed: ${e.message}`); process.exitCode = 1; });
}

module.exports = {
  FILES, NODE, context, extensionId, migrateData, updateDesktopConfig, desktopNeedsUpdate, desktopEntry, desktopEntriesIn, desktopCommand,
  extensionSteps, configDefaults, registerHost, registerMcp, targetBrowsers, install, uninstall,
};
