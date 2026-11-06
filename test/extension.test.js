'use strict';
// Loads the real service worker in a vm context with stand-ins for the chrome.* and canvas APIs:
// importScripts must work without a module system, and downloaded images must be cropped,
// measured and previewed as asked. Chrome itself is never involved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { gif } = require('./gif-fixture');
const { png } = require('./png-fixture');

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
    async convertToBlob(opts) { return new Blob([JSON.stringify({ type: opts.type, width: this.width, height: this.height })]); }
  };
}

function loadWorker() {
  const posted = [];
  const event = () => ({ addListener() {} });
  const port = { onMessage: event(), onDisconnect: event(), postMessage: m => posted.push(m) };
  const made = [];
  const sandbox = {
    console: { log() {}, error() {} }, setTimeout, clearTimeout, atob, btoa, Blob,
    chrome: {
      runtime: { id: 'test', getManifest: () => ({ version: '0.0.0' }), connectNative: () => port, onStartup: event(), onInstalled: event(), onMessage: event() },
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
  const ctx = vm.createContext(sandbox);
  sandbox.self = ctx;
  sandbox.importScripts = (...files) => {
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(EXT, f), 'utf8'), ctx, { filename: f });
  };
  vm.runInContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
  return { ctx: sandbox, posted, made };
}

const decode = b64 => JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));

test('the service worker loads aspect.js through importScripts and connects', () => {
  const { ctx, posted } = loadWorker();
  assert.equal(typeof ctx.BackdrawAspect.cropRect, 'function');
  assert.equal(ctx.BackdrawAspect.TOLERANCE, 0.01);
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

test('processImage: GIF signatures skip cropping and alpha measurement despite the MIME and job options', async () => {
  for (const signature of ['GIF87a', 'GIF89a']) {
    const { ctx, made } = loadWorker();
    const bmp = ctx.nextBitmap = new FakeBitmap(12, 8, () => 0);
    const image = gif({ width: 12, height: 8, frames: [{}, {}, {}] });
    image.write(signature, 0, 'latin1');
    const data = image.toString('base64');
    const decoded = [];
    ctx.atob = b64 => { decoded.push(b64); return atob(b64); };
    ctx.measureAlpha = () => { throw new Error('GIF alpha must not be measured'); };
    const out = await ctx.processImage(data, 'image/png', {
      aspect: { w: 4, h: 1, label: '4:1' }, transparent: true, animated: false,
    });
    assert.deepEqual([out.width, out.height, out.crop, out.alpha, out.animated], [12, 8, null, null, true]);
    assert.deepEqual(decode(out.preview), { type: 'image/jpeg', width: 12, height: 8 });
    assert.equal(made.length, 1);
    assert.deepEqual(made[0].ops, [['fillRect', '#ffffff', 0, 0, 12, 8], ['drawImage', 0, 0, 12, 8, 0, 0, 12, 8]]);
    assert.deepEqual(decoded, [data]);
    assert.equal(bmp.closed, true);
  }
});

test('processImage: a large GIF preview keeps the whole first frame within the preview size limit', async () => {
  const { ctx, made } = loadWorker();
  ctx.nextBitmap = new FakeBitmap(1983, 793, () => 0);
  const out = await ctx.processImage(gif().toString('base64'), 'image/gif', { aspect: { w: 4, h: 1 }, transparent: true });
  assert.equal(out.animated, true);
  assert.deepEqual(decode(out.preview), { type: 'image/jpeg', width: 1024, height: 409 });
  assert.deepEqual(made[0].ops, [['fillRect', '#ffffff', 0, 0, 1024, 409], ['drawImage', 0, 0, 1983, 793, 0, 0, 1024, 409]]);
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
  assert.deepEqual(Object.keys(im).sort(), ['alpha', 'animated', 'crop', 'data', 'height', 'mime', 'preview', 'width']);
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
    assert.deepEqual([im.mime, im.width, im.height, im.crop, im.alpha, im.animated], ['image/png', 12, 8, null, null, true]);
    if (decodeFails) {
      assert.equal(im.preview, null);
      assert.ok(warned(posted, 'image processing failed'));
    } else {
      assert.deepEqual(decode(im.preview), { type: 'image/jpeg', width: 12, height: 8 });
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
