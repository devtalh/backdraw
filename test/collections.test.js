'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const c = require('../lib/collections');

const ROOT = path.join(path.sep, 'refs');
const im = (file, addedAt, extra) => ({ file, addedAt, ...extra });

test('safeFolderName: traversal attempts never leave a separator or a leading dot', () => {
  assert.equal(c.safeFolderName('..'), 'collection');
  assert.equal(c.safeFolderName('.'), 'collection');
  assert.equal(c.safeFolderName('../x'), 'x');
  assert.equal(c.safeFolderName('..\\..\\Windows'), 'Windows');
  assert.equal(c.safeFolderName('a/b'), 'ab');
  assert.equal(c.safeFolderName('C:\\Users\\x'), 'CUsersx');
  assert.equal(c.safeFolderName('/etc/passwd'), 'etcpasswd');
  for (const name of ['..', '../x', 'a/b', '..\\..\\x', '/abs', 'C:\\abs', '\\\\server\\share', '....', '. .']) {
    const folder = c.safeFolderName(name);
    assert.doesNotMatch(folder, /[\\/:]|^\.|\.$/, name);
    assert.ok(c.isInside(ROOT, path.join(ROOT, folder)), name);
  }
});

test('safeFolderName: Windows-forbidden and control characters are removed, spaces collapsed', () => {
  assert.equal(c.safeFolderName('a<b>c:d"e|f?g*h'), 'abcdefgh');
  assert.equal(c.safeFolderName('tab\there\nnew\u0000line\u001f'), 'tab here newline');
  assert.equal(c.safeFolderName('  many    spaces  '), 'many spaces');
  assert.equal(c.safeFolderName('trailing dots...'), 'trailing dots');
  assert.equal(c.safeFolderName('  '), 'collection');
  assert.equal(c.safeFolderName(''), 'collection');
  assert.equal(c.safeFolderName(undefined), 'collection');
  assert.equal(c.safeFolderName('???'), 'collection');
});

test('safeFolderName: device names get a suffix, also with an extension', () => {
  assert.equal(c.safeFolderName('CON'), 'CON_');
  assert.equal(c.safeFolderName('con'), 'con_');
  assert.equal(c.safeFolderName('Nul'), 'Nul_');
  assert.equal(c.safeFolderName('COM1'), 'COM1_');
  assert.equal(c.safeFolderName('lpt9'), 'lpt9_');
  assert.equal(c.safeFolderName('con.txt'), 'con_.txt');
  assert.equal(c.safeFolderName('AUX .png'), 'AUX_ .png');
  assert.equal(c.safeFolderName('CONIN$'), 'CONIN$_');
  assert.equal(c.safeFolderName('conout$'), 'conout$_');
  assert.equal(c.safeFolderName('Clock$.x'), 'Clock$_.x');
  assert.equal(c.safeFolderName('Console'), 'Console');
  assert.equal(c.safeFolderName('COM10'), 'COM10');
  assert.equal(c.safeFolderName('Prints'), 'Prints');
});

test('safeFolderName: emoji and Turkish letters are kept; long names are cut at 64 code points', () => {
  assert.equal(c.safeFolderName('🐉 Ejderhalar'), '🐉 Ejderhalar');
  assert.equal(c.safeFolderName('Çiçek Işığı'), 'Çiçek Işığı');
  assert.equal(c.safeFolderName('🐱'), '🐱');
  const long = c.safeFolderName('x'.repeat(300));
  assert.equal(long, 'x'.repeat(64));
  const emoji = c.safeFolderName('🐱'.repeat(100));
  assert.equal(Array.from(emoji).length, 64);
  assert.equal(emoji, '🐱'.repeat(64)); // never half a surrogate pair
  assert.equal(c.safeFolderName(`${'a'.repeat(63)}.b`), 'a'.repeat(63)); // the cut leaves a trailing dot: stripped
});

test('validateName: 1 to 64 visible characters after trimming', () => {
  assert.deepEqual(c.validateName('  Cats  '), { name: 'Cats' });
  assert.deepEqual(c.validateName('a\u0000b\n c'), { name: 'ab c' });
  assert.deepEqual(c.validateName('../x'), { name: '../x' }); // a name may say anything; only its folder is sanitized
  assert.match(c.validateName('   ').error, /empty/);
  assert.match(c.validateName('\u0000\u0007').error, /empty/);
  assert.match(c.validateName(undefined).error, /empty/);
  assert.deepEqual(c.validateName('🐱'.repeat(64)), { name: '🐱'.repeat(64) });
  assert.match(c.validateName('🐱'.repeat(65)).error, /longer than 64/);
  assert.match(c.validateName('x'.repeat(65)).error, /longer than 64/);
});

test('isInside: only paths strictly below the root', () => {
  assert.ok(c.isInside(ROOT, path.join(ROOT, 'a')));
  assert.ok(c.isInside(ROOT, path.join(ROOT, 'a', 'b.png')));
  assert.ok(c.isInside(ROOT, path.join(ROOT, '..a'))); // a folder named "..a" is still inside
  assert.ok(!c.isInside(ROOT, ROOT));
  assert.ok(!c.isInside(ROOT, path.join(ROOT, '..')));
  assert.ok(!c.isInside(ROOT, path.join(ROOT, '..', 'x')));
  assert.ok(!c.isInside(ROOT, path.join(ROOT, 'a', '..', '..', 'x')));
  assert.ok(!c.isInside(ROOT, path.join(path.sep, 'refsX', 'a')));
  if (process.platform === 'win32') assert.ok(!c.isInside('C:\\refs', 'D:\\refs\\a'));
});

test('isPlainFile: bare file names only', () => {
  for (const ok of ['001_cat.png', 'a.jpg', 'ünïcödé.webp']) assert.ok(c.isPlainFile(ok), ok);
  for (const bad of ['', '.', '..', '../x.png', 'a/b.png', 'a\\b.png', 'C:x.png', 'x.png.', 'x ', 'a\u0000.png', 'x'.repeat(201), 'CON.png', 'nul', 'conin$.jpg', null, 5]) {
    assert.ok(!c.isPlainFile(bad), String(bad));
  }
});

test('findCollection: exact, then ignoring case, then loosely; ties are reported', () => {
  const list = [{ name: 'Cats' }, { name: 'cats' }, { name: 'Dragon Refs' }, { name: 'İstanbul' }, { name: '🐱' }];
  assert.equal(c.findCollection(list, 'Cats').collection, list[0]);
  assert.equal(c.findCollection(list, 'cats').collection, list[1]);
  assert.deepEqual(c.findCollection(list, 'CATS'), { error: 'AMBIGUOUS', ties: [list[0], list[1]] });
  assert.equal(c.findCollection(list, 'dragon refs').collection, list[2]);
  assert.equal(c.findCollection(list, 'dragon-refs').collection, list[2]);
  assert.equal(c.findCollection(list, 'dragon-refs', { loose: false }).error, 'NOT_FOUND');
  assert.equal(c.findCollection(list, 'istanbul').collection, list[3]);
  assert.equal(c.findCollection(list, ' 🐱 ').collection, list[4]);
  // An emoji-only name has no loose form, so it can't match every other emoji-only name.
  assert.equal(c.findCollection([{ name: '🐶' }], '🐱').error, 'NOT_FOUND');
  assert.equal(c.findCollection(list, '').error, 'NOT_FOUND');
  assert.equal(c.findCollection([], 'x').error, 'NOT_FOUND');
});

test('pickRefs: newest first up to the limit', () => {
  const images = [im('001_a.png', '2026-01-01T00:00:00Z'), im('002_b.png', '2026-01-03T00:00:00Z'), im('003_c.png', '2026-01-02T00:00:00Z')];
  assert.deepEqual(c.pickRefs(images, 2).used.map(x => x.file), ['002_b.png', '003_c.png']);
  assert.deepEqual(c.pickRefs(images, 16).used.map(x => x.file), ['002_b.png', '003_c.png', '001_a.png']);
  assert.deepEqual(c.pickRefs(images, 0).used, []);
  assert.deepEqual(c.pickRefs(images, -3).used, []);
  // The same time: the one added later (further down the manifest) counts as newer.
  const same = [im('001_a.png', 'T'), im('002_b.png', 'T')];
  assert.deepEqual(c.pickRefs(same, 1).used.map(x => x.file), ['002_b.png']);
});

test('pickRefs: an explicit choice wins, in its order; unknown names are reported', () => {
  const images = [im('001_a.png', '1'), im('002_b.png', '2'), im('003_c.png', '3')];
  assert.deepEqual(c.pickRefs(images, 16, ['001_a.png', '003_c.png']), { used: [images[0], images[2]], unknown: [] });
  assert.deepEqual(c.pickRefs(images, 16, ['003_C.PNG', 'C:\\x\\001_a.png', '../002_b.png']).used.map(x => x.file), ['003_c.png', '001_a.png', '002_b.png']);
  assert.deepEqual(c.pickRefs(images, 16, ['001_a.png', '001_A.png']).used, [images[0]]);
  assert.deepEqual(c.pickRefs(images, 1, ['003_c.png', '002_b.png']).used, [images[2]]);
  assert.deepEqual(c.pickRefs(images, 16, ['nope.png', '002_b.png']), { used: [images[1]], unknown: ['nope.png'] });
  assert.deepEqual(c.pickRefs(images, 2, ['', '  ']).used.map(x => x.file), ['003_c.png', '002_b.png']); // nothing picked
});

test('fileNameFor: number, slug of the source file name, extension from the bytes', () => {
  assert.equal(c.fileNameFor(1, 'https://example.com/img/Kedi%20Fotoğrafı.JPEG?x=1', 'jpg'), '001_kedi-fotografi.jpg');
  assert.equal(c.fileNameFor(12, 'https://pbs.example.com/media/Fxyz?format=jpg&name=large', 'webp'), '012_fxyz.webp');
  assert.equal(c.fileNameFor(1234, 'https://example.com/', 'png'), '1234_image.png');
  assert.equal(c.fileNameFor(3, 'data:image/png;base64,AAAA', 'png'), '003_image.png');
  assert.equal(c.fileNameFor(3, 'blob:https://example.com/0f1e', 'gif'), '003_image.gif');
  assert.equal(c.fileNameFor(3, 'https://example.com/%E0%A4%A', 'png'), '003_image.png'); // malformed escape
  assert.equal(c.fileNameFor(3, 'not a url', 'png'), '003_image.png');
  // The extension is never taken from the URL, and only known image types are used.
  assert.equal(c.fileNameFor(4, 'https://example.com/evil.exe', 'exe'), '004_evil.png');
  assert.equal(c.fileNameFor(5, 'https://example.com/..%2F..%2Fx.png', 'png'), '005_x.png');
  assert.ok(c.isPlainFile(c.fileNameFor(6, `https://example.com/${'%2F..'.repeat(50)}`, 'png')));
});

test('the extension may only call the collection, gallery and chat cleanup methods', () => {
  assert.deepEqual([...c.EXTENSION_METHODS].sort(), [
    'chat_cleanup_check', 'chat_cleanup_list', 'chat_cleanup_mark',
    'collection_add', 'collection_add_job_image', 'collection_thumbs', 'delete_collection', 'delete_collection_image',
    'gallery_animation', 'gallery_list', 'gallery_thumb', 'list_collections', 'rename_collection', 'reveal_image',
  ]);
  for (const m of ['generate', 'diagnose', 'set_config', 'select_project', 'reload_extension', 'cancel', 'mark_copied', 'status']) {
    assert.ok(!c.EXTENSION_METHODS.has(m), m);
  }
});

test('describeCollections: names, counts, folders, files with their site, and how to use them', () => {
  assert.match(c.describeCollections([], 16), /^No reference collections yet\./);
  const text = c.describeCollections([{
    name: 'Cats', count: 2, path: 'C:\\refs\\Cats',
    images: [
      { file: '002_b.png', pageUrl: 'https://www.example.com/page', sourceUrl: 'https://cdn.example.net/b.png', width: 10, height: 20, addedAt: '2026-01-02T03:04:05Z' },
      { file: '001_a.png', pageUrl: null, sourceUrl: 'data:image/png;base64,', addedAt: null },
    ],
  }], 16, 1);
  assert.match(text, /^Reference collections \(1, most recently changed first\):$/m);
  assert.match(text, /^- "Cats": 2 image\(s\), folder C:\\refs\\Cats$/m);
  assert.match(text, /^ {2}- 002_b\.png \(example\.com, 10x20, added 2026-01-02\)$/m);
  assert.match(text, /^ {2}- … 1 more in the folder$/m);
  assert.match(text, /reference_collection="<name>"/);
  assert.match(text, /up to 16 references in total/);
  assert.match(c.describeCollections([{ name: 'X', count: 1, path: 'p', images: [{ file: 'f.png', sourceUrl: 'data:' }] }], 16), /f\.png \(data, added \?\)/);
});
