'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { gifInfo } = require('../lib/gif');
const { sniffExt } = require('../lib/naming');
const { gif } = require('./gif-fixture');
const { png } = require('./png-fixture');

test('animation: dimensions, raw delays, infinite loop and per-frame transparency', () => {
  assert.deepEqual(gifInfo(gif({ width: 258, height: 3, loop: 0,
    frames: [{ delayCs: 10 }, { delayCs: 20, transparentIndex: 0 }, { delayCs: 30 }] })), {
    width: 258, height: 3, frames: 3, delaysMs: [100, 200, 300], durationMs: 600,
    loop: 0, transparent: true, transparentFrames: 1, truncated: false
  });
});

test('a single frame without a GCE or loop extension plays once', () => {
  assert.deepEqual(gifInfo(gif()), { width: 4, height: 3, frames: 1, delaysMs: [0],
    durationMs: 0, loop: null, transparent: false, transparentFrames: 0, truncated: false });
  const legacy = gif();
  legacy.write('GIF87a', 0, 'latin1');
  assert.equal(gifInfo(legacy).frames, 1);
  assert.equal(gifInfo(legacy).truncated, false);
});

test('finite NETSCAPE and ANIMEXTS loop counts are little-endian', () => {
  assert.equal(gifInfo(gif({ loop: 3 })).loop, 3);
  const file = gif({ loop: 513 });
  file.write('ANIMEXTS1.0', 22, 'latin1');
  assert.equal(gifInfo(file).loop, 513);
  assert.equal(gifInfo(file).truncated, false);
  file.write('UNKNOWN1.00', 22, 'latin1');
  assert.equal(gifInfo(file).loop, null);
});

test('GCE flags apply only to the next frame and tiny delays stay raw', () => {
  const info = gifInfo(gif({ frames: [{ delayCs: 1, transparentIndex: 1 }, {}, { delayCs: 0, transparentIndex: 0 }] }));
  assert.deepEqual(info.delaysMs, [10, 0, 0]);
  assert.equal(info.durationMs, 10);
  assert.equal(info.transparentFrames, 2);
});

test('local color tables work without a global color table', () => {
  const options = { frames: [{ delayCs: 7 }, { delayCs: 9, transparentIndex: 0 }] };
  assert.deepEqual(gifInfo(gif({ ...options, globalTable: false })), gifInfo(gif(options)));
});

test('color table size uses all three packed size bits', () => {
  for (const globalTable of [true, false]) {
    const file = gif({ globalTable });
    const packedAt = globalTable ? 10 : 22;
    const tableAt = globalTable ? 13 : 23;
    file[packedAt] = 0x87;
    const expanded = Buffer.concat([file.subarray(0, tableAt + 6), Buffer.alloc(768 - 6), file.subarray(tableAt + 6)]);
    assert.equal(gifInfo(expanded).frames, 1);
    assert.equal(gifInfo(expanded).truncated, false);
  }
});

test('comment, plain text and unknown extensions skip their sub-blocks', () => {
  const file = gif({ frames: [{ delayCs: 10, transparentIndex: 0 }, {}] });
  const extensions = Buffer.from([0x21, 0xfe, 3, 0x2c, 0x3b, 0x21, 1, 0xff, 0,
    0x21, 0x01, 12, ...Buffer.alloc(12), 1, 65, 0, 0x21, 0xee, 2, 0x2c, 0x3b, 0]);
  // Insert after the first GCE, before its image descriptor.
  assert.deepEqual(gifInfo(Buffer.concat([file.subarray(0, 27), extensions, file.subarray(27)])), gifInfo(file));
});

test('truncated files keep every complete image descriptor counted so far', () => {
  const first = gif({ frames: [{ delayCs: 10 }] });
  const file = gif({ frames: [{ delayCs: 10 }, { delayCs: 20 }] });
  const endOfFirst = first.length - 1;
  const secondDescriptor = endOfFirst + 8;
  assert.equal(gifInfo(file.subarray(0, endOfFirst)).frames, 1);
  assert.equal(gifInfo(file.subarray(0, secondDescriptor + 9)).frames, 1);
  const partial = gifInfo(file.subarray(0, secondDescriptor + 10));
  assert.equal(partial.frames, 2);
  assert.deepEqual(partial.delaysMs, [100, 200]);
  assert.equal(partial.truncated, true);
  const noTrailer = gifInfo(file.subarray(0, -1));
  assert.equal(noTrailer.frames, 2);
  assert.equal(noTrailer.truncated, true);
});

test('every truncated prefix is safe, including tables, GCEs and application sub-blocks', () => {
  for (const globalTable of [true, false]) {
    const file = gif({ loop: 513, globalTable, frames: [{ delayCs: 65535, transparentIndex: 0 }, {}] });
    for (let n = 0; n < file.length; n++) {
      const info = gifInfo(file.subarray(0, n));
      if (n < 13) assert.equal(info, null, `${n} bytes`);
      else {
        assert.equal(info.truncated, true, `${n} bytes`);
        assert.equal(info.frames, info.delaysMs.length);
        assert.equal(info.durationMs, info.delaysMs.reduce((sum, delay) => sum + delay, 0));
      }
    }
  }
});

test('unknown block introducers and overflowing sub-blocks stop the walk', () => {
  const file = gif();
  const unknown = Buffer.concat([file.subarray(0, -1), Buffer.from([0x7f, 0x3b])]);
  assert.equal(gifInfo(unknown).frames, 1);
  assert.equal(gifInfo(unknown).truncated, true);
  const overflow = Buffer.concat([file.subarray(0, -1), Buffer.from([0x21, 0xfe, 255, 0x3b])]);
  assert.equal(gifInfo(overflow).frames, 1);
  assert.equal(gifInfo(overflow).truncated, true);
  const brokenGce = gif({ frames: [{ delayCs: 1 }] });
  brokenGce[21] = 3;
  assert.equal(gifInfo(brokenGce).truncated, true);
  brokenGce[21] = 4;
  brokenGce[26] = 1;
  assert.equal(gifInfo(brokenGce).truncated, true);
});

test('not a GIF or an incomplete logical screen descriptor returns null', () => {
  for (const input of [png(6), Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(0), null, 'GIF89a',
    Buffer.concat([Buffer.from('GIF90a'), Buffer.alloc(20)]), gif().subarray(0, 12)]) {
    assert.equal(gifInfo(input), null);
  }
});

test('the fixture packs valid LZW clear/pixel codes and EOI across data sub-blocks', () => {
  const width = 32;
  const height = 20;
  const file = gif({ width, height });
  assert.equal(sniffExt(file), 'gif');
  assert.equal(file.toString('latin1', 0, 6), 'GIF89a');
  assert.equal(file[19], 0x2c);
  assert.equal(file.readUInt16LE(24), width);
  assert.equal(file.readUInt16LE(26), height);
  assert.equal(file[29], 2); // minimum LZW code size
  const blocks = [];
  let pos = 30;
  while (file[pos] !== 0) {
    const size = file[pos++];
    assert.ok(pos + size < file.length);
    blocks.push(file.subarray(pos, pos + size));
    pos += size;
  }
  assert.ok(blocks.length > 1);
  assert.equal(file[++pos], 0x3b);
  assert.equal(pos + 1, file.length);
  const data = Buffer.concat(blocks);
  const codes = [];
  for (let bit = 0; bit + 3 <= data.length * 8; bit += 3) {
    let value = 0;
    for (let n = 0; n < 3; n++) value |= ((data[(bit + n) >> 3] >> ((bit + n) & 7)) & 1) << n;
    codes.push(value);
  }
  // Each clear resets the decoder; the next literal emits exactly one black pixel.
  for (let n = 0; n < width * height; n++) {
    assert.equal(codes[n * 2], 4);
    assert.equal(codes[n * 2 + 1], 0);
  }
  assert.equal(codes[width * height * 2], 5);
  assert.equal(data.length, Math.ceil((width * height * 2 + 1) * 3 / 8));
  assert.equal(gifInfo(file).truncated, false);
});
