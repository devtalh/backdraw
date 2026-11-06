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
