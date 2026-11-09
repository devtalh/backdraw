'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { animateImage, animationResultLines } = require('../lib/animate');
const { encodePng, decodePng } = require('../lib/png-codec');
const { LIGHT_MOTIONS, motionSpec } = require('../lib/light-motion');
const { gifInfo } = require('../lib/gif');
const { decodeGifFrames, contactLayout } = require('../extension/gifframes');
const { MAX_REF_BYTES, MAX_ANIMATION_BYTES } = require('../lib/limits');

test('animationResultLines describes both backgrounds, sampling modes, source opacity and gallery outcomes', () => {
  assert.equal(MAX_ANIMATION_BYTES, 8 * 1024 * 1024);
  const result = { sourcePath: path.join('stickers', 'starfish.png'), path: 'starfish_bounce.gif', motion: 'bounce',
    frames: 16, durationMs: 800, delaysMs: Array(16).fill(50), width: 384, height: 300, bytes: 4096,
    background: 'transparent', pixelArt: false, sampling: 'smooth', opaqueSource: false };
  assert.deepEqual(animationResultLines(result, { added: true, jobId: 'img_1234abcd' }), [
    'SUCCESS \u2014 animated starfish.png locally with "bounce" (no ChatGPT, nothing was sent).',
    'Saved: starfish_bounce.gif',
    'Animated GIF: 16 frames, 800 ms per loop (50 ms per frame), loops forever; 384 x 300 px; 4.0 KB.',
    'Background: transparent (1-bit: pixels at least half opaque are kept with their own color, the rest are fully transparent).',
    'Sampling: smooth (downscaled with premultiplied alpha), so edges get no halo.',
    'The attached preview shows all 16 frames in order, numbered from 1, over a checkerboard where the GIF is transparent. Check the loop and the edges.',
    'Gallery: added (img_1234abcd).',
    'The source PNG was not changed.',
  ]);
  const lines = animationResultLines({ ...result, background: 'white', pixelArt: true, pixelScale: 4,
    sampling: 'pixel-grid', opaqueSource: true },
    { added: false, reason: 'offline' });
  assert.deepEqual(lines.slice(3, 6), [
    'Background: white.',
    'Pixel art detected (4 px blocks): moved on its pixel grid and scaled with nearest neighbor, so edges stay sharp.',
    'WARNING \u2014 the PNG has no transparent pixels, so the whole rectangle moves. For a sticker, first make a transparent PNG (generate_image with transparent_background=true).',
  ]);
  assert.equal(lines.at(-2), 'Gallery: not added \u2014 offline. The GIF is saved.');
  assert.equal(lines.at(-1), 'The source PNG was not changed.');
  const nearest = animationResultLines({ ...result, sampling: 'nearest', scaleFactor: 6,
    sourceWidth: 48, sourceHeight: 48 }, { added: true, jobId: 'img_1234abcd' });
  assert.equal(nearest[4], 'Sampling: nearest neighbor (enlarged 6x from 48 x 48 source pixels), so edges stay sharp and no new colors appear.');
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backdraw-animate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const imagePath = path.join(dir, 'character.png'), width = 60, height = 80;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 8; y < 73; y++) for (let x = 8; x < 52; x++) {
    if (Math.hypot((x - 29) / 22, (y - 40) / 32) < 1) rgba.set([200, 30, 10, 255], (y * width + x) * 4);
  }
  fs.writeFileSync(imagePath, encodePng(width, height, rgba));
  return { dir, imagePath };
}
function snapshot(file) {
  return { hash: createHash('sha256').update(fs.readFileSync(file)).digest('hex'), mtimeMs: fs.statSync(file).mtimeMs };
}
function nativePixelSprite(edge = 48) {
  const colors = [[0, 0, 0, 0], [16, 48, 96, 255], [224, 48, 24, 255], [32, 208, 80, 255]];
  const rgba = new Uint8Array(edge * edge * 4);
  for (let y = 2; y < edge - 2; y++) for (let x = 2; x < edge - 2; x++) {
    const inside = (x >= Math.floor(edge / 4) && x < Math.ceil(edge * 3 / 4)) ||
      (y >= Math.floor(edge / 3) && y < Math.ceil(edge * 2 / 3));
    if (inside && (x * 3 + y * 5) % 13 !== 0) {
      rgba.set(colors[1 + (x * 7 + y * 11) % 3], (y * edge + x) * 4);
    }
  }
  return { width: edge, height: edge, rgba, colors };
}
const colorKey = (rgba, i) => rgba[i] * 65536 + rgba[i + 1] * 256 + rgba[i + 2];
function verify(result, size, transparent) {
  const data = fs.readFileSync(result.path), info = gifInfo(data), spec = motionSpec(result.motion);
  const decoded = decodeGifFrames(data, { maxFrames: 16 });
  assert.equal(info.frames, spec.frames); assert.equal(decoded.total, spec.frames);
  assert.deepEqual(info.delaysMs, Array(spec.frames).fill(spec.delayMs));
  assert.deepEqual(result.delaysMs, info.delaysMs); assert.equal(result.durationMs, info.durationMs);
  assert.equal(info.loop, 0); assert.equal(info.transparent, transparent);
  assert.equal(info.transparentFrames, transparent ? spec.frames : 0); assert.equal(info.truncated, false);
  assert.equal(result.bytes, data.length); assert.equal(result.frames, spec.frames);
  const long = Math.max(info.width, info.height);
  if (result.sampling === 'nearest') {
    assert.ok(Number.isInteger(result.scaleFactor) && result.scaleFactor >= 1);
    assert.ok(long <= size);
    assert.equal(info.width % result.scaleFactor, 0); assert.equal(info.height % result.scaleFactor, 0);
    assert.ok(long / result.scaleFactor * (result.scaleFactor + 1) > size);
  } else {
    assert.equal(result.scaleFactor, null);
    assert.equal(long, size);
  }
  for (const frame of decoded.frames) for (const i of [0, info.width - 1, (info.height - 1) * info.width, info.width * info.height - 1]) {
    assert.deepEqual(Array.from(frame.rgba.subarray(i * 4, i * 4 + 4)), transparent ? [0, 0, 0, 0] : [255, 255, 255, 255]);
  }
  assert.equal(result.sheet.shown, spec.frames);
  assert.equal(decodePng(result.sheet.png).width, result.sheet.width);
}

function firstSheetFrame(result) {
  const decoded = decodeGifFrames(fs.readFileSync(result.path), { maxFrames: 16 });
  const sheet = decodePng(result.sheet.png);
  const layout = [1024, 768, 512].map(max => contactLayout(decoded.width, decoded.height, decoded.total, max))
    .find(candidate => candidate.width === sheet.width && candidate.height === sheet.height);
  assert.ok(layout, 'contact sheet layout');
  const left = layout.gap + Math.floor((layout.cellWidth - layout.imageWidth) / 2);
  const top = layout.gap + layout.label;
  return { decoded, frame: decoded.frames[0].rgba, sheet, layout, left, top };
}

test('exclusive sibling filenames preserve source hash, mtime and existing outputs', t => {
  const { dir, imagePath } = fixture(t), before = snapshot(imagePath);
  const first = animateImage({ imagePath, motion: 'bounce', size: 96 });
  const second = animateImage({ imagePath, motion: 'bounce', size: 96 });
  assert.equal(first.path, path.join(dir, 'character_bounce.gif'));
  assert.equal(second.path, path.join(dir, 'character_bounce_2.gif'));
  assert.equal(first.sourcePath, imagePath); verify(first, 96, true); verify(second, 96, true);
  assert.deepEqual(fs.readFileSync(first.path), fs.readFileSync(second.path), 'deterministic GIF bytes');
  const existing = path.join(dir, 'character_sway.gif'); fs.writeFileSync(existing, 'keep this file');
  const sway = animateImage({ imagePath, motion: 'sway', size: 96 });
  assert.equal(sway.path, path.join(dir, 'character_sway_2.gif'));
  assert.equal(fs.readFileSync(existing, 'utf8'), 'keep this file');
  assert.deepEqual(snapshot(imagePath), before);
  const files = fs.readdirSync(dir);
  assert.throws(() => animateImage({ imagePath, motion: 'nod', maxOutputBytes: 1 }), err =>
    err.code === 'BAD_REQUEST' && /MB.*smaller size/.test(err.message));
  assert.deepEqual(fs.readdirSync(dir), files); assert.deepEqual(snapshot(imagePath), before);
});

test('all six motions round trip through both GIF readers; white mode has an opaque white canvas', t => {
  const { imagePath } = fixture(t);
  for (const motion of LIGHT_MOTIONS) verify(animateImage({ imagePath, motion, size: 96 }), 96, true);
  const white = animateImage({ imagePath, motion: 'idle', size: 96, background: 'white' });
  assert.equal(white.background, 'white'); verify(white, 96, false);
});

test('contact sheets show the encoded GIF transparency and palette', t => {
  const { imagePath } = fixture(t);
  const transparent = animateImage({ imagePath, motion: 'idle', size: 64 });
  const white = animateImage({ imagePath, motion: 'idle', size: 64, background: 'white' });
  const whiteView = firstSheetFrame(white);
  const whiteCorner = (whiteView.top * whiteView.sheet.width + whiteView.left) * 4;
  assert.deepEqual(Array.from(whiteView.sheet.rgba.subarray(whiteCorner, whiteCorner + 4)), [255, 255, 255, 255]);

  const view = firstSheetFrame(transparent);
  assert.ok(view.layout.imageWidth >= view.decoded.width && view.layout.imageHeight >= view.decoded.height);
  assert.ok(Array.from(view.frame).filter((_, index) => index % 4 === 3).every(alpha => alpha === 0 || alpha === 255));
  const corner = (view.top * view.sheet.width + view.left) * 4;
  assert.ok([226, 255].includes(view.sheet.rgba[corner]));
  assert.deepEqual(Array.from(view.sheet.rgba.subarray(corner, corner + 4)),
    [view.sheet.rgba[corner], view.sheet.rgba[corner], view.sheet.rgba[corner], 255]);
  let comparedOpaque = false;
  for (let y = 0; y < view.layout.imageHeight; y++) for (let x = 0; x < view.layout.imageWidth; x++) {
    const sx = Math.floor((x + 0.5) * view.decoded.width / view.layout.imageWidth);
    const sy = Math.floor((y + 0.5) * view.decoded.height / view.layout.imageHeight);
    const source = (sy * view.decoded.width + sx) * 4;
    const target = ((view.top + y) * view.sheet.width + view.left + x) * 4;
    const checker = (Math.floor(x / 16) + Math.floor(y / 16)) % 2 === 0 ? 226 : 255;
    const expected = view.frame[source + 3] ? Array.from(view.frame.subarray(source, source + 4)) : [checker, checker, checker, 255];
    assert.deepEqual(Array.from(view.sheet.rgba.subarray(target, target + 4)), expected);
    if (view.frame[source + 3]) comparedOpaque = true;
  }
  assert.equal(comparedOpaque, true);
});

test('animation results expose sampling metadata and detected pixel scale', t => {
  const { dir, imagePath } = fixture(t);
  const smooth = animateImage({ imagePath, motion: 'idle', size: 64 });
  assert.equal(smooth.pixelArt, false); assert.equal(smooth.pixelScale, null);
  assert.equal(smooth.sampling, 'smooth'); assert.equal(smooth.scaleFactor, null);
  const width = 64, height = 64, rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const light = (Math.floor(x / 4) + Math.floor(y / 4)) % 2;
    rgba.set(light ? [220, 40, 20, 255] : [20, 60, 200, 255], (y * width + x) * 4);
  }
  const pixelPath = path.join(dir, 'pixel.png');
  fs.writeFileSync(pixelPath, encodePng(width, height, rgba));
  const pixel = animateImage({ imagePath: pixelPath, motion: 'idle', size: 96 });
  assert.equal(pixel.pixelArt, true); assert.equal(pixel.pixelScale, 4);
  assert.equal(pixel.sampling, 'pixel-grid'); assert.equal(pixel.scaleFactor, null);
});

test('native-resolution pixel PNG stays on its source palette through the GIF pipeline', t => {
  const { dir } = fixture(t), source = nativePixelSprite();
  const imagePath = path.join(dir, 'native-pixel.png');
  fs.writeFileSync(imagePath, encodePng(source.width, source.height, source.rgba));
  const result = animateImage({ imagePath, motion: 'idle', size: 384 });
  assert.equal(result.sampling, 'nearest'); assert.equal(result.pixelArt, false);
  assert.equal(result.pixelScale, null); assert.ok(result.scaleFactor >= 2);
  assert.deepEqual([result.sourceWidth, result.sourceHeight], [source.width, source.height]);
  assert.ok(Math.max(result.width, result.height) <= 384);
  const colors = new Set(source.colors.slice(1).map(color => color[0] * 65536 + color[1] * 256 + color[2]));
  const decoded = decodeGifFrames(fs.readFileSync(result.path), { maxFrames: 16 });
  for (const frame of decoded.frames) for (let i = 0; i < frame.rgba.length; i += 4) {
    assert.ok(frame.rgba[i + 3] === 0 || frame.rgba[i + 3] === 255);
    if (frame.rgba[i + 3]) assert.ok(colors.has(colorKey(frame.rgba, i)), 'GIF introduced a new opaque color');
  }
});

test('invalid paths, motion, sizes, background and PNG bytes fail without changing the source', t => {
  const { dir, imagePath } = fixture(t), before = snapshot(imagePath);
  for (const override of [
    { imagePath: 'relative.png' }, { imagePath: path.join(dir, 'missing.png') }, { imagePath: dir },
    { motion: 'unknown' }, ...[63, 1025, 300.5, '384'].map(size => ({ size })), { background: 'black' },
  ]) assert.throws(() => animateImage({ imagePath, motion: 'idle', ...override }), { code: 'BAD_REQUEST' });
  const jpeg = path.join(dir, 'jpeg.png'); fs.writeFileSync(jpeg, Buffer.from([255, 216, 255, 224, 0, 0]));
  assert.throws(() => animateImage({ imagePath: jpeg, motion: 'idle' }), err =>
    err.code === 'BAD_PNG' && err.message.includes(jpeg) && /not a PNG/.test(err.message));
  const cut = path.join(dir, 'cut.png'); fs.writeFileSync(cut, fs.readFileSync(imagePath).subarray(0, -5));
  assert.throws(() => animateImage({ imagePath: cut, motion: 'idle' }), { code: 'BAD_PNG' });
  const empty = path.join(dir, 'empty.png'); fs.writeFileSync(empty, encodePng(8, 8, new Uint8Array(8 * 8 * 4)));
  assert.throws(() => animateImage({ imagePath: empty, motion: 'idle' }), { code: 'BAD_REQUEST', message: 'the PNG is fully transparent' });
  assert.deepEqual(snapshot(imagePath), before);
  assert.equal(fs.readdirSync(dir).filter(file => file.endsWith('.gif')).length, 0);
});

test('oversized source is rejected before any read', t => {
  const { dir } = fixture(t), imagePath = path.join(dir, 'large.png');
  fs.writeFileSync(imagePath, ''); fs.truncateSync(imagePath, MAX_REF_BYTES + 1);
  const read = t.mock.method(fs, 'readFileSync', () => assert.fail('must not read oversized source'));
  assert.throws(() => animateImage({ imagePath, motion: 'bounce' }), err => err.code === 'BAD_REQUEST' && /20 MB/.test(err.message));
  assert.equal(read.mock.callCount(), 0); read.mock.restore();
});

test('write failures name the target and preserve source content and mtime', t => {
  const { imagePath } = fixture(t), before = snapshot(imagePath);
  const originalOpen = fs.openSync;
  const open = t.mock.method(fs, 'openSync', (file, flags, ...rest) => {
    if (file.endsWith('.gif')) assert.equal(flags, 'wx');
    return originalOpen(file, flags, ...rest);
  });
  const write = t.mock.method(fs, 'writeFileSync', file => {
    assert.equal(typeof file, 'number', 'write only through the owned exclusive descriptor');
    throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
  });
  assert.throws(() => animateImage({ imagePath, motion: 'idle', size: 96 }), err =>
    err.code === 'EACCES' && err.message.includes('character_idle.gif') && /cannot write/.test(err.message));
  write.mock.restore(); open.mock.restore(); assert.deepEqual(snapshot(imagePath), before);
});

test('partial write failure removes only its own GIF and preserves occupied names and the PNG', t => {
  const { dir, imagePath } = fixture(t), before = snapshot(imagePath);
  const occupied = path.join(dir, 'character_idle.gif'), partial = path.join(dir, 'character_idle_2.gif');
  fs.writeFileSync(occupied, 'existing GIF');
  const originalWrite = fs.writeFileSync;
  const write = t.mock.method(fs, 'writeFileSync', (fd, data) => {
    assert.equal(typeof fd, 'number');
    originalWrite(fd, data.subarray(0, 20));
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  });
  assert.throws(() => animateImage({ imagePath, motion: 'idle', size: 64 }), { code: 'ENOSPC', message: /cannot write.*character_idle_2.gif.*disk full/ });
  write.mock.restore();
  assert.equal(fs.existsSync(partial), false);
  assert.equal(fs.readFileSync(occupied, 'utf8'), 'existing GIF');
  assert.deepEqual(snapshot(imagePath), before);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['character.png', 'character_idle.gif']);
});

test('an unsuccessful exclusive open never deletes another file', t => {
  const { dir, imagePath } = fixture(t), before = snapshot(imagePath);
  const target = path.join(dir, 'character_idle.gif');
  fs.writeFileSync(target, 'owned by someone else');
  const originalOpen = fs.openSync;
  const open = t.mock.method(fs, 'openSync', (file, flags, ...rest) => {
    if (flags !== 'wx') return originalOpen(file, flags, ...rest);
    assert.equal(file, target);
    throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
  });
  const unlink = t.mock.method(fs, 'unlinkSync', () => assert.fail('no owned file to remove'));
  assert.throws(() => animateImage({ imagePath, motion: 'idle', size: 64 }), { code: 'EACCES' });
  assert.equal(unlink.mock.callCount(), 0);
  open.mock.restore(); unlink.mock.restore();
  assert.equal(fs.readFileSync(target, 'utf8'), 'owned by someone else');
  assert.deepEqual(snapshot(imagePath), before);
});

test('exclusive filename attempts stop after 1000 collisions', t => {
  const { imagePath } = fixture(t), before = snapshot(imagePath), names = [];
  const originalOpen = fs.openSync;
  const open = t.mock.method(fs, 'openSync', (file, flags, ...rest) => {
    if (flags !== 'wx') return originalOpen(file, flags, ...rest);
    names.push(path.basename(file));
    throw Object.assign(new Error('already exists'), { code: 'EEXIST' });
  });
  const unlink = t.mock.method(fs, 'unlinkSync', () => assert.fail('collisions are never owned'));
  assert.throws(() => animateImage({ imagePath, motion: 'idle', size: 64 }), { code: 'BAD_REQUEST', message: /all 1000 output filenames.*already exist/ });
  assert.equal(names.length, 1000);
  assert.equal(names[0], 'character_idle.gif'); assert.equal(names.at(-1), 'character_idle_1000.gif');
  assert.equal(unlink.mock.callCount(), 0);
  open.mock.restore(); unlink.mock.restore();
  assert.deepEqual(snapshot(imagePath), before);
});

test('1024-pixel full pipeline timing and decoder check', t => {
  const { imagePath } = fixture(t), start = performance.now();
  const result = animateImage({ imagePath, motion: 'bounce', size: 1024 });
  const elapsed = performance.now() - start;
  t.diagnostic(`1024px bounce: ${Math.round(elapsed)} ms, ${result.bytes} GIF bytes`);
  verify(result, 1024, true);
});
