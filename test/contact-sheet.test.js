'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { contactSheet } = require('../lib/contact-sheet');
const { decodePng } = require('../lib/png-codec');
const { contactLayout } = require('../extension/gifframes');

function region(rgba, width, x, y, w, h) {
  const values = [];
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
    values.push(...rgba.subarray((yy * width + xx) * 4, (yy * width + xx + 1) * 4));
  }
  return values;
}

for (const count of [16, 12, 2]) test(`${count} frames use the shared layout, checkerboard and numbered labels`, () => {
  const frames = Array.from({ length: count }, () => new Uint8Array(80 * 60 * 4));
  const result = contactSheet(frames, 80, 60), decoded = decodePng(result.png);
  const layout = contactLayout(80, 60, count);
  assert.equal(result.shown, count); assert.ok(result.width <= 1024 && result.height <= 1024);
  assert.deepEqual([result.width, result.height], [layout.width, layout.height]);
  assert.equal(decoded.width, result.width); assert.equal(decoded.height, result.height);
  const labels = [];
  for (let i = 0; i < count; i++) {
    const x = layout.gap + i % layout.columns * (layout.cellWidth + layout.gap);
    const y = layout.gap + Math.floor(i / layout.columns) * (layout.cellHeight + layout.gap);
    const label = region(decoded.rgba, decoded.width, x, y, 36, layout.label);
    assert.ok(label.some(value => value < 10)); labels.push(label);
    const left = x + Math.floor((layout.cellWidth - layout.imageWidth) / 2);
    const dark = ((y + layout.label) * decoded.width + left) * 4;
    const white = dark + 16 * 4;
    assert.deepEqual(Array.from(decoded.rgba.subarray(dark, dark + 4)), [226, 226, 226, 255]);
    assert.deepEqual(Array.from(decoded.rgba.subarray(white, white + 4)), [255, 255, 255, 255]);
  }
  if (count >= 10) assert.notDeepEqual(labels[0], labels[9]);
});

test('noisy frames retry smaller layouts and return the smallest attempt for an impossible limit', () => {
  let seed = 123456;
  const frames = Array.from({ length: 16 }, () => Uint8Array.from({ length: 384 * 384 * 4 }, (_, i) => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return i % 4 === 3 ? 255 : seed & 255;
  }));
  const result = contactSheet(frames, 384, 384), smallest = contactLayout(384, 384, 16, 512);
  assert.ok(result.width <= 768 && result.height <= 768, 'retry path');
  assert.ok(result.png.length <= 600 * 1024 || (result.width === smallest.width && result.height === smallest.height));
  const tiny = contactSheet(frames, 384, 384, { maxBytes: 1 });
  assert.deepEqual([tiny.width, tiny.height], [smallest.width, smallest.height]);
  assert.equal(tiny.shown, 16); assert.ok(decodePng(tiny.png).rgba.length > 0);
});

test('area reduction composites premultiplied color without hidden transparent RGB', () => {
  const width = 512, height = 512;
  const frame = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    frame.set(x % 2 ? [255, 255, 255, 0] : [200, 0, 0, 255], (y * width + x) * 4);
  }
  const result = contactSheet(Array(16).fill(frame), width, height);
  const decoded = decodePng(result.png), layout = contactLayout(width, height, 16);
  const i = ((layout.gap + layout.label + 3) * result.width + layout.gap + 3) * 4;
  // Dark checkerboard behind an approximately half-covered red footprint.
  assert.ok(decoded.rgba[i] >= 210 && decoded.rgba[i] <= 216);
  assert.ok(decoded.rgba[i + 1] >= 100 && decoded.rgba[i + 1] <= 125);
  assert.equal(decoded.rgba[i + 1], decoded.rgba[i + 2]);
});
