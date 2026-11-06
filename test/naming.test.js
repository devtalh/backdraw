'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { stamp, slugify, sniffExt } = require('../lib/naming');

test('stamp: local time as yyyyMMdd-HHmmss, zero padded', () => {
  assert.equal(stamp(new Date(2024, 0, 5, 3, 4, 9)), '20240105-030409');
  assert.equal(stamp(new Date(2025, 11, 31, 23, 59, 58)), '20251231-235958');
  assert.match(stamp(), /^\d{8}-\d{6}$/);
});

test('slugify: Turkish letters become plain lowercase ASCII', () => {
  assert.equal(slugify('Çılgın Şövalye Ğ Ü Ö İstanbul ı'), 'cilgin-sovalye-g-u-o-istanbul-i');
  assert.equal(slugify('ÇĞİÖŞÜ çğıöşü'), 'cgiosu-cgiosu');
});

test('slugify: accents are dropped, letters without a decomposition are lost', () => {
  assert.equal(slugify('Café Niño Über'), 'cafe-nino-uber');
  assert.equal(slugify('Ångström'), 'angstrom');
  // Current behavior: ß, Æ, ø and Œ have no ASCII decomposition and become separators.
  assert.equal(slugify('Straße'), 'stra-e');
  assert.equal(slugify('Ærø Œuvre'), 'r-uvre');
});

test('slugify: emoji and symbols only separate words', () => {
  assert.equal(slugify('🐉 dragon 🔥'), 'dragon');
  assert.equal(slugify('void mage, purple & black!'), 'void-mage-purple-black');
});

test('slugify: nothing usable gives "image"', () => {
  assert.equal(slugify('!!! ??? ***'), 'image');
  assert.equal(slugify('🐉🔥'), 'image');
  assert.equal(slugify(''), 'image');
});

test('slugify: leading and trailing dashes are removed', () => {
  assert.equal(slugify('---abc---'), 'abc');
  assert.equal(slugify('  hello world  '), 'hello-world');
});

test('slugify: at most 48 characters and never ends with a dash', () => {
  assert.equal(slugify('x'.repeat(60)), 'x'.repeat(48));
  // The 48th character would be the separator before "b".
  assert.equal(slugify(`${'a'.repeat(47)} b`), 'a'.repeat(47));
  const long = slugify('a long prompt about a purple and black void mage casting a spell in the rain');
  assert.ok(long.length <= 48);
  assert.doesNotMatch(long, /-$/);
});

test('sniffExt: recognizes png, jpg, webp and gif by their magic bytes', () => {
  assert.equal(sniffExt(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'png');
  assert.equal(sniffExt(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])), 'jpg');
  assert.equal(sniffExt(Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 ')])), 'webp');
  assert.equal(sniffExt(Buffer.from('GIF89a')), 'gif');
  assert.equal(sniffExt(Buffer.from('GIF87a')), 'gif');
});

test('sniffExt: anything else is unknown (null)', () => {
  assert.equal(sniffExt(Buffer.from('hello world')), null);
  assert.equal(sniffExt(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')])), null);
  assert.equal(sniffExt(Buffer.alloc(0)), null);
});

test('sniffExt: leading bytes take precedence over embedded SVG text', () => {
  const { png } = require('./png-fixture');
  const { gif } = require('./gif-fixture');
  const svg = Buffer.from('image/svg+xml <svg xmlns="http://www.w3.org/2000/svg">');
  assert.equal(sniffExt(Buffer.concat([png(6), svg])), 'png');
  assert.equal(sniffExt(gif()), 'gif');
});
