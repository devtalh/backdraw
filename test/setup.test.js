'use strict';
// The popup's setup checklist: the pure helpers (setup.js, i18n.js, menus.js) in Node, and the
// worker's ChatGPT sign-in check in a vm with stand-ins for chrome.* and a virtual clock.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const setup = require('../extension/setup');
const i18n = require('../extension/i18n');
const { centreOver } = require('../extension/menus');

const EXT = path.join(__dirname, '..', 'extension');
const read = f => fs.readFileSync(path.join(EXT, f), 'utf8');
const en = (key, vars) => i18n.translate('en', key, vars);

// ---------------------------------------------------------------- setup.js

const steps = (s, ack) => Object.fromEntries(setup.setupSteps(s, ack).steps.map(x => [x.id, x.state]));
const PROJECT = { name: 'Backdraw', url: 'https://chatgpt.com/g/g-p-0123abcd/project' };

test('setup steps: no answer from the worker: the bridge is the problem, the rest waits', () => {
  assert.deepEqual(steps(null, false), { bridge: 'todo', chatgpt: 'wait', project: 'wait', ready: 'wait' });
  assert.deepEqual(setup.setupSteps(null, true).wizard, true);
});

test('setup steps: connected, ChatGPT unknown or signed out, no project', () => {
  assert.deepEqual(steps({ connected: true }, false), { bridge: 'done', chatgpt: 'wait', project: 'todo', ready: 'wait' });
  assert.deepEqual(steps({ connected: true, chatgpt: { loggedIn: false } }, false), { bridge: 'done', chatgpt: 'todo', project: 'todo', ready: 'wait' });
  // A verification page needs the user even when the account is signed in.
  assert.equal(steps({ connected: true, chatgpt: { loggedIn: true, challenge: 'captcha' } }).chatgpt, 'todo');
});

test('setup steps: everything done: the last step waits for "Done" once, then the checklist steps aside', () => {
  const s = { connected: true, chatgpt: { loggedIn: true, challenge: null }, project: PROJECT };
  assert.deepEqual(setup.setupSteps(s, false), { steps: [
    { id: 'bridge', state: 'done' }, { id: 'chatgpt', state: 'done' }, { id: 'project', state: 'done' }, { id: 'ready', state: 'todo' },
  ], wizard: true, done: 3 });
  assert.deepEqual(setup.setupSteps(s, true).wizard, false);
  assert.equal(setup.setupSteps(s, true).done, 4);
  // Something breaks later: the checklist comes back.
  assert.equal(setup.setupSteps({ ...s, connected: false }, true).wizard, true);
  assert.equal(setup.setupSteps({ ...s, chatgpt: { loggedIn: false } }, true).wizard, true);
  // Not knowing (e.g. no check since the install) does not bring it back.
  assert.equal(setup.setupSteps({ ...s, chatgpt: { loggedIn: null } }, true).wizard, false);
});

test('project from the active tab: a project page or a chat inside it, nothing else', () => {
  assert.deepEqual(setup.projectFromTab({ url: 'https://chatgpt.com/g/g-p-0123abcd-images/project', title: 'Images - ChatGPT' }),
    { url: 'https://chatgpt.com/g/g-p-0123abcd-images/project', name: 'Images' });
  assert.deepEqual(setup.projectFromTab({ url: 'https://chatgpt.com/g/g-p-0123abcd-my-art/c/6812a3b4-1c2d', title: 'A chat' }),
    { url: 'https://chatgpt.com/g/g-p-0123abcd-my-art/project', name: 'my-art' });
  for (const url of ['https://chatgpt.com/', 'https://chatgpt.com/c/6812a3b4', 'https://evil.example/g/g-p-0123abcd/project', 'chrome://newtab/']) {
    assert.equal(setup.projectFromTab({ url, title: 'x' }), null, url);
  }
  assert.equal(setup.projectFromTab(undefined), null);
});

test('same project: the id decides, with or without the name in the link', () => {
  const tab = setup.projectFromTab({ url: 'https://chatgpt.com/g/g-p-0123abcd-backdraw/project', title: 'Backdraw - ChatGPT' });
  assert.equal(setup.sameProject(PROJECT, tab), true); // picked from the list: no name in the link
  assert.equal(setup.sameProject({ url: 'https://chatgpt.com/g/g-p-0123ABCD/project' }, tab), true);
  assert.equal(setup.sameProject({ url: 'https://chatgpt.com/g/g-p-0123abce/project' }, tab), false);
  assert.equal(setup.sameProject(null, tab), false);
  assert.equal(setup.sameProject({ url: 'https://chatgpt.com/' }, { url: 'https://chatgpt.com/' }), false);
  assert.match(read('popup.js'), /pick\.hidden = !\(s\.connected && tabProject && !sameProject\(s\.project, tabProject\)\)/);
});

test('job text: every step the worker reports has a text; ChatGPT\'s percentage is kept', () => {
  const steps = new Set([...read('background.js').matchAll(/progress\('([a-z_]+)'/g)].map(m => m[1]));
  assert.ok(steps.size >= 10, [...steps].join());
  for (const step of steps) assert.ok(setup.JOB_STEPS[step], step);
  for (const key of Object.values(setup.JOB_STEPS)) for (const lang of ['en', 'tr']) assert.ok(i18n.STRINGS[lang][key], `${lang}.${key}`);
  assert.equal(setup.jobText(null, en), 'Idle');
  assert.equal(setup.jobText({ step: 'opening', message: 'Opening ChatGPT in a background tab' }, en), 'Opening ChatGPT');
  assert.equal(setup.jobText({ step: 'generating', message: 'ChatGPT is generating the image (40%)' }, en), 'ChatGPT is generating the image (40%)');
  assert.equal(setup.jobText({ step: 'generating', message: '… (40%)' }, (k, v) => i18n.translate('tr', k, v)), 'ChatGPT görseli üretiyor (%40)');
  assert.equal(setup.jobText({ step: 'something_new', message: 'As the worker said' }, en), 'As the worker said');
});

test('step titles and the ChatGPT row exist in both languages', () => {
  for (const key of Object.values(setup.STEP_TITLES)) assert.ok(i18n.STRINGS.en[key] && i18n.STRINGS.tr[key], key);
  assert.equal(setup.chatgptText({ loggedIn: true }, en), 'Signed in');
  assert.equal(setup.chatgptText({ loggedIn: false }, en), 'Not signed in');
  assert.equal(setup.chatgptText({ loggedIn: true, challenge: 'captcha' }, en), 'Verification needed');
  assert.equal(setup.chatgptText(undefined, en), 'Not checked');
});

// ---------------------------------------------------------------- i18n.js

test('language: the popup\'s choice wins; "auto" follows the browser (Turkish or else English)', () => {
  assert.equal(i18n.resolve('auto', 'tr-TR'), 'tr');
  assert.equal(i18n.resolve('auto', 'tr'), 'tr');
  assert.equal(i18n.resolve('auto', 'en-US'), 'en');
  assert.equal(i18n.resolve('auto', 'de'), 'en');
  assert.equal(i18n.resolve('auto', undefined), 'en');
  assert.equal(i18n.resolve('tr', 'en-US'), 'tr');
  assert.equal(i18n.resolve('en', 'tr-TR'), 'en');
  assert.equal(i18n.resolve('fr', 'en-US'), 'en');
  assert.deepEqual(i18n.PREFERENCES, ['auto', 'en', 'tr']);
});

test('language: "auto" follows Chrome\'s UI language, not the websites\' language list', () => {
  globalThis.chrome = { i18n: { getUILanguage: () => 'tr' } };
  try {
    assert.equal(i18n.setPreference('auto'), 'tr');
    globalThis.chrome = { i18n: { getUILanguage: () => 'en-US' } };
    assert.equal(i18n.lang(), 'en');
  } finally {
    delete globalThis.chrome;
  }
  assert.equal(i18n.lang(), i18n.resolve('auto', globalThis.navigator && navigator.language)); // no chrome.i18n (tests)
  i18n.setPreference('en');
});

test('language: load() reads chrome.storage.local, watch() follows changes; both survive a missing chrome', async () => {
  let changed = null;
  const listeners = [];
  globalThis.chrome = { storage: { local: { get: async key => ({ [key]: 'tr' }) }, onChanged: { addListener: f => listeners.push(f) } } };
  try {
    assert.equal(await i18n.load(), 'tr');
    assert.equal(i18n.t('collections'), 'Koleksiyonlar');
    i18n.watch(lang => { changed = lang; });
    listeners[0]({ theme: { newValue: 'dark' } }, 'local');
    assert.equal(changed, null);
    listeners[0]({ language: { newValue: 'en' } }, 'sync');
    assert.equal(changed, null);
    listeners[0]({ language: { newValue: 'en' } }, 'local');
    assert.equal(changed, 'en');
    assert.equal(i18n.t('collections'), 'Collections');
  } finally {
    delete globalThis.chrome;
  }
  assert.equal(i18n.setPreference('en'), 'en');
  assert.equal(await i18n.load(), 'en'); // no chrome: the choice stays as it was
  assert.doesNotThrow(() => i18n.watch(() => {}));
});

test('every English text has a Turkish one and the same placeholders', () => {
  assert.deepEqual(Object.keys(i18n.STRINGS.tr).sort(), Object.keys(i18n.STRINGS.en).sort());
  assert.equal(i18n.translate('tr', 'no such key'), 'no such key');
  assert.equal(i18n.translate('tr', 'setupCount', { done: 2, total: 4 }), '2/4 tamam');
});

test('paths: the home folder shows as "~"; without it, user folders are recognised by their shape', () => {
  const B = String.raw;
  assert.equal(i18n.shortPath(B`C:\Users\Jane Doe\Pictures\Backdraw\References\Cats`, B`C:\Users\Jane Doe`), B`~\Pictures\Backdraw\References\Cats`);
  assert.equal(i18n.shortPath(B`EPERM: open 'c:\users\jane doe\a.png'`, 'C:\\Users\\Jane Doe\\'), B`EPERM: open '~\a.png'`);
  assert.equal(i18n.shortPath(B`C:\Users\Janet\a.png`, B`C:\Users\Jane`), B`C:\Users\Janet\a.png`); // someone else's folder
  assert.equal(i18n.shortPath(B`D:\Pictures\Backdraw`, B`C:\Users\Jane`), B`D:\Pictures\Backdraw`);
  assert.equal(i18n.shortPath(B`C:\Users\Jane Doe\Pictures`, null), B`~\Pictures`);
  assert.equal(i18n.shortPath('/home/jane/Pictures and https://example.com/home/page', ''), '~/Pictures and https://example.com/home/page');
  assert.equal(i18n.shortPath('/Users/jane/Pictures', undefined), '~/Pictures');
  assert.equal(i18n.shortPath(undefined, 'x'), '');
});

// ---------------------------------------------------------------- menus.js

test('the "New collection" window is centred over the browser window', () => {
  assert.deepEqual(centreOver({ left: 100, top: 50, width: 1280, height: 800 }, 380, 470), { left: 550, top: 215 });
  assert.deepEqual(centreOver({ left: -1920, top: 0, width: 1921, height: 1080 }, 380, 470), { left: -1149, top: 305 }); // a screen on the left
  assert.deepEqual(centreOver(null, 380, 470), {});
  assert.deepEqual(centreOver({ left: 0, top: 0 }, 380, 470), {});
  assert.match(read('collections.js'), /chrome\.windows\.get\(tab\.windowId\)/);
  assert.match(read('collections.js'), /\.\.\.backdrawMenus\.centreOver\(over, 380, 470\)/);
});

// ---------------------------------------------------------------- pages

test('pages: theme and settings load in <head> before the page script; every file they name exists', () => {
  for (const page of ['popup.html', 'collection.html']) {
    const html = read(page);
    const head = html.slice(0, html.indexOf('</head>'));
    assert.match(head, /<link rel="stylesheet" href="theme\.css">/, page);
    assert.ok(head.indexOf('i18n.js') >= 0 && head.indexOf('i18n.js') < head.indexOf('settings.js'), page);
    for (const [, ref] of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) assert.ok(fs.existsSync(path.join(EXT, ref)), `${page}: ${ref}`);
  }
  const theme = read('theme.css');
  assert.match(theme, /:root\[data-theme="dark"\]/);
  assert.match(theme, /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\)/);
  assert.match(theme, /--accent: #7c3aed/);
  assert.match(read('settings.js'), /THEMES = \['auto', 'light', 'dark'\]/);
});

test('mascot images: small PNGs without text or EXIF chunks', () => {
  for (const [file, size] of [['mascot-96.png', 96], ['mascot-192.png', 192]]) {
    const b = fs.readFileSync(path.join(EXT, 'icons', file));
    assert.ok(b.length < 40 * 1024, `${file}: ${b.length} bytes`);
    assert.equal(b.toString('latin1', 1, 4), 'PNG');
    assert.deepEqual([b.readUInt32BE(16), b.readUInt32BE(20)], [size, size]);
    const chunks = [];
    for (let i = 8; i < b.length; i += 12 + b.readUInt32BE(i)) chunks.push(b.toString('latin1', i + 4, i + 8));
    for (const meta of ['tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME']) assert.ok(!chunks.includes(meta), `${file} has ${meta}`);
  }
});

test('popup: the gallery button only with a side panel, opened straight from the click', () => {
  const popup = read('popup.js');
  assert.match(popup, /!chrome\.sidePanel \|\| !chrome\.runtime\.getManifest\(\)\.side_panel/);
  assert.match(popup, /\$\('gallery'\)\.onclick = \(\) => chrome\.sidePanel\.open\(\{ windowId \}\)/);
  assert.match(read('popup.html'), /<button id="gallery"[^>]* hidden/);
});

test('nothing reads cookies, tokens or the session endpoint', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.ok(!manifest.permissions.includes('cookies'));
  for (const f of ['background.js', 'collections.js', 'popup.js', 'setup.js', 'settings.js', 'inpage.js']) {
    assert.doesNotMatch(read(f), /chrome\.cookies|document\.cookie|\/api\/auth\/session|accessToken/, f);
    assert.doesNotMatch(read(f), /Authorization|\/backend-api\/conversation/, f);
  }
});

// ---------------------------------------------------------------- the worker's sign-in check

// probes: what each probe of a ChatGPT tab returns, in order (the last one repeats). Time is
// virtual: every timer fires at once and moves the clock forward.
function loadWorker(probes = [], stored = {}) {
  let clock = 1e12;
  const event = list => ({ addListener: f => { if (list) list.push(f); } });
  const onMessage = [];
  const fromHost = [];
  const posted = [];
  const port = { onMessage: event(fromHost), onDisconnect: event(), postMessage: m => { posted.push(m); } };
  const saved = [];
  const created = [];
  const removed = [];
  const sandbox = {
    console: { log() {}, error() {} }, atob, btoa, Blob, navigator: { language: 'en-US' },
    Date: { now: () => clock },
    setTimeout: (fn, ms = 0) => { const due = clock + ms; return setTimeout(() => { clock = Math.max(clock, due); fn(); }, 0); },
    clearTimeout,
    chrome: {
      runtime: {
        id: 'ext', getManifest: () => ({ version: '0.0.0' }), getURL: p => `chrome-extension://ext/${p}`, connectNative: () => port,
        onStartup: event(), onInstalled: event(), onMessage: event(onMessage),
      },
      alarms: { create() {}, onAlarm: event() },
      contextMenus: { onClicked: event(), removeAll: cb => cb(), create: (item, cb) => cb() },
      windows: { onRemoved: event(), getLastFocused: async () => ({ id: 1, type: 'normal' }) },
      tabs: {
        create: async o => { created.push(o); return { id: 40 + created.length }; }, update: async () => ({}),
        get: async id => ({ id, active: false }), remove: async id => { removed.push(id); },
      },
      scripting: { executeScript: async ({ func }) => (func ? [{ result: probes.length > 1 ? probes.shift() : probes[0] }] : []) },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      storage: {
        session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        local: { get: async key => (key in stored ? { [key]: stored[key] } : {}), set: async v => { saved.push(v); } },
        onChanged: event(),
      },
    },
  };
  const ctx = vm.createContext(sandbox);
  sandbox.self = ctx;
  sandbox.importScripts = (...files) => {
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(EXT, f), 'utf8'), ctx, { filename: f });
  };
  vm.runInContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
  // Each message goes to every listener, as Chrome does; the answer comes back through reply. With no
  // listener keeping the channel open (returning true) and no answer, it resolves to undefined.
  const send = (msg, url = 'chrome-extension://ext/popup.html') => new Promise(resolve => {
    let open = false;
    for (const f of onMessage) if (f(msg, { id: 'ext', url }, resolve) === true) open = true;
    if (!open) setImmediate(() => resolve(undefined));
  });
  return { ctx, send, saved, created, removed, fromHost, posted, state: () => JSON.parse(JSON.stringify(vm.runInContext('chatgptState', ctx))) };
}

const LOADING = { url: 'https://chatgpt.com/', composer: false, login: false, challenge: null };
const SIGNED_IN = { ...LOADING, composer: true };
const SIGNED_OUT = { ...LOADING, composer: true, login: true };

test('every probe a job or project list does updates the sign-in state (saved only when it changes)', async () => {
  const w = loadWorker([SIGNED_OUT, SIGNED_OUT, SIGNED_IN, LOADING, { ...SIGNED_IN, challenge: 'captcha' }, SIGNED_IN]);
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(w.state(), { loggedIn: null, challenge: null, checkedAt: null });
  await w.ctx.pageCall(7, 'probe', null);
  assert.equal(w.state().loggedIn, false);
  await w.ctx.pageCall(7, 'probe', null);
  await w.ctx.pageCall(7, 'probe', null);
  assert.equal(w.state().loggedIn, true);
  await w.ctx.pageCall(7, 'probe', null); // still loading: tells nothing
  assert.equal(w.state().loggedIn, true);
  await w.ctx.pageCall(7, 'probe', null);
  assert.deepEqual([w.state().loggedIn, w.state().challenge], [true, 'captcha']);
  await w.ctx.pageCall(7, 'probe', null);
  assert.deepEqual([w.state().loggedIn, w.state().challenge], [true, null]);
  assert.deepEqual(w.saved.map(s => [s.chatgptState.loggedIn, s.chatgptState.challenge]), [[false, null], [true, null], [true, 'captcha'], [true, null]]);
});

test('popup:status carries the sign-in state and the home folder from the host', async () => {
  const w = loadWorker([], { chatgptState: { loggedIn: true, challenge: null, checkedAt: 5 } });
  await new Promise(r => setTimeout(r, 0));
  w.fromHost[0]({ type: 'welcome', project: PROJECT, collections: [], home: 'C:\\Users\\Jane' });
  const s = await w.send({ type: 'popup:status' });
  assert.equal(s.connected, true);
  assert.equal(s.home, 'C:\\Users\\Jane');
  assert.deepEqual(JSON.parse(JSON.stringify(s.chatgpt)), { loggedIn: true, challenge: null, checkedAt: 5, checking: false });
});

test('an error from the host reaches the extension\'s pages with the home folder as "~"', async () => {
  const w = loadWorker();
  await new Promise(r => setTimeout(r, 0));
  w.fromHost[0]({ type: 'welcome', project: PROJECT, collections: [], home: 'C:\\Users\\Jane' });
  const answer = w.send({ type: 'host:call', method: 'rename_collection', params: { name: 'Cats', newName: 'Dogs' } });
  await new Promise(r => setTimeout(r, 0));
  const call = w.posted.find(m => m.type === 'call');
  w.fromHost[0]({ type: 'reply', reqId: call.reqId, ok: false, error: "EPERM: operation not permitted, rename 'C:\\Users\\Jane\\Pictures\\Backdraw\\References\\Cats'" });
  assert.deepEqual({ ...await answer }, { ok: false, error: "EPERM: operation not permitted, rename '~\\Pictures\\Backdraw\\References\\Cats'" });
});

test('popup:check-chatgpt: a background tab, looked at until the message box stays, then closed', async () => {
  const w = loadWorker([LOADING, LOADING, SIGNED_IN]);
  const r = await w.send({ type: 'popup:check-chatgpt' });
  assert.equal(r.ok, true);
  assert.equal(r.chatgpt.loggedIn, true);
  assert.deepEqual(JSON.parse(JSON.stringify(w.created)), [{ windowId: 1, url: 'https://chatgpt.com/', active: false }]);
  assert.deepEqual(w.removed, [41]);
});

test('popup:check-chatgpt: a login wall or a verification page answers at once', async () => {
  const out = loadWorker([LOADING, SIGNED_OUT]);
  const r = await out.send({ type: 'popup:check-chatgpt' });
  assert.deepEqual([r.ok, r.chatgpt.loggedIn], [true, false]);
  const gate = loadWorker([{ ...LOADING, challenge: 'verification' }]);
  const g = await gate.send({ type: 'popup:check-chatgpt' });
  assert.deepEqual([g.ok, g.chatgpt.challenge], [true, 'verification']);
  assert.deepEqual(gate.removed, [41]);
});

test('popup:check-chatgpt: a page that never loads is an error in the popup\'s language', async () => {
  const w = loadWorker([LOADING]);
  const r = await w.send({ type: 'popup:check-chatgpt' });
  assert.deepEqual({ ...r }, { ok: false, error: 'ChatGPT did not finish loading; try again.' });
  assert.equal(w.state().loggedIn, null);
});

test('setup requests are only answered for the extension\'s own pages', async () => {
  const w = loadWorker([SIGNED_IN]);
  assert.equal(await w.send({ type: 'popup:check-chatgpt' }, 'https://chatgpt.com/'), undefined);
  assert.equal(w.created.length, 0);
});

test('popup:reconnect connects at once and reports the outcome', async () => {
  const w = loadWorker();
  const r = await w.send({ type: 'popup:reconnect' });
  assert.equal(r.ok, true);
  assert.equal(typeof r.connected, 'boolean');
});
