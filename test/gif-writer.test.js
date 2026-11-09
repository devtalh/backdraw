'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { encodeGif } = require('../lib/gif-writer');
const { gifInfo } = require('../lib/gif');
const { decodeGifFrames } = require('../extension/gifframes');

function randomBytes(length, seed = 0x12345678) {
  return Uint8Array.from({ length }, () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return seed & 255;
  });
}

// Independent, deliberately simple LZW reader. Read EOI as well as the final pixel,
// so an encoder width error at the very end cannot hide behind a complete canvas.
function readLzw(data, minimum) {
  const clear = 2 ** minimum, end = clear + 1;
  let dictionary, size, previous, bit = 0, clears = 0, maxSize = 0;
  const output = [];
  while (bit + (size || minimum + 1) <= data.length * 8) {
    const width = size || minimum + 1;
    maxSize = Math.max(maxSize, width);
    let code = 0;
    for (let i = 0; i < width; i++, bit++) code += ((data[Math.floor(bit / 8)] >> (bit % 8)) & 1) * 2 ** i;
    if (code === clear) {
      dictionary = Array.from({ length: end + 1 }, (_, i) => i < clear ? [i] : null);
      size = minimum + 1; previous = null; clears++;
      continue;
    }
    assert.ok(dictionary, 'initial clear');
    if (code === end) return { indices: Uint8Array.from(output), clears, maxSize };
    const entry = code === dictionary.length && previous ? [...previous, previous[0]] : dictionary[code];
    assert.ok(entry, `valid LZW code ${code}`);
    output.push(...entry);
    if (previous && dictionary.length < 4096) {
      dictionary.push([...previous, entry[0]]);
      if (dictionary.length === 2 ** size && size < 12) size++;
    }
    previous = entry;
  }
  assert.fail('LZW stream must include EOI');
}

function inspect(data) {
  assert.equal(data.toString('latin1', 0, 6), 'GIF89a');
  assert.ok(data[10] & 128, 'global table');
  const width = data.readUInt16LE(6), height = data.readUInt16LE(8);
  const size = 2 ** ((data[10] & 7) + 1);
  const palette = Array.from({ length: size }, (_, i) => [...data.subarray(13 + i * 3, 16 + i * 3)]);
  let pos = 13 + size * 3, control;
  const frames = [];
  const blocks = () => {
    const parts = [], sizes = [];
    for (let n; (n = data[pos++]);) {
      assert.ok(pos + n < data.length);
      sizes.push(n); parts.push(data.subarray(pos, pos + n)); pos += n;
    }
    return { bytes: Buffer.concat(parts), sizes };
  };
  while (data[pos] !== 0x3b) {
    assert.ok(pos < data.length, 'GIF trailer');
    const marker = data[pos++];
    if (marker === 0x21) {
      const label = data[pos++];
      if (label === 0xf9) {
        assert.equal(data[pos], 4); assert.equal(data[pos + 5], 0);
        control = { flags: data[pos + 1], delay: data.readUInt16LE(pos + 2) * 10, transparentIndex: data[pos + 4] };
        pos += 6;
      } else blocks();
    } else {
      assert.equal(marker, 0x2c);
      const x = data.readUInt16LE(pos), y = data.readUInt16LE(pos + 2);
      const w = data.readUInt16LE(pos + 4), h = data.readUInt16LE(pos + 6), flags = data[pos + 8];
      assert.equal(flags, 0, 'no local table or interlace');
      pos += 9;
      const minimum = data[pos++];
      assert.equal(minimum, Math.max(2, Math.log2(size)));
      const compressed = blocks(), decoded = readLzw(compressed.bytes, minimum);
      assert.equal(decoded.indices.length, w * h);
      frames.push({ x, y, w, h, ...control, ...decoded, blockSizes: compressed.sizes });
      control = undefined;
    }
  }
  assert.equal(pos, data.length - 1);
  // Composite independently of the extension decoder too.
  const canvas = new Uint8Array(width * height * 4);
  for (const frame of frames) {
    for (let y = 0; y < frame.h; y++) for (let x = 0; x < frame.w; x++) {
      const color = frame.indices[y * frame.w + x];
      assert.ok(color < palette.length);
      if ((frame.flags & 1) && color === frame.transparentIndex) continue;
      canvas.set([...palette[color], 255], ((frame.y + y) * width + frame.x + x) * 4);
    }
    frame.rgba = canvas.slice();
    if (((frame.flags >> 2) & 7) === 2) for (let y = frame.y; y < frame.y + frame.h; y++) {
      canvas.fill(0, (y * width + frame.x) * 4, (y * width + frame.x + frame.w) * 4);
    }
  }
  return { width, height, palette, frames };
}

function expectedFrame(input, transparent = true, threshold = 128, palette) {
  const result = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i += 4) {
    const alpha = input[i + 3];
    if (transparent && alpha < threshold) continue;
    let rgb = Array.from(input.subarray(i, i + 3), value => transparent ? value : Math.round(value * alpha / 255 + 255 - alpha));
    if (palette) {
      let distance = Infinity, nearest;
      for (const c of palette.slice(transparent ? 1 : 0)) {
        const d = c.reduce((sum, value, j) => sum + (value - rgb[j]) ** 2, 0);
        if (d < distance) { distance = d; nearest = c; }
      }
      rgb = nearest;
    }
    result.set([...rgb, 255], i);
  }
  return result;
}

function verify(result, expected) {
  const info = gifInfo(result.data), structure = inspect(result.data);
  const decoded = decodeGifFrames(result.data, { maxFrames: 16 });
  assert.equal(info.frames, expected.length);
  assert.equal(info.truncated, false);
  assert.deepEqual(info.delaysMs, result.delaysMs);
  assert.equal(info.durationMs, result.delaysMs.reduce((a, b) => a + b, 0));
  assert.equal(decoded.total, expected.length);
  assert.equal(decoded.width, structure.width); assert.equal(decoded.height, structure.height);
  expected.forEach((rgba, i) => assert.deepEqual(structure.frames[i].rgba, rgba));
  decoded.frames.forEach(frame => assert.deepEqual(Uint8Array.from(frame.rgba), expected[frame.index]));
  return { info, ...structure };
}

for (const count of [1, 2, 8, 16]) test(`${count} transparent frames share a palette and round trip full canvases`, () => {
  const width = 7, height = 5;
  const frames = Array.from({ length: count }, (_, frame) => Uint8Array.from({ length: width * height * 4 }, (_, i) => {
    const pixel = Math.floor(i / 4), c = i % 4;
    return c === 3 ? (pixel + frame) % 3 ? 255 : 0 : [200, 30, 80][(pixel + frame + c) % 3];
  }));
  const result = encodeGif(frames, { width, height, delayMs: 95 });
  const out = verify(result, frames.map(f => expectedFrame(f)));
  assert.equal(out.info.loop, 0); assert.equal(out.info.transparent, true);
  assert.equal(out.info.transparentFrames, count);
  assert.equal(result.transparentIndex, 0);
  assert.deepEqual(result.delaysMs, Array(count).fill(100));
  for (const f of out.frames) assert.equal(f.flags, 9);
  const seen = new Map();
  for (const f of out.frames) for (const index of f.indices) {
    if (index === result.transparentIndex) continue;
    const key = out.palette[index].join(',');
    if (seen.has(key)) assert.equal(index, seen.get(key));
    seen.set(key, index);
  }
});

test('per-frame delays round to centiseconds, clamp to 20 ms, and retain finite loops', () => {
  const frame = Uint8Array.of(10, 20, 30, 255);
  const result = encodeGif(Array(8).fill(frame), { width: 1, height: 1, delayMs: [0, 1, 10, 14, 24, 25, 106, 655350], loop: 513 });
  assert.deepEqual(result.delaysMs, [20, 20, 20, 20, 20, 30, 110, 655350]);
  assert.equal(verify(result, Array(8).fill(frame)).info.loop, 513);
});

test('five-color pixel art is lossless, including opaque black distinct from transparent black', () => {
  const colors = [[0, 0, 0, 255], [255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [77, 81, 99, 255]];
  const frame = Uint8Array.from(colors.flat());
  const result = encodeGif([frame, frame], { width: 5, height: 1, delayMs: 40 });
  const out = verify(result, [frame, frame]);
  assert.equal(result.palette, 8);
  assert.equal(out.frames[0].indices.includes(0), false);
});

test('weighted median cut gives bounded gradient error, nearest-color mapping and deterministic bytes', () => {
  const width = 64, height = 64;
  const frame = Uint8Array.from({ length: width * height * 4 }, (_, i) => {
    const pixel = Math.floor(i / 4), x = pixel % width, y = Math.floor(pixel / width);
    return [x * 4, y * 4, (x + y) * 2, 255][i % 4];
  });
  for (const transparent of [true, false]) {
    const options = { width, height, delayMs: 100, transparent };
    const result = encodeGif([frame], options);
    assert.deepEqual(encodeGif([frame], options).data, result.data);
    assert.ok(result.palette <= 256);
    const parsed = inspect(result.data);
    const expected = expectedFrame(frame, transparent, 128, parsed.palette);
    verify(result, [expected]);
    for (let i = 0; i < frame.length; i++) assert.ok(Math.abs(expected[i] - frame[i]) <= 24, `channel ${i}: ${expected[i]} vs ${frame[i]}`);
    if (transparent) assert.ok(new Set(parsed.frames[0].indices).size <= 255);
  }
});

test('median-cut box means are weighted by pixel counts across the input', () => {
  // Every red value has nine blue=0 samples and one blue=1 sample. At 256 boxes,
  // each weighted mean has blue=0; an unweighted mean would round blue to 1.
  const frame = new Uint8Array(256 * 10 * 4);
  for (let r = 0; r < 256; r++) for (let n = 0; n < 10; n++) {
    frame.set([r, 0, n === 9 ? 1 : 0, 255], (r * 10 + n) * 4);
  }
  const result = encodeGif([frame], { width: 2560, height: 1, delayMs: 20, transparent: false });
  const out = inspect(result.data);
  assert.deepEqual(out.palette, Array.from({ length: 256 }, (_, r) => [r, 0, 0]));
  const expected = frame.slice();
  for (let i = 2; i < expected.length; i += 4) expected[i] = 0;
  verify(result, [expected]);
});

test('transparent matte RGB and soft red edges produce no white or pink halo', () => {
  const frame = Uint8Array.from([[255, 255, 255, 0], [200, 0, 0, 64], [200, 0, 0, 192], [200, 0, 0, 255]].flat());
  const result = encodeGif([frame], { width: 4, height: 1, delayMs: 100 });
  const out = verify(result, [Uint8Array.from([[0, 0, 0, 0], [0, 0, 0, 0], [200, 0, 0, 255], [200, 0, 0, 255]].flat())]);
  assert.deepEqual([out.frames[0].x, out.frames[0].w], [2, 2]);
  assert.equal(result.palette, 2);
});

test('alpha threshold is strict and can be customized', () => {
  const frame = Uint8Array.from([127, 128, 255].flatMap(alpha => [80, 20, 60, alpha]));
  for (const threshold of [0, 128, 255]) {
    verify(encodeGif([frame], { width: 3, height: 1, delayMs: 20, alphaThreshold: threshold }), [expectedFrame(frame, true, threshold)]);
  }
});

test('white mode blends alpha, preserves the canvas, and crops changed or identical frames', () => {
  const first = Uint8Array.from([[200, 0, 0, 128], [0, 0, 0, 0], [0, 0, 0, 255], [0, 255, 0, 255]].flat());
  const changed = first.slice(); changed.set([0, 0, 255, 255], 8);
  const frames = [first, first, changed, changed];
  const result = encodeGif(frames, { width: 4, height: 1, delayMs: 100, transparent: false });
  const out = verify(result, frames.map(f => expectedFrame(f, false)));
  assert.deepEqual([...out.frames[0].rgba.subarray(0, 4)], [227, 127, 127, 255]);
  assert.equal(out.info.transparent, false); assert.equal(out.info.transparentFrames, 0);
  assert.equal(result.transparentIndex, null);
  assert.deepEqual(out.frames.map(f => [f.x, f.y, f.w, f.h]), [[0, 0, 4, 1], [0, 0, 1, 1], [2, 0, 1, 1], [0, 0, 1, 1]]);
  for (const f of out.frames) assert.equal(f.flags, 4);
});

test('disposal 2 clears old object bounds when it moves from right to left', () => {
  const right = new Uint8Array(6 * 3 * 4), left = right.slice();
  right.set([200, 0, 0, 255], (1 * 6 + 5) * 4);
  left.set([200, 0, 0, 255], (2 * 6) * 4);
  const out = verify(encodeGif([right, left], { width: 6, height: 3, delayMs: 100 }), [right, left]);
  assert.deepEqual(out.frames.map(f => [f.x, f.y, f.w, f.h]), [[5, 1, 1, 1], [0, 2, 1, 1]]);
});

test('all-transparent frames and 1x1 canvases remain valid between opaque frames', () => {
  const empty = Uint8Array.of(255, 255, 255, 0), red = Uint8Array.of(200, 0, 0, 255);
  for (const frames of [[empty], [red, empty, red, empty]]) {
    const out = verify(encodeGif(frames, { width: 1, height: 1, delayMs: 20 }), frames.map(f => expectedFrame(f)));
    for (const f of out.frames) assert.deepEqual([f.x, f.y, f.w, f.h], [0, 0, 1, 1]);
  }
  const emptyCanvas = new Uint8Array(8 * 9 * 4);
  const out = verify(encodeGif([emptyCanvas], { width: 8, height: 9, delayMs: 20 }), [emptyCanvas]);
  assert.deepEqual([out.frames[0].w, out.frames[0].h], [1, 1]);
});

test('LZW reaches 12 bits, clears full dictionaries, uses 255-byte blocks and decodes exactly', () => {
  const random = randomBytes(256 * 256);
  const rgba = new Uint8Array(random.length * 4);
  random.forEach((value, i) => rgba.set([value % 200, (value % 200) * 37 % 256, (value % 200) * 71 % 256, 255], i * 4));
  const result = encodeGif([rgba], { width: 256, height: 256, delayMs: 100 });
  const out = verify(result, [rgba]);
  assert.equal(out.frames[0].maxSize, 12);
  assert.ok(out.frames[0].clears > 1);
  assert.ok(out.frames[0].blockSizes.length > 1);
  assert.ok(out.frames[0].blockSizes.slice(0, -1).every(size => size === 255));
});

test('LZW repeated strings, tiny palettes and width transitions retain the final EOI', () => {
  for (const length of [1, 2, 3, 4, 5, 6, 7, 8, 15, 31, 63, 127, 255, 511, 1023]) {
    const rgba = new Uint8Array(length * 4);
    for (let i = 0; i < length; i++) rgba.set([i % 3 === 0 ? 255 : 0, 0, 0, 255], i * 4);
    verify(encodeGif([rgba], { width: length, height: 1, delayMs: 20 }), [rgba]);
  }
});

test('64-frame limit and 4096-edge validation do not require a large canvas allocation', () => {
  const rgba = Uint8Array.of(10, 20, 30, 255);
  const result = encodeGif(Array(64).fill(rgba), { width: 1, height: 1, delayMs: 20 });
  assert.equal(gifInfo(result.data).frames, 64);
  assert.equal(decodeGifFrames(result.data).total, 64);
  assert.equal(inspect(result.data).frames.length, 64);
  // Reaching frame-length validation proves that the maximum dimensions were accepted.
  assert.throws(() => encodeGif([rgba], { width: 4096, height: 4096, delayMs: 20 }), { code: 'BAD_REQUEST', message: 'Invalid GIF RGBA frame length' });
});

test('invalid dimensions, frames, delays, loops and transparency options carry BAD_REQUEST', () => {
  const rgba = Uint8Array.of(1, 2, 3, 255), valid = { width: 1, height: 1, delayMs: 100 };
  for (const frames of [null, [], Array(65).fill(rgba), [new Uint8Array(3)], [[1, 2, 3, 255]], [null], Array(1)]) {
    assert.throws(() => encodeGif(frames, valid), { code: 'BAD_REQUEST' });
  }
  for (const override of [
    { width: 0 }, { height: 0 }, { width: 4097 }, { height: 4097 }, { width: 1.5 }, { width: NaN },
    { delayMs: [] }, { delayMs: [20, 30] }, { delayMs: Array(1) }, { delayMs: -1 }, { delayMs: Infinity },
    { delayMs: NaN }, { delayMs: undefined }, { delayMs: '100' }, { delayMs: 655360 },
    { loop: -1 }, { loop: 65536 }, { loop: 1.5 }, { transparent: 1 }, { alphaThreshold: -1 },
    { alphaThreshold: 256 }, { alphaThreshold: NaN }, { alphaThreshold: 1.5 },
  ]) assert.throws(() => encodeGif([rgba], { ...valid, ...override }), { code: 'BAD_REQUEST' });
  assert.throws(() => encodeGif([rgba]), { code: 'BAD_REQUEST' });
  for (const options of [null, [], 1]) assert.throws(() => encodeGif([rgba], options), { code: 'BAD_REQUEST' });
});
