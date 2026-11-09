'use strict';
// The side panel gallery on the host's side: lib/gallery.js, the host's own file name for an image
// added from the gallery, and platform revealInFolder (with a stand-in for spawn: Explorer never opens).
// The scratch folder stays inside the project (ignored as *.tmp).
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const g = require('../lib/gallery');
const c = require('../lib/collections');
const store = require('../lib/collection-store');
const { gif } = require('./gif-fixture');
const { png } = require('./png-fixture');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, `.backdraw-gallery-test-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
fs.mkdirSync(DIR);
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const abs = name => path.join(DIR, name);
const job = (id, status, images, extra) => ({ id, status, prompt: `prompt of ${id}`, createdAt: `2026-10-0${id.slice(-1)}T10:00:00.000Z`, conversationUrl: `https://chatgpt.com/c/${id}`, images, ...extra });
const im = (name, extra) => ({ path: abs(name), width: 1024, height: 1536, preview: abs(`${name}.jpg`), aspect: null, ...extra });

const JOBS = [
  job('img_00000001', 'succeeded', [im('a1.png')]),
  job('img_00000002', 'failed', [im('b1.png')]),
  // 1024x1536 does not match the requested 4:1 and there is no cropped original, so it was not applied.
  job('img_00000003', 'succeeded', [im('c1.png', { aspect: '4:1', preview: null }), { path: 'relative.png' }, null, im('c4.png')]),
  job('img_00000004', 'text_reply', []),
  job('img_00000005', 'succeeded', [im('e1.png')], { prompt: '' }),
];

test('listGallery: succeeded jobs only, newest first, a job\'s images in order, numbered from 1', () => {
  const page = g.listGallery(JOBS, 0, 12);
  assert.equal(page.total, 4);
  assert.equal(page.next, null);
  assert.deepEqual(page.items.map(x => `${x.jobId}:${x.n}`), ['img_00000005:1', 'img_00000003:1', 'img_00000003:4', 'img_00000001:1']);
  assert.deepEqual(page.items[1], {
    jobId: 'img_00000003', n: 1, createdAt: '2026-10-03T10:00:00.000Z', prompt: 'prompt of img_00000003',
    conversationUrl: 'https://chatgpt.com/c/img_00000003', path: abs('c1.png'), width: 1024, height: 1536,
    format: 'PNG', frames: null, durationMs: null, aspect: null, preview: false,
  });
  assert.equal(page.items[0].prompt, '');
  assert.equal(page.items[2].preview, true);
  // A malformed entry keeps its place: n is always the index in job.images plus one.
  assert.equal(g.findJobImage(JOBS, 'img_00000003', 4).image.path, abs('c4.png'));
});

test('listGallery: format comes only from the file extension; GIF details are validated independently', () => {
  const images = [
    im('a.PNG'), im('b.jpg'), im('c.JPEG'), im('d.webp'),
    im('e.gif', { gif: { frames: 12, durationMs: 1400 } }),
    im('old.gif'), im('f.bmp'), im('no-extension'),
    im('bad.gif', { gif: { frames: 0, durationMs: -1 } }),
    im('mixed.gif', { gif: { frames: 3, durationMs: '600' } }),
    im('zero.gif', { gif: { frames: '3', durationMs: 0 } }),
    im('odd.gif', { gif: true }),
  ];
  const items = g.listGallery([job('img_formats', 'succeeded', images)]).items;
  assert.deepEqual(items.map(x => x.format), ['PNG', 'JPG', 'JPG', 'WEBP', 'GIF', 'GIF', null, null, 'GIF', 'GIF', 'GIF', 'GIF']);
  assert.deepEqual(items.map(x => [x.frames, x.durationMs]), [
    [null, null], [null, null], [null, null], [null, null], [12, 1400], [null, null],
    [null, null], [null, null], [null, null], [3, null], [null, 0], [null, null],
  ]);
});

test('listGallery: aspect is shown only when a valid ratio was actually applied', () => {
  const images = [
    im('cropped.png', { width: 1024, height: 256, aspect: '4:1', full: { path: abs('cropped_full.png') } }),
    im('within.png', { width: 1010, height: 1000, aspect: '1:1' }),
    im('outside.png', { width: 1011, height: 1000, aspect: '1:1' }),
    im('animated.gif', { width: 362, height: 362, aspect: '16:9', gif: { frames: 12, durationMs: 1400 } }),
    im('metadata.png', { width: 1600, height: 900, aspect: '16:9', gif: {} }),
    im('malformed-metadata.png', { width: 1600, height: 900, aspect: '16:9', gif: 0 }),
    im('broken.png', { width: 1600, height: 900, aspect: 'not-a-ratio' }),
  ];
  let page;
  assert.doesNotThrow(() => { page = g.listGallery([job('img_aspects', 'succeeded', images)]); });
  assert.deepEqual(page.items.map(x => x.aspect), ['4:1', '1:1', null, null, null, null, null]);
});

test('listGallery: pages with offset and limit; next is the offset to ask for', () => {
  assert.deepEqual(g.listGallery(JOBS, 0, 2).items.map(x => x.n), [1, 1]);
  assert.equal(g.listGallery(JOBS, 0, 2).next, 2);
  const second = g.listGallery(JOBS, 2, 2);
  assert.deepEqual(second.items.map(x => `${x.jobId}:${x.n}`), ['img_00000003:4', 'img_00000001:1']);
  assert.equal(second.next, null);
  assert.deepEqual(g.listGallery(JOBS, 10, 12), { total: 4, items: [], next: null });
  // Odd values fall back to sane ones; a page is never more than PAGE_MAX.
  assert.equal(g.listGallery(JOBS, -3, 1).items[0].jobId, 'img_00000005');
  assert.equal(g.listGallery(JOBS, 'x', 'y').items.length, 4);
  assert.equal(g.listGallery(JOBS, '1', '2').items[0].jobId, 'img_00000003');
  const many = Array.from({ length: 150 }, (_, i) => job(`img_${String(i).padStart(8, '0')}`, 'succeeded', [im(`m${i}.png`)]));
  assert.equal(g.listGallery(many, 0, 1000).items.length, g.PAGE_MAX);
  assert.equal(g.listGallery(many, 0, 1000).next, g.PAGE_MAX);
  assert.deepEqual(g.listGallery(null), { total: 0, items: [], next: null });
});

test('listGallery: long prompts are cut at 300 characters, never inside an emoji', () => {
  const long = job('img_0000000a', 'succeeded', [im('l.png')], { prompt: `${'🐉'.repeat(299)}ab` });
  const [item] = g.listGallery([long]).items;
  assert.equal(item.prompt, `${'🐉'.repeat(299)}a…`);
  const exact = job('img_0000000b', 'succeeded', [im('x.png')], { prompt: 'p'.repeat(300) });
  assert.equal(g.listGallery([exact]).items[0].prompt, 'p'.repeat(300));
});

test('listGallery: exists() marks the files that are gone, only on the page asked for', () => {
  const asked = [];
  const page = g.listGallery(JOBS, 0, 2, p => { asked.push(p); return p !== abs('e1.png'); });
  assert.deepEqual(page.items.map(x => x.missing), [true, false]);
  assert.deepEqual(asked, [abs('e1.png'), abs('c1.png')]);
  assert.equal('missing' in g.listGallery(JOBS).items[0], false);
});

test('findJobImage: only a known job id and a whole image number, never anything else', () => {
  assert.equal(g.findJobImage(JOBS, 'img_00000001', 1).job.id, 'img_00000001');
  for (const [id, n] of [
    ['img_00000001', 2], ['img_00000001', 0], ['img_00000001', -1], ['img_00000001', 1.5], ['img_00000001', '1'], ['img_00000001', null],
    ['img_00000002', 1], // failed
    ['img_00000003', 2], ['img_00000003', 3], // malformed entries
    ['img_99999999', 1], ['', 1], [null, 1], [{ toString: () => 'img_00000001' }, 1], ['__proto__', 1], ['constructor', 1],
    [abs('a1.png'), 1],
  ]) {
    assert.equal(g.findJobImage(JOBS, id, n), null, `${String(id)} ${String(n)}`);
  }
  assert.equal(g.findJobImage(undefined, 'img_00000001', 1), null);
});

test('readPreview: a JPEG or PNG inside the previews folder only, and not too large for one native message', () => {
  const previews = abs('previews');
  fs.mkdirSync(previews);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 1)]);
  fs.writeFileSync(path.join(previews, 'ok.jpg'), jpeg);
  fs.writeFileSync(path.join(previews, 'png.jpg'), png(2));
  fs.writeFileSync(path.join(previews, 'sheet.png'), png(6));
  fs.writeFileSync(path.join(previews, 'bad.png'), Buffer.from('not PNG'));
  fs.writeFileSync(path.join(previews, 'big.png'), Buffer.concat([png(6), Buffer.alloc(g.MAX_PREVIEW_BYTES)]));
  fs.writeFileSync(path.join(previews, 'big.jpg'), Buffer.concat([jpeg, Buffer.alloc(g.MAX_PREVIEW_BYTES)]));
  fs.writeFileSync(abs('outside.jpg'), jpeg);
  assert.deepEqual(g.readPreview(previews, { preview: path.join(previews, 'ok.jpg') }), { data: jpeg.toString('base64'), mime: 'image/jpeg' });
  assert.deepEqual(g.readPreview(previews, { preview: path.join(previews, 'png.jpg') }), { data: png(2).toString('base64'), mime: 'image/png' });
  assert.deepEqual(g.readPreview(previews, { preview: path.join(previews, 'sheet.png') }), { data: png(6).toString('base64'), mime: 'image/png' });
  for (const preview of [path.join(previews, 'bad.png'), path.join(previews, 'big.png'), path.join(previews, 'big.jpg'), path.join(previews, 'gone.jpg'), abs('outside.jpg'),
    path.join(previews, '..', 'outside.jpg'), previews, 'ok.jpg', null, undefined, 7]) {
    assert.deepEqual(g.readPreview(previews, { preview }), { data: null, mime: null }, String(preview));
  }
  assert.deepEqual(g.readPreview(previews, null), { data: null, mime: null });
  assert.ok(Math.ceil(g.MAX_PREVIEW_BYTES / 3) * 4 + 1000 < 1000000); // lib/extension-calls MAX_REPLY
});

test('readAnimation: a small saved GIF only, never another format or a file over the native-message limit', () => {
  const animation = gif({ frames: [{ delayCs: 4 }, { delayCs: 6 }] });
  const gifFile = abs('animation.gif');
  const pngFile = abs('animation.png');
  const bigFile = abs('big-animation.gif');
  fs.writeFileSync(gifFile, animation);
  fs.writeFileSync(pngFile, png(2));
  fs.writeFileSync(bigFile, Buffer.concat([animation, Buffer.alloc(g.MAX_PREVIEW_BYTES)]));
  assert.deepEqual(g.readAnimation({ path: gifFile }), { data: animation.toString('base64'), mime: 'image/gif' });
  for (const image of [{ path: pngFile }, { path: bigFile }, { path: abs('gone.gif') }, {}, null]) {
    assert.deepEqual(g.readAnimation(image), { data: null, mime: null }, JSON.stringify(image));
  }
});

test('fileExists: files only', () => {
  fs.writeFileSync(abs('here.png'), 'x');
  assert.equal(g.fileExists(abs('here.png')), true);
  assert.equal(g.fileExists(abs('nothere.png')), false);
  assert.equal(g.fileExists(DIR), false);
});

test('an image added from the gallery is named after the host\'s own file name, never the request\'s', () => {
  assert.equal(c.fileNameFor(3, 'https://chatgpt.com/c/6812a3b4-1c2d', 'png', '20261021-034512_a-wide-banner-1'), '003_20261021-034512-a-wide-banner-1.png');
  assert.equal(c.fileNameFor(3, 'https://chatgpt.com/c/6812a3b4-1c2d', 'png'), '003_6812a3b4-1c2d.png');
  assert.equal(c.fileNameFor(4, null, 'jpg', '..\\..\\Windows\\evil.exe'), '004_windows-evil.jpg');
  const root = abs('refs');
  const data = png(6, { width: 8, height: 8 }).toString('base64');
  const r = store.add(root, { collection: 'Picks', create: true, data, sourceUrl: 'https://chatgpt.com/c/abc', fileName: 'from-the-request' },
    new Date('2026-10-21T00:00:00Z'), { fileName: '20261021-034512_a-cat' });
  assert.equal(r.file, '001_20261021-034512-a-cat.png');
  const plain = store.add(root, { collection: 'Picks', data: png(2, { width: 8, height: 8 }).toString('base64'), sourceUrl: 'https://x.example/b.png', fileName: 'from-the-request' });
  assert.equal(plain.file, '002_b.png');
  assert.equal(store.find(root, 'Picks').images.find(x => x.file === r.file).sourceUrl, 'https://chatgpt.com/c/abc');
});

test('revealInFolder: explorer.exe straight, no shell, the path quoted as one argument', () => {
  const win = require('../platform/win32');
  const calls = [];
  let unref = 0;
  const fake = (...args) => { calls.push(args); return { on() {}, unref() { unref++; } }; };
  win.revealInFolder('C:\\Users\\x\\Pictures\\Backdraw\\a, b.png', fake);
  assert.deepEqual(calls, [['explorer.exe', ['/select,', '"C:\\Users\\x\\Pictures\\Backdraw\\a, b.png"'], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }]]);
  assert.equal(unref, 1);
  assert.ok(!('shell' in calls[0][2]));
  for (const bad of ['a.png', 'C:a.png', '..\\a.png', 'C:\\a".png', '', null, undefined, ['C:\\a.png']]) {
    assert.throws(() => win.revealInFolder(bad, fake), /absolute file path/, String(bad));
  }
  assert.equal(calls.length, 1);
});
