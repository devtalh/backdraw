'use strict';
// Loads the real service worker in a vm context with stand-ins for the chrome.* and canvas APIs:
// importScripts must work without a module system, and downloaded images must be cropped,
// measured and previewed as asked. Chrome itself is never involved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { crc32 } = require('./png-fixture');
const { gif, rasterGif } = require('./gif-fixture');
const { contactLayout } = require('../extension/gifframes');
const { png, rgbaPng, decodePng } = require('./png-fixture');

const EXT = path.join(__dirname, '..', 'extension');

// A decoded image whose alpha is given per pixel; RGB is always 0.
class FakeBitmap {
  constructor(width, height, alphaAt) { Object.assign(this, { width, height, alphaAt, closed: false }); }
  rgba(x, y) { return [0, 0, 0, this.alphaAt(x, y)]; }
  close() { this.closed = true; }
}

// Records what is drawn; drawImage copies pixels (nearest neighbour) so getImageData is real.
function fakeCanvasClass(made) {
  return class FakeCanvas {
    constructor(width, height) {
      Object.assign(this, { width, height, ops: [], data: new Uint8ClampedArray(width * height * 4) });
      made.push(this);
    }
    getContext() {
      const c = this;
      return {
        fillStyle: '#000000',
        fillText(text, x, y) { c.ops.push(['fillText', text, x, y, this.font, this.textBaseline]); },
        createImageData(width, height) { return { width, height, data: new Uint8ClampedArray(width * height * 4) }; },
        putImageData(image, x, y) {
          assert.deepEqual([x, y, image.width, image.height], [0, 0, c.width, c.height]);
          c.data.set(image.data);
        },
        fillRect(x, y, w, h) { c.ops.push(['fillRect', this.fillStyle, x, y, w, h]); },
        drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh) {
          c.ops.push(['drawImage', sx, sy, sw, sh, dx, dy, dw, dh]);
          for (let y = 0; y < dh; y++) {
            for (let x = 0; x < dw; x++) {
              const px = src.rgba(sx + Math.floor((x * sw) / dw), sy + Math.floor((y * sh) / dh));
              c.data.set(px, ((dy + y) * c.width + dx + x) * 4);
            }
          }
        },
        getImageData(x, y, w, h) { assert.deepEqual([x, y, w, h], [0, 0, c.width, c.height]); return { data: c.data }; },
      };
    }
    rgba(x, y) { return this.data.subarray((y * this.width + x) * 4, (y * this.width + x + 1) * 4); }
    async convertToBlob(opts) { return new Blob([JSON.stringify({ type: opts.type, width: this.width, height: this.height })]); }
  };
}

function pixelCanvasClass() {
  const color = value => {
    const match = /^#([0-9a-f]{6})$/i.exec(value);
    if (!match) throw new Error(`Unsupported fill color ${value}`);
    const n = Number.parseInt(match[1], 16);
    return [n >> 16, (n >> 8) & 0xff, n & 0xff, 255];
  };
  return class PixelCanvas {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.data = new Uint8ClampedArray(width * height * 4);
      this.labels = [];
    }
    getContext() {
      const canvas = this;
      const write = (x, y, rgba) => {
        if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
        const i = (y * canvas.width + x) * 4;
        const sa = rgba[3] / 255;
        const da = canvas.data[i + 3] / 255;
        const outA = sa + da * (1 - sa);
        for (let c = 0; c < 3; c++) {
          canvas.data[i + c] = outA ? Math.round((rgba[c] * sa + canvas.data[i + c] * da * (1 - sa)) / outA) : 0;
        }
        canvas.data[i + 3] = Math.round(outA * 255);
        // Browser canvases store premultiplied pixels, so fully transparent RGB cannot survive a write or draw.
        if (canvas.data[i + 3] === 0) canvas.data.fill(0, i, i + 4);
      };
      const sourcePixel = (source, x, y) => {
        if (source.data) return source.data.subarray((y * source.width + x) * 4, (y * source.width + x + 1) * 4);
        return source.rgba(x, y);
      };
      return {
        fillStyle: '#000000',
        fillText(text, x, y) { canvas.labels.push({ text, x, y, font: this.font, baseline: this.textBaseline }); },
        fillRect(x, y, width, height) {
          const rgba = color(this.fillStyle);
          for (let py = y; py < y + height; py++) for (let px = x; px < x + width; px++) write(px, py, rgba);
        },
        drawImage(source, ...args) {
          let sx = 0;
          let sy = 0;
          let sw = source.width;
          let sh = source.height;
          let dx;
          let dy;
          let dw;
          let dh;
          if (args.length === 2) [dx, dy, dw, dh] = [args[0], args[1], sw, sh];
          else if (args.length === 4) [dx, dy, dw, dh] = args;
          else if (args.length === 8) [sx, sy, sw, sh, dx, dy, dw, dh] = args;
          else throw new Error(`Unsupported drawImage argument count ${args.length + 1}`);
          for (let y = 0; y < dh; y++) {
            for (let x = 0; x < dw; x++) {
              const sourceX = Math.min(source.width - 1, sx + Math.floor((x * sw) / dw));
              const sourceY = Math.min(source.height - 1, sy + Math.floor((y * sh) / dh));
              write(dx + x, dy + y, sourcePixel(source, sourceX, sourceY));
            }
          }
        },
        createImageData(width, height) { return { width, height, data: new Uint8ClampedArray(width * height * 4) }; },
        getImageData(x, y, width, height) {
          const data = new Uint8ClampedArray(width * height * 4);
          for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
            const src = ((y + py) * canvas.width + x + px) * 4;
            data.set(canvas.data.subarray(src, src + 4), (py * width + px) * 4);
          }
          return { width, height, data };
        },
        putImageData(image, dx, dy) {
          for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
            const i = (y * image.width + x) * 4;
            const rgba = image.data.subarray(i, i + 4);
            const dst = ((dy + y) * canvas.width + dx + x) * 4;
            canvas.data.set(rgba, dst);
            if (canvas.data[dst + 3] === 0) canvas.data.fill(0, dst, dst + 4);
          }
        },
      };
    }
    async convertToBlob({ type = 'image/png' } = {}) {
      return new Blob([rgbaPng(this.width, this.height, this.data)], { type });
    }
  };
}

function loadPixelWorker() {
  const worker = loadWorker();
  worker.ctx.OffscreenCanvas = pixelCanvasClass();
  worker.ctx.createImageBitmap = async blob => {
    const bytes = Buffer.from(await blob.arrayBuffer());
    if (!bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      throw new Error(`Pixel test bitmap decoder only supports PNG, not ${blob.type || 'unknown data'}`);
    }
    const decoded = decodePng(bytes);
    return { ...decoded, close() {} };
  };
  return worker;
}

function loadWorker(configure) {
  const posted = [];
  const listeners = [];
  const event = (list = []) => ({ addListener(fn) { list.push(fn); } });
  const port = { onMessage: event(), onDisconnect: event(), postMessage: m => posted.push(m) };
  const made = [];
  const sandbox = {
    console: { log() {}, error() {} }, setTimeout, clearTimeout, atob, btoa, Blob, CompressionStream, Response,
    chrome: {
      runtime: { id: 'test', getManifest: () => ({ version: '0.0.0' }), connectNative: () => port, onStartup: event(), onInstalled: event(), onMessage: event(listeners) },
      alarms: { create() {}, onAlarm: event() },
      contextMenus: { onClicked: event(), removeAll: async () => {}, create() {}, update: async () => {} },
      windows: { onRemoved: event() },
      tabs: { onRemoved: event() },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      storage: { session: { get: async () => ({}), set: async () => {}, remove: async () => {} }, local: { get: async () => ({}), set: async () => {} }, onChanged: event() },
    },
    OffscreenCanvas: fakeCanvasClass(made),
    nextBitmap: null,
    createImageBitmap: async () => sandbox.nextBitmap,
  };
  if (configure) configure(sandbox, port);
  const ctx = vm.createContext(sandbox);
  sandbox.self = ctx;
  sandbox.importScripts = (...files) => {
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(EXT, f), 'utf8'), ctx, { filename: f });
  };
  vm.runInContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
  return { ctx: sandbox, posted, made, listeners };
}

const CLEANUP_ID = '12345678-abcd-1234-abcd-123456789abc';
const cleanupChat = (n = 0) => {
  const id = CLEANUP_ID.slice(0, -1) + n.toString(16);
  return { id, url: `https://chatgpt.com/g/g-p-abc123-project/c/${id}` };
};
const plain = value => JSON.parse(JSON.stringify(value));

function cleanupWorker(options = {}) {
  const pages = [], scripts = [], created = [], updated = [], removed = [], logs = [], writes = [];
  const session = plain(options.session || {});
  const local = options.setting === undefined ? {} : { chatCleanup: options.setting };
  const tabs = new Map();
  let worker, now = 100000, navigated = false;
  worker = loadWorker((sandbox, port) => {
    sandbox.URL = URL;
    sandbox.Date = { now: () => now };
    sandbox.console = { log: (...args) => logs.push(args), error: (...args) => logs.push(args) };
    sandbox.setTimeout = (fn, ms) => {
      // Host call deadlines remain real and are cleared by replies. Only page waits advance time.
      if (ms >= 60000) return setTimeout(fn, ms);
      return setTimeout(() => { now += ms; options.onSleep?.(ms, worker); fn(); }, 0);
    };
    sandbox.chrome.runtime.getURL = p => `chrome-extension://test/${p}`;
    sandbox.chrome.contextMenus.removeAll = cb => cb();
    sandbox.chrome.contextMenus.create = (item, cb) => cb();
    sandbox.chrome.storage.session = {
      get: async key => Array.isArray(key) ? plain(session) : { [key]: session[key] },
      set: async value => { const copy = plain(value); writes.push(copy); Object.assign(session, copy); },
      remove: async key => { delete session[key]; },
    };
    sandbox.chrome.storage.local.get = async key => ({ [key]: local[key] });
    sandbox.chrome.windows.getLastFocused = async () => ({ id: 1, type: 'normal' });
    sandbox.chrome.tabs = {
      ...sandbox.chrome.tabs,
      create: async args => {
        const tab = { id: 50 + created.length, active: !!options.activeTab, url: args.url };
        created.push(args); tabs.set(tab.id, tab); navigated = false;
        return tab;
      },
      get: async id => {
        if (!tabs.has(id)) throw new Error('No tab with id');
        return tabs.get(id);
      },
      update: async (id, args) => {
        updated.push({ id, ...args });
        if (args.url) navigated = false;
        return Object.assign(tabs.get(id), args);
      },
      remove: async id => { await options.onRemove?.(id); removed.push(id); tabs.delete(id); },
    };
    sandbox.chrome.scripting = { executeScript: async args => {
      scripts.push(args);
      if (!tabs.has(args.target.tabId)) throw new Error('No tab with id');
      if (args.files) return [];
      const [name, params] = args.args;
      pages.push({ name, params: plain(params), tabId: args.target.tabId });
      const custom = await options.page?.(name, params, { tabs, pages, worker });
      if (custom !== undefined) return [{ result: custom }];
      let result;
      if (name === 'chatPageState') result = { onChat: !navigated, trigger: true, lang: 'en-US', title: 'Private cleanup title', login: false, challenge: null };
      else if (name === 'openChatMenu') result = { ok: true, title: 'Private cleanup title' };
      else if (name === 'chatMenuItems') result = options.unarchive ? ['Unarchive', 'Delete'] : ['Archive', 'Delete'];
      else if (name === 'clickChatMenuItem') { navigated = params[0] === 'Archive'; result = { clicked: true }; }
      else if (name === 'closeChatMenu') result = { ok: true };
      else if (name === 'deleteDialogState') result = { found: true, title: 'Private cleanup title' };
      else if (name === 'confirmDeleteChat') { navigated = true; result = { ok: true }; }
      else throw new Error(`Unexpected page helper: ${name}`);
      return [{ result }];
    } };
    const original = port.postMessage;
    port.postMessage = msg => {
      original(msg);
      if (msg.type !== 'call') return;
      Promise.resolve().then(async () => {
        let result = await options.host?.(msg);
        if (result === undefined) {
          if (msg.method === 'chat_cleanup_check') result = { eligible: options.ineligible ? [] : msg.params.ids };
          else if (msg.method === 'chat_cleanup_mark') result = { id: msg.params.id, state: msg.params.state };
          else if (msg.method === 'chat_cleanup_release') result = {};
          else if (msg.method === 'chat_cleanup_list') result = { eligible: options.chats || [cleanupChat()], deletable: options.deletable || options.chats || [cleanupChat()], kept: { active: 2 }, keptTotal: 2, cleaned: { archived: 1, deleted: 0 } };
          else throw new Error(`Unexpected host call: ${msg.method}`);
        }
        await worker.ctx.onHostMessage({ type: 'reply', reqId: msg.reqId, ok: !result.__error, result, error: result.__error });
      });
    };
  });
  const send = (msg, sender = { id: 'test', url: 'chrome-extension://test/popup.html' }) => new Promise(resolve => {
    let open = false;
    for (const listener of worker.listeners) if (listener(msg, sender, resolve) === true) open = true;
    if (!open) setImmediate(() => resolve(undefined));
  });
  const welcome = () => worker.ctx.onHostMessage({ type: 'welcome' });
  const done = chats => worker.ctx.onHostMessage({ type: 'chat_done', chats: chats || [cleanupChat()] });
  const state = () => plain(vm.runInContext('({ queue: cleanupQueue, progress: cleanupProgress, running: cleanupRunning })', worker.ctx));
  const wait = async predicate => {
    for (let i = 0; i < 500; i++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.fail('Cleanup did not reach the expected state');
  };
  const finish = () => wait(() => !!state().progress?.finishedAt && !state().running);
  const calls = method => worker.posted.filter(msg => msg.type === 'call' && msg.method === method);
  return { ...worker, pages, scripts, created, updated, removed, logs, session, writes, local, tabs, send, welcome, done, state, wait, finish, calls };
}

test('chat cleanup: keep is the silent default, including unknown settings', async () => {
  for (const setting of [undefined, 'keep', 'unknown']) {
    const w = cleanupWorker({ setting });
    await w.welcome();
    await w.done();
    assert.equal(w.created.length, 0);
    assert.equal(w.scripts.length, 0);
    assert.equal(w.posted.filter(msg => /^chat_cleanup_/.test(msg.method || '')).length, 0);
    assert.equal(w.logs.length, 0);
  }
});

test('chat cleanup: archive checks eligibility and marks only the UUID and result', async () => {
  const w = cleanupWorker({ setting: 'archive' });
  await w.welcome();
  await w.done();
  await w.finish();
  assert.deepEqual(plain(w.calls('chat_cleanup_check')[0].params), { ids: [cleanupChat().id], reserve: true, action: 'archive' });
  assert.deepEqual(plain(w.calls('chat_cleanup_mark')[0].params), { id: cleanupChat().id, state: 'archived', error: null });
  assert.deepEqual(w.pages.filter(p => p.name === 'clickChatMenuItem').map(p => p.params), [['Archive', 'Private cleanup title']]);
  assert.equal(w.state().progress.archived, 1);
  assert.equal(w.state().progress.done, 1);
  assert.equal(w.created[0].active, false);
  assert.deepEqual(w.removed, [50]);
  assert.equal(w.session.cleanupQueue.length, 0);
  assert.ok(w.writes.some(write => write.cleanupQueue?.length === 1 && write.cleanupProgress?.running));
  const outgoing = JSON.stringify([w.posted, w.logs]);
  assert.doesNotMatch(outgoing, /token|cookie|Authorization|Private cleanup title|https:\/\/chatgpt\.com/i);
});

test('chat cleanup: an archived chat is skipped when archiving but deleted when deleting', async () => {
  const archive = cleanupWorker({ setting: 'archive', unarchive: true });
  await archive.welcome(); await archive.done(); await archive.finish();
  assert.equal(archive.pages.filter(p => p.name === 'clickChatMenuItem').length, 0);
  assert.equal(archive.state().progress.alreadyArchived, 1);
  assert.equal(archive.calls('chat_cleanup_mark')[0].params.state, 'archived');
  assert.equal(archive.pages.some(p => ['deleteDialogState', 'confirmDeleteChat'].includes(p.name)), false);
  assert.ok(archive.pages.some(p => p.name === 'closeChatMenu'));

  const del = cleanupWorker({ setting: 'delete', unarchive: true });
  await del.welcome(); await del.done(); await del.finish();
  assert.deepEqual(plain(del.calls('chat_cleanup_check')[0].params), { ids: [cleanupChat().id], reserve: true, action: 'delete' });
  assert.deepEqual(del.pages.filter(p => p.name === 'clickChatMenuItem').map(p => p.params), [['Delete', 'Private cleanup title']]);
  assert.ok(del.pages.some(p => p.name === 'deleteDialogState'));
  assert.deepEqual(del.pages.filter(p => p.name === 'confirmDeleteChat').map(p => p.params), [['Private cleanup title']]);
  assert.equal(del.calls('chat_cleanup_mark')[0].params.state, 'deleted');
  assert.equal(del.state().progress.deleted, 1);
  assert.equal(del.state().progress.alreadyArchived || 0, 0);
});

test('chat cleanup: manual start queues the deletable list for delete and the eligible list for archive', async () => {
  const open = cleanupChat(1), archived = { ...cleanupChat(2), archived: true };
  for (const [action, expected] of [['delete', [open.id, archived.id]], ['archive', [open.id]]]) {
    const w = cleanupWorker({ chats: [open], deletable: [open, archived] });
    await w.welcome();
    const started = await w.send({ type: 'cleanup:start', action, ...(action === 'delete' ? { confirmed: true } : {}) });
    assert.equal(started.queued, expected.length);
    await w.finish();
    assert.deepEqual(w.calls('chat_cleanup_check').map(msg => msg.params.ids[0]), expected);
    assert.ok(w.calls('chat_cleanup_check').every(msg => msg.params.action === action));
  }
});

test('chat cleanup: a new manual archive drops a stopped delete queue', async () => {
  let language = 'tr';
  const chats = [cleanupChat(), cleanupChat(1)];
  const w = cleanupWorker({ chats, page: name => name === 'chatPageState' && language === 'tr'
    ? { onChat: true, trigger: true, lang: language } : undefined });
  await w.welcome();
  await w.send({ type: 'cleanup:start', action: 'delete', confirmed: true });
  await w.finish();
  assert.equal(w.state().progress.error, 'unsupported_language');
  assert.equal(w.state().queue.length, 0);
  assert.equal(w.state().progress.notProcessed, 2);
  assert.equal(w.calls('chat_cleanup_release').length, 1);
  language = 'en';
  const started = await w.send({ type: 'cleanup:start', action: 'archive' });
  assert.equal(started.queued, 2);
  await w.finish();
  assert.deepEqual(w.pages.filter(p => p.name === 'clickChatMenuItem').map(p => p.params[0]), ['Archive', 'Archive']);
  assert.equal(w.pages.some(p => p.name === 'confirmDeleteChat'), false);
});

test('chat cleanup: manual archive updates pending deletes without changing the in-flight chat', async () => {
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const opening = new Promise(resolve => { entered = resolve; });
  let opens = 0;
  const w = cleanupWorker({ setting: 'delete', chats: [0, 1, 2].map(cleanupChat), page: async name => {
    if (name === 'openChatMenu' && ++opens === 1) { entered(); await blocked; }
  } });
  await w.welcome(); await w.done([0, 1, 2].map(cleanupChat)); await opening;
  const started = await w.send({ type: 'cleanup:start', action: 'archive' });
  assert.equal(started.queued, 2);
  assert.deepEqual(w.state().queue.map(item => [item.action, item.source]), [['delete', 'auto'], ['archive', 'manual'], ['archive', 'manual']]);
  release(); await w.finish();
  assert.deepEqual(w.pages.filter(p => p.name === 'clickChatMenuItem').map(p => p.params), [
    ['Delete', 'Private cleanup title'], ['Archive', 'Private cleanup title'], ['Archive', 'Private cleanup title'],
  ]);
});

test('chat cleanup: a manual request during a running cleanup updates the progress action and source', async () => {
  for (const [setting, manual, extra] of [['archive', 'delete', { confirmed: true }], ['delete', 'archive', {}]]) {
    let release, entered;
    const blocked = new Promise(resolve => { release = resolve; });
    const opening = new Promise(resolve => { entered = resolve; });
    let opens = 0;
    const w = cleanupWorker({ setting, chats: [0, 1, 2].map(cleanupChat), page: async name => {
      if (name === 'openChatMenu' && ++opens === 1) { entered(); await blocked; }
    } });
    await w.welcome(); await w.done([0, 1, 2].map(cleanupChat)); await opening;
    assert.equal(w.state().progress.action, setting);
    assert.equal(w.state().progress.source, 'auto');
    await w.send({ type: 'cleanup:start', action: manual, ...extra });
    assert.equal(w.state().progress.action, manual);
    assert.equal(w.state().progress.source, 'manual');
    release(); await w.finish();
  }
});

test('chat cleanup: an auto item whose setting turned to keep is skipped without a reservation release', async () => {
  let changed = false;
  const w = cleanupWorker({ setting: 'archive', onSleep(ms) {
    if (ms === 1000 && !changed) { changed = true; w.local.chatCleanup = 'keep'; }
  } });
  await w.welcome(); await w.done([cleanupChat(), cleanupChat(1)]); await w.finish();
  assert.equal(changed, true);
  assert.equal(w.state().progress.skipped, 1);
  assert.equal(w.calls('chat_cleanup_check').length, 1);
  assert.equal(w.calls('chat_cleanup_release').length, 0);
});

test('chat cleanup: items queued after an error finishes are discarded instead of left in the queue', async () => {
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const closing = new Promise(resolve => { entered = resolve; });
  let closes = 0;
  const w = cleanupWorker({ setting: 'archive', page: name => name === 'chatPageState'
    ? { onChat: true, trigger: true, lang: 'tr' } : undefined, onRemove: async () => {
    if (++closes === 1) { entered(); await blocked; }
  } });
  await w.welcome(); await w.done(); await closing;
  assert.equal(w.state().progress.error, 'unsupported_language');
  await w.done([cleanupChat(1)]);
  assert.equal(w.state().queue.length, 1);
  release(); await w.finish();
  await w.wait(() => w.state().queue.length === 0 && w.session.cleanupQueue.length === 0);
  assert.equal(w.state().progress.notProcessed, 2);
  assert.equal(w.session.cleanupProgress.notProcessed, 2);
  assert.equal(w.calls('chat_cleanup_check').length, 1);
});

test('chat cleanup: an idle manual archive replaces deletes preserved after a host error', async () => {
  let checks = 0;
  const w = cleanupWorker({ chats: [cleanupChat(), cleanupChat(1)], host: msg => {
    if (msg.method === 'chat_cleanup_check' && ++checks === 1) return { __error: 'not connected' };
  } });
  await w.welcome();
  await w.send({ type: 'cleanup:start', action: 'delete', confirmed: true });
  await w.finish();
  assert.equal(w.state().progress.error, 'not_connected');
  assert.equal(w.state().queue.length, 2);
  const started = await w.send({ type: 'cleanup:start', action: 'archive' });
  assert.equal(started.queued, 2);
  await w.finish();
  assert.deepEqual(w.pages.filter(p => p.name === 'clickChatMenuItem').map(p => p.params[0]), ['Archive', 'Archive']);
});

test('chat cleanup: auto items reread keep, invalid and changed actions before processing', async () => {
  for (const next of ['keep', 'invalid', 'archive']) {
    let changed = false;
    const w = cleanupWorker({ setting: 'delete', onSleep(ms) {
      if (ms === 1000 && !changed) { changed = true; w.local.chatCleanup = next; }
    } });
    await w.welcome(); await w.done([cleanupChat(), cleanupChat(1)]); await w.finish();
    assert.equal(changed, true);
    const labels = w.pages.filter(p => p.name === 'clickChatMenuItem').map(p => p.params[0]);
    assert.deepEqual(labels, next === 'archive' ? ['Delete', 'Archive'] : ['Delete']);
    assert.equal(w.calls('chat_cleanup_mark').length, next === 'archive' ? 2 : 1);
    assert.equal(w.state().progress.skipped, next === 'archive' ? 0 : 1);
  }
});

test('chat cleanup: stop or a current job after reservation releases before driving the chat', async () => {
  for (const reason of ['stop', 'current']) {
    let release, entered;
    const blocked = new Promise(resolve => { release = resolve; });
    const checking = new Promise(resolve => { entered = resolve; });
    let checks = 0;
    const w = cleanupWorker({ setting: 'archive', host: async msg => {
      if (msg.method === 'chat_cleanup_check' && ++checks === 1) { entered(); await blocked; }
    } });
    await w.welcome(); await w.done(); await checking;
    if (reason === 'stop') await w.send({ type: 'cleanup:stop' });
    else vm.runInContext('current = { job: { id: "active" } }', w.ctx);
    release();
    await w.wait(() => w.calls('chat_cleanup_release').length === 1);
    assert.equal(w.created.length, 0);
    assert.equal(w.calls('chat_cleanup_mark').length, 0);
    if (reason === 'current') await w.send({ type: 'cleanup:stop' });
    await w.finish();
    assert.equal(w.state().progress.notProcessed, 1);
  }
});

test('chat cleanup: dismiss clears a stored error and persists the acknowledgement', async () => {
  const w = cleanupWorker({ setting: 'archive', page: name => name === 'chatPageState'
    ? { onChat: true, trigger: true, lang: 'tr' } : undefined });
  await w.welcome(); await w.done(); await w.finish();
  assert.equal((await w.send({ type: 'cleanup:status' })).progress.error, 'unsupported_language');
  assert.deepEqual(plain(await w.send({ type: 'cleanup:dismiss' })), { ok: true });
  assert.equal(w.session.cleanupProgress, null);
  assert.equal((await w.send({ type: 'cleanup:status' })).progress, null);
});

test('chat cleanup: ineligible chats are skipped before any tab or page interaction', async () => {
  const w = cleanupWorker({ setting: 'archive', ineligible: true });
  await w.welcome(); await w.done(); await w.finish();
  assert.equal(w.scripts.length, 0);
  assert.equal(w.created.length, 0);
  assert.equal(w.calls('chat_cleanup_mark').length, 0);
  assert.equal(w.state().progress.skipped, 1);
});

test('chat cleanup: waits for the current job, then reuses one separate helper tab', async () => {
  let waits = 0;
  const w = cleanupWorker({ setting: 'archive', onSleep(ms, worker) {
    if (ms === 3000 && ++waits === 2) vm.runInContext('current = null', worker.ctx);
  } });
  await w.welcome();
  vm.runInContext('current = { job: { id: "active" } }; workerTabId = 99', w.ctx);
  await w.done([cleanupChat(), cleanupChat(1)]);
  assert.equal(w.calls('chat_cleanup_check').length, 0);
  assert.equal(w.created.length, 0);
  await w.finish();
  assert.equal(waits, 2);
  assert.equal(w.created.length, 1);
  assert.equal(w.updated.filter(args => args.url).length, 1);
  assert.ok(w.pages.every(p => p.tabId === 50));
  assert.equal(vm.runInContext('workerTabId', w.ctx), 99);
});

test('chat cleanup: three consecutive failures mark fixed codes and clear remaining items', async () => {
  const w = cleanupWorker({ setting: 'archive', page: name => name === 'openChatMenu' ? { ok: false, error: 'menu_trigger_not_found' } : undefined });
  await w.welcome(); await w.done(Array.from({ length: 10 }, (_, n) => cleanupChat(n))); await w.finish();
  assert.equal(w.state().progress.error, 'too_many_failures');
  assert.equal(w.state().progress.failed, 3);
  assert.equal(w.state().progress.done, 3);
  assert.equal(w.state().progress.notProcessed, 7);
  assert.equal(w.session.cleanupProgress.notProcessed, 7);
  assert.equal(w.calls('chat_cleanup_check').length, 3);
  assert.deepEqual(w.calls('chat_cleanup_mark').map(msg => plain(msg.params)), [0, 1, 2].map(n => ({
    id: cleanupChat(n).id, state: 'failed', error: 'menu_trigger_not_found',
  })));
  assert.equal(w.state().queue.length, 0);
});

test('chat cleanup: non-English, empty language, login and challenge stop without clicks or marks', async () => {
  for (const [extra, error] of [[{ lang: 'tr' }, 'unsupported_language'], [{ lang: '' }, 'unsupported_language'],
    [{ login: true }, 'login'], [{ challenge: 'captcha' }, 'challenge']]) {
    const w = cleanupWorker({ setting: 'archive', page: name => name === 'chatPageState'
      ? { onChat: true, trigger: true, lang: 'en', ...extra } : undefined });
    await w.welcome(); await w.done([cleanupChat(), cleanupChat(1)]); await w.finish();
    assert.equal(w.state().progress.error, error);
    assert.ok(w.pages.every(p => p.name === 'chatPageState'));
    assert.equal(w.calls('chat_cleanup_mark').length, 0);
    assert.equal(w.calls('chat_cleanup_check').length, 1);
    assert.equal(w.calls('chat_cleanup_release').length, 1);
    assert.equal(w.state().queue.length, 0);
    assert.equal(w.state().progress.notProcessed, 2);
  }
});

test('chat cleanup: manual delete requires explicit confirmation and extension-page provenance', async () => {
  const w = cleanupWorker();
  await w.welcome();
  assert.equal((await w.send({ type: 'cleanup:start', action: 'delete' })).error, 'confirmation_required');
  assert.equal((await w.send({ type: 'cleanup:start', action: 'delete', confirmed: 'true' })).error, 'confirmation_required');
  assert.equal((await w.send({ type: 'cleanup:start', action: 'other' })).error, 'invalid_action');
  assert.equal(await w.send({ type: 'cleanup:start', action: 'archive' }, { id: 'test', url: 'https://chatgpt.com/' }), undefined);
  assert.equal(await w.send({ type: 'cleanup:start', action: 'archive' }, { id: 'other', url: 'chrome-extension://test/popup.html' }), undefined);
  assert.equal(w.calls('chat_cleanup_list').length, 0);
  assert.equal(w.state().queue.length, 0);
  const preview = await w.send({ type: 'cleanup:preview' });
  assert.equal(preview.ok, true);
  assert.equal(preview.result.eligible.length, 1);
  const started = await w.send({ type: 'cleanup:start', action: 'delete', confirmed: true });
  assert.deepEqual(plain(started), { ok: true, queued: 1, kept: { active: 2 }, keptTotal: 2, cleaned: { archived: 1, deleted: 0 } });
  await w.finish();
  assert.equal(w.state().progress.deleted, 1);
  assert.equal(w.state().progress.source, 'manual');
  assert.deepEqual(w.session.cleanupProgress.kept, { active: 2 });
  assert.equal(w.session.cleanupProgress.keptTotal, 2);
});

test('chat cleanup: disconnected preview and start return stable errors without host calls', async () => {
  const w = cleanupWorker();
  for (const type of ['cleanup:preview', 'cleanup:start']) {
    assert.deepEqual(plain(await w.send({ type, action: 'archive' })), { ok: false, error: 'not_connected' });
  }
  assert.equal(w.calls('chat_cleanup_list').length, 0);
});

test('chat cleanup: title mismatch marks a fixed failure code without a successful confirmation', async () => {
  const w = cleanupWorker({ setting: 'delete', page: name => name === 'confirmDeleteChat' ? { ok: false, error: 'title_mismatch' } : undefined });
  await w.welcome(); await w.done(); await w.finish();
  assert.deepEqual(plain(w.calls('chat_cleanup_mark')[0].params), { id: cleanupChat().id, state: 'failed', error: 'title_mismatch' });
  assert.equal(w.state().progress.deleted, 0);
  assert.equal(w.pages.filter(p => p.name === 'chatPageState').length, 3);
  // The real helper's Cancel/Delete clicks are covered by the DOM tests, rather than this script fake.
  assert.equal(w.pages.filter(p => p.name === 'confirmDeleteChat').length, 1);
  assert.doesNotMatch(JSON.stringify([w.posted, w.logs]), /token|cookie|Authorization|Private cleanup title|https:\/\/chatgpt\.com/i);
});

test('chat cleanup: validates targets and deduplicates queued UUIDs while manual work adds to the total', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const w = cleanupWorker({ setting: 'archive', chats: [cleanupChat(), cleanupChat(1)],
    host: async msg => { if (msg.method === 'chat_cleanup_check') await blocked; } });
  await w.welcome();
  const valid = cleanupChat();
  await w.done([valid, { id: 'bad', url: valid.url }, { ...valid, url: valid.url + '0' },
    { ...valid, url: valid.url.replace('https:', 'http:') }, { ...valid, url: valid.url.replace('chatgpt.com', 'example.com') },
    { ...valid, url: cleanupChat(1).url }, { ...valid, url: `https://chatgpt.com/share/${valid.id}` }]);
  await w.done([{ ...valid, id: valid.id.toUpperCase() }]);
  const started = await w.send({ type: 'cleanup:start', action: 'archive' });
  assert.equal(started.queued, 1);
  assert.equal(w.state().queue.length, 2);
  assert.equal(w.state().progress.total, 2);
  release(); await w.finish();
  assert.equal(w.calls('chat_cleanup_mark').length, 2);
});

test('chat cleanup: stop finishes the in-flight chat and discards queued chats', async () => {
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const opening = new Promise(resolve => { entered = resolve; });
  const w = cleanupWorker({ setting: 'archive', page: async name => {
    if (name === 'openChatMenu') { entered(); await blocked; }
  } });
  await w.welcome(); await w.done([cleanupChat(), cleanupChat(1)]);
  await opening;
  assert.equal((await w.send({ type: 'cleanup:stop' })).ok, true);
  assert.equal((await w.send({ type: 'cleanup:status' })).queued, 0);
  release(); await w.finish();
  assert.equal(w.state().progress.archived, 1);
  assert.equal(w.calls('chat_cleanup_check').length, 1);
  assert.equal(w.session.cleanupQueue.length, 0);
  assert.equal(w.state().progress.notProcessed, 1);
});

test('chat cleanup: closed helper stops without marking and active helpers remain open', async () => {
  const closed = cleanupWorker({ setting: 'archive', page(name, params, { tabs }) {
    if (name === 'openChatMenu') { tabs.clear(); throw new Error('Tab was closed'); }
  } });
  await closed.welcome(); await closed.done(); await closed.finish();
  assert.equal(closed.state().progress.error, 'tab_closed');
  assert.equal(closed.calls('chat_cleanup_mark').length, 0);
  assert.equal(closed.calls('chat_cleanup_release').length, 1);
  assert.equal(closed.state().progress.notProcessed, 1);
  const active = cleanupWorker({ setting: 'archive', activeTab: true });
  await active.welcome(); await active.done(); await active.finish();
  assert.equal(active.removed.length, 0);
});

test('chat cleanup: stop during a gate failure counts every unprocessed chat once', async () => {
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const reading = new Promise(resolve => { entered = resolve; });
  const w = cleanupWorker({ setting: 'archive', page: async name => {
    if (name === 'chatPageState') {
      entered(); await blocked;
      return { onChat: true, trigger: true, lang: 'tr' };
    }
  } });
  await w.welcome(); await w.done([cleanupChat(), cleanupChat(1)]); await reading;
  await w.send({ type: 'cleanup:stop' });
  await w.send({ type: 'cleanup:stop' });
  release(); await w.finish();
  assert.equal(w.state().progress.notProcessed, 2);
  assert.equal(w.state().progress.done, 0);
  assert.equal(w.calls('chat_cleanup_mark').length, 0);
  assert.equal(w.calls('chat_cleanup_release').length, 1);
});

test('chat cleanup: restores session work only after welcome and continues prior progress', async () => {
  const item = { ...cleanupChat(), action: 'archive', source: 'manual' };
  const w = cleanupWorker({ session: { cleanupQueue: [item], cleanupProgress: {
    running: true, action: 'archive', source: 'manual', total: 2, done: 1, archived: 1, deleted: 0,
    alreadyArchived: 0, skipped: 0, failed: 0, consecutiveFailures: 0, error: null, startedAt: 123, finishedAt: null,
  } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(w.calls('chat_cleanup_check').length, 0);
  assert.equal(w.created.length, 0);
  await w.welcome(); await w.finish();
  assert.equal(w.state().progress.archived, 2);
  assert.equal(w.state().progress.total, 2);
  assert.equal(w.state().progress.done, 2);
  assert.equal(w.state().progress.startedAt, 123);
  assert.deepEqual(w.session.cleanupQueue, []);
  assert.deepEqual(w.session.cleanupProgress.kept, {});
  assert.equal(w.session.cleanupProgress.keptTotal, 0);
  assert.equal(w.session.cleanupProgress.notProcessed, 0);
});

test('chat cleanup: an enqueue during the final tab close continues without losing progress', async () => {
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const closing = new Promise(resolve => { entered = resolve; });
  let closes = 0;
  const w = cleanupWorker({ setting: 'archive', onRemove: async () => {
    if (++closes === 1) { entered(); await blocked; }
  } });
  await w.welcome(); await w.done(); await closing;
  await w.done([cleanupChat(1)]);
  assert.equal(w.state().progress.total, 2);
  release(); await w.finish();
  assert.equal(w.state().progress.done, 2);
  assert.equal(w.state().progress.archived, 2);
  assert.equal(w.calls('chat_cleanup_mark').length, 2);
  assert.equal(w.session.cleanupQueue.length, 0);
});

test('chat cleanup: loading and confirmation timeouts produce fixed errors and never guess menu labels', async () => {
  const scenarios = [
    { error: 'wrong_page', page: name => name === 'chatPageState' ? { onChat: false, trigger: false, lang: 'en-US' } : undefined },
    { error: 'menu_trigger_not_found', page: name => name === 'chatPageState' ? { onChat: true, trigger: false, lang: 'en-US' } : undefined },
    { error: 'menu_unexpected', page: name => name === 'chatMenuItems' ? ['Auto', 'Instant', 'Thinking'] : undefined, closed: true },
    { error: 'item_ambiguous', page: name => name === 'clickChatMenuItem' ? { clicked: false, error: 'item_ambiguous' } : undefined, closed: true },
    { error: 'not_confirmed', page: name => name === 'chatPageState' ? { onChat: true, trigger: true, lang: 'EN-us', title: 'Private cleanup title' } : undefined },
    { error: 'dialog_not_found', action: 'delete', page: name => name === 'deleteDialogState' ? { found: false } : undefined },
  ];
  for (const scenario of scenarios) {
    const w = cleanupWorker({ setting: scenario.action || 'archive', page: scenario.page });
    await w.welcome(); await w.done(); await w.finish();
    assert.equal(w.calls('chat_cleanup_mark')[0].params.error, scenario.error);
    assert.equal(w.calls('chat_cleanup_mark')[0].params.state, 'failed');
    assert.equal(w.state().progress.failed, 1);
    if (scenario.closed) assert.ok(w.pages.some(p => p.name === 'closeChatMenu'));
    if (['wrong_page', 'menu_trigger_not_found', 'menu_unexpected'].includes(scenario.error)) {
      assert.equal(w.pages.filter(p => p.name === 'clickChatMenuItem').length, 0);
    }
    assert.equal(w.pages.filter(p => p.name === 'confirmDeleteChat').length, 0);
  }
});

test('chat cleanup: retries loading injection errors and never sends raw page errors to the host', async () => {
  let reads = 0;
  const w = cleanupWorker({ setting: 'archive', page: name => {
    if (name === 'chatPageState' && ++reads === 1) throw new Error('Frame is loading');
    if (name === 'clickChatMenuItem') throw new Error(`Private cleanup title ${cleanupChat().url}`);
  } });
  await w.welcome(); await w.done(); await w.finish();
  assert.ok(reads >= 3);
  assert.equal(w.calls('chat_cleanup_mark')[0].params.error, 'not_confirmed');
  assert.doesNotMatch(JSON.stringify([w.posted, w.logs]), /token|cookie|Authorization|Private cleanup title|https:\/\/chatgpt\.com/i);
});

test('chat cleanup: a successful chat resets consecutive failures and mark rejection does not stop the queue', async () => {
  let opened = 0, marked = 0;
  const w = cleanupWorker({ setting: 'archive', page: name => {
    if (name === 'openChatMenu' && ++opened <= 2) return { ok: false, error: 'menu_trigger_not_found' };
  }, host: msg => {
    if (msg.method === 'chat_cleanup_mark' && ++marked === 3) return { __error: `Private cleanup title ${cleanupChat().url}` };
  } });
  await w.welcome(); await w.done([0, 1, 2, 3].map(cleanupChat)); await w.finish();
  assert.equal(w.state().progress.error, null);
  assert.equal(w.state().progress.done, 4);
  assert.equal(w.state().progress.failed, 3);
  assert.equal(w.state().progress.archived, 1); // The rejected mark is counted only as a failure.
  assert.equal(w.state().progress.deleted, 0);
  assert.equal(w.state().progress.consecutiveFailures, 0);
  assert.equal(w.calls('chat_cleanup_mark').length, 4);
  assert.doesNotMatch(JSON.stringify([w.posted, w.logs]), /Private cleanup title|https:\/\/chatgpt\.com/i);
});

test('chat cleanup: mark rejection counts once without a success for archive, delete, already archived or page failure', async () => {
  for (const options of [{ setting: 'archive' }, { setting: 'delete' }, { setting: 'archive', unarchive: true },
    { setting: 'archive', page: name => name === 'openChatMenu' ? { ok: false, error: 'menu_trigger_not_found' } : undefined }]) {
    const w = cleanupWorker({ ...options, host: msg => msg.method === 'chat_cleanup_mark' ? { __error: 'mark rejected' } : undefined });
    await w.welcome(); await w.done(); await w.finish();
    const p = w.state().progress;
    assert.equal(p.failed, 1);
    assert.equal(p.archived + p.deleted + p.alreadyArchived, 0);
    assert.equal(p.done, 1);
    assert.equal(p.consecutiveFailures, options.page ? 1 : 0);
    assert.equal(p.error, null);
    assert.equal(w.calls('chat_cleanup_release').length, 1);
  }
});

test('chat cleanup: disconnection preserves pending work for the next welcome', async () => {
  let disconnected = false;
  const w = cleanupWorker({ setting: 'archive', onSleep(ms, worker) {
    if (!disconnected && ms === 3000) {
      disconnected = true;
      vm.runInContext('hostReady = false; current = null', worker.ctx);
    }
  } });
  await w.welcome();
  vm.runInContext('current = { job: { id: "active" } }', w.ctx);
  await w.done(); await w.finish();
  assert.equal(w.state().progress.error, 'not_connected');
  assert.equal(w.session.cleanupQueue.length, 1);
  assert.equal(w.calls('chat_cleanup_mark').length, 0);
  await w.welcome(); await w.finish();
  assert.equal(w.state().progress.archived, 1);
  assert.equal(w.session.cleanupQueue.length, 0);
});

test('chat cleanup: recreates a helper closed between items', async () => {
  const w = cleanupWorker({ setting: 'archive', onSleep(ms) { if (ms === 1000) w.tabs.clear(); } });
  await w.welcome(); await w.done([cleanupChat(), cleanupChat(1)]); await w.finish();
  assert.equal(w.created.length, 2);
  assert.equal(w.state().progress.archived, 2);
  assert.deepEqual([...new Set(w.pages.map(p => p.tabId))], [50, 51]);
});

// Page states for the chat cleanup worker: 'gone' is ChatGPT's access notice on the home page,
// 'lost' is an unexpected home page without it. Anything else is a normal, working chat page.
const GONE_PAGE = { onChat: false, trigger: false, lang: 'en-US', login: false, challenge: null, gone: true };
const LOST_PAGE = { onChat: false, trigger: false, lang: 'en-US', login: false, challenge: null, gone: false };
const pagesByChat = kinds => (name, params) => {
  if (name !== 'chatPageState') return undefined;
  const kind = kinds[kinds.map((_, n) => cleanupChat(n).id).indexOf(params[0])];
  return kind === 'gone' ? GONE_PAGE : kind === 'lost' ? LOST_PAGE : undefined;
};

test('chat cleanup: chats ChatGPT already lost are marked gone without a failure and do not stop the run', async () => {
  const w = cleanupWorker({ setting: 'archive', page: pagesByChat(['gone', 'gone', 'gone', 'ok']) });
  await w.welcome(); await w.done([0, 1, 2, 3].map(cleanupChat)); await w.finish();
  const p = w.state().progress;
  assert.equal(p.error, null);
  assert.equal(p.stop, null);
  assert.equal(p.gone, 3);
  assert.equal(p.failed, 0);
  assert.equal(p.archived, 1);
  assert.equal(p.done, 4);
  assert.equal(p.notProcessed, 0);
  assert.equal(p.consecutiveFailures, 0);
  assert.deepEqual(w.calls('chat_cleanup_mark').map(msg => plain(msg.params)), [
    { id: cleanupChat(0).id, state: 'gone', error: null }, { id: cleanupChat(1).id, state: 'gone', error: null },
    { id: cleanupChat(2).id, state: 'gone', error: null }, { id: cleanupChat(3).id, state: 'archived', error: null },
  ]);
  // A gone chat never opens a menu: only the archived one does.
  assert.deepEqual(w.pages.filter(page => page.name === 'openChatMenu').map(page => page.params), [[cleanupChat(3).id]]);
  assert.equal(w.calls('chat_cleanup_release').length, 0);
  assert.equal(w.session.cleanupProgress.gone, 3);
  assert.equal(w.session.cleanupQueue.length, 0);
});

test('chat cleanup: five gone chats in a row never trip the failure brake', async () => {
  const w = cleanupWorker({ setting: 'archive', page: pagesByChat(Array(5).fill('gone')) });
  await w.welcome(); await w.done([0, 1, 2, 3, 4].map(cleanupChat)); await w.finish();
  const p = w.state().progress;
  assert.equal(p.error, null);
  assert.equal(p.gone, 5);
  assert.equal(p.failed, 0);
  assert.equal(p.done, 5);
  assert.equal(p.consecutiveFailures, 0);
  assert.equal(w.calls('chat_cleanup_mark').length, 5);
  assert.equal(w.pages.some(page => page.name === 'openChatMenu'), false);
});

test('chat cleanup: three real unexpected pages still stop the run and name the step and code', async () => {
  const w = cleanupWorker({ setting: 'archive', page: pagesByChat(Array(10).fill('lost')) });
  await w.welcome(); await w.done(Array.from({ length: 10 }, (_, n) => cleanupChat(n))); await w.finish();
  const p = w.state().progress;
  assert.equal(p.error, 'too_many_failures');
  assert.deepEqual(p.stop, { step: 'load', code: 'wrong_page' });
  assert.equal(p.failed, 3);
  assert.equal(p.gone, 0);
  assert.equal(p.notProcessed, 7);
  assert.deepEqual(w.session.cleanupProgress.stop, { step: 'load', code: 'wrong_page' });
  assert.deepEqual(w.calls('chat_cleanup_mark').map(msg => msg.params.error), ['wrong_page', 'wrong_page', 'wrong_page']);
});

test('chat cleanup: a gone chat neither adds to nor resets the failure count', async () => {
  const w = cleanupWorker({ setting: 'archive', page: pagesByChat(['lost', 'gone', 'lost', 'lost', 'ok']) });
  await w.welcome(); await w.done([0, 1, 2, 3, 4].map(cleanupChat)); await w.finish();
  const p = w.state().progress;
  assert.equal(p.error, 'too_many_failures');
  assert.deepEqual(p.stop, { step: 'load', code: 'wrong_page' });
  assert.equal(p.failed, 3);
  assert.equal(p.gone, 1);
  assert.equal(p.done, 4);
  assert.equal(p.notProcessed, 1);
  assert.equal(w.calls('chat_cleanup_check').length, 4);
  assert.equal(w.state().queue.length, 0);
  // The same three failures with the gone chat after them still stop at the third failure.
  const after = cleanupWorker({ setting: 'archive', page: pagesByChat(['lost', 'lost', 'lost', 'gone']) });
  await after.welcome(); await after.done([0, 1, 2, 3].map(cleanupChat)); await after.finish();
  assert.equal(after.state().progress.error, 'too_many_failures');
  assert.equal(after.state().progress.gone, 0);
  assert.equal(after.state().progress.notProcessed, 1);
});

test('chat cleanup: a rejected gone mark counts as a failed chat, not a gone one, and leaves the brake alone', async () => {
  const w = cleanupWorker({ setting: 'archive', page: pagesByChat(['gone', 'ok']),
    host: msg => msg.method === 'chat_cleanup_mark' && msg.params.state === 'gone' ? { __error: 'Private cleanup title mark rejected' } : undefined });
  await w.welcome(); await w.done([0, 1].map(cleanupChat)); await w.finish();
  const p = w.state().progress;
  assert.equal(p.gone, 0);
  assert.equal(p.failed, 1);
  assert.equal(p.archived, 1);
  assert.equal(p.consecutiveFailures, 0);
  assert.equal(p.error, null);
  assert.equal(w.calls('chat_cleanup_release').length, 1);
});

test('chat cleanup: every stopping step is named, and the failure steps follow the page flow', async () => {
  const scenarios = [
    { step: 'load', code: 'wrong_page', page: name => name === 'chatPageState' ? LOST_PAGE : undefined },
    { step: 'load', code: 'menu_trigger_not_found', page: name => name === 'chatPageState' ? { onChat: true, trigger: false, lang: 'en-US' } : undefined },
    { step: 'open_menu', code: 'menu_trigger_not_found', page: name => name === 'openChatMenu' ? { ok: false, error: 'menu_trigger_not_found' } : undefined },
    { step: 'menu_items', code: 'menu_unexpected', page: name => name === 'chatMenuItems' ? ['Auto', 'Instant'] : undefined },
    { step: 'click_item', code: 'item_ambiguous', page: name => name === 'clickChatMenuItem' ? { clicked: false, error: 'item_ambiguous' } : undefined },
    { step: 'click_item', code: 'item_not_found', page: name => name === 'clickChatMenuItem' ? { clicked: false } : undefined },
    { step: 'delete_dialog', code: 'dialog_not_found', action: 'delete', page: name => name === 'deleteDialogState' ? { found: false } : undefined },
    { step: 'confirm_delete', code: 'title_mismatch', action: 'delete', page: name => name === 'confirmDeleteChat' ? { ok: false, error: 'title_mismatch' } : undefined },
    { step: 'verify', code: 'not_confirmed', page: name => name === 'chatPageState' ? { onChat: true, trigger: true, lang: 'en-US', title: 'Private cleanup title' } : undefined },
  ];
  for (const scenario of scenarios) {
    const w = cleanupWorker({ setting: scenario.action || 'archive', page: scenario.page });
    await w.welcome(); await w.done([0, 1, 2, 3].map(cleanupChat)); await w.finish();
    assert.equal(w.state().progress.error, 'too_many_failures', JSON.stringify(scenario));
    assert.deepEqual(w.state().progress.stop, { step: scenario.step, code: scenario.code }, JSON.stringify(scenario));
    assert.equal(w.state().progress.notProcessed, 1);
  }
});

test('chat cleanup: gates stop with their step, and the stop is cleared when the cleanup resumes', async () => {
  for (const [extra, code, step] of [[{ lang: 'tr' }, 'unsupported_language', 'language'], [{ login: true }, 'login', 'load'],
    [{ challenge: 'captcha' }, 'challenge', 'load']]) {
    const w = cleanupWorker({ setting: 'archive', page: name => name === 'chatPageState'
      ? { onChat: true, trigger: true, lang: 'en', ...extra } : undefined });
    await w.welcome(); await w.done(); await w.finish();
    assert.equal(w.state().progress.error, code);
    assert.deepEqual(w.state().progress.stop, { step, code });
    assert.deepEqual(w.session.cleanupProgress.stop, { step, code });
    assert.equal(w.calls('chat_cleanup_mark').length, 0);
  }
  // A manual start after a stopped run begins with a fresh progress object.
  let language = 'tr';
  const w = cleanupWorker({ chats: [cleanupChat()], page: name => name === 'chatPageState' && language === 'tr'
    ? { onChat: true, trigger: true, lang: language } : undefined });
  await w.welcome();
  await w.send({ type: 'cleanup:start', action: 'archive' });
  await w.finish();
  assert.deepEqual(w.state().progress.stop, { step: 'language', code: 'unsupported_language' });
  language = 'en';
  await w.send({ type: 'cleanup:start', action: 'archive' });
  await w.finish();
  assert.equal(w.state().progress.stop, null);
  assert.equal(w.state().progress.error, null);
  assert.equal(w.state().progress.archived, 1);
});

test('chat cleanup: a run without a stop keeps stop null and zero gone', async () => {
  const w = cleanupWorker({ setting: 'archive' });
  await w.welcome(); await w.done(); await w.finish();
  assert.equal(w.state().progress.stop, null);
  assert.equal(w.state().progress.gone, 0);
  assert.equal(w.session.cleanupProgress.stop, null);
});

test('chat cleanup: progress stored by an older build gains the gone counter and an empty stop', async () => {
  const item = { ...cleanupChat(), action: 'archive', source: 'manual' };
  const w = cleanupWorker({ session: { cleanupQueue: [item], cleanupProgress: {
    running: true, action: 'archive', source: 'manual', total: 2, done: 1, archived: 1, deleted: 0,
    alreadyArchived: 0, skipped: 0, failed: 0, consecutiveFailures: 0, error: null, startedAt: 123, finishedAt: null,
  } } });
  await w.welcome(); await w.finish();
  assert.equal(w.state().progress.gone, 0);
  assert.equal(w.state().progress.stop, null);
  assert.equal(w.state().progress.archived, 2);
});

test('chat cleanup: logs carry only the id, step and code, and never page text, titles or links', async () => {
  const w = cleanupWorker({ setting: 'archive', page: pagesByChat(['lost', 'gone', 'lost', 'lost', 'ok']) });
  await w.welcome(); await w.done([0, 1, 2, 3, 4].map(cleanupChat)); await w.finish();
  const logs = w.posted.filter(msg => msg.type === 'log' && /^chat cleanup/.test(msg.msg));
  const ids = n => cleanupChat(n).id;
  assert.deepEqual(logs.filter(l => l.msg === 'chat cleanup step failed').map(l => [l.level, plain(l.data)]), [
    ['warn', { id: ids(0), step: 'load', code: 'wrong_page' }], ['warn', { id: ids(2), step: 'load', code: 'wrong_page' }],
  ]);
  assert.deepEqual(logs.filter(l => l.msg === 'chat cleanup stopped at a step').map(l => [l.level, plain(l.data)]), [
    ['warn', { id: ids(3), step: 'load', code: 'wrong_page' }],
  ]);
  assert.deepEqual(logs.filter(l => l.msg === 'chat cleanup: chat already gone').map(l => [l.level, plain(l.data)]), [
    ['info', { id: ids(1) }],
  ]);
  for (const entry of logs.filter(l => l.msg !== 'chat cleanup finished')) {
    assert.deepEqual(Object.keys(entry.data).sort(), entry.msg.endsWith('gone') ? ['id'] : ['code', 'id', 'step']);
  }
  assert.doesNotMatch(JSON.stringify([w.posted, w.logs]), /token|cookie|Authorization|Private cleanup title|https:\/\/chatgpt\.com|access to this conversation/i);
  // A gate stop is logged the same way.
  const gate = cleanupWorker({ setting: 'archive', page: name => name === 'chatPageState'
    ? { onChat: true, trigger: true, lang: 'tr' } : undefined });
  await gate.welcome(); await gate.done(); await gate.finish();
  assert.deepEqual(gate.posted.filter(msg => msg.type === 'log' && msg.msg === 'chat cleanup stopped at a step').map(msg => [msg.level, plain(msg.data)]), [
    ['warn', { id: cleanupChat().id, step: 'language', code: 'unsupported_language' }],
  ]);
});

const decode = b64 => JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));

test('the service worker loads aspect.js through importScripts and connects', () => {
  const { ctx, posted } = loadWorker();
  assert.equal(typeof ctx.BackdrawAspect.cropRect, 'function');
  assert.equal(ctx.BackdrawAspect.TOLERANCE, 0.01);
  assert.equal(typeof ctx.BackdrawGif.decodeGifFrames, 'function');
  assert.equal(typeof ctx.BackdrawGif.contactLayout, 'function');
  assert.equal(posted[0].type, 'hello');
});

test('processImage: no aspect, no transparency: just the size and a white-backed preview', async () => {
  const { ctx, made } = loadWorker();
  const bmp = ctx.nextBitmap = new FakeBitmap(1983, 793, () => 255);
  const out = await ctx.processImage(btoa('x'), 'image/png', {});
  assert.equal(out.width, 1983);
  assert.equal(out.height, 793);
  assert.equal(out.crop, null);
  assert.equal(out.alpha, null);
  assert.equal(out.animated, false);
  assert.equal(out.previewFrames, null);
  assert.deepEqual(decode(out.preview), { type: 'image/jpeg', width: 1024, height: 409 });
  assert.equal(made.length, 1);
  assert.deepEqual(made[0].ops, [['fillRect', '#ffffff', 0, 0, 1024, 409], ['drawImage', 0, 0, 1983, 793, 0, 0, 1024, 409]]);
  assert.equal(bmp.closed, true);
});

test('processImage: cropped to the aspect ratio, measured, previewed from the crop over a checkerboard', async () => {
  const { ctx, made } = loadWorker();
  // The left 500 columns are see-through.
  const bmp = ctx.nextBitmap = new FakeBitmap(1983, 793, x => (x < 500 ? 0 : 255));
  const out = await ctx.processImage(btoa('x'), 'image/png', { aspect: { w: 4, h: 1, label: '4:1' }, transparent: true });
  assert.deepEqual({ ...out.crop, data: decode(out.crop.data) }, { data: { type: 'image/png', width: 1983, height: 496 }, mime: 'image/png', width: 1983, height: 496 });
  assert.deepEqual([out.width, out.height], [1983, 793]);
  assert.equal(out.animated, false);
  // The crop keeps the full width, so 500 of its 1983 columns are see-through.
  assert.ok(Math.abs(out.alpha.transparentShare - 500 / 1983) < 0.005, String(out.alpha.transparentShare));
  assert.ok(Math.abs(out.alpha.transparentShare + out.alpha.opaqueShare - 1) < 1e-9);
  assert.equal(made.length, 2); // the crop canvas is reused for the measurement
  assert.deepEqual(made[0].ops, [['drawImage', 0, 148, 1983, 496, 0, 0, 1983, 496]]);
  const preview = made[1];
  assert.deepEqual([preview.width, preview.height], [1024, 256]);
  assert.deepEqual(preview.ops[0], ['fillRect', '#ffffff', 0, 0, 1024, 256]);
  const squares = preview.ops.filter(op => op[0] === 'fillRect' && op[1] === '#e2e2e2');
  assert.equal(squares.length, 32 * 16);
  assert.deepEqual(squares.slice(0, 2), [['fillRect', '#e2e2e2', 0, 0, 16, 16], ['fillRect', '#e2e2e2', 32, 0, 16, 16]]);
  assert.deepEqual(preview.ops[preview.ops.length - 1], ['drawImage', 0, 148, 1983, 496, 0, 0, 1024, 256]);
  assert.deepEqual(decode(out.preview), { type: 'image/jpeg', width: 1024, height: 256 });
  assert.equal(bmp.closed, true);
});

test('processImage: within 1% of the ratio: no crop; an opaque image gets no checkerboard', async () => {
  const { ctx, made } = loadWorker();
  ctx.nextBitmap = new FakeBitmap(1983, 793, () => 255);
  const out = await ctx.processImage(btoa('x'), 'image/png', { aspect: { w: 5, h: 2, label: '5:2' }, transparent: true });
  assert.equal(out.crop, null);
  assert.deepEqual({ ...out.alpha }, { transparentShare: 0, opaqueShare: 1 }); // copied out of the vm's realm
  assert.equal(made.length, 2); // the whole image drawn once for the measurement, then the preview
  assert.deepEqual(made[0].ops, [['drawImage', 0, 0, 1983, 793, 0, 0, 1983, 793]]);
  assert.equal(made[1].ops.filter(op => op[0] === 'fillRect').length, 1);
});

test('processImage: collect jobs crop too, without measuring alpha', async () => {
  const { ctx } = loadWorker();
  ctx.nextBitmap = new FakeBitmap(1254, 1254, () => 255);
  const out = await ctx.processImage(btoa('x'), 'image/png', { mode: 'collect', aspect: { w: 16, h: 9, label: '16:9' }, transparent: false });
  assert.deepEqual([out.crop.width, out.crop.height], [1254, 705]);
  assert.equal(out.alpha, null);
});

test('processImage: GIF signatures skip cropping and measure first-frame alpha despite the MIME and job options', async () => {
  for (const signature of ['GIF87a', 'GIF89a']) {
    const { ctx, made } = loadWorker();
    const bmp = ctx.nextBitmap = new FakeBitmap(12, 8, () => 0);
    const image = gif({ width: 12, height: 8, frames: [{}, {}, {}] });
    image.write(signature, 0, 'latin1');
    const data = image.toString('base64');
    const decoded = [];
    ctx.atob = b64 => { decoded.push(b64); return atob(b64); };
    let measurements = 0;
    const measure = ctx.measureAlpha;
    ctx.measureAlpha = canvas => { measurements++; return measure(canvas); };
    const out = await ctx.processImage(data, 'image/png', {
      aspect: { w: 4, h: 1, label: '4:1' }, transparent: true, animated: false,
    });
    assert.deepEqual([out.width, out.height, out.crop, { ...out.alpha }, out.animated],
      [12, 8, null, { transparentShare: 1, opaqueShare: 0 }, true]);
    assert.equal(measurements, 1);
    assert.deepEqual(decode(out.preview), { type: 'image/jpeg', width: 1024, height: 738 });
    assert.deepEqual({ ...out.previewFrames }, { shown: 3, total: 3 });
    assert.equal(made.length, 3);
    assert.deepEqual(made[0].ops, [['drawImage', 0, 0, 12, 8, 0, 0, 12, 8]]);
    assert.deepEqual(made[1].ops[0], ['fillRect', '#ffffff', 0, 0, 1024, 738]);
    assert.deepEqual(made[1].ops.filter(op => op[0] === 'drawImage'), [
      ['drawImage', 0, 0, 12, 8, 8, 32, 500, 333],
      ['drawImage', 0, 0, 12, 8, 516, 32, 500, 333],
      ['drawImage', 0, 0, 12, 8, 8, 397, 500, 333],
    ]);
    assert.deepEqual(made[1].ops.filter(op => op[0] === 'fillText'), [
      ['fillText', '1', 12, 12, 'bold 16px sans-serif', 'top'],
      ['fillText', '2', 520, 12, 'bold 16px sans-serif', 'top'],
      ['fillText', '3', 12, 377, 'bold 16px sans-serif', 'top'],
    ]);
    assert.deepEqual(decoded, [data]);
    assert.equal(bmp.closed, true);
  }
});

test('processImage: a large GIF preview keeps the whole first frame within the preview size limit', async () => {
  const { ctx, made } = loadWorker();
  ctx.nextBitmap = new FakeBitmap(1983, 793, () => 0);
  const out = await ctx.processImage(gif().toString('base64'), 'image/gif', { aspect: { w: 4, h: 1 }, transparent: true });
  assert.equal(out.animated, true);
  assert.equal(out.previewFrames, null);
  assert.deepEqual(decode(out.preview), { type: 'image/jpeg', width: 1024, height: 409 });
  assert.deepEqual({ ...out.alpha }, { transparentShare: 1, opaqueShare: 0 });
  const previewCanvas = made.find(canvas => canvas.width === 1024 && canvas.height === 409);
  assert.ok(previewCanvas);
  assert.deepEqual(previewCanvas.ops, [['fillRect', '#ffffff', 0, 0, 1024, 409], ['drawImage', 0, 0, 1983, 793, 0, 0, 1024, 409]]);
});

test('processImage: three colored GIF frames appear in order over a checkerboard, with numbered labels', async () => {
  const { ctx } = loadPixelWorker();
  const canvases = [];
  const Canvas = ctx.OffscreenCanvas;
  ctx.OffscreenCanvas = class extends Canvas {
    constructor(w, h) { super(w, h); canvases.push(this); }
  };
  const first = new Uint8ClampedArray(4 * 4 * 4);
  ctx.createImageBitmap = async () => ({ width: 4, height: 4, data: first, close() {} });
  const image = rasterGif({ width: 4, height: 4,
    palette: [[255, 0, 0], [0, 255, 0], [0, 0, 255], [0, 0, 0]],
    frames: [0, 1, 2].map(color => ({ indices: Array.from({ length: 16 }, (_, i) => i < 8 ? 3 : color),
      transparentIndex: 3, disposal: 2 })) });
  const encoded = [];
  const convert = Canvas.prototype.convertToBlob;
  ctx.OffscreenCanvas.prototype.convertToBlob = function(opts) { encoded.push({ ...opts }); return convert.call(this, opts); };
  const out = await ctx.processImage(image.toString('base64'), 'image/gif', {});
  const preview = decodePng(Buffer.from(out.preview, 'base64'));
  const l = contactLayout(4, 4, 3);
  assert.deepEqual([preview.width, preview.height], [l.width, l.height]);
  assert.deepEqual({ ...out.previewFrames }, { shown: 3, total: 3 });
  assert.deepEqual(encoded, [{ type: 'image/jpeg', quality: 0.86 }]);
  const px = (x, y) => [...preview.data.subarray((y * preview.width + x) * 4, (y * preview.width + x + 1) * 4)];
  const sheet = canvases.find(c => c.labels.length === 3);
  assert.ok(sheet);
  for (let i = 0; i < 3; i++) {
    const x = l.gap + (i % l.columns) * (l.cellWidth + l.gap);
    const y = l.gap + Math.floor(i / l.columns) * (l.cellHeight + l.gap);
    const top = y + l.label;
    const color = [0, 0, 0, 255]; color[i] = 255;
    assert.deepEqual(px(x + Math.floor(l.imageWidth / 2), top + Math.floor(l.imageHeight * 0.75)), color);
    assert.deepEqual(px(x + 2, top + 2), [226, 226, 226, 255]);
    assert.deepEqual(px(x + 18, top + 2), [255, 255, 255, 255]);
    assert.deepEqual(sheet.labels[i], { text: String(i + 1), x: x + 4, y: y + 4,
      font: 'bold 16px sans-serif', baseline: 'top' });
  }
  assert.deepEqual(px(0, 0), [255, 255, 255, 255]);
});

test('processImage: sampled GIF labels use the real frame numbers and metadata', async () => {
  const { ctx, made } = loadWorker();
  ctx.nextBitmap = new FakeBitmap(1, 1, () => 255);
  const data = rasterGif({ width: 1, height: 1, frames: Array(40).fill({}) }).toString('base64');
  const out = await ctx.processImage(data, 'image/gif', {});
  assert.deepEqual({ ...out.previewFrames }, { shown: 16, total: 40 });
  const l = contactLayout(1, 1, 16);
  assert.deepEqual(decode(out.preview), { type: 'image/jpeg', width: l.width, height: l.height });
  const labels = made.flatMap(c => c.ops.filter(op => op[0] === 'fillText').map(op => op[1]));
  assert.deepEqual(labels, Array.from({ length: 16 }, (_, i) => String(Math.round(i * 39 / 15) + 1)));
});

test('processImage: corrupt GIF decoding and contact sheet export failures fall back to the first frame', async () => {
  for (const failure of ['truncated', 'decode', 'export']) {
    const { ctx, posted } = loadWorker();
    const bmp = ctx.nextBitmap = new FakeBitmap(12, 8, () => 0);
    const image = gif({ width: 12, height: 8, frames: [{}, {}, {}] });
    if (failure === 'decode') ctx.BackdrawGif.decodeGifFrames = () => { throw new Error('LZW failed'); };
    const Canvas = ctx.OffscreenCanvas;
    ctx.OffscreenCanvas = class extends Canvas {
      async convertToBlob(opts) {
        if (this.width > 12) throw new Error('Contact sheet export failed');
        return super.convertToBlob(opts);
      }
    };
    const out = await ctx.processImage((failure === 'truncated' ? image.subarray(0, -1) : image).toString('base64'), 'image/gif', {});
    assert.deepEqual(decode(out.preview), { type: 'image/jpeg', width: 12, height: 8 });
    assert.equal(out.previewFrames, null);
    assert.deepEqual({ ...out.alpha }, { transparentShare: 1, opaqueShare: 0 });
    assert.ok(warned(posted, 'contact sheet failed'));
    assert.equal(bmp.closed, true);
  }
});

test('processImage: single-frame GIF and collect mode retain the first frame preview', async () => {
  for (const [frames, job] of [[1, {}], [3, { mode: 'collect' }]]) {
    const { ctx, posted } = loadWorker();
    ctx.nextBitmap = new FakeBitmap(12, 8, () => 0);
    if (job.mode === 'collect') ctx.BackdrawGif.decodeGifFrames = () => { throw new Error('collect must not decode frames'); };
    const out = await ctx.processImage(gif({ width: 12, height: 8, frames: Array(frames).fill({}) }).toString('base64'), 'image/gif', job);
    assert.deepEqual(decode(out.preview), { type: 'image/jpeg', width: 12, height: 8 });
    assert.equal(out.previewFrames, null);
    assert.ok(!warned(posted, 'contact sheet failed'));
  }
});

test('processImage: PNG, JPEG and WebP keep their static preview behavior', async () => {
  for (const mime of ['image/png', 'image/jpeg', 'image/webp']) {
    const { ctx } = loadWorker();
    ctx.nextBitmap = new FakeBitmap(80, 40, () => 255);
    ctx.BackdrawGif.decodeGifFrames = () => { throw new Error('static image must not decode frames'); };
    const out = await ctx.processImage(btoa('static'), mime, {});
    assert.deepEqual(decode(out.preview), { type: 'image/jpeg', width: 80, height: 40 });
    assert.equal(out.previewFrames, null);
    assert.equal(out.alpha, null);
    assert.equal(out.animated, false);
  }
});

test('processImage: MIME and embedded text cannot turn PNG bytes into a GIF', async () => {
  const { ctx } = loadWorker();
  ctx.nextBitmap = new FakeBitmap(12, 8, () => 0);
  const image = Buffer.concat([png(6, { width: 12, height: 8 }), Buffer.from('image/svg+xml GIF89a')]);
  const out = await ctx.processImage(image.toString('base64'), 'image/gif', { aspect: { w: 4, h: 1 }, transparent: true });
  assert.equal(out.animated, false);
  assert.deepEqual([out.crop.width, out.crop.height], [12, 3]);
  assert.deepEqual({ ...out.alpha }, { transparentShare: 1, opaqueShare: 0 });
});

test('isGifBytes: only complete GIF87a and GIF89a signatures at the start match', () => {
  const { ctx } = loadWorker();
  for (const signature of ['', 'GIF', 'GIF89', 'GIF90a', 'xGIF89a', 'image/gif', 'GIF89b']) {
    assert.equal(ctx.isGifBytes(Buffer.from(signature)), false, signature);
  }
  assert.equal(ctx.isGifBytes(Buffer.from('GIF87a')), true);
  assert.equal(ctx.isGifBytes(Buffer.from('GIF89a')), true);
});

test('latestImageAsFile: GIF, PNG, WebP and JPEG keep the matching filename extension', async () => {
  const { ctx } = loadWorker();
  for (const [mime, ext] of [['image/gif', 'gif'], ['image/png', 'png'], ['image/webp', 'webp'], ['image/jpeg', 'jpg']]) {
    const calls = [];
    const data = (ext === 'gif' ? gif() : Buffer.from('image bytes')).toString('base64');
    ctx.pageCall = async (...args) => {
      calls.push(args);
      return args[1] === 'latestEarlierImage' ? { src: 'previous' } : { mime, data };
    };
    const out = JSON.parse(JSON.stringify(await ctx.latestImageAsFile({ tabId: 7 })));
    assert.deepEqual(out, [{ name: `previous-image.${ext}`, mime, data }]);
    assert.deepEqual(calls, [[7, 'latestEarlierImage'], [7, 'fetchImage', 'previous']]);
  }
});

// ---------------------------------------------------------------- downloadImages: what the host receives

const CHAT = 'https://chatgpt.com/c/6812a3b4-1c2d-8000-9e8f-0123456789ab';
// Each image as the result message carries it to the host: through JSON, as native messaging does.
async function download(ctx, job, images) {
  ctx.pageCall = async (tabId, fn, src) => ({ data: btoa(`bytes of ${src}`), mime: 'image/png', via: 'page', size: 9 });
  return JSON.parse(JSON.stringify(await ctx.downloadImages({ job, cancelled: false, tabId: 7, conversationUrl: CHAT }, images)));
}
const BANNER = { id: 'img_1a2b3c4d', aspect: { w: 4, h: 1, label: '4:1' }, transparent: true };
const warned = (posted, msg) => posted.some(m => m.type === 'log' && m.level === 'warn' && m.msg === msg);

test('downloadImages: each image carries ChatGPT\'s bytes, the crop and the alpha measurement', async () => {
  const { ctx } = loadWorker();
  ctx.nextBitmap = new FakeBitmap(1983, 793, x => (x < 500 ? 0 : 255));
  const images = await download(ctx, BANNER, [{ src: 'https://chatgpt.com/files/a.png', w: 1983, h: 793 }]);
  assert.equal(images.length, 1);
  const [im] = images;
  assert.deepEqual(Object.keys(im).sort(), ['alpha', 'animated', 'crop', 'data', 'height', 'mime', 'preview', 'previewFrames', 'width']);
  assert.equal(im.previewFrames, null);
  assert.equal(im.animated, false);
  assert.equal(Buffer.from(im.data, 'base64').toString(), 'bytes of https://chatgpt.com/files/a.png');
  assert.deepEqual([im.mime, im.width, im.height], ['image/png', 1983, 793]);
  assert.deepEqual({ ...im.crop, data: decode(im.crop.data) }, { data: { type: 'image/png', width: 1983, height: 496 }, mime: 'image/png', width: 1983, height: 496 });
  assert.ok(Math.abs(im.alpha.transparentShare - 500 / 1983) < 0.005, String(im.alpha.transparentShare));
  assert.deepEqual(decode(im.preview), { type: 'image/jpeg', width: 1024, height: 256 });
});

test('downloadImages: a failed preview keeps the crop and the measurement', async () => {
  const { ctx, posted } = loadWorker();
  ctx.nextBitmap = new FakeBitmap(1983, 793, () => 0);
  const Canvas = ctx.OffscreenCanvas;
  ctx.OffscreenCanvas = class extends Canvas {
    async convertToBlob(opts) {
      if (opts.type === 'image/jpeg') throw new Error('JPEG export failed');
      return super.convertToBlob(opts);
    }
  };
  const [im] = await download(ctx, BANNER, [{ src: 'a', w: 1983, h: 793 }]);
  assert.equal(im.preview, null);
  assert.deepEqual([im.crop.mime, im.crop.width, im.crop.height], ['image/png', 1983, 496]);
  assert.deepEqual(im.alpha, { transparentShare: 1, opaqueShare: 0 });
  assert.ok(warned(posted, 'preview failed'));
  assert.ok(!warned(posted, 'image processing failed'));
});

test('downloadImages: an image that cannot be decoded is still sent, uncropped, with the size the page saw', async () => {
  const { ctx, posted } = loadWorker();
  ctx.createImageBitmap = async () => { throw new Error('decode failed'); };
  const [im] = await download(ctx, BANNER, [{ src: 'a', w: 1536, h: 1024 }]);
  assert.equal(Buffer.from(im.data, 'base64').toString(), 'bytes of a');
  assert.deepEqual([im.width, im.height, im.preview, im.crop, im.alpha], [1536, 1024, null, null, null]);
  assert.ok(warned(posted, 'image processing failed'));
});

test('downloadImages: GIF bytes and animated metadata reach the host, even if decoding fails', async () => {
  for (const decodeFails of [false, true]) {
    const { ctx, posted } = loadWorker();
    ctx.nextBitmap = new FakeBitmap(12, 8, () => 0);
    if (decodeFails) ctx.createImageBitmap = async () => { throw new Error('decode failed'); };
    const data = gif({ width: 12, height: 8, frames: [{}, {}, {}] }).toString('base64');
    ctx.pageCall = async () => ({ data, mime: 'image/png' });
    const [im] = JSON.parse(JSON.stringify(await ctx.downloadImages({ job: BANNER, cancelled: false, tabId: 7 }, [{ src: 'a', w: 12, h: 8 }])));
    assert.equal(im.data, data);
    assert.deepEqual([im.mime, im.width, im.height, im.crop, im.alpha, im.animated],
      ['image/png', 12, 8, null, decodeFails ? null : { transparentShare: 1, opaqueShare: 0 }, true]);
    if (decodeFails) {
      assert.equal(im.preview, null);
      assert.equal(im.previewFrames, null);
      assert.ok(warned(posted, 'image processing failed'));
    } else {
      assert.deepEqual(decode(im.preview), { type: 'image/jpeg', width: 1024, height: 738 });
      assert.deepEqual(im.previewFrames, { shown: 3, total: 3 });
    }
  }
});

test('downloadImages: invalid base64 keeps the existing uncropped fallback', async () => {
  const { ctx, posted } = loadWorker();
  ctx.pageCall = async () => ({ data: 'invalid!', mime: 'image/png' });
  const [im] = JSON.parse(JSON.stringify(await ctx.downloadImages({ job: BANNER, cancelled: false, tabId: 7 }, [{ src: 'a', w: 12, h: 8 }])));
  assert.equal(im.data, 'invalid!');
  assert.deepEqual([im.width, im.height, im.preview, im.crop, im.alpha, im.animated], [12, 8, null, null, null, false]);
  assert.ok(warned(posted, 'image processing failed'));
});

// Run the real sendPrompt and probeTab without waiting for the send timeout in real time.
function sendingWorker(conversationUrl, probe) {
  const { ctx } = loadWorker();
  const calls = [];
  const baseline = { users: 1, images: 1 };
  const jobCtx = {
    job: { startUrl: 'https://chatgpt.com/g/g-p-0123456789abcdef/project' },
    tabId: 7, conversationUrl, cancelled: false, sent: false,
  };
  let now = 0;
  ctx.URL = URL;
  ctx.Date = { now: () => now };
  ctx.setTimeout = (fn, ms) => { now += ms; return setTimeout(fn, 0); };
  ctx.pageCall = async (tabId, fn, arg) => {
    assert.equal(tabId, jobCtx.tabId);
    calls.push(fn);
    if (fn === 'composerState') return { send: { disabled: false } };
    if (fn === 'clickSend' || fn === 'pressEnter') return { ok: true };
    assert.equal(fn, 'probe');
    assert.equal(arg, baseline);
    return { url: CHAT, stop: false, composer: true, composerText: 'Still in the box', ...probe() };
  };
  return { ctx, jobCtx, baseline, calls };
}

test('sendPrompt: a repeat send in the same chat waits for a new user turn', async () => {
  let probes = 0;
  const { ctx, jobCtx, baseline, calls } = sendingWorker(CHAT, () => ({ userTurns: ++probes >= 3 ? 1 : 0 }));
  const sent = await ctx.sendPrompt(jobCtx, baseline, false);
  assert.equal(probes, 3);
  assert.equal(sent.userTurns, 1);
  assert.equal(jobCtx.sent, true);
  assert.equal(jobCtx.sentAt, 1800);
  assert.equal(jobCtx.conversationUrl, CHAT);
  assert.deepEqual(calls, ['composerState', 'clickSend', 'probe', 'probe', 'probe']);
});

test('sendPrompt: an ineffective repeat send tries Enter and fails if the composer stays full', async () => {
  const { ctx, jobCtx, baseline, calls } = sendingWorker(CHAT, () => ({ userTurns: 0 }));
  await assert.rejects(ctx.sendPrompt(jobCtx, baseline, false), { reason: 'send_failed' });
  assert.equal(jobCtx.sent, false);
  assert.equal(calls.filter(fn => fn === 'clickSend').length, 1);
  assert.equal(calls.filter(fn => fn === 'pressEnter').length, 1);
  assert.equal(calls.indexOf('pressEnter'), 22); // 20 probes after the click timeout
  assert.equal(calls.filter(fn => fn === 'probe').length, 40);
});

test('sendPrompt: the first send still accepts navigation from the project to a chat', async () => {
  let probes = 0;
  const { ctx, jobCtx, baseline, calls } = sendingWorker(null, () => { probes++; return { userTurns: 0 }; });
  const sent = await ctx.sendPrompt(jobCtx, baseline, false);
  assert.equal(probes, 1);
  assert.equal(sent.userTurns, 0);
  assert.equal(jobCtx.sent, true);
  assert.equal(jobCtx.conversationUrl, CHAT);
  assert.deepEqual(calls, ['composerState', 'clickSend', 'probe']);
});

test('sendPrompt: stale sent signals are ignored until the new conversation appears', async () => {
  const PREVIOUS_CHAT = 'https://chatgpt.com/g/g-p-0123456789abcdef/c/11111111-1111-1111-1111-111111111111';
  const NEW_CHAT = 'https://chatgpt.com/g/g-p-0123456789abcdef/c/22222222-2222-2222-2222-222222222222';
  let probes = 0;
  const { ctx, jobCtx, baseline, calls } = sendingWorker(null, () => {
    probes++;
    assert.notEqual(jobCtx.conversationUrl, PREVIOUS_CHAT);
    if (probes <= 2) return { url: PREVIOUS_CHAT, userTurns: 1, stop: true };
    return { url: NEW_CHAT, userTurns: 1, stop: true };
  });
  jobCtx.staleUrl = PREVIOUS_CHAT;

  const sent = await ctx.sendPrompt(jobCtx, baseline, false);

  assert.equal(probes, 3);
  assert.equal(sent.url, NEW_CHAT);
  assert.equal(jobCtx.conversationUrl, NEW_CHAT);
  assert.notEqual(jobCtx.conversationUrl, PREVIOUS_CHAT);
  assert.deepEqual(calls, ['composerState', 'clickSend', 'probe', 'probe', 'probe']);
});

test('runJob: a reused worker never publishes the previous conversation URL', async () => {
  const PROJECT = 'https://chatgpt.com/g/g-p-0123456789abcdef/project';
  const PREVIOUS_CHAT = 'https://chatgpt.com/g/g-p-0123456789abcdef/c/11111111-1111-1111-1111-111111111111';
  const NEW_CHAT = 'https://chatgpt.com/g/g-p-0123456789abcdef/c/22222222-2222-2222-2222-222222222222';
  const { ctx, posted } = loadWorker();
  const jobText = 'Create a new animated starfish GIF';
  let tab = null;
  let now = 0;
  let probes = 0;

  ctx.URL = URL;
  ctx.Date = { now: () => now };
  ctx.setTimeout = (fn, ms) => { now += ms; return setTimeout(fn, 0); };
  ctx.chrome.windows.getLastFocused = async () => ({ id: 1, type: 'normal' });
  ctx.chrome.tabs.create = async ({ url }) => (tab = { id: 7, url, active: false });
  ctx.chrome.tabs.get = async id => id === 7 ? tab : null;
  ctx.chrome.tabs.update = async (id, changes) => {
    assert.equal(id, 7);
    tab = { ...tab, ...changes };
    return tab;
  };
  ctx.scheduleWorkerClose = () => {};
  ctx.typePrompt = async () => {};
  ctx.reloadWorker = async () => {};
  ctx.downloadImages = async () => [{ data: 'image', mime: 'image/png', width: 12, height: 8 }];
  ctx.pageCall = async (tabId, fn) => {
    assert.equal(tabId, 7);
    if (fn === 'composerState') return { send: { disabled: false } };
    if (fn === 'clickSend') return { ok: true };
    assert.equal(fn, 'probe');
    probes++;
    if (probes <= 4) {
      return { url: PREVIOUS_CHAT, composer: true, composerText: 'Previous prompt', counts: { users: 4, images: 1 },
        userTurns: 0, lastUserText: 'Previous prompt', stop: false, busy: false, images: [], sig: 'previous' };
    }
    if (probes === 5) {
      return { url: PROJECT, composer: true, composerText: '', counts: { users: 0, images: 0 },
        userTurns: 0, lastUserText: '', stop: false, busy: false, images: [], sig: 'project' };
    }
    return { url: NEW_CHAT, composer: true, composerText: '', counts: { users: 1, images: 1 },
      userTurns: 1, lastUserText: jobText, stop: false, busy: false, images: [{ src: 'result.png', w: 12, h: 8 }],
      text: 'done', title: 'done', replyCount: 1, done: true, sig: 'new' };
  };

  await ctx.openWorker(PREVIOUS_CHAT);
  await ctx.runJob({ id: 'reused_worker', startUrl: PROJECT, text: jobText, mode: 'generate', refs: [] });

  const progress = posted.filter(message => message.type === 'progress');
  const result = posted.find(message => message.type === 'result');
  assert.equal(result && result.conversationUrl, NEW_CHAT);
  const firstNew = progress.findIndex(message => message.conversationUrl === NEW_CHAT);
  assert.notEqual(firstNew, -1);
  assert.deepEqual(
    progress.slice(0, firstNew).filter(message => message.conversationUrl != null),
    [],
    'progress before the new chat appears must not contain a conversation URL',
  );
  assert.equal(
    [...progress, result].some(message => message && message.conversationUrl === PREVIOUS_CHAT),
    false,
    'the previous conversation URL must never be published',
  );
});

const navigationState = (url, extra = {}) => ({
  url, composer: true, composerText: '', counts: { users: 0, images: 0 }, userTurns: 0,
  lastUserText: '', stop: false, busy: false, images: [], sig: url, ...extra,
});

async function runNavigationJob({ startUrl, previousUrl = null, stateAt }) {
  const { ctx, posted } = loadWorker();
  const jobText = 'Create a navigation test image';
  let tab = null;
  let now = 0;
  let probes = 0;
  let created = 0;

  ctx.URL = URL;
  ctx.Date = { now: () => now };
  ctx.setTimeout = (fn, ms) => { now += ms; return setTimeout(fn, 0); };
  ctx.chrome.windows.getLastFocused = async () => ({ id: 1, type: 'normal' });
  ctx.chrome.tabs.create = async ({ url }) => {
    created++;
    return (tab = { id: 7, url, active: false });
  };
  ctx.chrome.tabs.get = async id => id === 7 ? tab : null;
  ctx.chrome.tabs.update = async (id, changes) => {
    assert.equal(id, 7);
    tab = { ...tab, ...changes };
    return tab;
  };
  ctx.scheduleWorkerClose = () => {};
  ctx.typePrompt = async () => {};
  ctx.reloadWorker = async () => {};
  ctx.downloadImages = async () => [{ data: 'image', mime: 'image/png', width: 12, height: 8 }];
  ctx.pageCall = async (tabId, fn) => {
    assert.equal(tabId, 7);
    if (fn === 'composerState') return { send: { disabled: false } };
    if (fn === 'clickSend') return { ok: true };
    if (fn === 'editCheck') return null;
    assert.equal(fn, 'probe');
    return stateAt(++probes, jobText);
  };

  if (previousUrl) await ctx.openWorker(previousUrl);
  await ctx.runJob({ id: `navigation_${Math.random()}`, startUrl, text: jobText, mode: 'generate', refs: [] });
  return {
    created,
    probes,
    progress: posted.filter(message => message.type === 'progress'),
    result: posted.find(message => message.type === 'result'),
  };
}

test('runJob: reusing the same conversation accepts its URL', async () => {
  const CHAT = 'https://chatgpt.com/g/g-p-0123456789abcdef/c/33333333-3333-3333-3333-333333333333';
  const run = await runNavigationJob({
    startUrl: CHAT,
    previousUrl: CHAT,
    stateAt: (probe, text) => navigationState(CHAT, probe < 4 ? {
      counts: { users: 1, images: 1 },
    } : {
      counts: { users: 2, images: 2 }, userTurns: 1, lastUserText: text,
      images: [{ src: 'result.png', w: 12, h: 8 }], text: 'done', title: 'done', replyCount: 1, done: true,
    }),
  });

  assert.equal(run.result && run.result.ok, true, run.result && run.result.error);
  assert.equal(run.result.conversationUrl, CHAT);
  assert.ok(run.progress.some(message => message.conversationUrl === CHAT));
});

test('runJob: a stale off-project document does not trigger project_unavailable', async () => {
  const PROJECT = 'https://chatgpt.com/g/g-p-0123456789abcdef/project';
  const PREVIOUS_CHAT = 'https://chatgpt.com/g/g-p-fedcba9876543210/c/44444444-4444-4444-4444-444444444444';
  const NEW_CHAT = 'https://chatgpt.com/g/g-p-0123456789abcdef/c/55555555-5555-5555-5555-555555555555';
  const run = await runNavigationJob({
    startUrl: PROJECT,
    previousUrl: PREVIOUS_CHAT,
    stateAt: (probe, text) => {
      if (probe <= 8) return navigationState(PREVIOUS_CHAT, { counts: { users: 3, images: 1 } });
      if (probe <= 11) return navigationState(PROJECT);
      return navigationState(NEW_CHAT, {
        counts: { users: 1, images: 1 }, userTurns: 1, lastUserText: text,
        images: [{ src: 'result.png', w: 12, h: 8 }], text: 'done', title: 'done', replyCount: 1, done: true,
      });
    },
  });

  assert.ok(run.probes > 11);
  assert.equal(run.result && run.result.ok, true, run.result && run.result.error);
  assert.equal(run.result.conversationUrl, NEW_CHAT);
  assert.equal([...run.progress, run.result].some(message => message.conversationUrl === PREVIOUS_CHAT), false);
});

test('runJob: a new worker tab keeps the project-to-conversation flow', async () => {
  const PROJECT = 'https://chatgpt.com/g/g-p-0123456789abcdef/project';
  const NEW_CHAT = 'https://chatgpt.com/g/g-p-0123456789abcdef/c/66666666-6666-6666-6666-666666666666';
  const run = await runNavigationJob({
    startUrl: PROJECT,
    stateAt: (probe, text) => navigationState(probe < 4 ? PROJECT : NEW_CHAT, probe < 4 ? {} : {
      counts: { users: 1, images: 1 }, userTurns: 1, lastUserText: text,
      images: [{ src: 'result.png', w: 12, h: 8 }], text: 'done', title: 'done', replyCount: 1, done: true,
    }),
  });

  assert.equal(run.created, 1);
  assert.equal(run.result && run.result.ok, true, run.result && run.result.error);
  assert.equal(run.result.conversationUrl, NEW_CHAT);
});

const TRANSPARENT_PIXELS = new Uint8ClampedArray(4 * 4 * 4);
for (const index of [5, 6, 9, 10]) TRANSPARENT_PIXELS.set([200, 40, 40, 255], index * 4);
for (const index of [1, 4, 7, 13]) TRANSPARENT_PIXELS.set([90, 9, 12, 3], index * 4);

async function runReferenceJob(refs) {
  const worker = loadPixelWorker();
  const { ctx, posted } = worker;
  let attached;
  ctx.URL = URL;
  ctx.setTimeout = fn => setTimeout(fn, 0);
  ctx.openWorker = async () => 7;
  ctx.scheduleWorkerClose = () => {};
  ctx.waitUntilReady = async () => ({ url: CHAT, counts: { users: 0, images: 0 } });
  ctx.typePrompt = async () => {};
  ctx.sendPrompt = async jobCtx => { jobCtx.sent = true; jobCtx.conversationUrl = CHAT; };
  ctx.waitForReply = async () => ({ kind: 'images', images: [{ src: 'result.png', w: 1, h: 1 }], text: 'done', title: 'done' });
  ctx.pageCall = async (tabId, name, payload) => {
    assert.equal(tabId, 7);
    if (name === 'attachFiles') { attached = payload; return { ok: true }; }
    if (name === 'attachmentState') return { count: refs.length, uploading: false, failed: [] };
    if (name === 'editCheck') return null;
    if (name === 'fetchImage') return { data: rgbaPng(1, 1, [1, 2, 3, 255]).toString('base64'), mime: 'image/png' };
    throw new Error(`Unexpected page call ${name}`);
  };
  ctx.fetch = async () => { throw new Error('Unexpected worker fetch'); };
  const job = { id: `reference_${Date.now()}_${Math.random()}`, startUrl: CHAT, text: 'Edit this image', mode: 'generate', refs };
  await ctx.runJob(job);
  const result = posted.find(message => message.type === 'result');
  assert.equal(result && result.ok, true, result && result.error);
  return { attached, job };
}

test('runJob: transparent PNG references keep alpha but upload RGB matted against white', async () => {
  const reference = rgbaPng(4, 4, TRANSPARENT_PIXELS);
  const { attached } = await runReferenceJob([{ name: 'transparent.png', mime: 'image/png', data: reference.toString('base64'), complete: true }]);
  const uploaded = decodePng(Buffer.from(attached[0].data, 'base64'));
  assert.deepEqual([uploaded.width, uploaded.height], [4, 4]);
  for (let pixel = 0; pixel < 16; pixel++) {
    const offset = pixel * 4;
    assert.equal(uploaded.data[offset + 3], TRANSPARENT_PIXELS[offset + 3], `pixel ${pixel} alpha`);
    const alpha = TRANSPARENT_PIXELS[offset + 3] / 255;
    for (let channel = 0; channel < 3; channel++) {
      const expected = Math.round(TRANSPARENT_PIXELS[offset + channel] * alpha + 255 * (1 - alpha));
      const actual = uploaded.data[offset + channel];
      assert.ok(Math.abs(actual - expected) <= 1, `pixel ${pixel} channel ${channel}: expected ${expected}, got ${actual}`);
    }
  }
});

test('runJob: opaque RGBA PNG reference bytes stay unchanged', async () => {
  const pixels = new Uint8ClampedArray(3 * 2 * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([20 + i, 80, 140, 255], i);
  const reference = rgbaPng(3, 2, pixels);
  const { attached } = await runReferenceJob([{ name: 'opaque.png', mime: 'image/png', data: reference.toString('base64'), complete: true }]);
  assert.deepEqual(Buffer.from(attached[0].data, 'base64'), reference);
});

test('runJob: JPEG and GIF reference bytes stay unchanged without bitmap decoding', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const gifBytes = gif({ width: 2, height: 2 });
  const refs = [
    { name: 'photo.jpg', mime: 'image/jpeg', data: jpeg.toString('base64'), complete: true },
    { name: 'animation.gif', mime: 'image/gif', data: gifBytes.toString('base64'), complete: true },
  ];
  const { attached } = await runReferenceJob(refs);
  assert.deepEqual(Buffer.from(attached[0].data, 'base64'), jpeg);
  assert.deepEqual(Buffer.from(attached[1].data, 'base64'), gifBytes);
});

test('runJob: preparing uploaded references does not mutate job reference data', async () => {
  const reference = rgbaPng(4, 4, TRANSPARENT_PIXELS);
  const refs = [{ name: 'transparent.png', mime: 'image/png', data: reference.toString('base64'), complete: true }];
  const before = JSON.parse(JSON.stringify(refs));
  const { job } = await runReferenceJob(refs);
  assert.deepEqual(job.refs, before);
});

// Run the real runJob, sendAndWait, probeTab and downloadImages with scripted page replies.
async function runAnimatedJob({ animated = true, firstGif = false, retry = 'gif', collect = false, reattach = false, debug = false } = {}) {
  const worker = loadWorker();
  const { ctx, posted } = worker;
  const calls = [];
  const counts = { users: 1, images: 1 };
  const imageReply = (src, text) => ({ kind: 'images', images: [{ src }], text, title: `${text} title` });
  const replies = [imageReply(firstGif ? 'first.gif' : 'first.png', 'first text')];
  if (reattach) replies.unshift({ kind: 'needs_reference', text: 'Please upload the image' });
  ctx.URL = URL;
  // The edit-check timeout stays pending; short cancellation waits finish immediately.
  ctx.setTimeout = (fn, ms) => ms >= 20000 ? null : setTimeout(fn, 0);
  ctx.nextBitmap = new FakeBitmap(12, 8, () => 255);
  ctx.openWorker = async () => 7;
  ctx.scheduleWorkerClose = () => {};
  ctx.waitUntilReady = async () => ({ url: CHAT, counts: { users: 0, images: 0 } });
  ctx.attachRefs = async (jobCtx, files) => { calls.push(['attach', files.length]); };
  ctx.typePrompt = async (jobCtx, text) => { calls.push(['type', text]); };
  ctx.sendPrompt = async (jobCtx, baseline, withFiles) => {
    calls.push(['send', { ...baseline }, withFiles]);
    jobCtx.sent = true;
    jobCtx.conversationUrl = CHAT;
  };
  ctx.waitForReply = async jobCtx => {
    if (replies.length) return replies.shift();
    if (retry === 'cancel') vm.runInContext('throw new Cancelled()', ctx);
    if (retry === 'cancel-flag') { jobCtx.cancelled = true; throw new Error('interrupted'); }
    if (retry === 'error') throw new Error('retry failed');
    if (retry === 'text') return { kind: 'text_reply', text: 'No GIF today' };
    return imageReply(retry === 'still' ? 'retry.png' : 'retry.gif', 'retry text');
  };
  ctx.pageCall = async (tabId, fn, arg) => {
    calls.push([fn, arg]);
    if (fn === 'probe') return { counts };
    if (fn === 'editCheck') return { results: [{ similarity: 0.9, against: 'original' }] };
    if (fn === 'fetchImage') {
      if (retry === 'download-error' && arg === 'retry.gif') throw new Error('download failed');
      const bytes = arg.endsWith('.gif') ? gif({ frames: [{}, {}] }) : png(6, { width: 12, height: 8 });
      return { data: bytes.toString('base64'), mime: arg.endsWith('.gif') ? 'image/gif' : 'image/png' };
    }
    return {};
  };
  ctx.fetch = async () => { throw new Error('worker download failed'); };
  await ctx.runJob({ id: 'img_animation', startUrl: CHAT, text: 'Initial GIF prompt', animated, debug,
    mode: collect ? 'collect' : 'generate', autoReattach: reattach,
    refs: reattach ? [{ name: 'original.png', mime: 'image/png', data: 'ref', complete: true }] : [] });
  const results = posted.filter(m => m.type === 'result');
  assert.equal(results.length, 1);
  return { ...worker, calls, result: results[0] };
}

test('runJob: a still image triggers exactly one GIF request with a fresh baseline and no attachments', async () => {
  const { calls, posted, result } = await runAnimatedJob();
  assert.deepEqual(calls.filter(c => c[0] === 'type'), [
    ['type', 'Initial GIF prompt'], ['type', 'Make it an animated GIF with one clear motion.'],
  ]);
  assert.deepEqual(calls.filter(c => c[0] === 'send'), [
    ['send', { users: 0, images: 0 }, false], ['send', { users: 1, images: 1 }, false],
  ]);
  assert.deepEqual(calls.filter(c => c[0] === 'fetchImage').map(c => c[1]), ['first.png', 'retry.gif']);
  assert.deepEqual([result.ok, result.animatedRetry, result.images[0].animated, result.assistantText, result.title],
    [true, true, true, 'retry text', 'retry text title']);
  const progress = posted.filter(m => m.type === 'progress' && m.step === 'animating');
  assert.equal(progress.length, 1);
  assert.equal(progress[0].message, 'ChatGPT sent a still image: asking once more for an animated GIF');
  assert.equal(progress[0].conversationUrl, CHAT);
  const fetches = calls.map(c => c[0]);
  assert.ok(fetches.indexOf('probe') > fetches.indexOf('fetchImage'));
  assert.ok(!fetches.includes('editCheck'));
  assert.equal(result.editCheck, null);
});

test('runJob: skipping edit check after a GIF retry is logged only in debug mode', async () => {
  for (const debug of [false, true]) {
    const { calls, posted, result } = await runAnimatedJob({ debug });
    assert.ok(!calls.some(c => c[0] === 'editCheck'));
    assert.equal(result.editCheck, null);
    assert.equal(posted.filter(m => m.type === 'log' && m.level === 'debug' &&
      m.msg === 'edit check skipped after animated GIF retry').length, debug ? 1 : 0);
  }
});

test('runJob: an initial GIF, a still-image job and collect mode never request animation again', async () => {
  for (const options of [{ firstGif: true }, { animated: false }, { collect: true }]) {
    const { calls, posted, result } = await runAnimatedJob(options);
    assert.equal(result.ok, true);
    assert.equal(result.animatedRetry, false);
    assert.equal(calls.filter(c => c[0] === 'type').length, options.collect ? 0 : 1);
    assert.ok(!posted.some(m => m.type === 'progress' && m.step === 'animating'));
    assert.equal(calls.filter(c => c[0] === 'fetchImage').length, 1);
    const names = calls.map(c => c[0]);
    if (options.animated === false) assert.ok(names.indexOf('editCheck') < names.indexOf('fetchImage'));
    if (options.collect) assert.ok(!names.includes('editCheck'));
    if (options.collect) {
      assert.equal(result.editCheck, null);
    } else {
      assert.equal(names.filter(fn => fn === 'editCheck').length, 1);
      assert.deepEqual(JSON.parse(JSON.stringify(result.editCheck)), { results: [{ similarity: 0.9, against: 'original' }] });
      if (options.firstGif) assert.ok(names.indexOf('editCheck') > names.lastIndexOf('fetchImage'));
    }
  }
});

test('runJob: a second still image is used without a third request', async () => {
  const { calls, result } = await runAnimatedJob({ retry: 'still' });
  assert.equal(calls.filter(c => c[0] === 'type').length, 2);
  assert.deepEqual([result.ok, result.animatedRetry, result.images[0].animated, result.assistantText], [true, true, false, 'retry text']);
  assert.ok(!calls.some(c => c[0] === 'editCheck'));
  assert.equal(result.editCheck, null);
});

test('runJob: text replies and retry errors keep the first images, text and title', async () => {
  for (const retry of ['text', 'error', 'download-error']) {
    const { calls, posted, result } = await runAnimatedJob({ retry });
    assert.equal(calls.filter(c => c[0] === 'type').length, 2);
    assert.deepEqual([result.ok, result.animatedRetry, result.images[0].animated, result.assistantText, result.title],
      [true, true, false, 'first text', 'first text title']);
    if (retry !== 'text') assert.ok(warned(posted, 'animated GIF retry failed'));
    assert.equal(result.images[0].data, png(6, { width: 12, height: 8 }).toString('base64'));
    assert.ok(!calls.some(c => c[0] === 'editCheck'));
    assert.equal(result.editCheck, null);
  }
});

test('runJob: cancellation during the GIF retry reaches the normal cancellation handler', async () => {
  for (const retry of ['cancel', 'cancel-flag']) {
    const { calls, posted, result } = await runAnimatedJob({ retry });
    assert.deepEqual([result.ok, result.status, result.animatedRetry], [false, 'cancelled', true]);
    assert.ok(calls.some(c => c[0] === 'clickStop'));
    assert.ok(!calls.some(c => c[0] === 'editCheck'));
    assert.ok(!warned(posted, 'animated GIF retry failed'));
  }
});

test('runJob: GIF retry preserves auto_reattach metadata and skips edit check', async () => {
  const { calls, result } = await runAnimatedJob({ reattach: true });
  assert.deepEqual([result.ok, result.reattached, result.animatedRetry, result.references], [true, true, true, 1]);
  assert.equal(calls.filter(c => c[0] === 'attach').length, 2);
  assert.equal(calls.filter(c => c[0] === 'type').length, 3);
  const sends = calls.filter(c => c[0] === 'send');
  assert.deepEqual(sends.map(c => c[2]), [true, true, false]);
  const names = calls.map(c => c[0]);
  assert.ok(!names.includes('editCheck'));
  assert.equal(result.editCheck, null);
});

async function preparedJob({ refs, collect = false, reattach = false,
  debug = false, configure = () => {}, reply = 'images' }) {
  const worker = loadPixelWorker();
  const { ctx, posted } = worker;
  const calls = [];
  ctx.setTimeout = (fn, ms) => ms >= 20000 ? null : setTimeout(fn, 0);
  ctx.openWorker = async () => 7;
  ctx.scheduleWorkerClose = () => {};
  ctx.waitUntilReady = async () => ({ url: CHAT, counts: {} });
  ctx.probeTab = async () => ({ counts: {} });
  ctx.sendAndWait = async (jobCtx, before, text, files) => {
    calls.push({ text, files, refs: jobCtx.refs });
    return { kind: reattach && calls.length === 1 ? 'needs_reference' : reply, images: [] };
  };
  ctx.waitForReply = async () => ({ kind: 'images', images: [] });
  ctx.pageCall = async (tabId, fn, refs) => { calls.push({ fn, refs }); return null; };
  ctx.downloadImages = async () => [{ animated: true }];
  configure(ctx);
  const job = { id: 'prepared', text: 'Original prompt', mode: collect ? 'collect' : 'generate', refs,
    startUrl: CHAT, animated: true, autoReattach: reattach, debug };
  await ctx.runJob(job);
  return { ...worker, calls, job, result: posted.find(m => m.type === 'result') };
}

const transparentRef = () => ({ name: 'ref.png', mime: 'image/png', complete: true,
  data: rgbaPng(4, 4, TRANSPARENT_PIXELS).toString('base64') });

test('runJob: transparent references keep the job text and reuse prepared files on reattach', async () => {
  const ref = transparentRef();
  const { calls, result, posted } = await preparedJob({ refs: [ref], reattach: true, debug: true });
  const sends = calls.filter(c => c.text);
  assert.equal(sends[0].text, 'Original prompt');
  assert.equal(sends[1].text, 'I attached the image again.\n\nOriginal prompt');
  assert.equal(sends[0].files, sends[1].files);
  assert.equal(sends[0].files, sends[0].refs);
  assert.notEqual(sends[0].files[0].data, ref.data);
  assert.equal(calls.find(c => c.fn === 'editCheck').refs[0].data, sends[0].files[0].data);
  assert.equal(result.referencesTransparent, 1);
  assert.equal(result.referencesMatted, 1);
  assert.equal(result.reattached, true);
  const summary = posted.find(m => m.type === 'log' && m.msg === 'reference prepared');
  assert.deepEqual({ ...summary.data }, { name: 'ref.png', width: 4, height: 4, transparent: true,
    oldBytes: Buffer.from(ref.data, 'base64').length, newBytes: Buffer.from(sends[0].files[0].data, 'base64').length });
});

test('runJob: opaque references and no references keep the job text; collect never prepares refs', async () => {
  const opaque = { ...transparentRef(), data: rgbaPng(1, 1, [10, 20, 30, 255]).toString('base64') };
  for (const options of [{ refs: [opaque] }, { refs: [] }]) {
    const { calls, result, posted } = await preparedJob(options);
    assert.equal(calls[0].text, 'Original prompt');
    assert.equal(result.referencesTransparent, 0);
    assert.equal(result.referencesMatted, 0);
    assert.ok(!posted.some(m => m.type === 'log' && m.level === 'debug'));
    if (options.refs[0] === opaque) assert.equal(calls[0].files[0], opaque);
  }
  const { calls, result } = await preparedJob({ refs: [transparentRef()], collect: true,
    configure: ctx => { ctx.createImageBitmap = async () => { throw new Error('collect must not decode'); }; } });
  assert.equal(calls.length, 0);
  assert.equal(result.referencesTransparent, 0);
  assert.equal(result.referencesMatted, 0);
});

test('runJob: byte signatures select PNG/WebP regardless of MIME; transparent WebP uploads as PNG', async () => {
  const webp = { ...transparentRef(), name: 'sprite.WEBP', mime: 'image/jpeg', data: Buffer.from('RIFFxxxxWEBP').toString('base64') };
  const { calls, result } = await preparedJob({ refs: [webp], configure: ctx => {
    ctx.createImageBitmap = async blob => {
      assert.equal(blob.type, 'image/webp');
      return { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 0]), close() {} };
    };
  } });
  const uploaded = calls[0].files[0];
  assert.equal(uploaded.name, 'sprite.png');
  assert.equal(uploaded.mime, 'image/png');
  assert.deepEqual(Array.from(decodePng(Buffer.from(uploaded.data, 'base64')).data), [255, 255, 255, 0]);
  assert.equal(result.referencesTransparent, 1);
  assert.equal(result.referencesMatted, 1);
  const pngRef = { ...transparentRef(), mime: 'image/gif' };
  const pngResult = await preparedJob({ refs: [pngRef] });
  assert.equal(pngResult.calls[0].files[0].mime, 'image/png');
  const unknown = { ...webp, data: Buffer.from('not an image').toString('base64') };
  const passed = await preparedJob({ refs: [unknown], configure: ctx => {
    ctx.createImageBitmap = async () => { throw new Error('unknown bytes must not decode'); };
  } });
  assert.equal(passed.calls[0].files[0], unknown);
  assert.ok(!warned(passed.posted, 'reference preparation failed; using original'));
});

test('runJob: preparation errors and safety limits upload originals and warn without failing the job', async () => {
  for (const failure of ['decode', 'encode', 'pixels', 'bytes']) {
    const ref = transparentRef();
    let closed = false;
    const { calls, result, posted } = await preparedJob({ refs: [ref], configure: ctx => {
      if (failure === 'decode') ctx.createImageBitmap = async () => { throw new Error('decode failed'); };
      if (failure === 'encode') ctx.encodeReferencePng = async () => { throw new Error('encode failed'); };
      if (failure === 'bytes') ctx.encodeReferencePng = async () => new Uint8Array(20 * 1024 * 1024 + 1);
      if (failure === 'pixels') {
        ctx.createImageBitmap = async () => ({ width: 4097, height: 4096, close() { closed = true; } });
        ctx.OffscreenCanvas = class { constructor() { assert.fail('oversized reference must not allocate a canvas'); } };
      }
    } });
    assert.equal(result.ok, true, failure);
    assert.equal(calls[0].files[0], ref, failure);
    assert.equal(result.referencesTransparent, ['encode', 'bytes'].includes(failure) ? 1 : 0);
    assert.equal(result.referencesMatted, 0);
    assert.ok(warned(posted, 'reference preparation failed; using original'), failure);
    if (failure === 'pixels') assert.equal(closed, true);
  }
});

test('runJob: failed replies retain the transparent reference count', async () => {
  const { result } = await preparedJob({ refs: [transparentRef(), transparentRef()], reply: 'text_reply' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'text_reply');
  assert.equal(result.referencesTransparent, 2);
  assert.equal(result.referencesMatted, 2);
});

test('runJob: cancellation after reference decoding closes the bitmap and sends no prompt', async () => {
  let closed = false;
  const { result, calls, posted } = await preparedJob({ refs: [transparentRef()], configure: ctx => {
    ctx.createImageBitmap = async () => {
      vm.runInContext('current.cancelled = true', ctx);
      return { width: 4, height: 4, close() { closed = true; } };
    };
  } });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.referencesTransparent, 0);
  assert.equal(result.referencesMatted, 0);
  assert.equal(calls.length, 0);
  assert.equal(closed, true);
  assert.ok(!warned(posted, 'reference preparation failed; using original'));
});

function opaquePixels(width, height, transparentIndexes = [], alpha = 0) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([30, 120, 210, 255], i);
  for (const index of transparentIndexes) pixels.set([30, 120, 210, alpha], index * 4);
  return pixels;
}

test('runJob: a single faint alpha pixel below the 0.5% share leaves the reference untouched', async () => {
  const pixels = opaquePixels(20, 20, [37], 254); // 1 of 400 pixels = 0.25%
  const ref = { name: 'edge.png', mime: 'image/png', complete: true, data: rgbaPng(20, 20, pixels).toString('base64') };
  const { calls, result, posted } = await preparedJob({ refs: [ref] });
  assert.equal(result.ok, true);
  assert.equal(calls[0].files[0], ref);
  assert.equal(calls[0].files[0].data, ref.data);
  assert.equal(calls[0].text, 'Original prompt');
  assert.equal(result.referencesTransparent, 0);
  assert.equal(result.referencesMatted, 0);
  assert.ok(!warned(posted, 'reference preparation failed; using original'));
});

test('runJob: exactly 0.5% see-through pixels get the matte without changing the job text', async () => {
  const pixels = opaquePixels(20, 20, [0, 399], 0); // 2 of 400 pixels = 0.5%
  pixels.set([77, 88, 99, 0], 0);
  const ref = { name: 'edge.png', mime: 'image/png', complete: true, data: rgbaPng(20, 20, pixels).toString('base64') };
  const { calls, result } = await preparedJob({ refs: [ref] });
  assert.equal(result.ok, true);
  assert.equal(calls[0].text, 'Original prompt');
  assert.equal(result.referencesTransparent, 1);
  assert.equal(result.referencesMatted, 1);
  const uploaded = decodePng(Buffer.from(calls[0].files[0].data, 'base64'));
  assert.deepEqual([uploaded.width, uploaded.height], [20, 20]);
  for (const index of [0, 399]) {
    assert.deepEqual(Array.from(uploaded.data.subarray(index * 4, index * 4 + 4)), [255, 255, 255, 0], `pixel ${index}`);
  }
  assert.deepEqual(Array.from(uploaded.data.subarray(4, 8)), [30, 120, 210, 255]);
});

test('runJob: cancellation while the reference PNG is encoded ends the job without uploading', async () => {
  const width = 8, height = 300; // more than REFERENCE_ENCODE_YIELD_ROWS rows, so the encoder yields
  const ref = { name: 'tall.png', mime: 'image/png', complete: true,
    data: rgbaPng(width, height, new Uint8ClampedArray(width * height * 4)).toString('base64') };
  let yields = 0;
  const { result, calls, posted } = await preparedJob({ refs: [ref], configure: ctx => {
    ctx.setTimeout = (fn, ms) => {
      if (ms === 0) { // the encoder's yield between row batches
        yields++;
        vm.runInContext('current.cancelled = true', ctx);
      }
      return setTimeout(fn, 0);
    };
  } });
  assert.ok(yields >= 1, 'the encoder never yielded');
  assert.equal(result.status, 'cancelled');
  assert.equal(result.referencesMatted, 0);
  assert.equal(calls.length, 0);
  assert.ok(!warned(posted, 'reference preparation failed; using original'));
});

test('processImage: GIF first-frame alpha is measured without a transparency request', async () => {
  const { ctx } = loadWorker();
  ctx.nextBitmap = new FakeBitmap(12, 8, x => x < 4 ? 0 : 255);
  const out = await ctx.processImage(gif().toString('base64'), 'image/gif', {});
  assert.equal(out.crop, null);
  assert.deepEqual({ ...out.alpha }, { transparentShare: 0.3333, opaqueShare: 0.6667 });
});

test('reference PNG encoder: CRCs, RGBA bytes and adaptive signed-byte scores round-trip', async () => {
  const { ctx } = loadWorker();
  const width = 9, height = 40, stride = width * 4;
  const pixels = new Uint8ClampedArray(stride * height);
  let seed = 23;
  for (let i = 0; i < pixels.length; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; pixels[i] = seed >>> 24; }
  pixels.fill(0, 0, stride);
  pixels.fill(255, stride, 2 * stride);
  pixels.copyWithin(2 * stride, stride, 2 * stride);
  const bytes = Buffer.from(await ctx.encodeReferencePng(width, height, pixels, { cancelled: false }));
  const decoded = decodePng(bytes);
  assert.equal(decoded.colorType, 6);
  assert.deepEqual([decoded.width, decoded.height], [width, height]);
  assert.deepEqual(decoded.data, pixels);
  const types = [], payloads = [];
  for (let pos = 8; pos < bytes.length;) {
    const length = bytes.readUInt32BE(pos);
    const type = bytes.toString('ascii', pos + 4, pos + 8);
    types.push(type);
    assert.equal(bytes.readUInt32BE(pos + length + 8), crc32(bytes.subarray(pos + 4, pos + length + 8)), type);
    if (type === 'IDAT') payloads.push(bytes.subarray(pos + 8, pos + 8 + length));
    pos += length + 12;
  }
  assert.deepEqual(types, ['IHDR', 'IDAT', 'IEND']);
  const rows = zlib.inflateSync(Buffer.concat(payloads));
  const selected = new Set();
  for (let y = 0; y < height; y++) {
    const scores = Array(5).fill(0);
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x;
      const a = x >= 4 ? pixels[i - 4] : 0, b = y ? pixels[i - stride] : 0;
      const c = y && x >= 4 ? pixels[i - stride - 4] : 0;
      const p = a + b - c;
      const distances = [a, b, c].map(v => Math.abs(p - v));
      const paeth = [a, b, c][distances.indexOf(Math.min(...distances))];
      const predictions = [0, a, b, Math.floor((a + b) / 2), paeth];
      for (let f = 0; f < 5; f++) {
        const value = (pixels[i] - predictions[f] + 256) % 256;
        scores[f] += Math.min(value, 256 - value);
      }
    }
    const filter = rows[y * (stride + 1)];
    selected.add(filter);
    assert.equal(filter, scores.indexOf(Math.min(...scores)), `row ${y}`);
  }
  assert.deepEqual([...selected].sort(), [0, 1, 2, 3, 4]);
});
