'use strict';
// `backdraw doctor`: turns the facts doctor.js gathered into checks (✓ / ⚠ / ✗, each with a one-line
// fix) and prints them so the output can be pasted into an issue: the home folder, which holds the
// user name, is shown as "~", and project names, prompts and chat links are never printed.
const path = require('path');
const { policyProblem } = require('./browsers');
const { painter, line } = require('./term');

const SETUP = 'npx backdraw@latest setup';
const FIX = 'npx backdraw@latest doctor --fix';

// Compares "2.1.0"-style versions: > 0 when a is newer.
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

const samePath = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// facts: see gather() in doctor.js. Returns [{ status, label, detail, fix, fixable }].
function evaluate(f) {
  const checks = [];
  const add = (status, label, detail, fix = '', fixable = false) => checks.push({ status, label, detail, fix, fixable });

  const major = Number((/^v?(\d+)/.exec(f.node) || [])[1]);
  if (major >= 20) add('ok', 'Node.js', f.node);
  else add('fail', 'Node.js', `${f.node} is too old`, 'Install Node.js 20 or newer (nodejs.org).');

  const inst = f.install;
  if (!inst.exists) add('fail', 'Install folder', `${inst.dir} is missing`, `Run: ${SETUP}`);
  else if (inst.missing.length) add('fail', 'Install folder', `${inst.dir} lacks ${inst.missing.join(', ')}`, `Run: ${SETUP}`);
  else add('ok', 'Install folder', `${inst.dir} (${inst.version})`);

  if (inst.exists && inst.version) {
    if (inst.extensionVersion && inst.extensionVersion !== inst.version) {
      add('fail', 'Version', `program ${inst.version}, extension files ${inst.extensionVersion}`, `Run: ${SETUP}`);
    } else if (compareVersions(f.self.version, inst.version) > 0) {
      add('warn', 'Version', `${inst.version} is installed; this is ${f.self.version}`, `Update: ${SETUP}`);
    } else {
      add('ok', 'Version', inst.version);
    }
  }

  const hm = f.hostManifest;
  if (inst.exists) {
    if (!hm.exists) add('fail', 'Host manifest', 'missing', FIX, true);
    else if (hm.problem) add('fail', 'Host manifest', hm.problem, FIX, true);
    else add('ok', 'Host manifest', hm.file);
  }

  if (f.registryError) add('warn', 'Browsers', `couldn't read the registry (${f.registryError})`);
  else if (!f.browsers.some(b => b.installed)) add('warn', 'Browsers', 'no Chrome, Edge, Brave or Chromium was found in the usual folders');
  for (const b of f.registryError ? [] : f.browsers.filter(x => x.installed)) {
    const reg = b.registration;
    if (!reg) add(b.id === 'chrome' ? 'fail' : 'warn', b.name, 'the native host is not registered', FIX, inst.exists);
    else if (!samePath(reg.path, hm.file)) add('fail', b.name, `the native host points to ${reg.path}`, FIX, inst.exists);
    else add('ok', b.name, `native host registered (${reg.key} key)`);
    const blocked = policyProblem(b.policies, f.hostName);
    if (blocked) add('fail', `${b.name} policy`, blocked, `Backdraw can't run in ${b.name} until an administrator allows it.`);
  }

  const br = f.bridge;
  if (!br.ok) {
    add('fail', 'Bridge', br.code === 'NOT_RUNNING' ? 'not running: the browser is closed, or the extension is not loaded or turned on' : br.error,
      `Open Chrome. Not loaded yet? Run ${SETUP}; turned off? Turn Backdraw on at chrome://extensions.`);
  } else {
    add('ok', 'Bridge', `host ${br.status.hostVersion} answers on the named pipe`);
  }

  if (br.ok) {
    const ext = br.status.extension;
    if (!ext) add('fail', 'Extension', 'not connected', 'Turn Backdraw on at chrome://extensions, or reload it there.');
    else if (inst.version && ext.version !== inst.version) add('warn', 'Extension', `${ext.version} is running; the files are ${inst.version}`, 'Reload Backdraw at chrome://extensions.');
    else add('ok', 'Extension', `${ext.version} connected`);

    const chat = f.chatgpt || {};
    if (chat.error) add('warn', 'ChatGPT', `couldn't ask the extension (${chat.error})`, 'Click the Backdraw icon in Chrome to see the sign-in state.');
    else if (chat.challenge) add('fail', 'ChatGPT', 'shows a human verification page', 'Open chatgpt.com in Chrome and complete it yourself.');
    else if (chat.loggedIn === false) add('fail', 'ChatGPT', 'signed out', 'Sign in at chatgpt.com in Chrome.');
    else if (chat.loggedIn === true) add('ok', 'ChatGPT', 'signed in');
    else add('warn', 'ChatGPT', 'not checked yet', 'Click the Backdraw icon in Chrome and press "Check now".');

    if (br.status.project) add('ok', 'Project', 'a ChatGPT Project is selected');
    else add('fail', 'Project', 'no ChatGPT Project is selected', 'Click the Backdraw icon in Chrome and choose a Project.');
  } else {
    for (const label of ['Extension', 'ChatGPT', 'Project']) add('info', label, 'not checked (the bridge is not running)');
  }

  for (const c of f.clients) {
    if (c.error) add('warn', c.label, c.error);
    else if (c.entry && c.problem) add('fail', c.label, c.problem, FIX, true);
    else if (c.entry) add('ok', c.label, 'set up for this install');
    else if (c.detected) add('warn', c.label, 'Backdraw is not added', `Run: ${SETUP} --clients=${c.id}`);
  }

  const d = f.desktop;
  for (const file of d.files) {
    // The Store (MSIX) app keeps its own copy of the config next to the classic one.
    const label = d.files.length > 1 ? `Claude desktop (${/\\Packages\\/i.test(file.file) ? 'Store' : 'classic'})` : 'Claude desktop app';
    if (file.error) add('warn', label, file.error);
    else if (file.entry && file.problem) {
      add('fail', label, file.problem, d.running === false ? FIX : `Quit Claude completely (also from the system tray), then run: ${FIX}`, d.running === false);
    } else if (file.entry) add('ok', label, 'set up for this install');
    else add('warn', label, 'Backdraw is not added', `Quit Claude completely (also from the system tray), then run: ${SETUP} --clients=claude-desktop`);
  }
  if (d.files.length && d.running) add('info', 'Claude desktop app', 'running (Backdraw only changes its config while it is closed)');

  return checks;
}

// The user's home folder (in the forms it is printed in) as "~", and the pipe's user tag.
function mask(text, home, userTag) {
  let out = String(text);
  if (home) {
    const forms = new Set([home, home.replace(/\\/g, '/'), home.replace(/\\/g, '\\\\')]);
    for (const form of [...forms].sort((a, b) => b.length - a.length)) {
      out = out.replace(new RegExp(form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '~');
    }
  }
  if (userTag) out = out.split(`backdraw-${userTag}`).join('backdraw-~');
  return out;
}

function format(checks, { header, color = false } = {}) {
  const paint = painter(color);
  const width = Math.max(...checks.map(c => c.label.length));
  const lines = header ? [header, ''] : [];
  for (const c of checks) {
    lines.push(line(paint, c.status, c.label, c.detail, width));
    if (c.fix) lines.push(`  ${' '.repeat(width)} → ${c.fix}`);
  }
  const fails = checks.filter(c => c.status === 'fail').length;
  const warns = checks.filter(c => c.status === 'warn').length;
  const fixable = checks.filter(c => c.fixable).length;
  lines.push('', fails || warns
    ? `${fails} problem${fails === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}.${fixable ? ` "${FIX}" can repair ${fixable} of them.` : ''}`
    : 'Everything looks good.');
  return lines.join('\n');
}

module.exports = { compareVersions, evaluate, mask, format, SETUP, FIX };
