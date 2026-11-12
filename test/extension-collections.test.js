'use strict';
// The extension's plain-JS helpers (menus.js, i18n.js) load in Node too; the rest is checked as text.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { menuItems, parseMenuId } = require('../extension/menus');
const i18n = require('../extension/i18n');
const { MAX_COLLECTION_BYTES } = require('../lib/limits');

const EXT = path.join(__dirname, '..', 'extension');
const read = f => fs.readFileSync(path.join(EXT, f), 'utf8');
const msg = key => `<${key}>`;

const PAGES = ['http://*/*', 'https://*/*', 'file:///*'];

test('menu while the host is not connected: one disabled item', () => {
  assert.deepEqual(menuItems(null, msg), [
    { id: 'backdraw', title: '<menuAdd>', contexts: ['image'], documentUrlPatterns: PAGES },
    { id: 'backdraw:off', parentId: 'backdraw', title: '<menuOffline>', contexts: ['image'], documentUrlPatterns: PAGES, enabled: false },
  ]);
});

test('menu: only on web pages and local files, never on the extension\'s own pages', () => {
  for (const list of [null, [], [{ name: 'Cats', count: 1 }]]) {
    for (const item of menuItems(list, msg)) assert.deepEqual(item.documentUrlPatterns, PAGES, item.id);
  }
  assert.ok(PAGES.every(p => !p.startsWith('chrome-extension:')));
});

test('menu without collections: only "New collection…", no separator', () => {
  assert.deepEqual(menuItems([], msg).map(i => i.id), ['backdraw', 'backdraw:new']);
});

test('menu with collections: one item each (name and count), a separator, then "New collection…"', () => {
  const items = menuItems([{ name: 'Cats', count: 3 }, { name: 'a:b 🐉', count: 0 }], msg);
  assert.deepEqual(items.map(i => [i.id, i.title, i.type]), [
    ['backdraw', '<menuAdd>', undefined],
    ['backdraw:add:Cats', 'Cats (3)', undefined],
    ['backdraw:add:a:b 🐉', 'a:b 🐉 (0)', undefined],
    ['backdraw:sep', undefined, 'separator'],
    ['backdraw:new', '<menuNew>', undefined],
  ]);
  assert.ok(items.slice(1).every(i => i.parentId === 'backdraw' && i.contexts.join() === 'image'));
  assert.equal(new Set(items.map(i => i.id)).size, items.length);
});

test('menu ids: every add item parses back to its collection name', () => {
  const names = ['Cats', 'a:b', 'backdraw:new', '🐉 Ejderha', ' spaced ', '../x', 'x'.repeat(64)];
  for (const item of menuItems(names.map(name => ({ name, count: 1 })), msg).filter(i => i.id.startsWith('backdraw:add:'))) {
    const parsed = parseMenuId(item.id);
    assert.equal(parsed.kind, 'add');
    assert.ok(names.includes(parsed.name), item.id);
  }
  assert.deepEqual(parseMenuId('backdraw:add:backdraw:new'), { kind: 'add', name: 'backdraw:new' });
  assert.deepEqual(parseMenuId('backdraw:new'), { kind: 'new' });
  for (const other of ['backdraw', 'backdraw:sep', 'backdraw:off', 'backdraw:add:', 'other', '', undefined, null, 7]) {
    assert.equal(parseMenuId(other), null, String(other));
  }
});

test('i18n: English by default, Turkish on request, English for missing keys, placeholders filled', () => {
  assert.equal(i18n.setPreference('en'), 'en'); // Node has navigator.language too: don't depend on this machine's
  assert.equal(i18n.lang(), 'en');
  assert.equal(i18n.t('collections'), 'Collections');
  assert.equal(i18n.translate('tr', 'collections'), 'Koleksiyonlar');
  assert.equal(i18n.translate('tr', 'toastAdded', { name: 'Kediler', images: '3 görsel' }), 'Kediler koleksiyonuna eklendi · 3 görsel');
  assert.equal(i18n.translate('de', 'save'), 'Save');
  assert.equal(i18n.translate('en', 'no such key'), 'no such key');
  assert.equal(i18n.t('toastAdded', { name: 'Cats' }), 'Added to Cats · {images}');
  assert.equal(i18n.images(1), '1 image');
  assert.equal(i18n.images(4), '4 images');
});

test('i18n: Turkish covers every English key and nothing else', () => {
  assert.deepEqual(Object.keys(i18n.STRINGS.tr).sort(), Object.keys(i18n.STRINGS.en).sort());
  for (const [key, en] of Object.entries(i18n.STRINGS.en)) {
    const vars = s => (s.match(/\{\w+\}/g) || []).sort();
    assert.deepEqual(vars(i18n.STRINGS.tr[key]), vars(en), key);
  }
});

test('i18n: every key the extension uses exists', () => {
  const used = new Set();
  for (const f of ['popup.html', 'collection.html']) for (const [, key] of read(f).matchAll(/data-i18n(?:-\w+)?="([^"]+)"/g)) used.add(key);
  for (const f of ['popup.js', 'collection.js', 'collections.js', 'setup.js', 'background.js']) {
    for (const [, key] of read(f).matchAll(/\b(?:t|tr|userError)\('([A-Za-z]+)'/g)) used.add(key);
    for (const [, a, b] of read(f).matchAll(/\b(?:t|tr)\([^()']*\? '([A-Za-z]+)' : '([A-Za-z]+)'/g)) used.add(a).add(b);
  }
  assert.ok(used.size > 20, [...used].join());
  for (const key of used) assert.ok(key in i18n.STRINGS.en, key);
});

test('cleanup texts: every static key, dynamic reason and count variant exists in both languages', () => {
  const keys = new Set(['chatDeleted', 'chatGone', 'chatArchived', 'openArchivedChat']);
  for (const key of Object.keys(i18n.STRINGS.en)) if (/^(cleanup|reason_)/.test(key)) keys.add(key);
  for (const file of ['chat-cleanup-ui.js', 'popup.js']) {
    for (const [, key] of read(file).matchAll(/['"]((?:cleanup|reason_)[A-Za-z_]+)['"]/g)) {
      if (key !== 'cleanupView' && key !== 'cleanupNow' && key !== 'cleanupSettingConfirm' && key !== 'cleanupHint') keys.add(key);
    }
  }
  assert.ok(keys.size > 50);
  for (const key of keys) {
    assert.ok(i18n.STRINGS.en[key], `en.${key}`);
    assert.ok(i18n.STRINGS.tr[key], `tr.${key}`);
    const placeholders = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
    assert.deepEqual(placeholders(i18n.STRINGS.en[key]), placeholders(i18n.STRINGS.tr[key]), key);
  }
});

test('menu titles come from i18n.js (the language override applies); _locales only holds the manifest description', () => {
  for (const key of ['menuAdd', 'menuNew', 'menuOffline']) {
    assert.ok(i18n.STRINGS.en[key] && i18n.STRINGS.tr[key], key);
    assert.ok(read('menus.js').includes(`'${key}'`), key);
  }
  assert.equal(i18n.translate('en', 'menuAdd'), 'Add to Backdraw');
  assert.equal(i18n.translate('tr', 'menuAdd'), 'Backdraw\'a ekle');
  assert.match(read('collections.js'), /backdrawMenus\.menuItems\([^\n]*key => i18n\.t\(key\)\)/);
  assert.doesNotMatch(read('collections.js') + read('background.js'), /chrome\.i18n\.getMessage/);
  const en = JSON.parse(read(path.join('_locales', 'en', 'messages.json')));
  const tr = JSON.parse(read(path.join('_locales', 'tr', 'messages.json')));
  assert.deepEqual(Object.keys(en), ['extDescription']);
  assert.deepEqual(Object.keys(tr), ['extDescription']);
  assert.equal(JSON.parse(read('manifest.json')).description, '__MSG_extDescription__');
});

test('manifest: right-click menu, every site for images and the toast, English default locale', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.default_locale, 'en');
  assert.equal(manifest.name, 'Backdraw');
  assert.ok(manifest.permissions.includes('contextMenus'));
  assert.ok(manifest.permissions.includes('scripting'));
  assert.ok(manifest.host_permissions.includes('<all_urls>'));
});

test('every script the pages and the worker load exists', () => {
  const [, list] = read('background.js').match(/importScripts\(([^)]*)\)/);
  const scripts = list.match(/'[^']+'/g).map(s => s.slice(1, -1));
  assert.deepEqual(scripts, ['aspect.js', 'gifframes.js', 'i18n.js', 'menus.js', 'collections.js']);
  for (const f of ['popup.html', 'collection.html']) for (const [, src] of read(f).matchAll(/<script src="([^"]+)"/g)) scripts.push(src);
  for (const s of scripts) assert.ok(fs.existsSync(path.join(EXT, s)), s);
  assert.ok(read('popup.html').indexOf('i18n.js') < read('popup.html').indexOf('popup.js'));
});

test('collections.js shares the worker scope without clashing with background.js names', () => {
  const names = f => new Set([...read(f).matchAll(/^(?:const|let|var|(?:async )?function|class) (\w+)/gm)].map(m => m[1]));
  const background = names('background.js');
  const collections = names('collections.js');
  assert.ok(collections.size > 20);
  for (const n of collections) assert.ok(!background.has(n), n);
  // The globals collections.js relies on are there.
  for (const n of ['post', 'connect', 'log', 'setBadge', 'b64ToBytes', 'bytesToB64', 'hostReady']) assert.ok(background.has(n), n);
});

test('the extension keeps the host\'s 25 MB limit and only forwards collection methods from its pages', () => {
  const src = read('collections.js');
  assert.match(src, /const MAX_IMAGE_BYTES = 25 \* 1024 \* 1024;/);
  assert.equal(25 * 1024 * 1024, MAX_COLLECTION_BYTES);
  const [, list] = src.match(/PAGE_HOST_METHODS = new Set\(\[([^\]]*)\]\)/);
  const methods = list.match(/'[^']+'/g).map(s => s.slice(1, -1));
  assert.deepEqual(methods.sort(), ['collection_thumbs', 'delete_collection', 'delete_collection_image', 'list_collections', 'rename_collection']);
  // Only the extension's own pages are answered.
  assert.match(src, /sender\.url[^\n]*startsWith\(chrome\.runtime\.getURL\(''\)\)/);
});

test('collections.js: downloads stop at the limit and time out; no click goes unanswered', () => {
  const src = read('collections.js');
  // No whole-body reads: both the worker and the page count the bytes as they arrive.
  assert.doesNotMatch(src, /res\.blob\(\)/);
  assert.equal((src.match(/res\.body\.getReader\(\)/g) || []).length, 2);
  assert.equal((src.match(/signal: ac\.signal/g) || []).length, 2);
  assert.match(src, /readImageInPage, args: \[srcUrl, MAX_IMAGE_BYTES, DOWNLOAD_MS, canvasOnly, svg\]/);
  // A click without an image address tells the user.
  assert.match(src, /if \(!info\.srcUrl\) \{ notifyUser\(tabId, tr\('errNoSource'\), true\); return; \}/);
  // An SVG's bytes go to the page, which draws them from its own blob: URL.
  assert.match(src, /readInPage\(source, true, looksLikeSvg\(blob, bytes\) \? bytesToB64\(bytes\) : null\)/);
  assert.match(src, /URL\.createObjectURL\(/);
  // A "New collection" window closed with its own × lets go of the prepared image.
  assert.match(src, /chrome\.windows\.onRemoved\.addListener/);
});

test('popup: every status text follows the UI language', () => {
  const popup = read('popup.js');
  const html = read('popup.html');
  assert.doesNotMatch(popup + html + read('background.js'), /Bağlı|Seçilmedi|Boşta|Sürüm|Köprü|projesini kullan/);
  assert.match(popup, /document\.documentElement\.lang = i18n\.lang\(\);/);
  for (const key of ['bridge', 'project', 'job', 'version', 'footerNote']) assert.match(html, new RegExp(`data-i18n="${key}"`), key);
});

test('the host answers extension calls through lib/extension-calls with every allowed method', () => {
  const host = fs.readFileSync(path.join(__dirname, '..', 'host.js'), 'utf8');
  assert.match(host, /case 'call':\s+answerCall\(msg, handlers, extensionCalls\.take\(msg\.reqId\)/);
  assert.match(host, /case 'call_chunk': extensionCalls\.chunk\(msg\)/);
  const { EXTENSION_METHODS } = require('../lib/collections');
  const handlers = host.slice(host.indexOf('const handlers = {'));
  for (const m of EXTENSION_METHODS) assert.match(handlers, new RegExp(`^  ${m}: `, 'm'), m);
});
