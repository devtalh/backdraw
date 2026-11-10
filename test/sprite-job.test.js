'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { RETRY_GATES, processSheet, retryReasons, pickBest } = require('../lib/sprite-job');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

for (const name of ['frog-walk-4x2.png', 'frog-jump-4x4.png']) {
  test(`processSheet ${name}: serializable summary, preview only in memory, immutable source`, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backdraw-sprite-job-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, name);
    fs.copyFileSync(path.join(__dirname, 'fixtures', name), file);
    const before = sha(file);
    const result = processSheet(file, { motion: 'walk', columns: 4, rows: 2, frames: 8, size: null, background: 'transparent' });
    assert.equal(sha(file), before);
    assert.ok(result.sheet.png.length > 0);
    assert.equal(JSON.parse(JSON.stringify(result)).sheet, undefined);
    assert.equal(Object.getOwnPropertyDescriptor(result, 'sheet').configurable, true);
    assert.equal(result.gates.length, 6);
    for (const dest of Object.values(result.paths).flat().filter(Boolean)) assert.ok(fs.existsSync(dest));
    if (name.includes('walk')) {
      assert.equal(result.frames, 8);
      assert.ok(result.gates.every(g => g.passed), JSON.stringify(result.gates));
      assert.equal(retryReasons(result), '');
    } else {
      assert.equal(result.gates.find(g => g.id === 'count').passed, false);
      assert.match(retryReasons(result), /count:/);
    }
    delete result.sheet;
    assert.equal(Object.hasOwn(result, 'sheet'), false);
  });
}

const attempt = (...failed) => ({ result: { gates: ['count', 'empty', 'identity', 'size', 'seam', 'edges']
  .map(id => ({ id, passed: !failed.includes(id), message: `${id} detail` })) } });
const error = () => ({ result: { error: 'No frames found', code: 'BAD_REQUEST', retryable: true } });
test('retry gates ignore advisory failures and preserve readable reasons', () => {
  assert.deepEqual(RETRY_GATES, ['count', 'empty', 'identity']);
  assert.equal(retryReasons(attempt('size', 'edges', 'seam').result), '');
  assert.equal(retryReasons(attempt('count', 'identity', 'seam').result), 'count: count detail; identity: identity detail');
  assert.equal(retryReasons(error().result), 'No frames found');
  assert.equal(retryReasons({ error: 'disk full', code: 'ENOSPC', retryable: false }), '');
});

test('processSheet retries malformed PNGs and extraction failures, but not filesystem errors', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backdraw-sprite-errors-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sprite.png'), sprite = { motion: 'walk', columns: 4, rows: 2, frames: 8 };
  fs.writeFileSync(file, 'not a PNG');
  const badPng = processSheet(file, sprite);
  assert.equal(badPng.code, 'BAD_PNG'); assert.equal(badPng.retryable, true);
  assert.equal(retryReasons(badPng), badPng.error);
  const { encodePng } = require('../lib/png-codec');
  fs.writeFileSync(file, encodePng(32, 32, new Uint8Array(32 * 32 * 4)));
  const extraction = processSheet(file, sprite);
  assert.equal(extraction.code, 'BAD_REQUEST'); assert.equal(extraction.retryable, true);
  assert.match(retryReasons(extraction), /Found 0 frames/);
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'frog-walk-4x2.png'), file);
  const denied = () => { throw Object.assign(new Error('access denied'), { code: 'EACCES' }); };
  const mkdir = t.mock.method(fs, 'mkdirSync', denied);
  const writeError = processSheet(file, sprite);
  mkdir.mock.restore();
  assert.deepEqual(writeError, { error: 'access denied', code: 'EACCES', retryable: false });
  assert.equal(retryReasons(writeError), '');
  const read = t.mock.method(fs, 'readFileSync', denied);
  const readError = processSheet(file, sprite);
  read.mock.restore();
  assert.equal(readError.code, 'BAD_REQUEST'); assert.equal(readError.retryable, false);
  assert.match(readError.error, /cannot read.*access denied/);
  assert.equal(retryReasons(readError), '');
});

test('processSheet excludes GIF size limits and unexpected errors from regeneration', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../lib/sprite-job.js'), 'utf8');
  for (const [code, message, retryable] of [
    ['BAD_PNG', 'Malformed PNG', true], ['BAD_REQUEST', 'No frames found', true],
    ['BAD_REQUEST', 'GIF exceeds limits; try a smaller size', false],
    ['ENOSPC', 'Disk full', false], ['EACCES', 'Access denied', false], [undefined, 'Self-check failed', false],
  ]) {
    const context = { module: { exports: {} }, require: name => {
      assert.equal(name, './sprite-export');
      return { animateSheet() { throw Object.assign(new Error(message), { code }); } };
    } };
    vm.runInNewContext(source, context);
    const result = context.module.exports.processSheet('unused', {});
    assert.equal(result.error, message); assert.equal(result.code, code); assert.equal(result.retryable, retryable);
    assert.equal(context.module.exports.retryReasons(result), retryable ? message : '');
  }
});
test('pickBest ranks errors, retry gate failures, all failures, and keeps first on exact ties', () => {
  assert.equal(pickBest([error(), attempt('count', 'empty', 'identity', 'size', 'seam', 'edges')]), 1);
  assert.equal(pickBest([attempt('count'), error()]), 0);
  assert.equal(pickBest([attempt('count'), attempt('size', 'seam', 'edges')]), 1);
  assert.equal(pickBest([attempt('count', 'seam'), attempt('count')]), 1);
  assert.equal(pickBest([attempt('size'), attempt('edges')]), 0);
  assert.equal(pickBest([attempt(), attempt()]), 0);
  assert.equal(pickBest([error(), error()]), 0);
});
