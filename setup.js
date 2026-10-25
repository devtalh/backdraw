'use strict';
// `backdraw setup` (npx backdraw@latest setup): installs Backdraw into %USERPROFILE%\.backdraw (npx's
// own copy is temporary), registers the native host for the installed browsers, adds Backdraw to
// the MCP clients the user picks, then walks through loading the extension and waits for it.
//   --yes                 no questions: every client that was found
//   --clients=a,b         exactly these (ids: see CLIENT_IDS)
//   --browser=edge        the browser to load the extension in (default: the first one found)
//   --no-wait             don't wait for the extension to connect
const fs = require('fs');
const path = require('path');
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

function parseClientList(value) {
  if (value === true || value === '') throw new Error(`--clients needs a list, e.g. --clients=claude-code,cursor (one of: ${CLIENT_IDS.join(', ')}).`);
  const ids = String(value).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const unknown = ids.filter(id => !CLIENT_IDS.includes(id));
  if (unknown.length) throw new Error(`Unknown client ${unknown.join(', ')}; use: ${CLIENT_IDS.join(', ')}.`);
  return [...new Set(ids)];
}

// The answer to the client question: '' = the found ones, "none"/"0", or numbers like "1,3".
// Returns the ids, or null for an answer that doesn't parse.
function parseChoice(answer, found) {
  const a = String(answer || '').trim().toLowerCase();
  if (!a) return found.filter(f => f.detected).map(f => f.id);
  if (a === 'none' || a === '0') return [];
  const nums = a.split(/[\s,]+/).filter(Boolean).map(Number);
  if (nums.some(n => !Number.isInteger(n) || n < 1 || n > found.length)) return null;
  return [...new Set(nums.map(n => found[n - 1].id))];
}

async function chooseClients(found, ask, log) {
  log('MCP clients on this PC:');
  found.forEach((f, i) => log(`  ${i + 1}. ${f.label.padEnd(20)} ${f.detected ? 'found' : 'not found'}`));
  const dflt = found.map((f, i) => (f.detected ? i + 1 : null)).filter(Boolean);
  for (let tries = 0; tries < 3; tries++) {
    const ids = parseChoice(await ask(`Add Backdraw to which? Enter = the found ones (${dflt.join(', ') || 'none'}), numbers like 1,3, or "none": `), found);
    if (ids) return ids;
    log(`Please answer with numbers from 1 to ${found.length}, or "none".`);
  }
  throw new Error('No valid answer; run setup again, or pass --clients=… or --yes.');
}

function addToDesktop(c, server) {
  const p = c.platform;
  const files = p.desktopConfigFiles();
  if (!files.length) return [['warn', 'no Claude desktop config was found; start the app once, then run: npx backdraw@latest setup --clients=claude-desktop']];
  const running = p.desktopAppRunning();
  if (running !== false) {
    return [['warn', `${running ? 'Claude is running' : 'couldn\'t tell whether Claude is running'}, so its config was left alone. Quit Claude completely (also from the system tray), then run: npx backdraw@latest setup --clients=claude-desktop`]];
  }
  return files.map(file => {
    try {
      const backup = installer.updateDesktopConfig(file, installer.desktopEntry(server));
      return ['ok', backup ? `added (${file}; backup ${path.basename(backup)})` : 'already set up'];
    } catch (e) { return ['fail', `${file}: ${e.message}`]; }
  });
}

function addToFileClient(c, id, server) {
  try {
    const r = mcpClients.addEntry(mcpClients.byId(id), c.clientEnv, installer.NODE, server);
    if (r.status === 'unchanged') return ['ok', `already set up (${r.file})`];
    return ['ok', `${r.status} (${r.file}${r.backup ? `; backup ${path.basename(r.backup)}` : ''})`];
  } catch (e) { return ['fail', e.message]; }
}

// Polls the bridge until the extension is connected. Resolves to its status, or null on a timeout
// or when skipped (Ctrl+C, or deps.skip).
function waitForExtension(call, { timeoutMs = WAIT_MS, intervalMs = 2000, onSigint = true } = {}) {
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
    const poll = async () => {
      try {
        const status = await call('status', {}, 3000);
        if (status && status.extension) return finish(status);
      } catch {}
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

  log(paint('bold', `Backdraw ${SELF} setup`));
  log('');
  const found = detectClients(c);
  let chosen;
  if (opts.clients !== undefined) chosen = parseClientList(opts.clients);
  else if (opts.yes || !deps.ask) chosen = found.filter(f => f.detected).map(f => f.id);
  else { chosen = await chooseClients(found, deps.ask, log); log(''); }

  const r = await installer.install({ ...base, clients: chosen });
  say('ok', 'Installed', `${r.dest} (${r.version})`);
  for (const m of r.migration.filter(x => x.startsWith('copied '))) say('ok', 'Migrated', m.replace(/^copied /, ''));
  if (r.hasLegacy) say('info', 'Old folder', `${r.legacyDir} is no longer used; delete it by hand once Backdraw works`);
  say('ok', 'Native host', `registered for ${r.registered.map(b => browsers.byId(b).name).join(', ')}`);

  const labels = Object.fromEntries(found.map(f => [f.id, f.label]));
  for (const id of chosen) {
    if (id === 'claude-code') say('ok', labels[id], 'added (user scope)');
    else if (id === 'claude-desktop') for (const [status, detail] of addToDesktop(c, r.server)) say(status, labels[id], detail);
    else {
      const [status, detail] = addToFileClient(c, id, r.server);
      say(status, labels[id], detail);
    }
  }
  if (!chosen.length) say('warn', 'MCP clients', `none chosen; add one later with: npx backdraw@latest setup --clients=${CLIENT_IDS[0]}`);

  // A reloaded extension needs a few seconds to start the host again.
  let status = r.reloaded
    ? await waitForExtension(call, { timeoutMs: deps.reloadWaitMs || 20000, intervalMs: deps.intervalMs || 1000, onSigint: false })
    : await connectedStatus(call);
  if (status) say('ok', 'Extension', `${status.extension.version} connected${r.reloaded ? ' (reloaded with the new files)' : ''}`);

  if (!status) {
    const browserId = opts.browser && opts.browser !== true ? String(opts.browser).toLowerCase() : r.registered[0];
    const browser = browsers.byId(browserId) || browsers.byId('chrome');
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

module.exports = { CLIENT_IDS, detectClients, parseClientList, parseChoice, waitForExtension, setup };
