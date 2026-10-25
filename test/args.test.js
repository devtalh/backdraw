'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { intArg, parseArgs } = require('../lib/args');

test('intArg: anything that is not a finite number gets the default', () => {
  assert.equal(intArg(undefined, 0, 900, 45), 45);
  assert.equal(intArg(NaN, 0, 900, 45), 45);
  assert.equal(intArg('abc', 0, 900, 45), 45);
  assert.equal(intArg('12abc', 0, 900, 45), 45);
  assert.equal(intArg(Infinity, 0, 900, 45), 45);
  assert.equal(intArg({}, 0, 900, 45), 45);
});

test('intArg: null, blank strings, booleans and arrays are not numbers either', () => {
  assert.equal(intArg(null, 0, 900, 45), 45);
  assert.equal(intArg('', 0, 900, 45), 45);
  assert.equal(intArg('   ', 0, 900, 45), 45);
  assert.equal(intArg(true, 0, 900, 45), 45);
  assert.equal(intArg(false, 0, 900, 45), 45);
  assert.equal(intArg(['30'], 0, 900, 45), 45);
});

test('intArg: clamps to the range', () => {
  assert.equal(intArg(5000, 0, 900, 45), 900);
  assert.equal(intArg(-3, 0, 900, 45), 0);
  assert.equal(intArg(0, 0, 900, 45), 0);
  assert.equal(intArg(900, 0, 900, 45), 900);
  assert.equal(intArg(undefined, 60, 900, 10), 60); // even the default is clamped
});

test('intArg: rounds to a whole number', () => {
  assert.equal(intArg(44.4, 0, 900, 45), 44);
  assert.equal(intArg(44.5, 0, 900, 45), 45);
  assert.equal(intArg(0.2, 0, 900, 45), 0);
});

test('intArg: numeric strings are numbers', () => {
  assert.equal(intArg('120', 0, 900, 45), 120);
  assert.equal(intArg(' 30 ', 0, 900, 45), 30);
  assert.equal(intArg('7.6', 0, 900, 45), 8);
  assert.equal(intArg('1e3', 0, 900, 45), 900);
});

const CLI = { booleans: ['raw', 'reattach', 'worker'], lists: ['ref'] };

test('parseArgs: a list flag collects every value', () => {
  assert.deepEqual(parseArgs(['--ref', 'a.png', '--ref', 'b.png'], CLI).flags, { ref: ['a.png', 'b.png'] });
  assert.deepEqual(parseArgs(['--ref', 'a.png', '--ref', 'b.png', '--ref', 'c.png'], CLI).flags, { ref: ['a.png', 'b.png', 'c.png'] });
  assert.deepEqual(parseArgs(['--ref', 'a.png'], CLI).flags, { ref: 'a.png' });
});

test('parseArgs: for any other repeated flag the last value wins', () => {
  assert.deepEqual(parseArgs(['--out', 'a', '--out', 'b'], CLI).flags, { out: 'b' });
  assert.deepEqual(parseArgs(['--wait', '60', '--wait', '90'], CLI).flags, { wait: '90' });
  assert.deepEqual(parseArgs(['--ref', 'a.png', '--ref', 'b.png']).flags, { ref: 'b.png' }); // not declared a list
});

test('parseArgs: a flag without a value is true', () => {
  assert.deepEqual(parseArgs(['--raw']).flags, { raw: true });
  // followed by another flag
  assert.deepEqual(parseArgs(['--raw', '--wait', '60']).flags, { raw: true, wait: '60' });
  // trailing
  assert.deepEqual(parseArgs(['prompt', '--reattach']), { pos: ['prompt'], flags: { reattach: true } });
});

test('parseArgs: values stay strings', () => {
  const { flags } = parseArgs(['--wait', '300', '--max', '5']);
  assert.equal(flags.wait, '300');
  assert.equal(flags.max, '5');
});

test('parseArgs: positionals keep their order around flags', () => {
  assert.deepEqual(parseArgs(['a', 'void', '--url', 'https://chatgpt.com/c/1', 'mage', 'at', '--raw', '--wait', '60', 'night']), {
    pos: ['a', 'void', 'mage', 'at', 'night'],
    flags: { url: 'https://chatgpt.com/c/1', raw: true, wait: '60' },
  });
  assert.deepEqual(parseArgs([]), { pos: [], flags: {} });
});

test('parseArgs: a boolean flag never takes the next word', () => {
  assert.deepEqual(parseArgs(['--raw', 'a', 'dragon'], CLI), { pos: ['a', 'dragon'], flags: { raw: true } });
  assert.deepEqual(parseArgs(['--raw', 'yes', 'please', '--reattach', 'now', '--worker', 'x'], CLI),
    { pos: ['yes', 'please', 'now', 'x'], flags: { raw: true, reattach: true, worker: true } });
  // An undeclared flag still takes it.
  assert.deepEqual(parseArgs(['--raw', 'at', 'night']), { pos: ['night'], flags: { raw: 'at' } });
});

test('parseArgs: a single dash is a value, not a flag', () => {
  assert.deepEqual(parseArgs(['--out', '-', '-x']), { pos: ['-x'], flags: { out: '-' } });
});

test('parseArgs: --flag=value, also for a boolean flag and a list flag', () => {
  assert.deepEqual(parseArgs(['setup', '--clients=claude-code,cursor', '--yes'], { booleans: ['yes'] }),
    { pos: ['setup'], flags: { clients: 'claude-code,cursor', yes: true } });
  assert.deepEqual(parseArgs(['--ref=a.png', '--ref', 'b.png', '--aspect=16:9'], CLI).flags, { ref: ['a.png', 'b.png'], aspect: '16:9' });
  assert.deepEqual(parseArgs(['--out=', 'x']).flags, { out: '' });
});
