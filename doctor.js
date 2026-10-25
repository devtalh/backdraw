'use strict';
// `backdraw doctor [--fix]`: gathers what can be checked about an install (files, host manifest,
// browser registry keys and policies, the bridge, the extension, ChatGPT, the MCP clients), prints
// it with lib/doctor.js, and with --fix repairs what is safe to repair: the host manifest, the
// registry keys, and client entries that point to the wrong place.
const fs = require('fs');
const os = require('os');
const path = require('path');
const identity = require('./identity');
const installer = require('./install');
const browsers = require('./lib/browsers');
const mcpClients = require('./lib/mcp-clients');
const report = require('./lib/doctor');
const { useColor, painter, line } = require('./lib/term');

const SELF = require('./package.json').version;
// What an install needs to run; anything else in the folder is optional.
const REQUIRED = ['package.json', 'identity.js', 'shared.js', 'host.js', 'mcp-server.js', 'cli.js', 'install.js',
  path.join('extension', 'manifest.json'), path.join('platform', 'index.js'), 'lib'];

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function commandExists(p, cmd) {
  if (typeof cmd !== 'string' || !cmd) return false;
  return path.isAbsolute(cmd) ? fs.existsSync(cmd) : !!p.which(cmd);
}

// What is wrong with the host manifest, or null.
function manifestProblem(json, dest) {
  if (!json) return 'unreadable';
  if (json.name !== identity.HOST_NAME) return `names ${json.name}, not ${identity.HOST_NAME}`;
  if (!json.path || !fs.existsSync(json.path)) return `its launcher ${json.path || '(none)'} is missing`;
  const node = (/"([^"]+node(?:\.exe)?)"/i.exec(fs.readFileSync(json.path, 'utf8')) || [])[1];
  if (node && !fs.existsSync(node)) return `its launcher starts ${node}, which is gone (Node.js moved?)`;
  const ext = readJson(path.join(dest, 'extension', 'manifest.json'));
  const origin = ext && ext.key ? `chrome-extension://${installer.extensionId(ext)}/` : null;
  if (origin && !(json.allowed_origins || []).includes(origin)) return 'it does not allow the Backdraw extension';
  return null;
}

// c: install.js context. call: the bridge's call(method, params, timeout).
async function gather(c, call) {
  const p = c.platform;
  const dest = p.installDir(c.home);
  const pkg = readJson(path.join(dest, 'package.json'));
  const ext = readJson(path.join(dest, 'extension', 'manifest.json'));
  const exists = fs.existsSync(dest);
  const facts = {
    node: process.version, self: { version: SELF }, hostName: identity.HOST_NAME,
    install: {
      dir: dest, exists, missing: exists ? REQUIRED.filter(f => !fs.existsSync(path.join(dest, f))) : [],
      version: pkg && pkg.version, extensionVersion: ext && ext.version,
    },
  };

  const manifestFile = path.join(dest, `${identity.HOST_NAME}.json`);
  const manifestThere = fs.existsSync(manifestFile);
  facts.hostManifest = { file: manifestFile, exists: manifestThere, problem: manifestThere ? manifestProblem(readJson(manifestFile), dest) : null };

  let reg = null;
  try { reg = p.parseBrowserRegistry(p.readBrowserRegistry(identity.HOST_NAME)); } catch (e) { facts.registryError = e.message.split('\n')[0]; }
  const targets = installer.targetBrowsers(p); // Chrome, and every other browser that is installed
  facts.browsers = browsers.BROWSERS.map(b => ({
    id: b.id, name: b.name, target: targets.includes(b.id),
    registration: reg ? browsers.effectiveHost(b, reg.hosts) : null, policies: reg ? reg.policies[b.id] : null,
  }));

  try {
    facts.bridge = { ok: true, status: await call('status', {}, 5000) };
  } catch (e) {
    facts.bridge = { ok: false, code: e.code, error: e.message };
  }
  if (facts.bridge.ok && facts.bridge.status.extension) {
    try { facts.chatgpt = await call('chatgpt_state', {}, 15000); } catch (e) {
      facts.chatgpt = { error: e.code === 'BAD_REQUEST' ? 'the running host is older than this version' : e.message };
    }
  }

  const server = path.join(dest, 'mcp-server.js');
  const problem = entry => (entry ? mcpClients.entryProblem(entry, server, cmd => commandExists(p, cmd)) : null);
  const claudeFile = p.claudeConfigFile(c.home);
  const claudeEntry = ((readJson(claudeFile) || {}).mcpServers || {})[identity.MCP_NAME] || null;
  facts.clients = [{
    id: 'claude-code', label: 'Claude Code', detected: !!c.claudeCli || fs.existsSync(claudeFile), entry: claudeEntry, problem: problem(claudeEntry),
  }];
  for (const client of mcpClients.FILE_CLIENTS) {
    const fact = { id: client.id, label: client.label, detected: client.detect(c.clientEnv) };
    try {
      fact.entry = mcpClients.readEntry(client, c.clientEnv).entry;
      fact.problem = problem(fact.entry);
    } catch (e) { fact.error = e.message; }
    facts.clients.push(fact);
  }

  const desktopFiles = p.desktopConfigFiles();
  facts.desktop = {
    files: desktopFiles.map(file => {
      const json = readJson(file);
      if (!json) return { file, error: `${file} is not valid JSON` };
      const entry = (json.mcpServers || {})[identity.MCP_NAME] || null;
      return { file, entry, problem: problem(entry) };
    }),
    running: desktopFiles.length ? p.desktopAppRunning() : false,
  };
  return facts;
}

// Repairs what `--fix` may: returns { fixed: [...], failed: [...] } lines.
function fix(c, facts) {
  const fixed = [];
  const failed = [];
  const dest = facts.install.dir;
  if (!facts.install.exists || facts.install.missing.length) {
    return { fixed, failed: [`The install folder is incomplete; run: ${report.SETUP}`] };
  }
  const server = path.join(dest, 'mcp-server.js');
  // The manifest can be rewritten even when the registry couldn't be read; registering again
  // doesn't need that read either.
  const manifestBad = !facts.hostManifest.exists || !!facts.hostManifest.problem;
  const registryBad = !facts.registryError && facts.browsers.some(b => b.target && (!b.registration
    || path.resolve(b.registration.path).toLowerCase() !== path.resolve(facts.hostManifest.file).toLowerCase()));
  if (manifestBad || registryBad) {
    try {
      const r = installer.registerHost(c, dest);
      fixed.push(`Rewrote the host manifest and registered it for ${r.browsers.map(b => browsers.byId(b).name).join(', ')}.`);
    } catch (e) { failed.push(`Couldn't register the native host: ${e.message}`); }
  }
  for (const client of facts.clients.filter(x => x.entry && x.problem)) {
    try {
      if (client.id === 'claude-code') installer.registerMcp(c, server);
      else mcpClients.addEntry(mcpClients.byId(client.id), c.clientEnv, installer.NODE, server);
      fixed.push(`${client.label}: the Backdraw entry now starts ${server}.`);
    } catch (e) { failed.push(`${client.label}: ${e.message}`); }
  }
  for (const file of facts.desktop.files.filter(x => x.entry && x.problem)) {
    if (facts.desktop.running !== false) { failed.push('Claude desktop app: it is running; quit it completely (also from the system tray) and run this again.'); continue; }
    try {
      installer.updateDesktopConfig(file.file, installer.desktopEntry(server));
      fixed.push(`Claude desktop app: updated ${file.file} (a backup was made).`);
    } catch (e) { failed.push(`Claude desktop app: ${e.message}`); }
  }
  return { fixed, failed };
}

// The tag in the pipe's name (the Windows user name), masked like the home folder.
function userTag(p) {
  try { return (/backdraw-(.+)$/.exec(p.pipePath()) || [])[1] || null; } catch { return null; }
}

async function doctor(opts = {}, deps = {}) {
  const log = deps.log || (text => console.log(text));
  const color = deps.color !== undefined ? deps.color : useColor();
  const c = installer.context({ ...(deps.ctx || {}), report: false });
  const call = deps.call || require('./shared').call;
  const hide = text => report.mask(text, c.home, userTag(c.platform));
  let facts = await gather(c, call);
  if (opts.fix) {
    const { fixed, failed } = fix(c, facts);
    const paint = painter(color);
    if (!fixed.length && !failed.length) log('Nothing to fix.');
    for (const l of fixed) log(hide(line(paint, 'ok', 'Fixed:', l)));
    for (const l of failed) log(hide(line(paint, 'fail', 'Not fixed:', l)));
    log('');
    facts = await gather(c, call);
  }
  const checks = report.evaluate(facts);
  const header = `Backdraw doctor ${SELF} · Node ${process.version} · ${os.type()} ${os.release()}`;
  log(hide(report.format(checks, { header, color })));
  return checks;
}

module.exports = { REQUIRED, gather, fix, doctor };
