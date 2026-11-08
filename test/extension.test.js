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
const { gif } = require('./gif-fixture');
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

function loadWorker() {
  const posted = [];
  const event = () => ({ addListener() {} });
  const port = { onMessage: event(), onDisconnect: event(), postMessage: m => posted.push(m) };
  const made = [];
  const sandbox = {
    console: { log() {}, error() {} }, setTimeout, clearTimeout, atob, btoa, Blob, CompressionStream, Response,
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
    assert.deepEqual(decode(out.preview), { type: 'image/jpeg', width: 12, height: 8 });
    assert.equal(made.length, 2);
    assert.deepEqual(made[0].ops, [['drawImage', 0, 0, 12, 8, 0, 0, 12, 8]]);
    assert.deepEqual(made[1].ops, [['fillRect', '#ffffff', 0, 0, 12, 8], ['drawImage', 0, 0, 12, 8, 0, 0, 12, 8]]);
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
  assert.deepEqual({ ...out.alpha }, { transparentShare: 1, opaqueShare: 0 });
  const previewCanvas = made.find(canvas => canvas.width === 1024 && canvas.height === 409);
  assert.ok(previewCanvas);
  assert.deepEqual(previewCanvas.ops, [['fillRect', '#ffffff', 0, 0, 1024, 409], ['drawImage', 0, 0, 1983, 793, 0, 0, 1024, 409]]);
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
    assert.deepEqual([im.mime, im.width, im.height, im.crop, im.alpha, im.animated],
      ['image/png', 12, 8, null, decodeFails ? null : { transparentShare: 1, opaqueShare: 0 }, true]);
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
