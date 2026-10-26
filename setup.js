'use strict';
// `backdraw setup` (npx backdraw@latest setup): installs Backdraw into %USERPROFILE%\.backdraw (npx's
// own copy is temporary), registers the native host for the installed browsers, adds Backdraw to
// the MCP clients the user picks, then walks through loading the extension and waits for it.
//   --yes                 no questions: every client that was found (on an update: every client that
//                         already has a Backdraw entry; new clients only with --clients or by picking them)
//   --clients=a,b         exactly these (ids: see CLIENT_IDS); --clients=none: none, the browser side only
// An entry that starts Backdraw through npx stays as it is (npx fetches the new version itself).
//   --browser=edge        the browser to load the extension in (default: the first one found)
//   --no-wait             don't wait for the extension to connect
const fs = require('fs');
const path = require('path');
const identity = require('./identity');
const installer = require('./install');
const browsers = require('./lib/browsers');
const mcpClients = require('./lib/mcp-clients');
const { useColor, painter, line } = require('./lib/term');

const SELF = require('./package.json').version;
const CLIENT_IDS = ['claude-code', 'claude-desktop', ...mcpClients.FILE_CLIENTS.map(c => c.id)];
const WAIT_MS = 180000;
const EXAMPLE = 'Generate an image with ChatGPT: a cozy reading nook by a rainy window, warm lamp light.';

// Every client setup knows, and whether it is on this PC.
function detectClients(c) {
  const p = c.platform;
  return [
    { id: 'claude-code', label: 'Claude Code', detected: !!c.claudeCli || fs.existsSync(p.claudeConfigFile(c.home)) },
    { id: 'claude-desktop', label: 'Claude desktop app', detected: p.desktopConfigFiles().length > 0 },
    ...mcpClients.FILE_CLIENTS.map(client => ({ id: client.id, label: client.label, detected: client.detect(c.clientEnv) })),
  ];
}

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// The Backdraw entries the clients have now: { id: [entry, …] } (the desktop app can have two
// config files). A client whose file can't be read counts as having none.
function existingEntries(c) {
  const p = c.platform;
  const found = {};
  const claude = ((readJson(p.claudeConfigFile(c.home)) || {}).mcpServers || {})[identity.MCP_NAME];
  if (claude) found['claude-code'] = [claude];
  const desktop = p.desktopConfigFiles().map(file => ((readJson(file) || {}).mcpServers || {})[identity.MCP_NAME]).filter(Boolean);
  if (desktop.length) found['claude-desktop'] = desktop;
  for (const client of mcpClients.FILE_CLIENTS) {
    try {
      const { entry } = mcpClients.readEntry(client, c.clientEnv);
      if (entry) found[client.id] = [entry];
    } catch {}
  }
  return found;
}

// The npx package a client's entry runs ("backdraw@latest"), or null when it starts a local file.
const npxOf = entries => (entries && entries.length && entries.every(e => mcpClients.npxSpec(e)) ? mcpClients.npxSpec(entries[0]) : null);

function parseClientList(value) {
  if (value === true || value === '') throw new Error(`--clients needs a list, e.g. --clients=claude-code,cursor (one of: ${CLIENT_IDS.join(', ')}).`);
  const ids = String(value).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (ids.length === 1 && ids[0] === 'none') return []; // the browser side only (e.g. the Claude Code plugin)
  const unknown = ids.filter(id => !CLIENT_IDS.includes(id));
  if (unknown.length) throw new Error(`Unknown client ${unknown.join(', ')}; use: ${CLIENT_IDS.join(', ')}.`);
  return [...new Set(ids)];
}

// The answer to the client question: '' = the default ones (the found ones, or on an update the
// ones already set up), "none"/"0", or numbers like "1,3". Returns the ids, or null for an answer
// that doesn't parse.
function parseChoice(answer, found, dflt = found.filter(f => f.detected).map(f => f.id)) {
  const a = String(answer || '').trim().toLowerCase();
  if (!a) return dflt;
  if (a === 'none' || a === '0') return [];
  const nums = a.split(/[\s,]+/).filter(Boolean).map(Number);
  if (nums.some(n => !Number.isInteger(n) || n < 1 || n > found.length)) return null;
  return [...new Set(nums.map(n => found[n - 1].id))];
}

// had: on an update, the clients that already have a Backdraw entry (they are the default then).
async function chooseClients(found, ask, log, had = null) {
  log('MCP clients on this PC:');
  found.forEach((f, i) => log(`  ${i + 1}. ${f.label.padEnd(20)} ${had && had[f.id] ? 'set up' : f.detected ? 'found' : 'not found'}`));
  const dfltIds = had ? found.filter(f => had[f.id]).map(f => f.id) : found.filter(f => f.detected).map(f => f.id);
  const dflt = found.map((f, i) => (dfltIds.includes(f.id) ? i + 1 : null)).filter(Boolean);
  const what = had ? 'the ones already set up' : 'the found ones';
  for (let tries = 0; tries < 3; tries++) {
    const ids = parseChoice(await ask(`Add Backdraw to which? Enter = ${what} (${dflt.join(', ') || 'none'}), numbers like 1,3, or "none": `), found, dfltIds);
    if (ids) return ids;
    log(`Please answer with numbers from 1 to ${found.length}, or "none".`);
  }
  throw new Error('No valid answer; run setup again, or pass --clients=… or --yes.');
}

// onlySetUp: on an update without --clients, only the config files that already have an entry.
// A file whose entry starts npx is kept as it is.
function addToDesktop(c, server, onlySetUp = false) {
  const p = c.platform;
  const entryIn = file => ((readJson(file) || {}).mcpServers || {})[identity.MCP_NAME] || null;
  const all = p.desktopConfigFiles().filter(file => !onlySetUp || entryIn(file));
  const kept = all.filter(file => mcpClients.npxSpec(entryIn(file)));
  const files = all.filter(file => !kept.includes(file));
  const keptLines = kept.map(file => ['ok', `kept as it is: starts via npx (${mcpClients.npxSpec(entryIn(file))}; ${file})`]);
  if (!files.length && kept.length) return keptLines;
  if (!files.length) return [['warn', 'no Claude desktop config was found; start the app once, then run: npx backdraw@latest setup --clients=claude-desktop']];
  // Nothing to change needs no closed app (an unreadable file goes on, to say why it is skipped).
  const entry = installer.desktopEntry(server);
  if (!files.some(file => !readJson(file) || installer.desktopNeedsUpdate(file, entry))) return keptLines.concat([['ok', 'already set up']]);
  const running = p.desktopAppRunning();
  if (running !== false) {
    return [...keptLines, ['warn', `${running ? 'Claude is running' : 'couldn\'t tell whether Claude is running'}, so its config was left alone. Quit Claude completely (also from the system tray), then run: npx backdraw@latest setup --clients=claude-desktop`]];
  }
  return keptLines.concat(files.map(file => {
    try {
      const had = entryIn(file);
      const backup = installer.updateDesktopConfig(file, entry);
      return ['ok', backup ? `${had ? 'updated' : 'added'} (${file}; backup ${path.basename(backup)})` : 'already set up'];
    } catch (e) { return ['fail', `${file}: ${e.message}`]; }
  }));
}

function addToFileClient(c, id, server) {
  try {
    const r = mcpClients.addEntry(mcpClients.byId(id), c.clientEnv, installer.NODE, server);
    if (r.status === 'unchanged') return ['ok', `already set up (${r.file})`];
    return ['ok', `${r.status} (${r.file}${r.backup ? `; backup ${path.basename(r.backup)}` : ''})`];
  } catch (e) { return ['fail', e.message]; }
}

// Polls the bridge until the extension is connected (and, with `version`, runs that version).
// Resolves to its status, or null on a timeout or when skipped (Ctrl+C).
function waitForExtension(call, { timeoutMs = WAIT_MS, intervalMs = 2000, onSigint = true, version = null } = {}) {
  return new Promise(resolve => {
    let done = false;
    let timer = null;
    const finish = value => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (onSigint) process.removeListener('SIGINT', skip);
      resolve(value);
    };
    const skip = () => finish(null);
    if (onSigint) process.on('SIGINT', skip);
    const deadline = Date.now() + timeoutMs;
    // A Ctrl+C can arrive while a call is still out: then nothing may poll again.
    const poll = async () => {
      if (done) return;
      try {
        const status = await call('status', {}, 3000);
        if (status && status.extension && (!version || status.extension.version === version)) return finish(status);
      } catch {}
      if (done) return;
      if (Date.now() >= deadline) return finish(null);
      timer = setTimeout(poll, intervalMs);
    };
    poll();
  });
}

async function connectedStatus(call) {
  try {
    const status = await call('status', {}, 3000);
    return status && status.extension ? status : null;
  } catch { return null; }
}

// deps (tests): ctx (install.js context), call (bridge), ask (question -> answer; none = no TTY),
// log, color, waitMs.
async function setup(opts = {}, deps = {}) {
  const log = deps.log || (text => console.log(text));
  const paint = painter(deps.color !== undefined ? deps.color : useColor());
  const say = (status, label, detail) => log(line(paint, status, label, detail, 20));
  const call = deps.call || require('./shared').call;
  const base = { ...(deps.ctx || {}), report: false };
  const c = installer.context(base);
  const p = c.platform;

  let browser = null;
  if (opts.browser !== undefined) {
    browser = browsers.byId(String(opts.browser).toLowerCase());
    if (!browser) throw new Error(`--browser takes one of: ${browsers.BROWSERS.map(b => b.id).join(', ')}.`);
  }

  log(paint('bold', `Backdraw ${SELF} setup`));
  log('');
  const found = detectClients(c);
  // An update (Backdraw is installed already) without --clients touches only the clients that
  // already start Backdraw; adding a new one takes --clients or picking it on the terminal.
  const updating = fs.existsSync(path.join(p.installDir(c.home), 'extension', 'manifest.json'));
  const had = existingEntries(c);
  const onlySetUp = updating && opts.clients === undefined;
  let chosen;
  if (opts.clients !== undefined) chosen = parseClientList(opts.clients);
  else if (opts.yes || !deps.ask) chosen = updating ? CLIENT_IDS.filter(id => had[id]) : found.filter(f => f.detected).map(f => f.id);
  else { chosen = await chooseClients(found, deps.ask, log, updating ? had : null); log(''); }
  // An npx entry keeps starting npx; only a local one is pointed at the new files.
  const keepClaudeCode = chosen.includes('claude-code') && npxOf(had['claude-code']);

  const r = await installer.install({ ...base, clients: chosen.filter(id => !(id === 'claude-code' && keepClaudeCode)), browsers: browser ? [browser.id] : [] });
  say('ok', 'Installed', `${r.dest} (${r.version})`);
  for (const m of r.migration.filter(x => x.startsWith('copied '))) say('ok', 'Migrated', m.replace(/^copied /, ''));
  if (r.hasLegacy) say('info', 'Old folder', `${r.legacyDir} is no longer used; delete it by hand once Backdraw works`);
  say('ok', 'Native host', `registered for ${r.registered.map(b => browsers.byId(b).name).join(', ')}`);

  const labels = Object.fromEntries(found.map(f => [f.id, f.label]));
  const keptNpx = spec => `kept as it is: starts via npx (${spec})`;
  for (const id of chosen) {
    if (id === 'claude-code') say('ok', labels[id], keepClaudeCode ? keptNpx(keepClaudeCode) : `${had[id] ? 'updated' : 'added'} (user scope)`);
    else if (id === 'claude-desktop') for (const [status, detail] of addToDesktop(c, r.server, onlySetUp)) say(status, labels[id], detail);
    else if (npxOf(had[id])) say('ok', labels[id], keptNpx(npxOf(had[id])));
    else {
      const [status, detail] = addToFileClient(c, id, r.server);
      say(status, labels[id], detail);
    }
  }
  if (onlySetUp) {
    for (const f of found.filter(x => x.detected && !chosen.includes(x.id))) {
      say('info', f.label, `skipped: it has no Backdraw entry (add it with: npx backdraw@latest setup --clients=${f.id})`);
    }
  }
  if (!chosen.length) {
    say(onlySetUp ? 'info' : 'warn', 'MCP clients', `${onlySetUp ? 'none had a Backdraw entry, so none was changed' : 'none chosen'}; add one later with: npx backdraw@latest setup --clients=${CLIENT_IDS[0]}`);
  }

  // A reloaded extension needs a few seconds to start the new host; until then the old one may
  // still answer with the old version.
  let status = r.reloaded
    ? await waitForExtension(call, { timeoutMs: deps.reloadWaitMs || 20000, intervalMs: deps.intervalMs || 1000, onSigint: false, version: r.version })
      || await connectedStatus(call)
    : await connectedStatus(call);
  if (status && status.extension.version !== r.version) {
    say('warn', 'Extension', `${status.extension.version} is still running; reload Backdraw at chrome://extensions to start ${r.version}`);
  } else if (status) say('ok', 'Extension', `${status.extension.version} connected${r.reloaded ? ' (reloaded with the new files)' : ''}`);

  if (!status) {
    // The one named with --browser, else the first one installed (Chrome comes first).
    if (!browser) browser = browsers.byId(p.detectBrowsers()[0] || 'chrome');
    const folder = path.join(r.dest, 'extension');
    try { p.openFolder(folder); } catch {}
    const copied = p.copyToClipboard(folder);
    const opened = p.openInBrowser(browser.id, browser.page);
    log('');
    log(paint('bold', `Load the extension in ${browser.name} (once):`));
    log(`  1. ${opened ? `${browser.page} is opening; turn` : `Open ${browser.page} and turn`} on "Developer mode" (top right).`);
    log('  2. Click "Load unpacked".');
    log(`  3. Pick the folder ${folder}${copied ? ' (the path is on your clipboard: paste it with Ctrl+V)' : ''}.`);
    if (opts.wait === false) {
      log('');
      say('info', 'Extension', 'not waiting (--no-wait); check later with: npx backdraw@latest doctor');
    } else {
      log('');
      log(`Waiting for the extension to connect (up to ${Math.round((deps.waitMs || WAIT_MS) / 60000)} min; Ctrl+C skips)…`);
      status = await waitForExtension(call, { timeoutMs: deps.waitMs || WAIT_MS, intervalMs: deps.intervalMs, onSigint: !deps.call });
      if (status) say('ok', 'Extension', `${status.extension.version} connected`);
      else say('warn', 'Extension', 'not connected yet; once it is loaded, check with: npx backdraw@latest doctor');
    }
  }

  log('');
  if (status) {
    log(paint('ok', '✓ Ready.'));
    if (!status.project) log('One more step: click the Backdraw icon in the toolbar and pick a ChatGPT Project (its checklist shows how).');
  }
  if (chosen.length) {
    log('Start a new session in your MCP client (Backdraw is loaded when a session starts) and say:');
    log(`  "${EXAMPLE}"`);
  }
  return { result: r, chosen, status };
}

module.exports = { CLIENT_IDS, detectClients, existingEntries, parseClientList, parseChoice, waitForExtension, setup };
