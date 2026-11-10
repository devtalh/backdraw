'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { renderSheet, sheetOptions, sheetMask, jumpArc, frameDurations } = require('../lib/sprite-sheet');
const { countGate } = require('../lib/sprite-gates');
const { raster, rect, grid, bounds } = require('./sprite-fixture');

test('3x2 extraction preserves reading order, source colors and aligned ground/center', () => {
  const source = grid(3, 2, { colored: true }), original = source.rgba.slice();
  const r = renderSheet(source, { motion: 'walk', columns: 3, rows: 2 });
  assert.equal(r.frames.length, 6);
  r.frames.forEach((frame, i) => {
    const b = bounds(frame, r.width);
    assert.equal(b.bottom, r.groundY); assert.ok(Math.abs(b.cx - r.anchorX) <= 1);
    assert.deepEqual([r.components[i].row, r.components[i].col], [Math.floor(i / 3) + 1, i % 3 + 1]);
    assert.equal(frame[(b.top * r.width + b.left) * 4], 20 + i * 25);
    assert.equal(b.area, 400);
  });
  assert.deepEqual(source.rgba, original);
  assert.equal(renderSheet(source, { motion: 'walk' }).frames.length, 6);
});

for (const layout of [{}, { columns: 6, rows: 1 }]) {
  test(`raised airborne poses retain left-to-right order with ${layout.rows ? 'explicit grid' : 'automatic detection'}`, () => {
    const source = raster(260, 80);
    for (let i = 0; i < 6; i++) rect(source, 10 + i * 40, i === 2 || i === 3 ? 16 : 40, 20, 28,
      [20 + i * 30, 70, 100, 255]);
    const r = renderSheet(source, { motion: 'jump', ...layout });
    assert.equal(r.frames.length, 6);
    assert.deepEqual(r.components.map(c => [c.row, c.col]), [[1, 1], [1, 2], [1, 3], [1, 4], [1, 5], [1, 6]]);
    r.frames.forEach((frame, i) => {
      const b = bounds(frame, r.width);
      assert.equal(frame[(b.top * r.width + b.left) * 4], 20 + i * 30);
    });
  });
}

test('row intervals merge transitively and explicit rows fall back to center gaps when needed', () => {
  const source = raster(180, 90);
  rect(source, 10, 10, 20, 30); rect(source, 70, 30, 20, 30); rect(source, 130, 50, 20, 30);
  const automatic = renderSheet(source, { motion: 'custom' });
  assert.deepEqual(automatic.components.map(c => [c.row, c.col]), [[1, 1], [1, 2], [1, 3]]);
  const explicit = renderSheet(source, { motion: 'custom', columns: 1, rows: 3 });
  assert.deepEqual(explicit.components.map(c => [c.row, c.col]), [[1, 1], [2, 1], [3, 1]]);
  assert.deepEqual(explicit.components.map(c => c.bbox.x), [10, 70, 130]);
});

test('a missing expected count does not promote distant half-percent specks to frames', () => {
  const source = raster(500, 320);
  for (let i = 0; i < 3; i++) rect(source, 20 + i * 150, 20, 40, 40);
  for (let i = 0; i < 5; i++) rect(source, 20 + i * 90, 250, 3, 3);
  const r = renderSheet(source, { motion: 'walk', frames: 8 });
  assert.equal(r.frames.length, 3);
  assert.deepEqual(r.components.map(c => c.area), [1600, 1600, 1600]);
  assert.equal(r.notes.discardedSpecks, 5); assert.equal(r.notes.discardedSpeckArea, 45);
  assert.equal(r.notes.splitTouching, 0);
  const count = countGate(r);
  assert.equal(count.passed, false); assert.equal(count.details.found, 3); assert.equal(count.details.expected, 8);
});

test('nearby small parts merge with ownership, distant specks are discarded', () => {
  const source = grid(2, 1);
  rect(source, 9, 20, 1, 1); rect(source, 45, 50, 1, 1);
  const r = renderSheet(source, { motion: 'walk', frames: 2 });
  assert.equal(r.components[0].area, 401); assert.equal(r.components[1].area, 400);
  assert.equal(r.notes.discardedSpecks, 1); assert.equal(r.notes.discardedSpeckArea, 1);
  assert.equal(bounds(r.frames[0], r.width).area, 401);
});

test('semi-transparent haze is excluded and every output alpha is binary', () => {
  const source = grid(); rect(source, 0, 0, source.width, 8, [250, 250, 250, 40]);
  const r = renderSheet(source, { motion: 'walk' });
  assert.ok(r.notes.sourceSemiTransparent > 0);
  for (const frame of r.frames) for (let i = 3; i < frame.length; i += 4) assert.ok(frame[i] === 0 || frame[i] === 255);
  assert.equal(r.frames.length, 6);
});

test('alpha threshold keeps RGB exactly and aligns the centroid of the final binary mask', () => {
  const source = raster(260, 60);
  rect(source, 10, 10, 40, 20, [15, 80, 30, 128]); rect(source, 50, 10, 40, 20, [15, 80, 30, 255]);
  rect(source, 150, 10, 80, 20, [15, 80, 30, 255]); rect(source, 10, 35, 80, 5, [240, 240, 240, 127]);
  const r = renderSheet(source, { motion: 'walk' });
  assert.equal(r.frames.length, 2); assert.ok(Math.abs(r.components[0].cx - r.components[0].maskCx) > 1);
  for (const frame of r.frames) {
    const b = bounds(frame, r.width); assert.ok(Math.abs(b.cx - r.anchorX) <= 1); assert.equal(b.area, 1600);
    for (let i = 0; i < frame.length; i += 4) if (frame[i + 3]) assert.deepEqual([...frame.slice(i, i + 4)], [15, 80, 30, 255]);
  }
});

test('touching frames split through the middle projection valley', () => {
  const source = grid(4, 1);
  rect(source, 32, 25, 42, 1);
  const r = renderSheet(source, { motion: 'walk', columns: 4, rows: 1 });
  assert.equal(r.frames.length, 4); assert.ok(r.notes.splitTouching >= 1);
  assert.equal(r.components.reduce((sum, c) => sum + c.area, 0), sheetMask(source).mask.reduce((a, b) => a + b, 0));
});

test('two fully touching four-frame rows split into eight frames in reading order', () => {
  const source = raster(190, 110);
  for (let i = 0; i < 8; i++) rect(source, 10 + i % 4 * 40, 10 + Math.floor(i / 4) * 60, 40, 30,
    [20 + i * 25, 70, 100, 255]);
  const r = renderSheet(source, { motion: 'walk', columns: 4, rows: 2 });
  assert.equal(r.frames.length, 8); assert.equal(r.notes.splitTouching, 6);
  assert.equal(countGate(r).passed, true);
  r.frames.forEach((frame, i) => {
    const b = bounds(frame, r.width);
    assert.equal(b.area, 1200);
    assert.deepEqual(r.components[i].bbox, { x: 10 + i % 4 * 40, y: 10 + Math.floor(i / 4) * 60, w: 40, h: 30 });
    for (let p = 0; p < frame.length; p += 4) if (frame[p + 3]) assert.deepEqual([...frame.slice(p, p + 4)], [20 + i * 25, 70, 100, 255]);
  });
});

test('vertically touching frames use row projection and top-to-bottom reading order', () => {
  const source = raster(60, 240);
  for (let i = 0; i < 4; i++) rect(source, 15, i * 60 + 15, 20, 20);
  rect(source, 25, 35, 1, 40);
  const r = renderSheet(source, { motion: 'walk', columns: 1, rows: 4 });
  assert.equal(r.frames.length, 4); assert.equal(r.notes.splitTouching, 1);
  assert.deepEqual(r.components.map(c => c.row), [1, 2, 3, 4]);
});

test('opaque flat background flood fill preserves enclosed matching colors', () => {
  const source = raster(120, 60); rect(source, 0, 0, 120, 60, [255, 255, 255, 255]);
  rect(source, 10, 10, 20, 20); rect(source, 70, 10, 20, 20);
  rect(source, 14, 14, 10, 10, [255, 255, 255, 255]);
  const r = renderSheet(source, { motion: 'idle' });
  assert.equal(r.notes.opaqueFallback, true); assert.deepEqual(r.notes.backgroundColor, [255, 255, 255]);
  assert.equal(r.components[0].area, 400);
  assert.ok(r.frames[0].some((v, i) => i % 4 === 0 && v === 255 && r.frames[0][i + 3] === 255));
});

test('opaque background without a dominant edge color is rejected', () => {
  const source = raster(60, 40);
  for (let y = 0; y < 40; y++) for (let x = 0; x < 60; x++) rect(source, x, y, 1, 1, (x + y) % 2 ? [0, 0, 0, 255] : [255, 255, 255, 255]);
  assert.throws(() => renderSheet(source, { motion: 'walk' }), { code: 'BAD_REQUEST', message: /no transparent background and no flat background color found at the edges/ });
});

test('zero, one and more than 64 frames are rejected', () => {
  for (const source of [raster(), grid(1, 1), grid(13, 5)]) assert.throws(() => renderSheet(source, { motion: 'walk' }), { code: 'BAD_REQUEST' });
});

test('jump auto selects the longest non-crouching run, grounds takeoff/landing and centers the peak', () => {
  const r = renderSheet(grid(8, 1, { heights: [12, 12, 20, 20, 20, 20, 12, 12] }), { motion: 'jump' });
  assert.deepEqual(r.jump, { airFrames: [3, 6], peak: 8, rule: 'auto' });
  assert.deepEqual(r.lifts, [0, 0, 5, 8, 8, 5, 0, 0]);
  r.frames.forEach((f, i) => assert.equal(bounds(f, r.width).bottom, r.groundY - r.lifts[i]));
  assert.deepEqual(r.durationsMs, [90, 150, 60, 60, 60, 60, 150, 90]);
});

test('jump manual range, peak override, fallback and tie-breaking', () => {
  const components = heights => heights.map(h => ({ bbox: { h, w: 10 } }));
  assert.deepEqual(jumpArc(components([20, 20, 20, 20]), { motion: 'jump' }).jump, { airFrames: [2, 3], peak: 10, rule: 'fallback' });
  const manual = jumpArc(components([20, 20, 20, 20]), { motion: 'jump', air_frames: [2, 3], jump_height: 18 });
  assert.deepEqual(manual.jump, { airFrames: [2, 3], peak: 18, rule: 'air_frames' });
  assert.deepEqual(manual.lifts, [0, 16, 16, 0]);
  assert.deepEqual(jumpArc(components([10, 20, 20, 10, 20, 20]), { motion: 'jump' }).jump.airFrames, [2, 3]);
  assert.equal(jumpArc(components([20, 10, 20]), { motion: 'jump' }).jump.rule, 'fallback');
  assert.throws(() => jumpArc(components([20, 20]), { motion: 'jump', air_frames: [2, 3] }), { code: 'BAD_REQUEST' });
});

test('jump auto spans the first and last crouch runs without grounding compact airborne poses', () => {
  const heights = [152, 134, 110, 154, 163, 150, 134, 128, 131, 143, 153, 143, 110, 126, 143, 154];
  const components = heights.map(h => ({ bbox: { h, w: 10 } }));
  const r = jumpArc(components, { motion: 'jump' });
  assert.deepEqual(r.jump.airFrames, [4, 12]); assert.equal(r.jump.rule, 'auto');
  r.lifts.forEach((lift, i) => assert.equal(lift > 0, i >= 3 && i <= 11));
  assert.equal(r.lifts.indexOf(Math.max(...r.lifts)) + 1, 8);
  assert.deepEqual(frameDurations(components, { motion: 'jump' }, r.jump),
    [90, 90, 150, 60, 60, 60, 60, 60, 60, 60, 60, 60, 150, 90, 90, 90]);
});

test('jump auto uses the longest non-crouching run when there is one crouch run', () => {
  const components = [20, 10, 20, 20, 20, 20].map(h => ({ bbox: { h, w: 10 } }));
  const r = jumpArc(components, { motion: 'jump' });
  assert.deepEqual(r.jump.airFrames, [3, 6]); assert.equal(r.jump.rule, 'auto');
});

test('motion profiles and timing overrides use the found frame count', () => {
  const components = [10, 15, 30, 10].map(w => ({ bbox: { w, h: 20 } }));
  for (const [motion, ms] of Object.entries({ idle: 150, walk: 83, run: 55, dance: 100, wave: 100, custom: 100 })) {
    assert.deepEqual(frameDurations(components, { motion }), Array(4).fill(ms));
  }
  assert.deepEqual(frameDurations(components, { motion: 'attack' }), [70, 140, 220, 70]);
  assert.deepEqual(frameDurations(components, { motion: 'attack', fps: 20 }), [50, 50, 50, 50]);
  assert.deepEqual(frameDurations(components, { motion: 'walk', durations_ms: [20, 30, 40, 5000] }), [20, 30, 40, 5000]);
  assert.throws(() => renderSheet(grid(), { motion: 'walk', durations_ms: [20, 30] }), { code: 'BAD_REQUEST' });
});

test('invalid extraction, timing, jump and output options are rejected', () => {
  for (const extra of [{ motion: 'bounce' }, { columns: 3 }, { rows: 2 }, { columns: 17, rows: 1 },
    { columns: 1, rows: 1 }, { columns: 9, rows: 8 }, { frames: 1 }, { frames: 65 }, { columns: 3, rows: 2, frames: 5 },
    { fps: 0 }, { fps: 51 }, { fps: NaN }, { fps: '20' }, { durations_ms: [19, 40] }, { durations_ms: [20, 5001] },
    { durations_ms: [20.5, 40] }, { fps: 20, durations_ms: [20, 40] }, { jump_height: 2 }, { air_frames: [1, 2] },
    { motion: 'jump', jump_height: 2049 }, { motion: 'jump', air_frames: [3, 2] }, { motion: 'jump', air_frames: [0, 2] },
    { size: 63 }, { size: 1025 }, { background: 'black' }, { background: null }, { include_preview: 'false' }]) {
    assert.throws(() => sheetOptions({ motion: 'walk', ...extra }), { code: 'BAD_REQUEST' }, JSON.stringify(extra));
  }
  assert.equal(sheetOptions({ motion: 'walk', columns: 3, rows: 2, frames: 6 }).expected, 6);
});
