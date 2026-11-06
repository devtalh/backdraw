'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { TOLERANCE, ALIASES, withinAspect, parseAspect, plan, safeBand, promptLines, aspectOption } = require('../lib/aspect');
const crop = require('../extension/aspect');

const TRANSPARENT = 'Background: fully transparent (PNG with an alpha channel). Show only the subject: no background colour, no scenery, no floor shadow, no white or checkerboard box.';

test('parseAspect: W:H, WxH, W/H and spaces', () => {
  assert.deepEqual(parseAspect('16:9'), { w: 16, h: 9, ratio: 16 / 9, label: '16:9', orientation: 'landscape' });
  for (const s of ['16x9', '16X9', '16/9', ' 16 : 9 ', '16 x 9', '16×9']) assert.equal(parseAspect(s).label, '16:9', s);
  assert.equal(parseAspect('4:5').orientation, 'portrait');
  assert.equal(parseAspect('1:1').orientation, 'square');
});

test('parseAspect: reduces by the greatest common divisor', () => {
  assert.equal(parseAspect('1920:1080').label, '16:9');
  assert.equal(parseAspect('1080x1920').label, '9:16');
  assert.equal(parseAspect('1500:500').label, '3:1');
  assert.equal(parseAspect('2:2').label, '1:1');
  assert.equal(parseAspect('100:99').label, '100:99');
});

test('parseAspect: a few aliases, any case', () => {
  const want = { square: '1:1', landscape: '3:2', portrait: '2:3', wide: '16:9', tall: '9:16', 'discord-banner': '5:2' };
  assert.deepEqual(ALIASES, want);
  for (const [alias, label] of Object.entries(want)) assert.equal(parseAspect(alias).label, label, alias);
  assert.equal(parseAspect('Square').label, '1:1');
  assert.equal(parseAspect('Discord Banner').label, '5:2');
  assert.equal(parseAspect('discord_banner').label, '5:2');
});

test('parseAspect: invalid input throws a helpful message', () => {
  for (const s of ['', 'abc', '16', '16:', ':9', '16:9:1', '-16:9', '16;9', 'constructor', 'toString', '1e3:1', '123456:1']) {
    assert.throws(() => parseAspect(s), /is not a ratio: use W:H with whole numbers, e\.g\. 16:9/, s);
  }
  assert.throws(() => parseAspect(undefined), /not a ratio/);
  assert.throws(() => parseAspect(null), /not a ratio/);
  assert.throws(() => parseAspect('0:1'), /both sides must be at least 1/);
  assert.throws(() => parseAspect('16:0'), /both sides must be at least 1/);
});

test('parseAspect: decimals are refused, with the whole-number ratio when there is one', () => {
  assert.throws(() => parseAspect('1.5:1'), /^Error: aspect_ratio "1\.5:1" must use whole numbers: use 3:2 instead\.$/);
  assert.throws(() => parseAspect('2.35:1'), /must use whole numbers: use 47:20 instead/);
  assert.throws(() => parseAspect('1.0:1'), /use 1:1 instead/);
  assert.throws(() => parseAspect('1.001:1'), /must use whole numbers, e\.g\. 16:9\.$/);
  // Out of range once reduced: the range is the problem, not a whole-number ratio that is refused too.
  for (const [s, label] of [['4.5:1', '9:2'], ['0.5:3', '1:6'], ['2.5:0.5', '5:1'], ['1:4.5', '2:9']]) {
    assert.throws(() => parseAspect(s), new RegExp(`^Error: aspect_ratio ${label} is outside the supported range 1:4 to 4:1`), s);
  }
});

test('parseAspect: 1:4 to 4:1 is accepted, anything beyond is not', () => {
  assert.equal(parseAspect('4:1').label, '4:1');
  assert.equal(parseAspect('1:4').label, '1:4');
  assert.equal(parseAspect('100:25').label, '4:1');
  for (const s of ['5:1', '1:5', '41:10', '10:41', '9:2']) {
    assert.throws(() => parseAspect(s), /is outside the supported range 1:4 to 4:1 \(ChatGPT itself draws 1:3 to 3:1\)/, s);
  }
  // Out of range wins over "too precise": the range is the real problem.
  assert.throws(() => parseAspect('1000:1'), /outside the supported range/);
});

test('parseAspect: after reducing, both numbers must be 100 or less', () => {
  assert.throws(() => parseAspect('1921:1080'), /"1921:1080" \(1921:1080\) is too precise: use a simpler ratio with numbers up to 100/);
  assert.throws(() => parseAspect('101:100'), /too precise/);
});

test('withinAspect: accepts the 1% boundary and rejects invalid dimensions', () => {
  const square = parseAspect('1:1');
  assert.equal(withinAspect(1010, 1000, square), true);
  assert.equal(withinAspect(1011, 1000, square), false);
  for (const dimensions of [[0, 1000], [-1, 1000], [NaN, 1000], [Infinity, 1000], [1000, null]]) {
    assert.equal(withinAspect(...dimensions, square), false, String(dimensions));
  }
  assert.equal(withinAspect(1000, 1000, null), false);
});

test('plan: native ratios are drawn as asked', () => {
  for (const s of ['1:1', '3:2', '2:3', '16:9', '9:16', '4:5', '5:2', '3:1', '1:3', '300:100']) {
    const p = plan(parseAspect(s));
    assert.equal(p.native, true, s);
    assert.deepEqual(p.generate, p.target, s);
  }
  assert.deepEqual(plan(parseAspect('16:9')), { target: { w: 16, h: 9, label: '16:9' }, native: true, generate: { w: 16, h: 9, label: '16:9' } });
});

test('plan: beyond 1:3..3:1 the nearest bound on the same side is drawn and cropped', () => {
  assert.deepEqual(plan(parseAspect('4:1')), { target: { w: 4, h: 1, label: '4:1' }, native: false, generate: { w: 3, h: 1, label: '3:1' } });
  assert.deepEqual(plan(parseAspect('1:4')), { target: { w: 1, h: 4, label: '1:4' }, native: false, generate: { w: 1, h: 3, label: '1:3' } });
  assert.deepEqual(plan(parseAspect('31:10')).generate, { w: 3, h: 1, label: '3:1' });
  assert.deepEqual(plan(parseAspect('10:31')).generate, { w: 1, h: 3, label: '1:3' });
});

test('safeBand: the share of the drawn frame that survives the centre crop', () => {
  assert.equal(safeBand(plan(parseAspect('16:9'))), null);
  assert.deepEqual(safeBand(plan(parseAspect('4:1'))), { axis: 'height', share: 0.75 });
  assert.deepEqual(safeBand(plan(parseAspect('1:4'))), { axis: 'width', share: 0.75 });
  const band = safeBand(plan(parseAspect('7:2')));
  assert.equal(band.axis, 'height');
  assert.ok(Math.abs(band.share - 6 / 7) < 1e-12);
  assert.ok(Math.abs(safeBand(plan(parseAspect('10:3'))).share - 0.9) < 1e-12);
});

test('promptLines: native ratio', () => {
  assert.deepEqual(promptLines(plan(parseAspect('16:9')), false), ['Aspect ratio: 16:9 (landscape). Fill the whole frame, no borders or letterboxing.']);
  assert.deepEqual(promptLines(plan(parseAspect('square')), false), ['Aspect ratio: 1:1 (square). Fill the whole frame, no borders or letterboxing.']);
  assert.deepEqual(promptLines(plan(parseAspect('9:16')), false), ['Aspect ratio: 9:16 (portrait). Fill the whole frame, no borders or letterboxing.']);
});

test('promptLines: a cropped ratio says where the safe band is', () => {
  assert.deepEqual(promptLines(plan(parseAspect('4:1')), false), [
    'Aspect ratio: make the image 3:1 (landscape). It will be cropped from the centre to exactly 4:1 afterwards, so keep every important element ' +
    '(subjects, faces, text, logos) inside the middle 75% of the height; the top and bottom 12.5% may be cut off. Fill the whole frame, no borders.',
  ]);
  const [tall] = promptLines(plan(parseAspect('1:4')), false);
  assert.match(tall, /^Aspect ratio: make the image 1:3 \(portrait\)\. It will be cropped from the centre to exactly 1:4 afterwards/);
  assert.match(tall, /inside the middle 75% of the width; the left and right 12\.5% may be cut off\./);
  assert.match(promptLines(plan(parseAspect('7:2')), false)[0], /middle 85\.7% of the height; the top and bottom 7\.1% may be cut off/);
});

test('promptLines: transparent background, alone or after the shape', () => {
  assert.deepEqual(promptLines(null, true), [TRANSPARENT]);
  assert.deepEqual(promptLines(undefined, true), [TRANSPARENT]);
  const lines = promptLines(plan(parseAspect('1:1')), true);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^Aspect ratio: 1:1/);
  assert.equal(lines[1], TRANSPARENT);
  assert.deepEqual(promptLines(null, false), []);
});

test('promptLines: with a transparent background the shape line does not ask to fill the frame', () => {
  const keep = 'Compose the subject to suit this frame; everything around it stays transparent, with no borders.';
  assert.deepEqual(promptLines(plan(parseAspect('1:1')), true), [`Aspect ratio: 1:1 (square). ${keep}`, TRANSPARENT]);
  const [banner] = promptLines(plan(parseAspect('4:1')), true);
  assert.match(banner, /the top and bottom 12\.5% may be cut off\. Compose the subject to suit this frame; /);
  assert.ok(banner.endsWith(keep));
  for (const s of ['1:1', '16:9', '4:1', '1:4']) assert.doesNotMatch(promptLines(plan(parseAspect(s)), true).join('\n'), /Fill the whole frame/, s);
});

test('aspectOption (what the host checks in createJob): nothing given is null, a bad value throws', () => {
  for (const v of [undefined, null, '', '   ']) assert.equal(aspectOption(v), null);
  assert.deepEqual(aspectOption('1920x1080'), plan(parseAspect('16:9')));
  assert.equal(aspectOption('4:1').native, false);
  assert.throws(() => aspectOption('5:1'), /outside the supported range/);
  assert.throws(() => aspectOption('wide-ish'), /not a ratio/);
  assert.throws(() => aspectOption(true), /"true" is not a ratio/);
});

// ---------------------------------------------------------------- extension/aspect.js cropRect

const { cropRect } = crop;

test('the extension and the host use the same 1% tolerance', () => {
  assert.equal(TOLERANCE, 0.01);
  assert.equal(crop.TOLERANCE, TOLERANCE);
});

test('the service worker loads aspect.js before anything else and uses cropRect from it', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const background = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');
  const code = background.split('\n').filter(l => l.trim() && !l.startsWith('//'));
  assert.match(code[0], /^importScripts\('aspect\.js'[,)]/);
  assert.match(background, /const \{ cropRect \} = self\.BackdrawAspect;/);
});

test('cropRect: the observed ChatGPT sizes', () => {
  // 1983x793 is ChatGPT's 5:2; cropped to 4:1 it keeps the full width (1983 / 4 = 495.75).
  assert.deepEqual(cropRect(1983, 793, 4, 1), { x: 0, y: 148, width: 1983, height: 496 });
  // Already within 1%: no crop.
  assert.equal(cropRect(1672, 941, 16, 9), null);
  assert.equal(cropRect(1254, 1254, 1, 1), null);
  assert.equal(cropRect(1448, 1086, 4, 3), null);
  assert.equal(cropRect(1122, 1402, 4, 5), null);
  assert.equal(cropRect(1983, 793, 5, 2), null);
  // A square asked as 16:9.
  assert.deepEqual(cropRect(1254, 1254, 16, 9), { x: 0, y: 274, width: 1254, height: 705 });
});

test('cropRect: ratios with large terms keep the whole limiting side and cut no more than needed', () => {
  // 100:27 drawn at 3:1: only the top and bottom 9.5% go, the width stays whole.
  assert.deepEqual(cropRect(2172, 724, 100, 27), { x: 0, y: 69, width: 2172, height: 586 });
  assert.deepEqual(cropRect(1254, 1254, 100, 97), { x: 0, y: 19, width: 1254, height: 1216 });
  assert.deepEqual(cropRect(2172, 724, 4, 1), { x: 0, y: 90, width: 2172, height: 543 });
});

test('cropRect: tolerance boundary, and a custom tolerance', () => {
  assert.equal(cropRect(1010, 1000, 1, 1), null); // 1.0% off
  assert.deepEqual(cropRect(1011, 1000, 1, 1), { x: 5, y: 0, width: 1000, height: 1000 });
  assert.equal(cropRect(1040, 1000, 1, 1, 0.05), null);
  assert.deepEqual(cropRect(1001, 1000, 1, 1, 0), { x: 0, y: 0, width: 1000, height: 1000 });
});

test('cropRect: centred with floor, portrait and landscape', () => {
  assert.deepEqual(cropRect(1000, 1001, 1, 1, 0), { x: 0, y: 0, width: 1000, height: 1000 });
  assert.deepEqual(cropRect(1000, 1003, 1, 1, 0), { x: 0, y: 1, width: 1000, height: 1000 });
  assert.deepEqual(cropRect(1086, 1448, 1, 4), { x: 362, y: 0, width: 362, height: 1448 });
  assert.deepEqual(cropRect(1024, 1536, 9, 16), { x: 80, y: 0, width: 864, height: 1536 });
});

test('cropRect: unreduced ratios give the same rectangle', () => {
  assert.deepEqual(cropRect(1983, 793, 400, 100), cropRect(1983, 793, 4, 1));
  assert.deepEqual(cropRect(1254, 1254, 32, 18), cropRect(1254, 1254, 16, 9));
});

test('cropRect: tiny images and bad input', () => {
  assert.deepEqual(cropRect(2, 1, 1, 1), { x: 0, y: 0, width: 1, height: 1 });
  assert.deepEqual(cropRect(15, 10, 16, 9), { x: 0, y: 1, width: 15, height: 8 });
  // Rounding gives the image back (17 * 9 / 16 = 9.56), or a side of 0: nothing to crop.
  assert.equal(cropRect(17, 10, 16, 9), null);
  assert.equal(cropRect(1, 1, 100, 99, 0), null);
  assert.equal(cropRect(10, 1, 1, 4), null);
  for (const args of [[0, 10, 1, 1], [10, 0, 1, 1], [10, 10, 0, 1], [10, 10, 1, 0], [NaN, 10, 1, 1], [10, 10, -1, 1]]) assert.equal(cropRect(...args), null, String(args));
});

test('cropRect: many random cases are w:h to the pixel, centred, maximal and inside the image', () => {
  let seed = 42;
  const rand = n => { seed = (seed * 16807) % 2147483647; return 1 + (seed % n); };
  let cropped = 0;
  for (let i = 0; i < 5000; i++) {
    const width = rand(4000);
    const height = rand(4000);
    const w = rand(100);
    const h = rand(100);
    const r = cropRect(width, height, w, h);
    const wide = width * h > height * w;
    // The side that is cut, rounded to the nearest pixel; the other side stays whole.
    const side = wide ? Math.round((height * w) / h) : Math.round((width * h) / w);
    if (r === null) {
      const within = Math.abs(width * h - height * w) <= TOLERANCE * height * w;
      assert.ok(within || side < 1 || side === (wide ? width : height), `${width}x${height} ${w}:${h}`);
      continue;
    }
    cropped++;
    const label = `${width}x${height} ${w}:${h} -> ${JSON.stringify(r)}`;
    assert.deepEqual([r.width, r.height], wide ? [side, height] : [width, side], label);
    assert.ok(Math.abs(r.width * h - r.height * w) <= (wide ? h : w) / 2, label); // at most half a pixel off w:h
    for (const v of Object.values(r)) assert.ok(Number.isInteger(v), label);
    assert.ok(r.x >= 0 && r.y >= 0 && r.width >= 1 && r.height >= 1, label);
    assert.ok(r.x + r.width <= width && r.y + r.height <= height, label);
    assert.equal(r.x, Math.floor((width - r.width) / 2), label);
    assert.equal(r.y, Math.floor((height - r.height) / 2), label);
  }
  assert.ok(cropped > 4000);
});
