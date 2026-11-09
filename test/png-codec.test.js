'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const zlib = require('node:zlib');
const { decodePng, encodePng, crc32 } = require('../lib/png-codec');
const { chunk, crc32: fixtureCrc32 } = require('./png-fixture');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function fixture({ width = 1, height = 1, type = 6, depth = 8, rows = [0, 0, 0, 0, 255],
  extra = [], interlace = 0, compressed, omitIdat = false, splitIdat = false } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth; ihdr[9] = type; ihdr[12] = interlace;
  const data = compressed || zlib.deflateSync(Buffer.from(rows));
  const blocks = omitIdat ? [] : splitIdat ? [chunk('IDAT', data.subarray(0, 3)), chunk('IDAT', data.subarray(3))] : [chunk('IDAT', data)];
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), ...extra, ...blocks, chunk('IEND')]);
}

function samples(type, depth, pixels, extra = [], height = 1) {
  const width = pixels.length / height, channels = CHANNELS[type];
  const stride = Math.ceil(width * channels * depth / 8);
  const rows = Buffer.alloc((stride + 1) * height);
  pixels.forEach((pixel, i) => pixel.forEach((value, channel) => {
    const y = Math.floor(i / width), sample = (i % width) * channels + channel;
    const row = y * (stride + 1) + 1;
    if (depth === 16) rows.writeUInt16BE(value, row + sample * 2);
    else if (depth === 8) rows[row + sample] = value;
    else rows[row + Math.floor(sample * depth / 8)] |= value << (8 - depth - (sample * depth) % 8);
  }));
  return decodePng(fixture({ width, height, type, depth, rows, extra })).rgba;
}

const key = (...values) => {
  const data = Buffer.alloc(values.length * 2);
  values.forEach((value, i) => data.writeUInt16BE(value, i * 2));
  return chunk('tRNS', data);
};
const expectPixels = (actual, pixels) => assert.deepEqual([...actual], pixels.flat());
const rejects = (input, message, options) => assert.throws(() => decodePng(input, options), err => {
  assert.ok(err instanceof Error);
  assert.equal(err.code, 'BAD_PNG');
  assert.match(err.message, message);
  return true;
});

test('seeded RGBA round trips preserve straight RGB and every alpha byte', () => {
  let seed = 0x12345678;
  for (const [width, height] of [[1, 1], [7, 13], [64, 32]]) {
    const rgba = Uint8Array.from({ length: width * height * 4 }, () => {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      return seed & 255;
    });
    if (rgba.length >= 8) { rgba[3] = 0; rgba[7] = 255; }
    const data = encodePng(width, height, rgba);
    assert.ok(Buffer.isBuffer(data));
    assert.deepEqual(decodePng(data), { width, height, rgba });
    assert.equal(data[24], 8); assert.equal(data[25], 6);
    assert.deepEqual(encodePng(width, height, rgba), data);
  }
});

test('CRC32 matches the standard vector and the independent fixture implementation', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
  assert.equal(crc32(Buffer.from([0, 255, 32, 74])), fixtureCrc32(Buffer.from([0, 255, 32, 74])));
});

const filtered = [
  [[10, 20, 30, 40, 50, 60, 70, 80], [15, 5, 250, 0, 90, 4, 100, 255]],
  [[10, 20, 30, 40, 40, 40, 40, 40], [15, 5, 250, 0, 75, 255, 106, 255]],
  [[10, 20, 30, 40, 50, 60, 70, 80], [5, 241, 220, 216, 40, 200, 30, 175]],
  [[10, 20, 30, 40, 45, 50, 55, 60], [10, 251, 235, 236, 58, 228, 196, 215]],
  [[10, 20, 30, 40, 40, 40, 40, 40], [5, 241, 220, 216, 40, 200, 106, 215]],
];
for (let filter = 0; filter <= 4; filter++) test(`filter ${filter}: first row, first pixel, wrapping and previous row`, () => {
  const rows = filtered[filter].flatMap(row => [filter, ...row]);
  expectPixels(decodePng(fixture({ width: 2, height: 2, rows, splitIdat: true })).rgba,
    [[10, 20, 30, 40], [50, 60, 70, 80], [15, 5, 250, 0], [90, 4, 100, 255]]);
});

for (const depth of [1, 2, 4, 8, 16]) test(`grayscale ${depth}-bit, row padding and full-precision transparency`, () => {
  const max = 2 ** depth - 1;
  const values = [0, max, Math.floor(max / 3), max, 0, Math.floor(max / 3)];
  const rgba = samples(0, depth, values.map(v => [v]), [key(max)], 2);
  const gray = v => depth === 16 ? v >>> 8 : Math.round(v * 255 / max);
  expectPixels(rgba, values.map(v => [gray(v), gray(v), gray(v), v === max ? 0 : 255]));
  if (depth === 16) expectPixels(samples(0, 16, [[0x1234], [0x1235]], [key(0x1234)]),
    [[18, 18, 18, 0], [18, 18, 18, 255]]);
});

for (const depth of [8, 16]) test(`RGB ${depth}-bit and tRNS compare the original samples`, () => {
  const values = depth === 8 ? [[20, 40, 80], [20, 40, 81]] : [[0x1234, 0x5678, 0x9abc], [0x1235, 0x5678, 0x9abc]];
  const rgb = values.map(pixel => pixel.map(v => depth === 16 ? v >>> 8 : v));
  expectPixels(samples(2, depth, values), rgb.map(c => [...c, 255]));
  expectPixels(samples(2, depth, values, [key(...values[0])]), rgb.map((c, i) => [...c, i ? 255 : 0]));
});

for (const depth of [1, 2, 4, 8]) test(`indexed ${depth}-bit with partial tRNS and row padding`, () => {
  const size = Math.min(2 ** depth, 5);
  const colors = Array.from({ length: size }, (_, i) => [i * 31, 255 - i * 21, i * 40]);
  const indices = Array.from({ length: 10 }, (_, i) => i % size);
  expectPixels(samples(3, depth, indices.map(i => [i]), [chunk('PLTE', Buffer.from(colors.flat())), chunk('tRNS', Buffer.from([0, 128]))], 2),
    indices.map(i => [...colors[i], i === 0 ? 0 : i === 1 ? 128 : 255]));
});

for (const depth of [8, 16]) test(`gray-alpha and RGBA ${depth}-bit`, () => {
  const scale = depth === 16 ? 257 : 1;
  expectPixels(samples(4, depth, [[23 * scale, 0], [180 * scale, 128 * scale], [255 * scale, 255 * scale]]),
    [[23, 23, 23, 0], [180, 180, 180, 128], [255, 255, 255, 255]]);
  const values = [[12 * scale, 34 * scale, 56 * scale, 78 * scale], [255 * scale, 0, 128 * scale, 0]];
  expectPixels(samples(6, depth, values), [[12, 34, 56, 78], [255, 0, 128, 0]]);
  if (depth === 16) expectPixels(samples(6, 16, [[0x12ff, 0x3401, 0x5680, 0x78fe]]), [[18, 52, 86, 120]]);
});

test('packed filters use one byte per pixel predictor and 16-bit filters use complete channel strides', () => {
  expectPixels(decodePng(fixture({ width: 8, height: 2, type: 0, depth: 1, rows: [1, 0xaa, 2, 0x55] })).rgba,
    [1, 0, 1, 0, 1, 0, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1].map(v => [v * 255, v * 255, v * 255, 255]));
  expectPixels(decodePng(fixture({ width: 2, type: 4, depth: 16, rows: [1, 0x12, 0x34, 0x56, 0x78, 1, 1, 1, 1] })).rgba,
    [[18, 18, 18, 86], [19, 19, 19, 87]]);
});

test('non-PNG inputs consistently report not a PNG file', () => {
  for (const input of [Buffer.from([255, 216, 255]), Buffer.from('GIF89a'), Buffer.alloc(0), Buffer.from('random'), null, 'PNG']) {
    rejects(input, /^not a PNG file$/);
  }
});

test('corruption, truncated chunks, missing image data and invalid compressed lengths', () => {
  const good = fixture();
  const badCrc = Buffer.from(good); badCrc[29] ^= 1;
  rejects(badCrc, /CRC mismatch/);
  for (let i = 8; i < good.length; i++) rejects(good.subarray(0, i), /truncated|missing/i);
  rejects(fixture({ omitIdat: true }), /missing IDAT/);
  rejects(fixture({ compressed: Buffer.from([1, 2, 3]) }), /compressed data/);
  for (const length of [4, 6, 100]) rejects(fixture({ rows: Buffer.alloc(length) }), /length/);
  rejects(fixture({ rows: [5, 0, 0, 0, 0] }), /filter 5/);
});

test('palette, header and chunk ordering failures carry BAD_PNG', () => {
  rejects(fixture({ type: 3, rows: [0, 0] }), /missing PLTE/);
  rejects(fixture({ type: 3, rows: [0, 2], extra: [chunk('PLTE', Buffer.from([0, 0, 0, 255, 0, 0]))] }), /exceeds palette/);
  rejects(fixture({ type: 3, depth: 16 }), /bit depth/);
  rejects(fixture({ type: 2, depth: 4 }), /bit depth/);
  rejects(fixture({ type: 5 }), /color type/);
  rejects(fixture({ interlace: 1 }), /^interlaced PNG is not supported$/);
  rejects(fixture({ interlace: 2 }), /interlace/);
  rejects(fixture({ extra: [key(0)] }), /tRNS/);
  rejects(fixture({ type: 0, depth: 8, extra: [key(256)] }), /tRNS sample/);
  rejects(fixture({ extra: [chunk('PLTE', Buffer.from([0, 1]))] }), /PLTE/);
  rejects(Buffer.concat([SIGNATURE, chunk('IDAT'), chunk('IEND')]), /first chunk/);
  rejects(Buffer.concat([fixture().subarray(0, 33), fixture().subarray(8)]), /IHDR/);
  rejects(fixture({ extra: [chunk('ABCD')] }), /critical chunk/);
  const unknown = fixture({ extra: [chunk('vpAg', Buffer.from([1, 2]))] });
  assert.equal(decodePng(unknown).rgba[3], 255);
  rejects(Buffer.concat([fixture(), Buffer.from([0])]), /after PNG IEND/);
});

test('size limits reject before inflate, including zero dimensions and custom pixel budgets', () => {
  const inflate = zlib.inflateSync;
  let calls = 0;
  zlib.inflateSync = () => { calls++; throw new Error('inflate must not be reached'); };
  try {
    for (const [width, height, options, message] of [
      [0, 1, {}, /greater than zero/], [1, 0, {}, /greater than zero/],
      [8193, 1, {}, /8192/], [1, 8193, {}, /8192/], [4097, 4096, {}, /pixels/],
      [2, 2, { maxPixels: 3 }, /3 pixels/], [3, 1, { maxEdge: 2 }, /edge/],
    ]) rejects(fixture({ width, height, compressed: Buffer.from([255]) }), message, options);
    assert.equal(calls, 0);
  } finally { zlib.inflateSync = inflate; }
});

test('encoder rejects invalid dimensions and pixel storage with BAD_PNG', () => {
  for (const args of [[0, 1, new Uint8Array(0)], [1.5, 1, new Uint8Array(4)], [1, 1, [1, 2, 3, 4]], [1, 1, new Uint8Array(3)]]) {
    assert.throws(() => encodePng(...args), { code: 'BAD_PNG' });
  }
});

test('invalid decoder options carry BAD_PNG and inflate receives the exact output budget', () => {
  for (const options of [null, [], 1, { maxPixels: 0 }, { maxEdge: NaN }, { maxPixels: 1.5 }]) {
    rejects(fixture(), /Invalid PNG/, options);
  }
  const inflate = zlib.inflateSync;
  let calls = 0;
  zlib.inflateSync = (data, options) => {
    calls++;
    assert.deepEqual(options, { maxOutputLength: 6 });
    return inflate(data, options);
  };
  try {
    expectPixels(decodePng(fixture()).rgba, [[0, 0, 0, 255]]);
    assert.equal(calls, 1);
  } finally { zlib.inflateSync = inflate; }
});
