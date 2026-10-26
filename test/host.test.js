'use strict';
// Runs a copy of the native host from a scratch folder (so its data/ and logs/ are scratch too), with
// its images folder there as well, on a private test pipe, and plays the Chrome extension over its
// stdio. The installed bridge, Chrome and the real images folder are never involved. The scratch
// folder stays inside the project (ignored as *.tmp), so the test never deletes anything outside it.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const identity = require('../identity');
const { buildText } = require('../lib/prompt');
const { SHOW_IMAGE, resultLines } = require('../lib/results');
const { MAX_COLLECTION_BYTES } = require('../lib/limits');
const { png } = require('./png-fixture');

const ROOT = path.join(__dirname, '..');
const TAG = `backdraw-host-test-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
const PIPE = process.platform === 'win32' ? `\\\\.\\pipe\\${TAG}` : path.join(os.tmpdir(), `${TAG}.sock`);
const DIR = path.join(ROOT, `.${TAG}.tmp`);
const IMAGES = path.join(DIR, 'images');
const REFS = path.join(DIR, 'refs');
const PROJECT = { id: 'g-p-67a1b2c3d4e5f60718293a4b5c6d7e8f', name: 'Images', url: 'https://chatgpt.com/g/g-p-67a1b2c3d4e5f60718293a4b5c6d7e8f/project' };
const CHAT_URL = 'https://chatgpt.com/g/g-p-67a1b2c3d4e5f60718293a4b5c6d7e8f/c/6812a3b4-1c2d-8000-9e8f-0123456789ab';

fs.mkdirSync(DIR);
for (const f of ['host.js', 'shared.js', 'identity.js', 'package.json', 'lib', 'platform']) fs.cpSync(path.join(ROOT, f), path.join(DIR, f), { recursive: true });
fs.mkdirSync(path.join(DIR, 'data'));
fs.writeFileSync(path.join(DIR, 'data', 'config.json'), JSON.stringify({ outputDir: IMAGES, collectionsDir: REFS, project: PROJECT }));

const child = spawn(process.execPath, [path.join(DIR, 'host.js')], { cwd: DIR, env: { ...process.env, [identity.PIPE_ENV]: PIPE }, stdio: ['pipe', 'pipe', 'ignore'] });
const exited = new Promise(resolve => child.once('exit', resolve));
test.after(async () => {
  child.stdin.end(); // Chrome closing the connection stops the host
  await exited;
  fs.rmSync(DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------- Chrome's side (native messaging)

const fromHost = [];
let out = Buffer.alloc(0);
child.stdout.on('data', chunk => {
  out = Buffer.concat([out, chunk]);
  while (out.length >= 4 && out.length >= 4 + out.readUInt32LE(0)) {
    const size = out.readUInt32LE(0);
    fromHost.push(JSON.parse(out.subarray(4, 4 + size).toString('utf8')));
    out = out.subarray(4 + size);
  }
});

function toHost(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  child.stdin.write(Buffer.concat([head, body]));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, what, timeoutMs = 5000) {
  for (const start = Date.now(); ; await sleep(20)) {
    const v = check();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
  }
}
const nextFromHost = type => until(() => { const i = fromHost.findIndex(m => m.type === type); return i >= 0 && fromHost.splice(i, 1)[0]; }, type);

// ---------------------------------------------------------------- the pipe (MCP server / CLI side)

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PIPE);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('error', reject);
    sock.on('connect', () => sock.write(JSON.stringify({ id: 1, method, params }) + '\n'));
    sock.on('data', chunk => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      sock.destroy();
      const msg = JSON.parse(buf.slice(0, nl));
      if (msg.error) reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      else resolve(msg.result);
    });
  });
}

async function finished(jobId) {
  for (const start = Date.now(); Date.now() - start < 5000; await sleep(30)) {
    const job = await call('job', { jobId });
    if (!['queued', 'running'].includes(job.status)) return job;
  }
  throw new Error(`job ${jobId} did not finish`);
}

const b64 = buf => buf.toString('base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);

test('the host', async t => {
  await until(() => fs.existsSync(path.join(DIR, 'data', 'jobs.json')), 'the host to start');
  for (let i = 0; ; i++) {
    try { await call('status'); break; } catch (e) { if (i > 100) throw e; await sleep(50); }
  }
  toHost({ type: 'hello', version: 'test' });
  assert.equal((await nextFromHost('welcome')).project.url, PROJECT.url);

  await t.test('older images are moved into the images folder once, then never again', () => {
    // Changing the images folder later must not copy the whole history into the new folder.
    assert.equal(JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'config.json'), 'utf8')).imagesCentralized, true);
  });

  await t.test('a bad aspect_ratio is refused before a job exists', async () => {
    await assert.rejects(call('generate', { prompt: 'x', aspect: '9:1' }), { code: 'BAD_REQUEST', message: /aspect_ratio 9:1 is outside the supported range 1:4 to 4:1/ });
    await assert.rejects(call('generate', { prompt: 'x', aspect: '1.5:1' }), { code: 'BAD_REQUEST', message: /use 3:2 instead/ });
    assert.deepEqual((await call('status')).queued, []);
  });

  await t.test('aspect + transparent: the run message, then both files saved for each cropped image', async () => {
    const legacy = path.join(DIR, 'legacy-out');
    const job = await call('generate', { prompt: 'A wide banner', aspect: '4:1', transparent: true, outputDir: legacy });
    assert.equal(job.aspect, '4:1');
    assert.equal(job.transparent, true);
    const { job: run } = await nextFromHost('run');
    assert.equal(run.id, job.id);
    assert.deepEqual(run.aspect, { w: 4, h: 1, label: '4:1' });
    assert.equal(run.transparent, true);
    assert.match(run.text, /\n\nA wide banner\n\nAspect ratio: make the image 3:1 \(landscape\)\. It will be cropped from the centre to exactly 4:1 afterwards, /);
    assert.match(run.text, /\nBackground: fully transparent \(PNG with an alpha channel\)\./);

    const original = png(2, { width: 1983, height: 793 });
    const cropped = png(6, { width: 1983, height: 496 });
    toHost({
      type: 'result', jobId: job.id, ok: true, status: 'succeeded', conversationUrl: CHAT_URL, title: 'Banner',
      images: [
        { data: b64(original), mime: 'image/png', width: 1983, height: 793, preview: b64(Buffer.from('preview-1')),
          crop: { data: b64(cropped), mime: 'image/png', width: 1983, height: 496 }, alpha: { transparentShare: 0, opaqueShare: 1 } },
        { data: b64(JPEG), mime: 'image/jpeg', width: 1983, height: 793, preview: null,
          crop: { data: b64(cropped), mime: 'image/png', width: 1983, height: 496 }, alpha: { transparentShare: 0, opaqueShare: 1 } },
      ],
    });
    const done = await finished(job.id);
    assert.equal(done.status, 'succeeded');
    const [a, b] = done.images;
    assert.equal(path.dirname(a.path), IMAGES);
    assert.match(path.basename(a.path), /^\d{8}-\d{6}_a-wide-banner-1\.png$/);
    assert.equal(a.full.path, a.path.replace(/\.png$/, '_full.png'));
    assert.deepEqual(fs.readFileSync(a.path), cropped);
    assert.deepEqual(fs.readFileSync(a.full.path), original);
    assert.deepEqual({ ...a, path: 0, preview: 0, full: { ...a.full, path: 0 } }, {
      path: 0, width: 1983, height: 496, bytes: cropped.length, preview: 0,
      full: { path: 0, width: 1983, height: 793, bytes: original.length },
      aspect: '4:1', png: { colorType: 2, alphaChannel: false, trns: false }, alpha: { transparentShare: 0, opaqueShare: 1 },
    });
    assert.equal(fs.readFileSync(a.preview, 'utf8'), 'preview-1');
    // ChatGPT's JPEG keeps its own extension; the crop is a PNG.
    assert.match(path.basename(b.path), /-2\.png$/);
    assert.equal(b.full.path, b.path.replace(/\.png$/, '_full.jpg'));
    assert.deepEqual(fs.readFileSync(b.full.path), JPEG);
    assert.equal(b.png, null);
    assert.equal(b.preview, null);
    // The legacy output_dir copy is the cropped main file only.
    assert.deepEqual(done.copies.map(c => path.relative(legacy, c)), [path.basename(a.path), path.basename(b.path)]);
    assert.deepEqual(fs.readFileSync(done.copies[0]), cropped);

    const lines = resultLines(done);
    assert.ok(lines.includes(`Saved: ${a.path} (1983x496, cropped from the centre to 4:1)`));
    assert.ok(lines.includes(`Full image before cropping: ${a.full.path} (1983x793)`));
    // ChatGPT's 5:2 instead of the 3:1 it was asked for: the crop cut more than the prompt allowed.
    assert.ok(lines.some(l => l.startsWith('⚠ ChatGPT drew 1983x793 instead of 3:1, so the crop removed 37.5% of the height')));
    assert.ok(lines.some(l => /^⚠ TRANSPARENT BACKGROUND MISSING: ChatGPT returned an image without an alpha channel \(RGB PNG\)/.test(l)));
    assert.ok(lines.some(l => /without an alpha channel \(JPEG\)/.test(l)));
  });

  await t.test('without the new options nothing changes: same message, one file, no extra fields set', async () => {
    const job = await call('generate', { prompt: 'A void mage' });
    const { job: run } = await nextFromHost('run');
    assert.equal(run.text, buildText({ prompt: 'A void mage', startUrl: PROJECT.url, references: [] }));
    assert.equal(run.aspect, null);
    assert.equal(run.transparent, false);
    const image = png(6, { width: 1254, height: 1254 });
    toHost({ type: 'result', jobId: job.id, ok: true, status: 'succeeded', images: [{ data: b64(image), mime: 'image/png', width: 1254, height: 1254, preview: null }] });
    const done = await finished(job.id);
    assert.equal(done.aspect, null);
    assert.equal(done.transparent, false);
    assert.equal(done.images.length, 1);
    const [im] = done.images;
    assert.deepEqual({ ...im, path: 0 }, {
      path: 0, width: 1254, height: 1254, bytes: image.length, preview: null, full: null, aspect: null,
      png: { colorType: 6, alphaChannel: true, trns: false }, alpha: null,
    });
    assert.deepEqual(fs.readFileSync(im.path), image);
    assert.deepEqual(resultLines(done).slice(1), [`Saved: ${im.path} (1254x1254)`, SHOW_IMAGE]);
  });

  await t.test('an aspect ratio that was already right: no crop, one file', async () => {
    const job = await call('generate', { prompt: 'A landscape', aspect: '16:9' });
    await nextFromHost('run');
    const image = png(2, { width: 1672, height: 941 });
    toHost({ type: 'result', jobId: job.id, ok: true, status: 'succeeded', images: [{ data: b64(image), mime: 'image/png', width: 1672, height: 941, crop: null }] });
    const [im] = (await finished(job.id)).images;
    assert.equal(im.full, null);
    assert.equal(im.aspect, '16:9');
    assert.deepEqual(resultLines(await call('job', { jobId: job.id })).slice(-2), ['Aspect ratio: 16:9 requested, got 1672x941 (within 1%, not cropped).', SHOW_IMAGE]);
  });

  await t.test('send_as_is: the text stays verbatim even with aspect and transparency', async () => {
    const job = await call('generate', { prompt: 'Yes, go ahead.', sendAsIs: true, aspect: '16:9', transparent: true, startUrl: CHAT_URL });
    const { job: run } = await nextFromHost('run');
    assert.equal(run.text, 'Yes, go ahead.');
    assert.deepEqual(run.aspect, { w: 16, h: 9, label: '16:9' });
    toHost({ type: 'result', jobId: job.id, ok: false, status: 'cancelled' });
    assert.equal((await finished(job.id)).status, 'cancelled');
  });

  await t.test('collect mode: no text, but the crop target goes along', async () => {
    const job = await call('generate', { mode: 'collect', startUrl: CHAT_URL, aspect: '1920x1080' });
    const { job: run } = await nextFromHost('run');
    assert.equal(run.mode, 'collect');
    assert.equal(run.text, '');
    assert.deepEqual(run.aspect, { w: 16, h: 9, label: '16:9' });
    assert.equal(run.transparent, false);
    toHost({ type: 'result', jobId: job.id, ok: false, status: 'failed', error: 'test over' });
    assert.equal((await finished(job.id)).status, 'failed');
  });

  // reveal_image is only ever called where it must fail: a real file would open Explorer.
  await t.test('gallery: list, preview, add to a collection, all by job id and number only', async () => {
    const job = await call('generate', { prompt: 'A gallery cat' });
    await nextFromHost('run');
    const image = png(2, { width: 900, height: 600 });
    toHost({ type: 'result', jobId: job.id, ok: true, status: 'succeeded', conversationUrl: CHAT_URL, images: [{ data: b64(image), mime: 'image/png', width: 900, height: 600, preview: b64(JPEG) }] });
    const done = await finished(job.id);
    const saved = done.images[0].path;

    const list = await call('gallery_list', { offset: 0, limit: 100 });
    assert.equal(list.total, 5); // the banner's two images, the void mage, the landscape and this one
    assert.deepEqual(list.items[0], {
      jobId: job.id, n: 1, createdAt: done.createdAt, prompt: 'A gallery cat', conversationUrl: CHAT_URL, path: saved,
      width: 900, height: 600, aspect: null, preview: true, missing: false,
    });
    assert.deepEqual(list.items.slice(3).map(x => [x.n, x.aspect, x.prompt]), [[1, '4:1', 'A wide banner'], [2, '4:1', 'A wide banner']]);
    assert.deepEqual(await call('gallery_thumb', { jobId: job.id, n: 1 }), { data: b64(JPEG), mime: 'image/jpeg' });
    assert.deepEqual(await call('gallery_thumb', { jobId: list.items[3].jobId, n: 1 }), { data: null, mime: null }); // its preview is no JPEG

    // The extension asks the same over its native port.
    toHost({ type: 'call', reqId: 'g1', method: 'gallery_list', params: { offset: 1, limit: 2 } });
    const page = await nextFromHost('reply');
    assert.deepEqual([page.reqId, page.ok, page.result.total, page.result.next, page.result.items.length], ['g1', true, 5, 3, 2]);

    toHost({ type: 'call', reqId: 'g2', method: 'collection_add_job_image', params: { collection: 'Gallery picks', create: true, jobId: job.id, n: 1, path: path.join(DIR, 'host.js') } });
    const added = await nextFromHost('reply');
    assert.equal(added.ok, true, added.error);
    assert.deepEqual({ ...added.result, file: 0 }, { name: 'Gallery picks', folder: 'Gallery picks', file: 0, count: 1, created: true, duplicate: false });
    assert.equal(added.result.file, `001_${path.basename(saved, '.png').replace(/_/g, '-')}.png`);
    assert.deepEqual(fs.readFileSync(path.join(REFS, 'Gallery picks', added.result.file)), image);
    assert.deepEqual(fs.readFileSync(path.join(REFS, 'Gallery picks', 'thumbs', `${added.result.file}.jpg`)), JPEG);
    const manifest = JSON.parse(fs.readFileSync(path.join(REFS, 'Gallery picks', 'collection.json'), 'utf8'));
    assert.deepEqual([manifest.images[0].sourceUrl, manifest.images[0].pageUrl], [CHAT_URL, CHAT_URL]);
    assert.deepEqual((await nextFromHost('collections')).collections, [{ name: 'Gallery picks', count: 1 }]);
    const again = await call('collection_add_job_image', { collection: 'gallery picks', jobId: job.id, n: 1 });
    assert.deepEqual([again.duplicate, again.count], [true, 1]);
    await assert.rejects(call('collection_add_job_image', { collection: 'Nope', jobId: job.id, n: 1 }), { code: 'NOT_FOUND' });

    // Never a path: an unknown job, a string number or a path alone find nothing.
    for (const p of [{ jobId: 'img_00000000', n: 1 }, { jobId: job.id, n: '1' }, { jobId: job.id, n: 2 }, { path: saved }, { jobId: saved, n: 1 }]) {
      for (const method of ['reveal_image', 'gallery_thumb', 'collection_add_job_image']) {
        await assert.rejects(call(method, { collection: 'Gallery picks', ...p }), { code: 'NOT_FOUND', message: 'That image is not in the gallery any more.' }, `${method} ${JSON.stringify(p)}`);
      }
    }
    // A file that grew past the collection limit is refused before it is read.
    fs.truncateSync(saved, MAX_COLLECTION_BYTES + 1);
    await assert.rejects(call('collection_add_job_image', { collection: 'Gallery picks', jobId: job.id, n: 1 }), { code: 'TOO_LARGE', message: 'The image is larger than 25 MB.' });
    // A file deleted by hand is marked in the list and refused.
    fs.unlinkSync(saved);
    assert.equal((await call('gallery_list', { limit: 1 })).items[0].missing, true);
    for (const method of ['reveal_image', 'collection_add_job_image']) {
      await assert.rejects(call(method, { collection: 'Gallery picks', jobId: job.id, n: 1 }), { code: 'NOT_FOUND', message: `The image file was moved or deleted: ${saved}` }, method);
    }
    toHost({ type: 'call', reqId: 'g3', method: 'reveal_image', params: { jobId: job.id, n: 1 } });
    assert.deepEqual(await nextFromHost('reply'), { type: 'reply', reqId: 'g3', ok: false, error: `The image file was moved or deleted: ${saved}`, code: 'NOT_FOUND' });
  });

  await t.test('filenameHint names the saved file instead of the prompt; a blank one is ignored', async () => {
    const saved = async params => {
      const job = await call('generate', params);
      await nextFromHost('run');
      toHost({ type: 'result', jobId: job.id, ok: true, status: 'succeeded', images: [{ data: b64(png(6, { width: 1254, height: 1254 })), mime: 'image/png', width: 1254, height: 1254 }] });
      return path.basename((await finished(job.id)).images[0].path);
    };
    const prompt = 'Ekteki referans görselleri incele ve aynı tarzda bir tilki maskotu çiz';
    assert.match(await saved({ prompt, filenameHint: '  Kırmızı tilki maskotu  ' }), /^\d{8}-\d{6}_kirmizi-tilki-maskotu\.png$/);
    assert.match(await saved({ prompt, filenameHint: '   ' }), /^\d{8}-\d{6}_ekteki-referans-gorselleri-incele-ve-ayni-tarzda\.png$/);
  });
});
