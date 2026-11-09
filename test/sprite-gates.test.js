'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { renderSheet } = require('../lib/sprite-sheet');
const { spriteGates, countGate, emptyGate, sizeGate, identityGate, seamGate, edgesGate } = require('../lib/sprite-gates');
const { raster, rect, grid } = require('./sprite-fixture');

test('a clean aligned sheet passes all six advisory checks', () => {
  const r = renderSheet(grid(), { motion: 'walk', columns: 3, rows: 2 });
  const gates = spriteGates(r);
  assert.deepEqual(gates.map(g => g.id), ['count', 'empty', 'size', 'identity', 'seam', 'edges']);
  for (const g of gates) { assert.equal(g.passed, true, g.message); assert.equal(typeof g.details, 'object'); }
});

test('count identifies total mismatch and wrong grid rows', () => {
  const r = renderSheet(grid(3, 2), { motion: 'walk', columns: 4, rows: 2 });
  const g = countGate(r);
  assert.equal(g.passed, false); assert.equal(g.details.found, 6); assert.equal(g.details.expected, 8);
  assert.deepEqual(g.details.wrongRows, [{ row: 1, found: 3 }, { row: 2, found: 3 }]);
  assert.match(g.message, /row counts differ: 1/);
});

test('empty and size report small or differently sized frames by 1-based index', () => {
  const r = renderSheet(grid(), { motion: 'walk' });
  const components = r.components.map(c => ({ ...c, bbox: { ...c.bbox } }));
  components[2].area = 20; components[2].bbox.h = 8; components[2].bbox.w = 8;
  const empty = emptyGate({ components }), size = sizeGate({ ...r, components });
  assert.equal(empty.passed, false); assert.deepEqual(empty.details.frames, [3]);
  assert.equal(size.passed, false); assert.deepEqual(size.details.frames, [{ index: 3, widthRatio: 0.4, heightRatio: 0.4 }]);
  components[2].bbox.w = 24; components[2].bbox.h = 24;
  assert.equal(sizeGate({ ...r, components }).passed, false);
  assert.equal(sizeGate({ ...r, components, options: { motion: 'dance' } }).passed, true);
  components[2].bbox.w = 29; components[2].bbox.h = 28;
  assert.equal(sizeGate({ ...r, components, options: { motion: 'jump' } }).passed, true);
  assert.equal(sizeGate({ ...r, components, options: { motion: 'idle' } }).passed, false);
});

test('identity detects a changed character color', () => {
  const source = grid();
  // Replace the complete third sprite, leaving its shape identical.
  rect(source, 134, 15, 20, 20, [240, 20, 20, 255]);
  const r = renderSheet(source, { motion: 'walk' }), g = identityGate(r);
  assert.equal(g.passed, false); assert.ok(g.details.outliers.some(f => f.index === 3 && f.score < 0.75));
});

test('seam compares the last-to-first difference with median adjacent differences', () => {
  const frames = [1, 2, 3, 4].map(x => rect(raster(12, 12), x, 4, 3, 3).rgba);
  const g = seamGate({ frames });
  assert.equal(g.passed, false); assert.equal(g.details.seam_ratio, 3);
  assert.equal(seamGate({ frames: [frames[0], frames[0], frames[0]] }).details.seam_ratio, 0);
  assert.equal(seamGate({ frames: frames.slice(0, 2) }).passed, true);
  assert.match(seamGate({ frames: frames.slice(0, 2) }).message, /skipped/);
});

test('seam includes shared opaque RGB differences as well as mask XOR', () => {
  const frames = [30, 40, 50, 60].map(red => rect(raster(12, 12), 2, 2, 4, 4, [red, 150, 70, 255]).rgba);
  assert.ok(seamGate({ frames }).details.seam_ratio > 1.8);
});

test('edges reports white/background halos and source haze, binary-alpha failures throw', () => {
  const source = grid();
  for (let i = 0; i < source.rgba.length; i += 4) if (source.rgba[i + 3]) source.rgba.set([240, 240, 240], i);
  const r = renderSheet(source, { motion: 'walk' });
  r.notes.sourceSemiTransparent = 0.27;
  const g = edgesGate(r);
  assert.equal(g.passed, false); assert.equal(g.details.haloRatio, 1); assert.match(g.message, /27.00%/);
  const green = renderSheet(grid(), { motion: 'walk' });
  green.notes.opaqueFallback = true; green.notes.backgroundColor = [30, 150, 70];
  assert.equal(edgesGate(green).passed, false);
  r.frames[0][3] = 40;
  assert.throws(() => edgesGate(r), /non-binary alpha/);
});
