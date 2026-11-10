'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { animateSheet, sheetResultLines, scaleFrames, firstFramesGif } = require('../lib/sprite-export');
const { renderSheet } = require('../lib/sprite-sheet');
const { encodePng, decodePng } = require('../lib/png-codec');
const { gifInfo } = require('../lib/gif');
const { encodeGif } = require('../lib/gif-writer');
const { contactSheet } = require('../lib/contact-sheet');
const { decodeGifFrames } = require('../extension/gifframes');
const { MAX_REF_BYTES } = require('../lib/limits');
const { raster, rect, grid, bounds } = require('./sprite-fixture');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fixture(t, source = grid()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backdraw-sheet-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const imagePath = path.join(dir, 'sprite.png');
  fs.writeFileSync(imagePath, encodePng(source.width, source.height, source.rgba));
  return imagePath;
}

function verifyOutput(result) {
  const bytes = fs.readFileSync(result.paths.gif), info = gifInfo(bytes), decoded = decodeGifFrames(bytes);
  assert.equal(info.frames, result.frames); assert.equal(decoded.total, result.frames);
  assert.equal(info.truncated, false); assert.equal(info.loop, 0); assert.equal(info.transparentFrames, result.frames);
  assert.deepEqual(info.delaysMs, result.durationsMs);
  assert.ok(decoded.frames.every(f => f.rgba.some((v, i) => i % 4 === 3 && v === 0)));
  if (result.scale === 1) for (const f of decoded.frames) {
    const b = bounds(f.rgba, result.width);
    assert.equal(b.bottom, result.groundY - result.manifest.frames[f.index].lift);
    assert.ok(Math.abs(b.cx - result.anchorX) <= 1);
  }
  const manifestText = fs.readFileSync(result.paths.manifest, 'utf8'), m = JSON.parse(manifestText);
  assert.equal(m.format, 'backdraw-sprite-sheet'); assert.equal(m.version, 1);
  assert.ok(!manifestText.includes(path.dirname(result.sourcePath).replaceAll('\\', '\\\\')));
  const checkPaths = value => {
    if (Array.isArray(value)) value.forEach(checkPaths);
    else if (value && typeof value === 'object') for (const [key, v] of Object.entries(value)) {
      if (key === 'file') assert.equal(path.isAbsolute(v), false);
      checkPaths(v);
    }
  };
  checkPaths(m);
  const atlas = decodePng(fs.readFileSync(result.paths.atlas));
  assert.deepEqual([atlas.width, atlas.height], [m.atlas.width, m.atlas.height]);
  for (const f of m.frames) {
    const png = decodePng(fs.readFileSync(path.join(result.folder, f.file)));
    assert.deepEqual([png.width, png.height], [m.cell.width, m.cell.height]);
    const b = bounds(png.rgba, png.width);
    assert.equal(b.bottom, m.groundY - f.lift); assert.ok(Math.abs(b.cx - m.anchor.x) <= 1);
    for (let y = 0; y < png.height; y++) {
      const start = ((f.rect.y + y) * atlas.width + f.rect.x) * 4;
      assert.deepEqual(atlas.rgba.slice(start, start + png.width * 4), png.rgba.slice(y * png.width * 4, (y + 1) * png.width * 4));
    }
  }
  assert.deepEqual(fs.readFileSync(result.paths.contact), result.sheet.png);
  return m;
}

test('exports verified transparent GIF, exact source-scale atlas/cells and path-free manifest', t => {
  const imagePath = fixture(t), original = sha(fs.readFileSync(imagePath));
  const r = animateSheet({ imagePath, motion: 'walk', columns: 3, rows: 2 });
  const m = verifyOutput(r);
  assert.equal(m.source.sha256, original); assert.equal(m.gif.scale, 1); assert.equal(m.gif.sampling, 'native');
  assert.equal(m.fps, 12.5); assert.deepEqual(r.durationsMs, Array(6).fill(80)); assert.equal(m.jump, undefined);
  assert.equal(sha(fs.readFileSync(imagePath)), original);
  const snapshot = new Map(Object.values(r.paths).flat().filter(Boolean).map(file => [file, sha(fs.readFileSync(file))]));
  const second = animateSheet({ imagePath, motion: 'walk', columns: 3, rows: 2 });
  assert.equal(second.folder, `${r.folder}_2`);
  for (const [file, hash] of snapshot) assert.equal(sha(fs.readFileSync(file)), hash);
  assert.equal(sha(fs.readFileSync(imagePath)), original);
  const text = sheetResultLines(r, { added: false, reason: 'offline' }).join('\n');
  assert.match(text, /^SUCCESS/); assert.match(text, /^QUALITY: all 6 checks passed\.$/m);
  assert.doesNotMatch(text, /Alignment:|GIF sampling:|Jump arc:|Opaque background|Extraction:|Edges:|Loop seam:/);
  assert.match(text, /Contact preview attached: all 6 frames in order, numbered from 1\./);
  assert.match(text, /Gallery: not added.*offline.*The GIF is saved/); assert.match(text, /The source PNG was not changed/);
});

test('white background saves both GIFs and chooses white for gallery/contact; timings round to GIF units', t => {
  const imagePath = fixture(t, grid(2, 1));
  const r = animateSheet({ imagePath, motion: 'custom', background: 'white', durations_ms: [73, 117], size: 64 });
  verifyOutput(r);
  assert.equal(r.path, r.paths.whiteGif); assert.deepEqual(r.durationsMs, [70, 120]);
  const decoded = decodeGifFrames(fs.readFileSync(r.path));
  assert.equal(gifInfo(fs.readFileSync(r.path)).transparent, false);
  for (const frame of decoded.frames) for (let i = 3; i < frame.rgba.length; i += 4) assert.equal(frame.rgba[i], 255);
  assert.equal(r.manifest.fps, 10.53);
  assert.match(sheetResultLines(r, { added: true, jobId: 'img_123' }).join('\n'), /Gallery: added \(img_123\)/);
  const fps = animateSheet({ imagePath, motion: 'attack', fps: 20 });
  assert.deepEqual(fps.durationsMs, [50, 50]);
});

test('GIF resizing uses integer nearest enlargement, premultiplied area reduction and leaves PNG cells native', t => {
  const source = grid(), r = renderSheet(source, { motion: 'walk' });
  const nearest = scaleFrames(r, 64), factor = Math.floor(64 / Math.max(r.width, r.height));
  assert.equal(nearest.scale, factor); assert.equal(nearest.sampling, 'nearest');
  for (let y = 0; y < nearest.height; y++) for (let x = 0; x < nearest.width; x++) {
    const src = (Math.floor(y / factor) * r.width + Math.floor(x / factor)) * 4, dst = (y * nearest.width + x) * 4;
    assert.deepEqual(nearest.frames[0].slice(dst, dst + 4), r.frames[0].slice(src, src + 4));
  }
  const smooth = scaleFrames(r, 11);
  assert.equal(smooth.sampling, 'smooth'); assert.equal(Math.max(smooth.width, smooth.height), 11);
  for (const f of smooth.frames) for (let i = 0; i < f.length; i += 4) if (f[i + 3]) assert.deepEqual([...f.slice(i, i + 3)], [30, 150, 70]);
  const imagePath = fixture(t, source);
  const output = animateSheet({ imagePath, motion: 'walk', size: 128 });
  assert.equal(output.cell.width, r.width); assert.equal(output.manifest.atlas.width, Math.ceil(Math.sqrt(6)) * r.width);
  assert.ok(Math.max(output.width, output.height) <= 128);
  const large = raster(300, 180); rect(large, 20, 20, 70, 100); rect(large, 180, 30, 70, 100);
  const smaller = animateSheet({ imagePath: fixture(t, large), motion: 'walk', size: 64 });
  assert.equal(smaller.sampling, 'smooth'); assert.equal(Math.max(smaller.width, smaller.height), 64);
  assert.ok(smaller.cell.height > 64); verifyOutput(smaller);
});

test('contact preview uses the first 16 played GIF frames, rather than samples across the loop', t => {
  const source = grid(17, 1, { colored: true }), imagePath = fixture(t, source);
  const r = animateSheet({ imagePath, motion: 'custom' }), rendered = renderSheet(source, { motion: 'custom' });
  const prefix = encodeGif(rendered.frames.slice(0, 16), { width: rendered.width, height: rendered.height, delayMs: 100 });
  const frames = decodeGifFrames(prefix.data).frames.map(f => new Uint8Array(f.rgba.buffer));
  assert.deepEqual(r.sheet.png, contactSheet(frames, r.width, r.height).png);
  assert.equal(r.sheet.shown, 16); assert.equal(r.frames, 17);
  assert.match(sheetResultLines(r, { added: true, jobId: 'x' }).join('\n'), /only the first 16/);
});

test('GIF prefixes reject truncated blocks and malformed streams without looping', () => {
  const r = renderSheet(grid(2, 1), { motion: 'walk' });
  const { data } = encodeGif(r.frames, { width: r.width, height: r.height, delayMs: 100 });
  const error = { message: 'Encoded GIF prefix failed self-check' };
  for (let end = 0; end < data.length; end++) {
    assert.throws(() => firstFramesGif(data.subarray(0, end), 3), error, `truncated at byte ${end}`);
  }
  const header = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00', 'binary');
  for (const tail of [[0xff], [0x21], [0x21, 0xfe], [0x21, 0xfe, 255, 1], [0x2c], [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x80]]) {
    assert.throws(() => firstFramesGif(Buffer.concat([header, Buffer.from(tail)]), 1), error);
  }
  assert.deepEqual(firstFramesGif(data, 3), data);
  const prefix = firstFramesGif(data, 1);
  assert.equal(gifInfo(prefix).frames, 1); assert.equal(gifInfo(prefix).truncated, false);
  assert.equal(decodeGifFrames(prefix).total, 1);
});

test('GIF size limit and bad inputs fail without creating output folders or changing source', t => {
  const imagePath = fixture(t), before = fs.readdirSync(path.dirname(imagePath)), hash = sha(fs.readFileSync(imagePath));
  assert.throws(() => animateSheet({ imagePath, motion: 'walk', maxOutputBytes: 1 }), { code: 'BAD_REQUEST', message: /smaller size/ });
  assert.deepEqual(fs.readdirSync(path.dirname(imagePath)), before); assert.equal(sha(fs.readFileSync(imagePath)), hash);
  for (const badPath of ['relative.png', path.dirname(imagePath), `${imagePath}.missing`]) assert.throws(() => animateSheet({ imagePath: badPath, motion: 'walk' }), { code: 'BAD_REQUEST' });
  const nonPng = path.join(path.dirname(imagePath), 'bad.png'); fs.writeFileSync(nonPng, 'not PNG');
  assert.throws(() => animateSheet({ imagePath: nonPng, motion: 'walk' }), { code: 'BAD_PNG' });
  fs.truncateSync(nonPng, MAX_REF_BYTES + 1);
  assert.throws(() => animateSheet({ imagePath: nonPng, motion: 'walk' }), { code: 'BAD_REQUEST', message: /exceeds 20 MB/ });
});

test('partial writes clean up only the files and directories created by the call', t => {
  const imagePath = fixture(t), write = fs.writeFileSync;
  let writes = 0;
  try {
    fs.writeFileSync = (...args) => {
      if (typeof args[0] === 'number' && ++writes === 3) {
        write(args[0], Buffer.from('partial')); throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      }
      return write(...args);
    };
    assert.throws(() => animateSheet({ imagePath, motion: 'walk' }), { code: 'ENOSPC' });
  } finally { fs.writeFileSync = write; }
  assert.deepEqual(fs.readdirSync(path.dirname(imagePath)), ['sprite.png']);
});

test('quality warnings and opaque fallback are included in English result text', t => {
  const source = grid(3, 2, { colored: true }), imagePath = fixture(t, source);
  const r = animateSheet({ imagePath, motion: 'idle', columns: 4, rows: 2 });
  const text = sheetResultLines(r, { added: true, jobId: 'x' }).join('\n');
  assert.match(text, /WARNING.*count:/); assert.match(text, /WARNING.*identity:/);
});

for (const [file, motion, rows, expected] of [['frog-walk-4x2.png', 'walk', 2, 8], ['frog-jump-4x4.png', 'jump', 4, 16]]) {
  test(`real fixture ${file}: complete aligned export and unchanged source`, t => {
    const imagePath = fixture(t), original = fs.readFileSync(path.join(__dirname, 'fixtures', file));
    fs.writeFileSync(imagePath, original);
    const hash = sha(original), r = animateSheet({ imagePath, motion, columns: 4, rows });
    const m = verifyOutput(r);
    assert.equal(r.frames, expected); assert.equal(r.gates.find(g => g.id === 'count').passed, true);
    assert.equal(sha(fs.readFileSync(imagePath)), hash);
    if (motion === 'jump') {
      assert.equal(r.jump.rule, 'auto'); assert.deepEqual(r.jump.airFrames, [4, 12]); assert.ok(m.frames.some(f => f.lift > 0));
      assert.doesNotMatch(sheetResultLines(r, { added: false, reason: 'offline' }).join('\n'), /Jump arc:/);
    }
    // Seam is reported as evidence, deliberately not asserted for the real walk sheet.
    t.diagnostic(JSON.stringify({ fixture: file, frames: r.frames, heights: m.frames.map(f => f.sourceRect.h), cell: r.cell, jump: r.jump,
      gates: r.gates.map(g => ({ id: g.id, passed: g.passed, message: g.message, details: g.details })) }));
  });
}
