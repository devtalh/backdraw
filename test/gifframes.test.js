'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { decodeGifFrames, contactLayout } = require('../extension/gifframes');
const { gif, rasterGif } = require('./gif-fixture');

const palette = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]];
const pixel = (frame, width, x, y) => [...frame.rgba.slice((y * width + x) * 4, (y * width + x + 1) * 4)];

test('global and local tables, frame order, extensions, GIF87a and single frames', () => {
  const data = rasterGif({ width: 2, height: 1, palette, frames: [
    { indices: [0, 0] }, { indices: [1, 1] }, { indices: [0, 0], palette: [[0, 0, 255], [0, 0, 0]] },
  ], extensions: [Buffer.from([0x21, 0xfe, 3, 65, 66, 67, 0]),
    Buffer.from([0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0])] });
  const result = decodeGifFrames(data);
  assert.deepEqual([result.width, result.height, result.total], [2, 1, 3]);
  assert.deepEqual(result.frames.map(f => f.index), [0, 1, 2]);
  assert.deepEqual(result.frames.map(f => pixel(f, 2, 1, 0)), palette.slice(0, 3).map(c => [...c, 255]));
  const old = gif(); old.write('GIF87a');
  assert.equal(decodeGifFrames(old).total, 1);
  assert.equal(decodeGifFrames(rasterGif({ palette: null, frames: [{ palette }] })).total, 1);
});

test('subrectangles, transparent indices and disposal 0/1, 2 and 3 composite full canvases', () => {
  const data = rasterGif({ width: 3, height: 2, palette, frames: [
    { indices: [0, 0, 0, 0, 0, 0], disposal: 0 },
    { x: 1, y: 0, w: 2, h: 1, indices: [1, 3], transparentIndex: 3, disposal: 1 },
    { x: 0, y: 1, w: 1, h: 1, indices: [2], disposal: 2 },
    { x: 1, y: 0, w: 1, h: 1, indices: [2], disposal: 3 },
    { x: 2, y: 1, w: 1, h: 1, indices: [1] },
  ] });
  const { frames } = decodeGifFrames(data);
  const red = [255, 0, 0, 255], green = [0, 255, 0, 255], blue = [0, 0, 255, 255];
  assert.deepEqual(pixel(frames[1], 3, 1, 0), green);
  assert.deepEqual(pixel(frames[1], 3, 2, 0), red); // transparent index leaves previous frame
  assert.deepEqual(pixel(frames[2], 3, 0, 1), blue);
  assert.deepEqual(pixel(frames[3], 3, 0, 1), [0, 0, 0, 0]); // disposal 2 clears just its rectangle
  assert.deepEqual(pixel(frames[3], 3, 1, 0), blue);
  assert.deepEqual(pixel(frames[4], 3, 1, 0), green); // disposal 3 restores earlier state
  assert.deepEqual(pixel(frames[4], 3, 0, 0), red);
  assert.deepEqual(pixel(frames[4], 3, 2, 1), green);
  assert.deepEqual(pixel(frames[4], 3, 0, 1), [0, 0, 0, 0]);
  const transparent = decodeGifFrames(rasterGif({ frames: [{ transparentIndex: 0 }] }));
  assert.ok(transparent.frames[0].rgba.every(c => c === 0));
});

test('interlaced local-table rectangle restores all four row passes', () => {
  const width = 5, height = 17;
  const indices = Array.from({ length: width * height }, (_, i) => (Math.floor(i / width) + i % width) % 4);
  const out = decodeGifFrames(rasterGif({ width: 7, height: 19, palette: null,
    frames: [{ x: 1, y: 1, w: width, h: height, indices, palette, interlace: true }] }));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    assert.deepEqual(pixel(out.frames[0], 7, x + 1, y + 1), [...palette[indices[y * width + x]], 255]);
  }
  assert.deepEqual(pixel(out.frames[0], 7, 0, 0), [0, 0, 0, 0]);
});

test('LZW grows through 12 bits and handles a full dictionary frozen or cleared', () => {
  const colors = Array.from({ length: 256 }, (_, i) => [i, i, i]);
  let random = 0x12345678;
  const indices = Uint8Array.from({ length: 256 * 256 }, () => {
    random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
    return random & 255;
  });
  for (const clearWhenFull of [false, true]) {
    const stats = {};
    const out = decodeGifFrames(rasterGif({ width: 256, height: 256, palette: colors,
      frames: [{ indices, encoder: { clearWhenFull, stats } }] }));
    assert.equal(stats.maxCodeSize, 12);
    assert.equal(stats.full, true);
    assert.equal(!!stats.cleared, clearWhenFull);
    const decoded = Uint8Array.from({ length: indices.length }, (_, i) => out.frames[0].rgba[i * 4]);
    assert.deepEqual(decoded, indices);
    for (let i = 0; i < indices.length; i++) {
      assert.deepEqual([...out.frames[0].rgba.subarray(i * 4, i * 4 + 4)], [indices[i], indices[i], indices[i], 255]);
    }
  }
});

test('LZW repeated strings including next-code special case decode exactly', () => {
  const indices = Array.from({ length: 400 }, (_, i) => i < 200 ? 1 : i % 2);
  const out = decodeGifFrames(rasterGif({ width: 20, height: 20, frames: [{ indices }] }));
  assert.deepEqual(Array.from({ length: 400 }, (_, i) => out.frames[0].rgba[i * 4] === 255 ? 1 : 0), indices);
});

test('LZW returns complete pixels without EOI and ignores trailing codes', () => {
  for (const frame of [
    { compressed: Buffer.from([0x04]) }, // clear, pixel 0; no room for EOI
    { compressed: Buffer.from([0xc4, 0x01]) }, // clear, pixel 0, invalid trailing code 7
    { indices: [0, 1] }, // a valid extra pixel after the frame is already full
  ]) {
    const out = decodeGifFrames(rasterGif({ width: 1, height: 1, frames: [frame] }));
    assert.equal(out.total, 1);
    assert.deepEqual([...out.frames[0].rgba], [0, 0, 0, 255]);
  }
});

test('LZW still rejects incomplete pixels, invalid codes and streams without an initial clear', () => {
  assert.throws(() => decodeGifFrames(rasterGif({ width: 2, height: 1,
    frames: [{ compressed: Buffer.from([0x04]) }] })), /Truncated GIF LZW stream/);
  assert.throws(() => decodeGifFrames(rasterGif({ width: 2, height: 1,
    frames: [{ indices: [0] }] })), /Incomplete GIF pixels/);
  assert.throws(() => decodeGifFrames(rasterGif({ width: 1, height: 1,
    frames: [{ compressed: Buffer.from([0x3c]) }] })), /Invalid GIF LZW code/);
  assert.throws(() => decodeGifFrames(rasterGif({ width: 1, height: 1,
    frames: [{ compressed: Buffer.from([0x00]) }] })), /no initial clear code/);
});

test('out-of-table transparent indices are ignored for global and local palettes', () => {
  for (const transparentIndex of [2, 7]) {
    const out = decodeGifFrames(rasterGif({ frames: [{ transparentIndex }] }));
    assert.deepEqual([...out.frames[0].rgba], Array.from({ length: 12 }, () => [0, 0, 0, 255]).flat());
    const local = decodeGifFrames(rasterGif({ width: 2, height: 1, palette,
      frames: [{ palette: [[0, 255, 0], [0, 0, 255]], indices: [0, 1], transparentIndex }] }));
    assert.deepEqual([...local.frames[0].rgba], [0, 255, 0, 255, 0, 0, 255, 255]);
    assert.throws(() => decodeGifFrames(rasterGif({ width: 1, height: 1,
      frames: [{ indices: [3], transparentIndex }] })), /GIF pixel exceeds color table/);
  }
});

test('canvas area rejects 4096x1025 and accepts exactly 2048x2048 with a small rectangle', () => {
  assert.throws(() => decodeGifFrames(rasterGif({ width: 4096, height: 1025,
    frames: [{ w: 1, h: 1 }] })), /GIF canvas exceeds limits/);
  const out = decodeGifFrames(rasterGif({ width: 2048, height: 2048,
    frames: [{ x: 2047, y: 2047, w: 1, h: 1, indices: [1] }] }));
  assert.deepEqual([out.width, out.height, out.total], [2048, 2048, 1]);
  assert.equal(out.frames[0].rgba.length, 2048 * 2048 * 4);
  assert.deepEqual(pixel(out.frames[0], 2048, 2047, 2047), [255, 255, 255, 255]);
  assert.deepEqual(pixel(out.frames[0], 2048, 0, 0), [0, 0, 0, 0]);
});

test('decoded pixel budget is checked across all frames before any LZW decoding', () => {
  const data = count => rasterGif({ width: 2048, height: 2048,
    frames: Array.from({ length: count }, () => ({ indices: [], compressed: Buffer.from([0xff]) })) });
  // Invalid LZW in the first frame must only be reached when the complete scan is within budget.
  assert.throws(() => decodeGifFrames(data(17), { maxFrames: 2 }), /GIF decoded pixel budget exceeds limits/);
  assert.throws(() => decodeGifFrames(data(16), { maxFrames: 2 }), /no initial clear code/);
});

test('sampling 40 frames keeps 16 evenly spaced real indices, including both endpoints', () => {
  const out = decodeGifFrames(rasterGif({ width: 1, height: 1, palette,
    frames: Array.from({ length: 40 }, (_, i) => ({ indices: [i % 4] })) }));
  assert.equal(out.total, 40);
  const expected = Array.from({ length: 16 }, (_, i) => Math.round(i * 39 / 15));
  assert.deepEqual(out.frames.map(f => f.index), expected);
  out.frames.forEach(f => assert.deepEqual(pixel(f, 1, 0, 0), [...palette[f.index % 4], 255]));
  assert.equal(decodeGifFrames(gif({ frames: Array(512).fill({}) })).total, 512);
});

test('corrupt/truncated GIFs, empty animations and limits throw without partial results', { timeout: 5000 }, () => {
  const good = rasterGif({ width: 4, height: 3, frames: [{}] });
  for (let end = 0; end < good.length; end++) assert.throws(() => decodeGifFrames(good.subarray(0, end)));
  const oversized = Buffer.from(good); oversized.writeUInt16LE(4097, 6);
  const tall = Buffer.from(good); tall.writeUInt16LE(4097, 8);
  const zero = Buffer.from(good); zero.writeUInt16LE(0, 8);
  const badHeader = Buffer.from(good); badHeader[0] = 0;
  for (const data of [oversized, tall, zero, badHeader,
    rasterGif(), rasterGif({ frames: Array(513).fill({}) }),
    rasterGif({ frames: [{ x: 4, w: 1 }] }),
    rasterGif({ palette: null, frames: [{}] }),
    rasterGif({ frames: [{ disposal: 4 }] }),
    rasterGif({ frames: [{ compressed: Buffer.from([0xff, 0xff]) }] }),
    rasterGif({ frames: [{ compressed: Buffer.from([0x2c]) }] }), // clear, EOI without pixels
    rasterGif({ frames: [{ indices: Array(12).fill(3) }] }),
  ]) assert.throws(() => decodeGifFrames(data));
  for (const maxFrames of [0, 1, 17, 1.5, NaN]) assert.throws(() => decodeGifFrames(good, { maxFrames }));
});

test('contact layouts preserve aspect, fit and never overlap, for every count and target shape', () => {
  for (const [w, h] of [[720, 237], [414, 414], [475, 356], [237, 720], [1, 1], [4096, 16]]) {
    for (let count = 1; count <= 16; count++) {
      const l = contactLayout(w, h, count);
      assert.deepEqual(contactLayout(w, h, count), l);
      assert.ok(l.width <= 1024 && l.height <= 1024);
      assert.ok(Math.abs(l.imageWidth - w * l.scale) <= 1 && Math.abs(l.imageHeight - h * l.scale) <= 1);
      const cells = Array.from({ length: count }, (_, i) => ({
        x: l.gap + (i % l.columns) * (l.cellWidth + l.gap),
        y: l.gap + Math.floor(i / l.columns) * (l.cellHeight + l.gap),
      }));
      cells.forEach((a, i) => {
        assert.ok(a.x >= 0 && a.y >= 0 && a.x + l.cellWidth <= l.width && a.y + l.cellHeight <= l.height);
        assert.ok(l.imageWidth <= l.cellWidth && l.imageHeight + l.label <= l.cellHeight);
        cells.slice(i + 1).forEach(b => assert.ok(a.x + l.cellWidth <= b.x || b.x + l.cellWidth <= a.x ||
          a.y + l.cellHeight <= b.y || b.y + l.cellHeight <= a.y));
      });
    }
  }
  assert.ok(contactLayout(720, 237, 9).columns <= 2);
  assert.ok(contactLayout(237, 720, 9).rows <= 2);
  for (const args of [[0, 1, 1], [1, 1, 17], [1, 1, 0], [1, 1, 1, 0]]) assert.throws(() => contactLayout(...args));
});
