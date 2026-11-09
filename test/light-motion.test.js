'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { LIGHT_MOTIONS, motionSpec, motionAt, detectPixelArt, renderLightMotion } = require('../lib/light-motion');
const { encodeGif } = require('../lib/gif-writer');
const { gifInfo } = require('../lib/gif');
const { decodeGifFrames } = require('../extension/gifframes');

function sprite() {
  const width = 60, height = 80, rgba = new Uint8Array(width * height * 4);
  for (let y = 10; y < 69; y++) for (let x = 12; x < 46; x++) {
    if (((x - 29) / 15) ** 2 + ((y - 38) / 28) ** 2 < 1 ||
        (y >= 53 && x >= 23 && x < 38) || (y >= 30 && y < 39 && x < 23)) {
      rgba.set(x < 27 && y < 32 ? [30, 110, 210, 255] : [200, 40, 10, 255], (y * width + x) * 4);
    }
  }
  return { width, height, rgba };
}

function pixelSprite(offsetX = 0, offsetY = 0) {
  const width = 64 + offsetX, height = 64 + offsetY;
  const colors = [[0, 0, 0, 0], [10, 30, 50, 255], [220, 30, 10, 255],
    [20, 210, 40, 255], [30, 40, 230, 255], [230, 210, 20, 255]];
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 2; y < 14; y++) for (let x = 2; x < 14; x++) {
    const color = colors[1 + (x * 7 + y * 3) % 5];
    for (let yy = 0; yy < 4; yy++) for (let xx = 0; xx < 4; xx++) {
      rgba.set(color, ((offsetY + y * 4 + yy) * width + offsetX + x * 4 + xx) * 4);
    }
  }
  return { width, height, rgba, colors };
}

function nativePixelSprite(edge) {
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

function outlinedSprite(edge) {
  const outline = [24, 56, 96, 255], fill = [232, 88, 32, 255];
  const rgba = new Uint8Array(edge * edge * 4);
  const left = Math.floor((edge - 12) / 2), top = Math.floor((edge - 9) / 2);
  for (let y = top; y < top + 9; y++) for (let x = left; x < left + 12; x++) {
    const boundary = x === left || x === left + 11 || y === top || y === top + 8;
    rgba.set(boundary ? outline : fill, (y * edge + x) * 4);
  }
  return { width: edge, height: edge, rgba, outline, fill };
}

const render = (source, motion, size = 144) => renderLightMotion(source, { motion, size, background: 'transparent' });
const difference = (a, b) => a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0);
const colorKey = (rgba, i) => rgba[i] * 65536 + rgba[i + 1] * 256 + rgba[i + 2];

function assertWholeEnlargement(result, size, minimum = 1) {
  const m = result.scaleFactor, long = Math.max(result.width, result.height);
  assert.ok(Number.isInteger(m) && m >= minimum);
  assert.ok(long <= size);
  assert.equal(result.width % m, 0); assert.equal(result.height % m, 0);
  assert.ok(long / m * (m + 1) > size, 'scaleFactor is the largest whole multiple within size');
}

function assertSourcePixels(frames, width, height, source, m = null) {
  const colors = new Set(), alphas = new Set();
  for (let i = 0; i < source.rgba.length; i += 4) {
    alphas.add(source.rgba[i + 3]);
    if (source.rgba[i + 3]) colors.add(colorKey(source.rgba, i));
  }
  for (const frame of frames) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, alpha = frame[i + 3];
    if (!alphas.has(alpha)) assert.fail(`new alpha ${alpha} at ${x},${y}`);
    if (alpha && !colors.has(colorKey(frame, i))) assert.fail(`new opaque color at ${x},${y}`);
    if (m !== null) {
      const block = ((y - y % m) * width + x - x % m) * 4;
      for (let c = 0; c < 4; c++) {
        if (frame[i + c] !== frame[block + c]) assert.fail(`non-uniform ${m}x block at ${x},${y}`);
      }
    }
  }
}

function assertClosedOutline(frame, width, height, fill) {
  const visited = new Uint8Array(width * height), queue = new Int32Array(width * height);
  let head = 0, tail = 0;
  const enqueue = index => {
    if (!visited[index] && frame[index * 4 + 3] === 0) {
      visited[index] = 1;
      queue[tail++] = index;
    }
  };
  enqueue(0); enqueue(width - 1); enqueue((height - 1) * width); enqueue(width * height - 1);
  while (head < tail) {
    const index = queue[head++], x = index % width, y = Math.floor(index / width);
    for (const neighbor of [x ? index - 1 : -1, x + 1 < width ? index + 1 : -1,
      y ? index - width : -1, y + 1 < height ? index + width : -1]) {
      if (neighbor < 0) continue;
      const i = neighbor * 4;
      assert.ok(frame[i] !== fill[0] || frame[i + 1] !== fill[1] ||
        frame[i + 2] !== fill[2] || frame[i + 3] !== fill[3], 'exterior transparency reached the fill');
      enqueue(neighbor);
    }
  }
}

function opaqueRow(frame, width, top) {
  let row = top ? Infinity : -1;
  for (let i = 3; i < frame.length; i += 4) if (frame[i]) {
    const y = Math.floor(i / 4 / width);
    row = top ? Math.min(row, y) : Math.max(row, y);
  }
  return row;
}

test('motion names, exact defaults, periodic endpoints and moving poses', () => {
  assert.deepEqual(LIGHT_MOTIONS, ['bounce', 'idle', 'sway', 'nod', 'squash', 'wiggle']);
  const expected = [[16, 50], [16, 110], [16, 80], [12, 80], [12, 60], [10, 40]];
  LIGHT_MOTIONS.forEach((name, index) => {
    const spec = motionSpec(name), first = motionAt(name, 0), last = motionAt(name, 1);
    assert.deepEqual([spec.frames, spec.delayMs], expected[index]);
    assert.ok(spec.frames <= 16 && spec.delayMs >= 40);
    assert.equal(spec.delayMs % 10, 0);
    for (const key of Object.keys(first)) assert.ok(Math.abs(first[key] - last[key]) <= 1e-9);
    const result = render(sprite(), name);
    assert.equal(result.durationMs, spec.frames * spec.delayMs);
    assert.deepEqual(result.delaysMs, Array(spec.frames).fill(spec.delayMs));
    const gif = encodeGif(result.frames, { width: result.width, height: result.height, delayMs: result.delaysMs });
    assert.deepEqual(gifInfo(gif.data).delaysMs, result.delaysMs);
    assert.ok(Array.from({ length: spec.frames }, (_, i) => motionAt(name, i / spec.frames))
      .some(pose => Object.keys(first).some(key => Math.abs(first[key] - pose[key]) > 1e-9)));
  });
  for (const fn of [motionSpec, name => motionAt(name, 0)]) {
    assert.throws(() => fn('unknown'), err => err.code === 'BAD_REQUEST' && LIGHT_MOTIONS.every(n => err.message.includes(n)));
  }
});

test('bounce squashes on contact, peaks in midair and is continuous at takeoff and landing', () => {
  const first = motionAt('bounce', 0), middle = motionAt('bounce', 0.5);
  assert.equal(first.lift, 0); assert.ok(first.sy < 1 && first.sx > 1);
  assert.equal(middle.sx, 1); assert.equal(middle.sy, 1); assert.ok(middle.lift > 0);
  for (let i = 0; i < 16; i++) assert.ok(motionAt('bounce', i / 16).lift <= middle.lift);
  for (const boundary of [0.1, 0.9]) {
    const a = motionAt('bounce', boundary - 1e-10), b = motionAt('bounce', boundary + 1e-10);
    for (const key of Object.keys(a)) assert.ok(Math.abs(a[key] - b[key]) < 1e-8);
  }
});

for (const motion of LIGHT_MOTIONS) test(`${motion}: pixel loop seam and clear canvas margins`, () => {
  const result = render(sprite(), motion);
  assert.equal(result.pixelArt, false);
  assert.equal(result.pixelScale, null);
  assert.equal(result.sampling, 'nearest');
  assertWholeEnlargement(result, 144);
  const diffs = result.frames.slice(1).map((frame, i) => difference(frame, result.frames[i]));
  assert.ok(Math.max(...diffs) > 0);
  assert.ok(difference(result.frames.at(-1), result.frames[0]) <= Math.max(...diffs) * 1.05, 'loop seam');
  for (const frame of result.frames) {
    for (let x = 0; x < result.width; x++) {
      assert.equal(frame[x * 4 + 3], 0);
      assert.equal(frame[((result.height - 1) * result.width + x) * 4 + 3], 0);
    }
    for (let y = 0; y < result.height; y++) {
      assert.equal(frame[y * result.width * 4 + 3], 0);
      assert.equal(frame[(y * result.width + result.width - 1) * 4 + 3], 0);
    }
  }
});

test('idle and squash keep their bottom opaque row anchored', () => {
  for (const motion of ['idle', 'squash']) {
    const result = render(sprite(), motion);
    const bottoms = result.frames.map(frame => {
      let bottom = -1;
      for (let i = 3; i < frame.length; i += 4) if (frame[i] >= 128) bottom = Math.floor(i / 4 / result.width);
      return bottom;
    });
    assert.ok(Math.max(...bottoms) - Math.min(...bottoms) <= 1);
  }
});

test('nearest transforms preserve closed one-pixel outlines for every frame', () => {
  for (const edge of [24, 48]) {
    const source = outlinedSprite(edge);
    assert.equal(detectPixelArt(source.rgba, source.width, source.height).pixelArt, false);
    for (const motion of ['squash', 'idle', 'sway', 'bounce']) {
      const result = render(source, motion, 384);
      assert.equal(result.sampling, 'nearest');
      assert.ok(result.scaleFactor >= 2);
      for (const frame of result.frames) assertClosedOutline(frame, result.width, result.height, source.fill);
    }
  }
});

test('nearest transforms move in output-pixel steps instead of source-pixel jumps', () => {
  const source = outlinedSprite(24);
  for (const motion of ['idle', 'squash']) {
    const result = render(source, motion, 384), m = result.scaleFactor;
    assert.ok(m >= 2);
    const rows = result.frames.map(frame => opaqueRow(frame, result.width, true));
    const steps = rows.map((row, i) => Math.abs(row - rows[(i + 1) % rows.length]));
    assert.ok(steps.every(step => step < m));
    assert.ok(steps.some(step => step % m !== 0));
    assert.ok(new Set(rows).size >= 4);
  }
  const bounce = render(source, 'bounce', 384), m = bounce.scaleFactor;
  assert.ok(m >= 2);
  const bottoms = bounce.frames.map(frame => opaqueRow(frame, bounce.width, false));
  const steps = bottoms.map((row, i) => Math.abs(row - bottoms[(i + 1) % bottoms.length]));
  assert.ok(new Set(bottoms.map(row => row % m)).size > 1);
  assert.ok(steps.some(step => step % m !== 0));
});

test('rotation stays around bottom center, with only the specified wiggle translation', () => {
  // A narrow marker at the pivot tracks the actual renderer, including its inverse transform.
  const source = { width: 60, height: 80, rgba: new Uint8Array(60 * 80 * 4) };
  for (let y = 10; y < 69; y++) for (let x = 15; x < 45; x++) {
    source.rgba.set(y >= 67 && x >= 28 && x < 32 ? [0, 0, 240, 255] : [220, 0, 0, 255], (y * 60 + x) * 4);
  }
  for (const motion of ['sway', 'nod', 'wiggle']) {
    const result = render(source, motion, 384);
    const poses = result.frames.map((_, i) => motionAt(motion, i / result.frames.length));
    const forward = (x, y, p) => {
      const angle = p.angle * Math.PI / 180;
      const xx = (x - 30) * p.sx, yy = (y - 69) * p.sy;
      return { x: 30 + p.dx * 30 + xx * Math.cos(angle) - yy * Math.sin(angle),
        y: 69 - p.lift * 59 + xx * Math.sin(angle) + yy * Math.cos(angle) };
    };
    const corners = poses.flatMap(p => [15, 45].flatMap(x => [10, 69].map(y => forward(x, y, p))));
    const margin = 59 * 0.06;
    const left = Math.floor(Math.min(...corners.map(p => p.x)) - margin);
    const top = Math.floor(Math.min(...corners.map(p => p.y)) - margin);
    const right = Math.ceil(Math.max(...corners.map(p => p.x)) + margin);
    const bottom = Math.ceil(Math.max(...corners.map(p => p.y)) + margin);
    const scale = Math.floor(384 / Math.max(right - left, bottom - top));
    assert.equal(result.sampling, 'nearest'); assert.equal(result.scaleFactor, scale);
    const markers = result.frames.map(frame => {
      let sx = 0, sy = 0, n = 0;
      // The blue channel weights the marker centroid in output-pixel coordinates.
      for (let i = 0; i < frame.length; i += 4) if (frame[i + 2] && frame[i + 3]) {
        const weight = frame[i + 2] * frame[i + 3];
        sx += ((i / 4) % result.width) * weight; sy += Math.floor(i / 4 / result.width) * weight; n += weight;
      }
      assert.ok(n > 0);
      return { x: sx / n + 0.5, y: sy / n + 0.5 };
    });
    poses.forEach((p, i) => {
      // The marker is centered one source pixel above the bottom pivot.
      const expected = forward(30, 68, p);
      assert.ok(Math.abs(markers[i].x - (expected.x - left) * scale) <= 1);
      assert.ok(Math.abs(markers[i].y - (expected.y - top) * scale) <= 1);
      // Recover the pivot from that marker, removing wiggle's intentional dx translation.
      const pivotX = markers[i].x - (Math.sin(p.angle * Math.PI / 180) * p.sy + p.dx * 30) * scale;
      const pivotY = markers[i].y + Math.cos(p.angle * Math.PI / 180) * p.sy * scale;
      assert.ok(Math.abs(pivotX - (30 - left) * scale) <= 1);
      assert.ok(Math.abs(pivotY - (69 - top) * scale) <= 1);
    });
  }
});

test('smooth downscaling and box reduction reject hidden white RGB halos through GIF', () => {
  const edge = 512, rgba = new Uint8Array(edge * edge * 4);
  for (let y = 0; y < edge; y++) for (let x = 0; x < edge; x++) {
    const distance = Math.hypot(x + 0.5 - edge / 2, y + 0.5 - edge / 2);
    const alpha = Math.round(Math.max(0, Math.min(1, edge * 0.35 - distance)) * 255);
    rgba.set(alpha ? [200, 0, 0, alpha] : [255, 255, 255, 0], (y * edge + x) * 4);
  }
  const result = render({ width: edge, height: edge, rgba }, 'sway', 128);
  assert.equal(result.sampling, 'smooth'); assert.equal(result.scaleFactor, null);
  assert.equal(Math.max(result.width, result.height), 128);
  const gif = encodeGif(result.frames, { width: result.width, height: result.height, delayMs: result.delaysMs });
  for (const frame of decodeGifFrames(gif.data).frames) for (let i = 0; i < frame.rgba.length; i += 4) {
    if (frame.rgba[i + 3]) assert.ok(frame.rgba[i + 1] <= 40 && frame.rgba[i + 2] <= 40);
  }
});

test('native-resolution pixel sprites use nearest sampling for all motions without new colors', () => {
  for (const edge of [16, 48]) {
    const source = nativePixelSprite(edge);
    assert.deepEqual(detectPixelArt(source.rgba, source.width, source.height),
      { pixelArt: false, scale: 1, offsetX: 0, offsetY: 0 });
    for (const motion of LIGHT_MOTIONS) {
      const result = render(source, motion, 384);
      assert.equal(result.sampling, 'nearest');
      assert.equal(result.pixelArt, false); assert.equal(result.pixelScale, null);
      assertWholeEnlargement(result, 384, 2);
      assertSourcePixels(result.frames, result.width, result.height, source);
      if (motion !== 'bounce') {
        assertSourcePixels([result.frames[0]], result.width, result.height, source, result.scaleFactor);
      }
    }
    const result = render(source, 'idle', 384);
    const gif = encodeGif(result.frames, { width: result.width, height: result.height, delayMs: result.delaysMs });
    const decoded = decodeGifFrames(gif.data);
    assertSourcePixels(decoded.frames.map(frame => frame.rgba), decoded.width, decoded.height, source);
  }
});

test('pixel grid detection retains scale and shifted origins, rejecting smooth or sparse input', () => {
  for (const [x, y] of [[0, 0], [2, 3]]) {
    const s = pixelSprite(x, y);
    assert.deepEqual(detectPixelArt(s.rgba, s.width, s.height), { pixelArt: true, scale: 4, offsetX: x, offsetY: y });
  }
  const gradient = new Uint8Array(64 * 64 * 4), circle = gradient.slice();
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    gradient.set([x * 4, y * 4, 100, 255], (y * 64 + x) * 4);
    circle.set([200, 10, 20, Math.round(Math.max(0, Math.min(1, 23 - Math.hypot(x - 31.5, y - 31.5))) * 255)], (y * 64 + x) * 4);
  }
  for (const rgba of [gradient, circle, new Uint8Array(64 * 64 * 4).fill(255)]) {
    assert.equal(detectPixelArt(rgba, 64, 64).pixelArt, false);
  }
});

test('pixel art uses only source colors and identity frames use uniform integer enlargement blocks', () => {
  const source = pixelSprite(2, 3), colors = new Set(source.colors.map(color => color.join(',')));
  // Idle's natural canvas is 16 x 17, so a 384 limit gives a 22x enlargement.
  const result = render(source, 'idle', 384), m = 22;
  assert.equal(result.pixelArt, true); assert.equal(result.pixelScale, 4);
  assert.equal(result.sampling, 'pixel-grid'); assert.equal(result.scaleFactor, null);
  assert.ok(Math.max(result.width, result.height) <= 384);
  assert.equal(result.width % m, 0); assert.equal(result.height % m, 0);
  for (const [frameIndex, frame] of result.frames.entries()) {
    for (let y = 0; y < result.height; y++) for (let x = 0; x < result.width; x++) {
      const i = (y * result.width + x) * 4;
      if (frame[i + 3]) assert.ok(colors.has(Array.from(frame.subarray(i, i + 4)).join(',')));
      if (frameIndex === 0) {
        const block = (Math.floor(y / m) * m * result.width + Math.floor(x / m) * m) * 4;
        for (let c = 0; c < 4; c++) assert.equal(frame[i + c], frame[block + c]);
      }
    }
  }
  // A larger native grid exercises the nearest-neighbor reduction branch too.
  const large = { width: 256, height: 256, rgba: new Uint8Array(256 * 256 * 4) };
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    large.rgba.set(source.colors[1 + (Math.floor(x / 2) + Math.floor(y / 2)) % 5], (y * 256 + x) * 4);
  }
  const small = render(large, 'sway', 64);
  assert.equal(small.pixelArt, true); assert.equal(small.sampling, 'pixel-grid');
  assert.equal(small.scaleFactor, null); assert.equal(Math.max(small.width, small.height), 64);
  for (const frame of small.frames) for (let i = 0; i < frame.length; i += 4) {
    if (frame[i + 3]) assert.ok(colors.has(Array.from(frame.subarray(i, i + 4)).join(',')));
  }
});

test('hidden RGB noise below alpha 16 does not break a four-pixel grid', () => {
  const source = pixelSprite();
  let seed = 0x12345678;
  for (let i = 0; i < source.rgba.length; i += 4) if (!source.rgba[i + 3]) {
    for (let c = 0; c < 4; c++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      source.rgba[i + c] = seed & (c === 3 ? 15 : 255);
    }
  }
  assert.deepEqual(detectPixelArt(source.rgba, source.width, source.height),
    { pixelArt: true, scale: 4, offsetX: 0, offsetY: 0 });
});

test('long flat rectangle edges and a single square are not evidence of pixel art', () => {
  const width = 1000, height = 1000;
  for (const rectangles of [
    [[200, 200, 400, 400]],
    [[200, 200, 400, 400], [600, 600, 800, 800]],
  ]) {
    const rgba = new Uint8Array(width * height * 4);
    for (const [left, top, right, bottom] of rectangles) {
      for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
        rgba.set([200, 30, 10, 255], (y * width + x) * 4);
      }
    }
    assert.deepEqual(detectPixelArt(rgba, width, height), { pixelArt: false, scale: 1, offsetX: 0, offsetY: 0 });
  }
});

test('all pixel art motions preserve colors and clear margins, with blocks on identity frames', () => {
  const source = pixelSprite(), colors = new Set(source.colors.map(color => color.join(',')));
  for (const motion of LIGHT_MOTIONS) {
    const spec = motionSpec(motion), corners = [];
    for (let i = 0; i < spec.frames; i++) {
      const p = motionAt(motion, i / spec.frames), angle = p.angle * Math.PI / 180;
      for (const x of [0, 12]) for (const y of [0, 12]) {
        corners.push({ x: 6 + p.dx * 12 + (x - 6) * p.sx * Math.cos(angle) - (y - 12) * p.sy * Math.sin(angle),
          y: 12 - p.lift * 12 + (x - 6) * p.sx * Math.sin(angle) + (y - 12) * p.sy * Math.cos(angle) });
      }
    }
    const w = Math.ceil(Math.max(...corners.map(p => p.x)) + 2) - Math.floor(Math.min(...corners.map(p => p.x)) - 2);
    const h = Math.ceil(Math.max(...corners.map(p => p.y)) + 2) - Math.floor(Math.min(...corners.map(p => p.y)) - 2);
    const m = Math.max(1, Math.floor(96 / Math.max(w, h))), result = render(source, motion, 96);
    assert.equal(result.pixelArt, true); assert.equal(result.sampling, 'pixel-grid');
    assert.equal(result.scaleFactor, null); assert.deepEqual([result.width, result.height], [w * m, h * m]);
    for (const [frameIndex, frame] of result.frames.entries()) for (let y = 0; y < result.height; y++) for (let x = 0; x < result.width; x++) {
      const i = (y * result.width + x) * 4;
      if (frame[i + 3]) assert.ok(colors.has(Array.from(frame.subarray(i, i + 4)).join(',')));
      if (!x || !y || x === result.width - 1 || y === result.height - 1) assert.equal(frame[i + 3], 0);
      if (motion !== 'bounce' && frameIndex === 0) {
        const block = (Math.floor(y / m) * m * result.width + Math.floor(x / m) * m) * 4;
        for (let c = 0; c < 4; c++) assert.equal(frame[i + c], frame[block + c]);
      }
    }
  }
});

test('opaque sources are flagged and fully transparent sources fail', () => {
  const source = { width: 30, height: 40, rgba: new Uint8Array(30 * 40 * 4).fill(255) };
  assert.equal(render(source, 'idle').opaqueSource, true);
  source.rgba.fill(0);
  assert.throws(() => render(source, 'idle'), { code: 'BAD_REQUEST', message: 'the PNG is fully transparent' });
});
