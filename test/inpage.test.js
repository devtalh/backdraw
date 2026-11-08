'use strict';
// Exercise the page helpers without a browser or DOM implementation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { rgbaPng, decodePng } = require('./png-fixture');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'inpage.js'), 'utf8');

function loadPage() {
  const sandbox = {};
  for (const name of ['document', 'location']) {
    Object.defineProperty(sandbox, name, { get() { assert.fail(`inpage.js accessed ${name}`); } });
  }
  vm.runInNewContext(source, sandbox, { filename: 'inpage.js' });
  return sandbox.__cgb;
}

function signatureCanvasClass() {
  const parseColor = value => {
    const match = /^#([0-9a-f]{6})$/i.exec(value);
    if (!match) throw new Error(`Unsupported fill color ${value}`);
    const n = Number.parseInt(match[1], 16);
    return [n >> 16, (n >> 8) & 0xff, n & 0xff, 255];
  };
  return class SignatureCanvas {
    constructor() {
      this._width = 300;
      this._height = 150;
      this.data = new Uint8ClampedArray(this._width * this._height * 4);
    }
    get width() { return this._width; }
    set width(value) { this._width = value; this.data = new Uint8ClampedArray(this._width * this._height * 4); }
    get height() { return this._height; }
    set height(value) { this._height = value; this.data = new Uint8ClampedArray(this._width * this._height * 4); }
    getContext() {
      const canvas = this;
      const composite = (x, y, rgba) => {
        if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
        const i = (y * canvas.width + x) * 4;
        const sa = rgba[3] / 255;
        const da = canvas.data[i + 3] / 255;
        const outA = sa + da * (1 - sa);
        for (let channel = 0; channel < 3; channel++) {
          canvas.data[i + channel] = outA
            ? Math.round((rgba[channel] * sa + canvas.data[i + channel] * da * (1 - sa)) / outA)
            : 0;
        }
        canvas.data[i + 3] = Math.round(outA * 255);
        if (canvas.data[i + 3] === 0) canvas.data.fill(0, i, i + 4);
      };
      const sampleBox = (source, x0, y0, x1, y1) => {
        let alpha = 0;
        const premultiplied = [0, 0, 0];
        let area = 0;
        for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
          const yWeight = Math.max(0, Math.min(y1, y + 1) - Math.max(y0, y));
          for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
            const weight = yWeight * Math.max(0, Math.min(x1, x + 1) - Math.max(x0, x));
            if (!weight || x < 0 || y < 0 || x >= source.width || y >= source.height) continue;
            const i = (y * source.width + x) * 4;
            const a = source.data[i + 3] / 255;
            alpha += a * weight;
            for (let channel = 0; channel < 3; channel++) premultiplied[channel] += source.data[i + channel] * a * weight;
            area += weight;
          }
        }
        return [
          alpha ? premultiplied[0] / alpha : 0,
          alpha ? premultiplied[1] / alpha : 0,
          alpha ? premultiplied[2] / alpha : 0,
          area ? (alpha / area) * 255 : 0,
        ];
      };
      return {
        fillStyle: '#000000',
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'low',
        fillRect(x, y, width, height) {
          const rgba = parseColor(this.fillStyle);
          for (let py = y; py < y + height; py++) for (let px = x; px < x + width; px++) composite(px, py, rgba);
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
          for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
            const x0 = sx + (x * sw) / dw;
            const y0 = sy + (y * sh) / dh;
            composite(dx + x, dy + y, sampleBox(source, x0, y0, sx + ((x + 1) * sw) / dw, sy + ((y + 1) * sh) / dh));
          }
        },
        getImageData(x, y, width, height) {
          const data = new Uint8ClampedArray(width * height * 4);
          for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
            const src = ((y + py) * canvas.width + x + px) * 4;
            data.set(canvas.data.subarray(src, src + 4), (py * width + px) * 4);
          }
          return { width, height, data };
        },
      };
    }
  };
}

function loadSignaturePage(Canvas = signatureCanvasClass()) {
  const sandbox = {
    atob, Blob, Uint8Array,
    HTMLImageElement: class HTMLImageElement {},
    document: { createElement(name) { if (name !== 'canvas') throw new Error(`Unexpected element ${name}`); return new Canvas(); } },
    createImageBitmap: async blob => {
      const decoded = decodePng(Buffer.from(await blob.arrayBuffer()));
      return { ...decoded, close() {} };
    },
  };
  vm.runInNewContext(source, sandbox, { filename: 'inpage.js' });
  return sandbox.__cgb;
}

function recordingSignatureCanvasClass(calls) {
  const Canvas = signatureCanvasClass();
  return class RecordingSignatureCanvas extends Canvas {
    getContext(...args) {
      const context = super.getContext(...args);
      const fillRect = context.fillRect;
      const drawImage = context.drawImage;
      context.fillRect = function (...rect) {
        calls.push(['fillRect', this.fillStyle, ...rect]);
        return fillRect.apply(this, rect);
      };
      context.drawImage = function (bitmap, ...rect) {
        calls.push(['drawImage', ...rect]);
        return drawImage.call(this, bitmap, ...rect);
      };
      return context;
    }
  };
}

function legacySquareSignature(bitmap) {
  const Canvas = signatureCanvasClass();
  const canvas = new Canvas();
  canvas.width = 32;
  canvas.height = 32;
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, 0, 0, 32, 32);
  const data = context.getImageData(0, 0, 32, 32).data;
  const gray = new Array(1024);
  for (let i = 0; i < 1024; i++) gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  return gray;
}

function imageSource(width, height, pixels) {
  return { data: rgbaPng(width, height, pixels).toString('base64'), mime: 'image/png' };
}

function element(text, options = {}) {
  return { className: '', childElementCount: 0, closest() { return null; }, matches() { return false; }, textContent: text, innerText: text, ...options };
}

test('inpage loads without accessing the DOM or location', () => {
  const page = loadPage();
  assert.equal(page.version, '2.0.0');
  assert.equal(typeof page.replyText, 'function');
  assert.equal(typeof page.busyIn, 'function');
});

test('busyIn: file names and non-status text are not busy', () => {
  const { busyIn } = loadPage();
  assert.equal(busyIn([
    element('koi_flat_logo_preview.png'),
    element('Open preview of koi_flat_logo.svg'),
    element('Download file'),
  ]), false);
  for (const text of [
    'thinking_notes.txt',
    'sketch.svg',
    'eskiz_taslak.png',
    'önizleme.gif',
    'My sketchbook',
    'Previewing options',
    'görsel_önizleme.png',
    'image_preview.svg',
    'Preview.png',
    'Creating imagery',
  ]) assert.equal(busyIn([element(text)]), false, text);
});

test('busyIn: English and Turkish progress labels remain busy', () => {
  const { busyIn } = loadPage();
  for (const text of [
    'Creating image',
    'Generating image…',
    'Image is being generated',
    'Thinking',
    'Thinking…',
    'Sketching it out',
    'Setting the scene',
    'Finishing up',
    'Preview',
    'Düşünüyor',
    'Eskiz çiziliyor',
    'Eskiz çiziliyor %41',
    'Son rötuşlar yapılıyor',
    'Görsel oluşturuluyor',
    'Önizleme',
    'önizleme',
    'Creating images',
    'Generating images…',
    'Görsel önizleme',
    'Görsel önizleme %47',
    'Image preview',
    '✨ Thinking',
    '⏳ Düşünüyor',
    '  Thinking',
    'THINKING',
    'Thinking '.padEnd(79, 'x'),
  ]) assert.equal(busyIn([element(text)]), true, text);
});

test('busyIn: markdown, child and length guards remain while busy selectors win', () => {
  const { busyIn } = loadPage();
  assert.equal(busyIn([element('Thinking', { closest: selector => selector.includes('markdown') ? {} : null })]), false);
  assert.equal(busyIn([element('Thinking', { childElementCount: 1 })]), false);
  assert.equal(busyIn([element('Thinking '.padEnd(80, 'x'))]), false);
  assert.equal(busyIn([element('Not a text status', { matches: selector => selector.includes('[aria-busy="true"]') })]), true);
});

test('replyText: a feedback survey alone leaves no assistant text', () => {
  const { replyText } = loadPage();
  for (const text of [
    'Is this conversation helpful so far?',
    'IS THIS CONVERSATION HELPFUL SO FAR',
    '  Is this conversation\n helpful so far?  Yes No  ',
  ]) assert.equal(replyText([element(text)]), '', text);
});

test('replyText: a survey alongside a real leaf keeps only the real text', () => {
  const { replyText } = loadPage();
  assert.equal(replyText([
    element('Is this conversation helpful so far?'),
    element('Here is your animation.'),
  ]), 'Here is your animation.');
});

test('replyText: markdown takes precedence and survey text inside markdown is preserved', () => {
  const { replyText } = loadPage();
  for (const className of ['MarkdownRoot', 'markdown']) {
    for (const text of ['Here is your animation.\nIs this conversation helpful so far?', 'Is this conversation helpful so far?']) {
      assert.equal(replyText([
        element(text, { className, childElementCount: 1 }),
        element('Is this conversation helpful so far?'),
        element('Other leaf text'),
      ]), text);
    }
  }
});

test('replyText: normal helpfulness statements and survey mentions remain assistant text', () => {
  const { replyText } = loadPage();
  for (const text of [
    'This sketch is helpful for planning.',
    'This image is helpful for choosing colors.',
    'The survey asks: Is this conversation helpful so far?',
    'Is this conversation helpful so farther along?',
    'Bu sohbet yararlıdır.',
  ]) assert.equal(replyText([element(text)]), text);
});

test('replyText: a survey prefix is filtered only below 80 squashed characters', () => {
  const { replyText } = loadPage();
  const prefix = 'Is this conversation helpful so far? ';
  assert.equal(replyText([element(prefix.padEnd(79, 'x'))]), '');
  const longText = prefix.padEnd(80, 'x');
  assert.equal(replyText([element(longText)]), longText);
});

test('replyText: plausible Turkish survey labels are excluded', () => {
  const { replyText } = loadPage();
  for (const text of [
    'Bu sohbet şu ana kadar faydalı mı?',
    'Bu konuşma şimdiye kadar yararlı mı?',
    'Bu sohbet işe yarar mı?',
    'Bu konuşma faydalı',
  ]) assert.equal(replyText([element(text)]), '', text);
});

test('replyText: existing leaf exclusions and failure reporting are preserved', () => {
  const { replyText } = loadPage();
  assert.equal(replyText([
    element('Container text', { childElementCount: 1 }),
    element('Button text', { closest: selector => selector.includes('button') ? {} : null }),
    element('Image generation failed Try again', {
      closest: selector => selector.includes('[role="status"]') ? {} : null,
    }),
  ]), 'Image generation failed');
});

function squareReferencePixels(flattened = false) {
  const pixels = new Uint8ClampedArray(64 * 64 * 4);
  if (flattened) {
    for (let i = 0; i < pixels.length; i += 4) pixels.set([255, 255, 255, 255], i);
  }
  for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) pixels.set([200, 40, 40, 255], (y * 64 + x) * 4);
  return pixels;
}

test('signature: a transparent reference stays similar to the same image flattened on white', async () => {
  const { signature, similarity } = loadSignaturePage();
  const reference = imageSource(64, 64, squareReferencePixels());
  const flattened = imageSource(64, 64, squareReferencePixels(true));
  const score = similarity(await signature(reference), await signature(flattened));
  assert.ok(score >= 0.9, `expected similarity >= 0.9, got ${score}`);
});

test('signature: a square transparent reference has nonzero similarity to the wider 478x356 output from the bug report', async () => {
  const { signature, similarity } = loadSignaturePage();
  const wide = new Uint8ClampedArray(478 * 356 * 4);
  for (let i = 0; i < wide.length; i += 4) wide.set([255, 255, 255, 255], i);
  const startX = Math.floor((478 - 178) / 2);
  const startY = Math.floor((356 - 178) / 2);
  for (let y = startY; y < startY + 178; y++) for (let x = startX; x < startX + 178; x++) {
    wide.set([200, 40, 40, 255], (y * 478 + x) * 4);
  }
  const score = similarity(
    await signature(imageSource(64, 64, squareReferencePixels())),
    await signature(imageSource(478, 356, wide)),
  );
  assert.ok(score > 0, `expected similarity > 0, got ${score}`);
  assert.ok(score >= 0.5, `expected similarity >= 0.5, got ${score}`);
});

test('signature: opaque self similarity is one and inverted colors stay dissimilar', async () => {
  const { signature, similarity } = loadSignaturePage();
  const pixels = new Uint8ClampedArray(64 * 64 * 4);
  const inverted = new Uint8ClampedArray(pixels.length);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const i = (y * 64 + x) * 4;
    const rgb = [(x * 3 + y) & 0xff, (x + y * 2) & 0xff, (x * 2 + y * 3) & 0xff];
    pixels.set([...rgb, 255], i);
    inverted.set(rgb.map(value => 255 - value).concat(255), i);
  }
  const original = await signature(imageSource(64, 64, pixels));
  assert.equal(similarity(original, original), 1);
  assert.ok(similarity(original, await signature(imageSource(64, 64, inverted))) < 0.2);
});

test('signature: paints white before drawing centered aspect-preserving thumbnails', async () => {
  for (const [width, height, expected] of [
    [64, 64, ['drawImage', 0, 0, 32, 32]],
    [128, 64, ['drawImage', 0, 8, 32, 16]],
    [64, 128, ['drawImage', 8, 0, 16, 32]],
  ]) {
    const calls = [];
    const { signature } = loadSignaturePage(recordingSignatureCanvasClass(calls));
    await signature(imageSource(width, height, new Uint8ClampedArray(width * height * 4)));
    assert.deepEqual(calls, [
      ['fillRect', '#ffffff', 0, 0, 32, 32],
      expected,
    ]);
  }
});

test('signature: an opaque square keeps the legacy stretched signature exactly', async () => {
  const pixels = new Uint8ClampedArray(64 * 64 * 4);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const i = (y * 64 + x) * 4;
    pixels.set([(x * 5) & 0xff, (y * 3) & 0xff, (x + y * 2) & 0xff, 255], i);
  }
  const actual = await loadSignaturePage().signature(imageSource(64, 64, pixels));
  assert.deepEqual(Array.from(actual), legacySquareSignature({ width: 64, height: 64, data: pixels }));
});
