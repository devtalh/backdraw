'use strict';
// The gallery side panel on the extension's side: the page is checked as text, the service worker's
// plumbing runs in a vm with stand-ins for chrome.* (Chrome itself is never involved).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const i18n = require('../extension/i18n');
const { actionItems, parseMenuId, GALLERY_ID } = require('../extension/menus');
const { EXTENSION_METHODS } = require('../lib/collections');

const EXT = path.join(__dirname, '..', 'extension');
const read = f => fs.readFileSync(path.join(EXT, f), 'utf8');
const plain = v => JSON.parse(JSON.stringify(v)); // out of the vm's realm
const tick = () => new Promise(r => setImmediate(r));

test('manifest: the side panel page and its permission; the toolbar icon keeps its popup', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.deepEqual(manifest.side_panel, { default_path: 'sidepanel.html' });
  assert.ok(manifest.permissions.includes('sidePanel'));
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.ok(fs.existsSync(path.join(EXT, manifest.side_panel.default_path)));
});

test('sidepanel.html: its scripts and stylesheet exist, i18n.js first, nothing inline', () => {
  const html = read('sidepanel.html');
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
  assert.deepEqual(scripts, ['i18n.js', 'sidepanel.js']);
  assert.equal((html.match(/<script/g) || []).length, 2); // MV3 refuses inline scripts
  assert.match(html, /<link rel="stylesheet" href="sidepanel\.css">/);
  for (const f of [...scripts, 'sidepanel.css']) assert.ok(fs.existsSync(path.join(EXT, f)), f);
});

test('sidepanel: every text key exists in English and Turkish, and every step the worker reports has a label', () => {
  const html = read('sidepanel.html');
  const js = read('sidepanel.js');
  const used = new Set([...html.matchAll(/data-i18n(?:-\w+)?="([^"]+)"/g)].map(m => m[1]));
  for (const [, key] of js.matchAll(/\bt\('([A-Za-z]+)'/g)) used.add(key);
  for (const [, a, b] of js.matchAll(/\bt\([^()']*\? '([A-Za-z]+)' : '([A-Za-z]+)'/g)) used.add(a).add(b);
  const steps = Object.fromEntries([...js.match(/const STEPS = \{([^}]*)\}/)[1].matchAll(/(\w+): '(\w+)'/g)].map(m => [m[1], m[2]]));
  for (const key of Object.values(steps)) used.add(key);
  assert.ok(used.size > 30, [...used].join());
  for (const key of used) {
    assert.ok(key in i18n.STRINGS.en, key);
    assert.ok(key in i18n.STRINGS.tr, key);
  }
  const reported = new Set(['queued', 'needs_human']);
  for (const [, step] of read('background.js').matchAll(/progress\('(\w+)'/g)) reported.add(step);
  assert.ok(reported.size >= 10, [...reported].join());
  for (const step of reported) assert.ok(steps[step], step);
});

test('sidepanel: GIF detail titles are translated in English and Turkish', () => {
  assert.equal(i18n.translate('en', 'gifFrames', { frames: 12 }), '12 frames');
  assert.equal(i18n.translate('en', 'gifDetails', { frames: 12, seconds: '1.4' }), '12 frames, 1.4 s per loop');
  assert.equal(i18n.translate('tr', 'gifFrames', { frames: 12 }), '12 kare');
  assert.equal(i18n.translate('tr', 'gifDetails', { frames: 12, seconds: '1,4' }), '12 kare, döngü başına 1,4 sn');
  assert.match(read('sidepanel.js'), /seconds: language === 'tr' \? seconds\.replace\('\.', ','\) : seconds/);
});

test('sidepanel: images go to the host by job id and number only; markup only from constants', () => {
  const js = read('sidepanel.js');
  const calls = [...js.matchAll(/hostCall\('(\w+)', \{([^}]*)\}/g)].map(m => [m[1], m[2]]);
  assert.deepEqual([...new Set(calls.map(c => c[0]))].sort(), ['collection_add_job_image', 'gallery_animation', 'gallery_list', 'gallery_thumb', 'list_collections', 'reveal_image']);
  for (const [method, params] of calls) assert.doesNotMatch(params, /path/, method);
  assert.equal((js.match(/innerHTML/g) || []).length, 1);
  assert.match(js, /tpl\.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">\$\{ICONS\[name\]\}<\/svg>`/);
  // Only ChatGPT links are opened.
  assert.match(js, /const CHAT = \/\^https:\\\/\\\/chatgpt\\\.com\\\/\/i;/);
  // The stored theme and language are followed, under the keys the popup stores them with.
  assert.match(js, /chrome\.storage\.local\.get\(\['theme', 'language'\]\)/);
  assert.match(js, /changes\.theme \|\| changes\.language/);
  assert.match(js, /typeof s\.language === 'string'/);
  const css = read('sidepanel.css');
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\)/);
  assert.match(css, /:root\[data-theme="dark"\] \{/);
});

test('sidepanel: GIF hover is gated by format, missing state and reduced motion; collection thumbnails stay previews', () => {
  const js = read('sidepanel.js');
  assert.match(js, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches/);
  assert.match(js, /if \(it\.format === 'GIF' && !it\.missing && !reducedMotion\)/);
  assert.match(js, /pic\.addEventListener\('mouseenter'/);
  assert.match(js, /pic\.addEventListener\('mouseleave'/);
  assert.match(js, /hostCall\('gallery_animation', \{ jobId: it\.jobId, n: it\.n \}\)/);
  assert.match(js, /shown\.src === url/);
});

test('toolbar icon menu: "Open Backdraw gallery", which the image menu handler leaves alone', () => {
  assert.deepEqual(actionItems(key => `<${key}>`), [{ id: 'backdraw:gallery', title: '<menuGallery>', contexts: ['action'] }]);
  assert.equal(GALLERY_ID, 'backdraw:gallery');
  assert.equal(parseMenuId(GALLERY_ID), null);
  assert.equal(i18n.STRINGS.en.menuGallery, 'Open Backdraw gallery');
  assert.equal(i18n.STRINGS.tr.menuGallery, 'Backdraw galerisini aç');
  for (const lang of ['en', 'tr']) assert.equal(JSON.parse(read(path.join('_locales', lang, 'messages.json'))).menuGallery, undefined, lang);
});

// ---------------------------------------------------------------- the service worker

function loadWorker() {
  const posted = [];
  const created = [];
  const opened = [];
  const on = { message: [], menu: [], port: [] };
  const event = list => ({ addListener: fn => { if (list) list.push(fn); } });
  const port = { onMessage: event(on.port), onDisconnect: event(), postMessage: m => posted.push(m) };
  const sandbox = {
    console: { log() {}, error() {} }, setTimeout, clearTimeout, atob, btoa, Blob,
    chrome: {
      runtime: {
        id: 'ext', getURL: p => `chrome-extension://ext/${p}`, getManifest: () => ({ version: '0.0.0' }), connectNative: () => port,
        onStartup: event(), onInstalled: event(), onMessage: event(on.message),
      },
      i18n: { getMessage: key => `<${key}>`, getUILanguage: () => 'en' },
      alarms: { create() {}, onAlarm: event() },
      contextMenus: { onClicked: event(on.menu), removeAll: cb => cb(), create: (item, cb) => { created.push(item); cb(); } },
      sidePanel: { open: o => { opened.push(o); return Promise.resolve(); } },
      windows: { onRemoved: event() },
      tabs: { onRemoved: event() },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      storage: { session: { get: async () => ({}), set: async () => {}, remove: async () => {} }, local: { get: async () => ({}), set: async () => {} }, onChanged: event() },
    },
  };
  const ctx = vm.createContext(sandbox);
  sandbox.self = ctx;
  sandbox.importScripts = (...files) => {
    for (const f of files) vm.runInContext(read(f), ctx, { filename: f });
  };
  vm.runInContext(read('background.js'), ctx, { filename: 'background.js' });
  const send = (msg, sender = { id: 'ext', url: 'chrome-extension://ext/sidepanel.html' }) => {
    const replies = [];
    let async = false;
    for (const l of on.message) if (l(msg, sender, r => replies.push(plain(r))) === true) async = true;
    return { replies, async };
  };
  const fromHost = msg => on.port.forEach(l => l(msg));
  return { posted, created, opened, on, send, fromHost };
}

test('worker: panel:status answers at once with the connection and the job in progress', () => {
  const w = loadWorker();
  const r = w.send({ type: 'panel:status' });
  assert.deepEqual(r.replies, [{ connected: false, lastError: null, current: null }]);
  assert.equal(r.async, false);
});

test('worker: the panel reaches only the gallery methods (and the collection list), and only from the extension\'s pages', async () => {
  const w = loadWorker();
  w.fromHost({ type: 'welcome', project: null, collections: [] });
  for (const method of ['generate', 'diagnose', 'set_config', 'select_project', 'collection_add', 'delete_collection', 'status', '__proto__', undefined]) {
    const r = w.send({ type: 'panel:call', method, params: {} });
    assert.deepEqual(r.replies, [{ ok: false, error: `Not allowed: ${method}` }], String(method));
  }
  for (const sender of [{ id: 'ext', url: 'https://chatgpt.com/' }, { id: 'other', url: 'chrome-extension://ext/sidepanel.html' }, { id: 'ext' }]) {
    const r = w.send({ type: 'panel:call', method: 'gallery_list', params: {} }, sender);
    assert.deepEqual([r.replies, r.async], [[], false], JSON.stringify(sender));
    assert.deepEqual(w.send({ type: 'panel:status' }, sender).replies, []);
  }
  assert.equal(w.posted.filter(m => m.type === 'call').length, 0);

  const r = w.send({ type: 'panel:call', method: 'gallery_thumb', params: { jobId: 'img_0a1b2c3d', n: 1 } });
  assert.equal(r.async, true);
  await tick();
  const call = w.posted.find(m => m.type === 'call');
  assert.deepEqual(plain({ ...call, reqId: 0 }), { type: 'call', reqId: 0, method: 'gallery_thumb', params: { jobId: 'img_0a1b2c3d', n: 1 } });
  w.fromHost({ type: 'reply', reqId: call.reqId, ok: true, result: { data: null, mime: null } });
  await tick();
  assert.deepEqual(r.replies, [{ ok: true, result: { data: null, mime: null } }]);

  const failed = w.send({ type: 'panel:call', method: 'reveal_image', params: { jobId: 'img_0a1b2c3d', n: 1 } });
  await tick();
  const second = w.posted.filter(m => m.type === 'call')[1];
  w.fromHost({ type: 'reply', reqId: second.reqId, ok: false, error: 'The image file was moved or deleted: x', code: 'NOT_FOUND' });
  await tick();
  assert.deepEqual(failed.replies, [{ ok: false, error: 'The image file was moved or deleted: x' }]);
});

test('worker: the panel\'s methods are all on the host\'s own allow-list', () => {
  const [, list] = read('background.js').match(/PANEL_HOST_METHODS = new Set\(\[([^\]]*)\]\)/);
  const methods = list.match(/'[^']+'/g).map(s => s.slice(1, -1));
  assert.deepEqual(methods.sort(), ['collection_add_job_image', 'gallery_animation', 'gallery_list', 'gallery_thumb', 'list_collections', 'reveal_image']);
  for (const m of methods) assert.ok(EXTENSION_METHODS.has(m), m);
});

test('worker: the toolbar menu item is (re)built with the image menu and opens the side panel right in the click', async () => {
  const w = loadWorker();
  w.fromHost({ type: 'welcome', project: null, collections: [{ name: 'Cats', count: 2 }] });
  for (let i = 0; i < 10 && !w.created.some(x => x.id === GALLERY_ID); i++) await tick();
  assert.deepEqual(plain(w.created.find(x => x.id === GALLERY_ID)), { id: GALLERY_ID, title: 'Open Backdraw gallery', contexts: ['action'] });
  assert.ok(w.created.some(x => x.id === 'backdraw:add:Cats'));

  for (const l of w.on.menu) l({ menuItemId: GALLERY_ID }, { id: 4, windowId: 9 });
  assert.deepEqual(plain(w.opened), [{ windowId: 9 }]); // no await before it: the user gesture still counts
  for (const l of w.on.menu) l({ menuItemId: 'something-else' }, { id: 4, windowId: 9 });
  for (const l of w.on.menu) l({ menuItemId: GALLERY_ID }, undefined);
  assert.equal(w.opened.length, 1);
});
