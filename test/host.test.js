'use strict';
// Runs a copy of the native host from a scratch folder (so its data/ and logs/ are scratch too), with
// its images folder there as well, on a private test pipe, and plays the Chrome extension over its
// stdio. The installed bridge, Chrome and the real images folder are never involved. The scratch
// folder is created exclusively under the OS temp directory; cleanup removes only that fixture.
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
const { MOTION_NAMES } = require('../lib/motion');
const { SHOW_IMAGE, resultLines } = require('../lib/results');
const { MAX_COLLECTION_BYTES, MAX_ANIMATION_BYTES } = require('../lib/limits');
const { MAX_PREVIEW_BYTES } = require('../lib/gallery');
const { png } = require('./png-fixture');
const { gif } = require('./gif-fixture');

const ROOT = path.join(__dirname, '..');
const TAG = `backdraw-host-test-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
const PIPE = process.platform === 'win32' ? `\\\\.\\pipe\\${TAG}` : path.join(os.tmpdir(), `${TAG}.sock`);
process.env[identity.PIPE_ENV] = PIPE;
const { copyResults } = require('../shared');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), `${TAG}-`));
const IMAGES = path.join(DIR, 'images');
const REFS = path.join(DIR, 'refs');
const PROJECT = { id: 'g-p-67a1b2c3d4e5f60718293a4b5c6d7e8f', name: 'Images', url: 'https://chatgpt.com/g/g-p-67a1b2c3d4e5f60718293a4b5c6d7e8f/project' };
const CHAT_URL = 'https://chatgpt.com/g/g-p-67a1b2c3d4e5f60718293a4b5c6d7e8f/c/6812a3b4-1c2d-8000-9e8f-0123456789ab';

for (const f of ['host.js', 'shared.js', 'identity.js', 'package.json', 'lib', 'platform', 'extension/gifframes.js']) fs.cpSync(path.join(ROOT, f), path.join(DIR, f), { recursive: true });
fs.mkdirSync(path.join(DIR, 'data'));
fs.writeFileSync(path.join(DIR, 'data', 'config.json'), JSON.stringify({ outputDir: IMAGES, collectionsDir: REFS, project: PROJECT }));
// An old history entry has no motion field; both public summary paths should return null.
const LEGACY_JOB_ID = 'img_1e9ac000';
fs.writeFileSync(path.join(DIR, 'data', 'jobs.json'), JSON.stringify([{
  id: LEGACY_JOB_ID, mode: 'generate', prompt: 'An older image', status: 'succeeded', images: [], references: [],
  createdAt: '2026-01-01T00:00:00.000Z', conversationUrl: null,
}]));

const child = spawn(process.execPath, [path.join(DIR, 'host.js')], { cwd: DIR, env: { ...process.env, [identity.PIPE_ENV]: PIPE }, stdio: ['pipe', 'pipe', 'ignore'] });
const exited = new Promise(resolve => child.once('exit', resolve));
test.after(async () => {
  child.stdin.end(); // Chrome closing the connection stops the host
  await exited;
  assert.equal(path.dirname(path.resolve(DIR)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(DIR).startsWith(`${TAG}-`));
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

  await t.test('history entries without motion remain readable as null', async () => {
    assert.equal((await call('job', { jobId: LEGACY_JOB_ID })).motion, null);
    assert.equal((await call('status')).recent.find(j => j.id === LEGACY_JOB_ID).motion, null);
  });

  await t.test('unknown motion and collect with motion are refused before a job exists', async () => {
    const before = JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'jobs.json'), 'utf8')).length;
    for (const motion of ['fly', 'WALK', ' ', 'toString', '__proto__', 7, false, ['walk'], {}]) {
      await assert.rejects(call('generate', { prompt: 'A fox', motion }), {
        code: 'BAD_REQUEST', message: `Unknown motion. Use: ${MOTION_NAMES.join(', ')}.`,
      });
    }
    await assert.rejects(call('generate', { mode: 'collect', startUrl: CHAT_URL, motion: 'walk' }), {
      code: 'BAD_REQUEST', message: 'motion cannot be used when only fetching images.',
    });
    assert.equal(JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'jobs.json'), 'utf8')).length, before);
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
      path: 0, width: 1983, height: 496, bytes: cropped.length, preview: 0, previewFrames: null,
      full: { path: 0, width: 1983, height: 793, bytes: original.length },
      aspect: '4:1', png: { colorType: 2, alphaChannel: false, trns: false }, alpha: { transparentShare: 0, opaqueShare: 1 }, gif: null,
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
      path: 0, width: 1254, height: 1254, bytes: image.length, preview: null, previewFrames: null, full: null, aspect: null,
      png: { colorType: 6, alphaChannel: true, trns: false }, alpha: null, gif: null,
    });
    assert.deepEqual(fs.readFileSync(im.path), image);
    assert.deepEqual(resultLines(done).slice(1), [`Saved: ${im.path} (1254x1254)`, SHOW_IMAGE]);
  });

  await t.test('conversation URLs stay isolated between consecutive jobs', async () => {
    const chatA = 'https://chatgpt.com/g/g-p-67a1b2c3d4e5f60718293a4b5c6d7e8f/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const chatB = 'https://chatgpt.com/g/g-p-67a1b2c3d4e5f60718293a4b5c6d7e8f/c/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const first = await call('generate', { prompt: 'First consecutive job' });
    await nextFromHost('run');
    toHost({ type: 'progress', jobId: first.id, step: 'generating', message: 'Generating', conversationUrl: chatA });
    assert.equal((await call('job', { jobId: first.id })).conversationUrl, chatA);
    toHost({ type: 'result', jobId: first.id, ok: false, status: 'text_reply', error: 'test complete', conversationUrl: chatA });
    assert.equal((await finished(first.id)).conversationUrl, chatA);

    const second = await call('generate', { prompt: 'Second consecutive job' });
    await nextFromHost('run');
    const running = await call('job', { jobId: second.id });
    assert.equal(running.status, 'running');
    assert.equal(running.conversationUrl, null);
    assert.notEqual(running.conversationUrl, chatA);

    toHost({ type: 'progress', jobId: second.id, step: 'generating', message: 'Generating', conversationUrl: chatB });
    const updated = await call('job', { jobId: second.id });
    assert.equal(updated.conversationUrl, chatB);
    assert.notEqual(updated.conversationUrl, chatA);
    toHost({ type: 'result', jobId: second.id, ok: false, status: 'text_reply', error: 'test complete', conversationUrl: chatB });
    assert.equal((await finished(second.id)).conversationUrl, chatB);
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
    const animation = gif({ width: 12, height: 8, frames: [{ delayCs: 4 }, { delayCs: 6 }] });
    toHost({ type: 'result', jobId: job.id, ok: true, status: 'succeeded', conversationUrl: CHAT_URL, images: [
      { data: b64(image), mime: 'image/png', width: 900, height: 600, preview: b64(JPEG) },
      { data: b64(animation), mime: 'image/gif', width: 12, height: 8 },
    ] });
    const done = await finished(job.id);
    const saved = done.images[0].path;

    const list = await call('gallery_list', { offset: 0, limit: 100 });
    assert.equal(list.total, 6); // the banner's two images, the void mage, the landscape and these two
    assert.deepEqual(list.items[0], {
      jobId: job.id, n: 1, createdAt: done.createdAt, prompt: 'A gallery cat', conversationUrl: CHAT_URL, chatState: null, path: saved,
      width: 900, height: 600, format: 'PNG', frames: null, durationMs: null, aspect: null, preview: true, missing: false,
    });
    assert.deepEqual(list.items.slice(4).map(x => [x.n, x.aspect, x.prompt]), [[1, '4:1', 'A wide banner'], [2, '4:1', 'A wide banner']]);
    assert.deepEqual(await call('gallery_thumb', { jobId: job.id, n: 1 }), { data: b64(JPEG), mime: 'image/jpeg' });
    assert.deepEqual(await call('gallery_thumb', { jobId: list.items[4].jobId, n: 1 }), { data: null, mime: null }); // its preview is no JPEG
    assert.deepEqual(await call('gallery_animation', { jobId: job.id, n: 2 }), { data: b64(animation), mime: 'image/gif' });
    assert.deepEqual(await call('gallery_animation', { jobId: job.id, n: 1 }), { data: null, mime: null });

    // The extension asks the same over its native port.
    toHost({ type: 'call', reqId: 'g1', method: 'gallery_list', params: { offset: 1, limit: 2 } });
    const page = await nextFromHost('reply');
    assert.deepEqual([page.reqId, page.ok, page.result.total, page.result.next, page.result.items.length], ['g1', true, 6, 3, 2]);

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
    for (const p of [{ jobId: 'img_00000000', n: 1 }, { jobId: job.id, n: '1' }, { jobId: job.id, n: 3 }, { path: saved }, { jobId: saved, n: 1 }]) {
      for (const method of ['reveal_image', 'gallery_thumb', 'gallery_animation', 'collection_add_job_image']) {
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

  await t.test('motion alone enables animation, survives summaries and storage, without changing the extension protocol', async () => {
    for (const motion of MOTION_NAMES) {
      const refs = [{ name: 'ref.png', mime: 'image/png', data: b64(png(6)) }];
      const references = motion === 'walk' ? refs : [];
      const job = await call('generate', { prompt: 'A pixel fox.', motion, animated: false, references });
      assert.equal(job.motion, motion);
      assert.equal(job.animated, true);
      const { job: run } = await nextFromHost('run');
      assert.equal(run.animated, true);
      assert.equal(Object.hasOwn(run, 'motion'), false);
      assert.equal(run.text, buildText({ prompt: 'A pixel fox.', animated: true, motion, references }));
      const status = await call('status');
      assert.equal(status.running.motion, motion);
      assert.equal(status.recent.find(j => j.id === job.id).motion, motion);
      assert.equal((await call('job', { jobId: job.id })).motion, motion);
      toHost({ type: 'result', jobId: job.id, ok: false, status: 'text_reply' });
      assert.equal((await finished(job.id)).motion, motion);
      const stored = JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'jobs.json'), 'utf8')).find(j => j.id === job.id);
      assert.equal(stored.motion, motion);
      assert.equal(stored.animated, true);
    }
    for (const motion of [undefined, null, '']) {
      const job = await call('generate', { prompt: 'A fox.', motion });
      assert.equal(job.motion, null);
      assert.equal(job.animated, false);
      const { job: run } = await nextFromHost('run');
      assert.equal(run.text, buildText({ prompt: 'A fox.' }));
      toHost({ type: 'result', jobId: job.id, ok: false, status: 'text_reply' });
      await finished(job.id);
    }
  });

  await t.test('animated jobs carry the GIF prompt and retain animatedRetry in job summaries', async () => {
    const job = await call('generate', { prompt: 'A fox waves.', animated: true, aspect: '4:1', transparent: true });
    assert.equal(job.animated, true);
    assert.equal(job.animatedRetry, false);
    const { job: run } = await nextFromHost('run');
    assert.equal(run.animated, true);
    assert.equal(run.text, "Create an animated GIF: A fox waves, one clear motion, still camera, seamless loop. Don't ask follow-up questions; create the GIF directly.");
    const status = await call('status');
    assert.equal(status.running.animated, true);
    assert.equal(status.recent.find(j => j.id === job.id).animated, true);
    toHost({ type: 'result', jobId: job.id, ok: true, status: 'succeeded', animatedRetry: true,
      images: [{ data: b64(gif({ width: 12, height: 8, frames: [{}, {}, {}] })), mime: 'image/gif' }] });
    const done = await finished(job.id);
    assert.equal(done.status, 'succeeded');
    assert.equal(done.animated, true);
    assert.equal(done.animatedRetry, true);
    assert.ok(done.images[0].gif);
    const stored = JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'jobs.json'), 'utf8')).find(j => j.id === job.id);
    assert.equal(stored.animated, true);
    assert.equal(stored.animatedRetry, true);
  });

  await t.test('GIF bytes ignore a crop and keep every frame in the main file and output_dir copy', async () => {
    const legacy = path.join(DIR, 'gif-out');
    const job = await call('generate', { prompt: 'A moving banner', aspect: '4:1', transparent: true, outputDir: legacy });
    await nextFromHost('run');
    const image = gif({ width: 12, height: 8, loop: 0,
      frames: [{ delayCs: 10 }, { delayCs: 20, transparentIndex: 0 }, { delayCs: 30 }] });
    const before = fs.readdirSync(IMAGES);
    toHost({ type: 'result', jobId: job.id, ok: true, status: 'succeeded', images: [{
      data: b64(image), mime: 'image/png', animated: false,
      crop: { data: b64(png(6, { width: 12, height: 3 })), width: 12, height: 3 },
    }] });
    const done = await finished(job.id);
    assert.equal(done.status, 'succeeded');
    assert.equal(done.images.length, 1);
    const [im] = done.images;
    assert.match(im.path, /\.gif$/);
    assert.deepEqual(fs.readFileSync(im.path), image);
    assert.equal(im.full, null);
    assert.equal(im.aspect, '4:1');
    assert.deepEqual([im.width, im.height, im.bytes, im.png, im.alpha], [12, 8, image.length, null, null]);
    assert.deepEqual(fs.readdirSync(IMAGES).filter(f => !before.includes(f)), [path.basename(im.path)]);
    assert.equal(fs.existsSync(im.path.replace(/\.gif$/, '_full.gif')), false);
    assert.deepEqual(im.gif, { frames: 3, durationMs: 600, delaysMs: [100, 200, 300], loop: 0,
      transparent: true, transparentFrames: 1, truncated: false });
    assert.deepEqual(done.copies, [path.join(legacy, path.basename(im.path))]);
    assert.deepEqual(fs.readdirSync(legacy), [path.basename(im.path)]);
    assert.deepEqual(fs.readFileSync(done.copies[0]), image);
    assert.deepEqual(resultLines(done).slice(1, 5), [
      `Saved: ${im.path} (12x8)`,
      'Animated GIF: 3 frames, 600 ms per loop, loops forever; the attached preview shows only the first frame.',
      'Aspect ratio: 4:1 requested; not applied to the animated GIF (cropping would keep only the first frame). Saved at 12x8.',
      'Transparent background: GIF with a transparent color in 1 of 3 frames; how much of it is transparent could not be measured.',
    ]);
    const stored = JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'jobs.json'), 'utf8')).find(j => j.id === job.id);
    assert.equal(stored.status, 'succeeded', 'the completed GIF job must also be persisted as succeeded');
    assert.deepEqual(stored.images[0].gif, im.gif);
    assert.equal(Object.hasOwn(stored, 'gif'), false);
    assert.equal(Object.hasOwn(stored.images[0], 'animated'), false);
  });

  await t.test('GIF metadata keeps only the first 64 delays, all frame totals and extension dimensions', async () => {
    const job = await call('generate', { prompt: 'Many frames' });
    await nextFromHost('run');
    const image = gif({ frames: Array.from({ length: 65 }, () => ({ delayCs: 2 })) }).subarray(0, -1);
    image.write('GIF87a', 0, 'latin1');
    toHost({ type: 'result', jobId: job.id, ok: true, images: [{ data: b64(image), mime: 'image/jpeg', width: 40, height: 30 }] });
    const done = await finished(job.id);
    assert.equal(done.status, 'succeeded');
    const [im] = done.images;
    assert.deepEqual(fs.readFileSync(im.path), image);
    assert.deepEqual([im.width, im.height, im.full, im.aspect], [40, 30, null, null]);
    assert.deepEqual(im.gif, { frames: 65, durationMs: 1300, delaysMs: Array(64).fill(20), loop: null,
      transparent: false, transparentFrames: 0, truncated: true });
  });

  await t.test('run messages never include a transparent reference prompt line', async () => {
    const refs = [{ name: 'ref.png', mime: 'image/png', data: b64(png(6)) }];
    for (const options of [{ animated: true, references: refs }, { animated: true, references: refs, sendAsIs: true },
      { references: refs }, { animated: true }]) {
      const job = await call('generate', { prompt: 'A fox waves', ...options });
      assert.equal(job.referencesTransparent, 0);
      assert.equal(job.referencesMatted, 0);
      const { job: run } = await nextFromHost('run');
      assert.equal('transparentReferenceLine' in run, false);
      assert.equal(run.text, buildText({ prompt: 'A fox waves', ...options, startUrl: PROJECT.url }));
      assert.doesNotMatch(run.text, /Keep the background transparent/);
      toHost({ type: 'result', jobId: job.id, ok: false, status: 'text_reply', referencesTransparent: 1, referencesMatted: 1 });
      const done = await finished(job.id);
      assert.equal(done.referencesTransparent, 1);
      assert.equal(done.referencesMatted, 1);
      assert.equal(done.status, 'text_reply');
      assert.equal((await call('job', { jobId: job.id })).referencesTransparent, 1);
      assert.equal((await call('job', { jobId: job.id })).referencesMatted, 1);
    }
  });

  await t.test('GIF alpha and transparent reference counts survive saving and public job summaries', async () => {
    const job = await call('generate', { prompt: 'A fox waves', animated: true });
    await nextFromHost('run');
    const alpha = { transparentShare: 0.6, opaqueShare: 0.4 };
    toHost({ type: 'result', jobId: job.id, ok: true, referencesTransparent: 2, referencesMatted: 1,
      images: [{ data: b64(gif({ width: 12, height: 8, frames: [{}, {}, {}] })), mime: 'image/gif', alpha }] });
    const done = await finished(job.id);
    assert.equal(done.status, 'succeeded');
    assert.equal(done.referencesTransparent, 2);
    assert.equal(done.referencesMatted, 1);
    assert.deepEqual(done.images[0].alpha, alpha);
    const stored = JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'jobs.json'), 'utf8')).find(j => j.id === job.id);
    assert.equal(stored.referencesTransparent, 2);
    assert.equal(stored.referencesMatted, 1);
    assert.deepEqual(stored.images[0].alpha, alpha);
  });

  await t.test('GIF contact sheet metadata survives storage and reaches results, gallery and collections', async () => {
    const inspect = ' Check that the subject keeps the same look, size and position from frame to frame.';
    for (const [frames, previewFrames, suffix] of [
      [9, { shown: 9, total: 9, ignored: 'discard' }, 'all 9 frames in order, numbered from 1.' + inspect],
      [40, { shown: 16, total: 40 }, '16 of 40 frames, evenly spaced and numbered by frame.' + inspect],
      [9, null, 'only the first frame.'],
    ]) {
      const job = await call('generate', { prompt: 'A walking fox', motion: 'walk' });
      await nextFromHost('run');
      const image = gif({ width: 12, height: 8, loop: 0, frames: Array.from({ length: frames }, () => ({ delayCs: 10 })) });
      toHost({ type: 'result', jobId: job.id, ok: true, images: [{ data: b64(image), mime: 'image/gif', preview: b64(JPEG), previewFrames }] });
      const done = await finished(job.id);
      const [im] = done.images;
      const expected = previewFrames ? { shown: previewFrames.shown, total: frames } : null;
      assert.deepEqual(im.previewFrames, expected);
      assert.deepEqual(fs.readFileSync(im.path), image);
      const lines = resultLines(done);
      const at = lines.indexOf(`Animated GIF: ${frames} frames, ${frames * 100} ms per loop, loops forever; the attached preview shows ${suffix}`);
      assert.ok(at > 0);
      assert.equal(lines[at + 1], 'Requested motion: walk (hint: about 8 frames at 100 ms; ChatGPT may use a different count).');
      const stored = JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'jobs.json'), 'utf8')).find(j => j.id === job.id);
      assert.deepEqual(stored.images[0].previewFrames, expected);
      assert.deepEqual(await call('gallery_thumb', { jobId: job.id, n: 1 }), { data: b64(JPEG), mime: 'image/jpeg' });
      assert.deepEqual(await call('gallery_animation', { jobId: job.id, n: 1 }), { data: b64(image), mime: 'image/gif' });
      const added = await call('collection_add_job_image', { jobId: job.id, n: 1, collection: 'Contact sheets', create: true });
      assert.deepEqual(fs.readFileSync(path.join(REFS, 'Contact sheets', 'thumbs', `${added.file}.jpg`)), JPEG);
      assert.deepEqual(fs.readFileSync(path.join(REFS, 'Contact sheets', added.file)), image);
    }
  });

  await t.test('previewFrames accepts only small integer counts matching a complete GIF and an attached preview', async () => {
    const job = await call('generate', { prompt: 'Metadata validation' });
    await nextFromHost('run');
    const animation = gif({ width: 12, height: 8, frames: [{}, {}, {}] });
    const invalid = [undefined, null, {}, { shown: '3', total: 3 }, { shown: 3, total: '3' },
      { shown: 1, total: 3 }, { shown: 2, total: 3 }, { shown: 17, total: 40 },
      { shown: 3.5, total: 3 }, { shown: 3, total: 513 }, { shown: 4, total: 3 },
      { shown: 3, total: 4 }, { shown: -1, total: -1 }];
    const images = invalid.map(previewFrames => ({ data: b64(animation), mime: 'image/gif', preview: b64(JPEG), previewFrames }));
    images.push(
      { data: b64(animation), mime: 'image/gif', previewFrames: { shown: 3, total: 3 } },
      { data: b64(png(6, { width: 256, height: 256 })), mime: 'image/png', preview: b64(JPEG), previewFrames: { shown: 3, total: 3 } },
      { data: b64(animation.subarray(0, -1)), mime: 'image/gif', preview: b64(JPEG), previewFrames: { shown: 3, total: 3 } },
    );
    toHost({ type: 'result', jobId: job.id, ok: true, images });
    const done = await finished(job.id);
    assert.equal(done.status, 'succeeded', done.error);
    assert.equal(done.images.length, images.length);
    for (const im of done.images) assert.equal(im.previewFrames, null);
    const stored = JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'jobs.json'), 'utf8')).find(j => j.id === job.id);
    for (const im of stored.images) assert.equal(im.previewFrames, null);
  });

  await t.test('add_local_animation validates its own GIF, registers it and notifies the gallery without running a job', async () => {
    const file = path.join(DIR, 'starfish_bounce.GIF');
    const image = gif({ width: 12, height: 8, loop: 0, frames: Array.from({ length: 16 }, () => ({ delayCs: 5, transparentIndex: 0 })) });
    const preview = png(6, { width: 256, height: 256 });
    fs.writeFileSync(file, image);
    const before = (await call('gallery_list', { limit: 1 })).total;
    const runs = fromHost.filter(m => m.type === 'run').length;
    const params = { path: file, sourcePath: path.join(DIR, 'starfish.png'), motion: 'bounce', background: 'transparent',
      preview: b64(preview), previewFrames: { shown: 16, total: 16 }, width: 999, gif: { frames: 999 } };
    const job = await call('add_local_animation', params);
    assert.match(job.id, /^img_[0-9a-f]{8}$/);
    assert.deepEqual([job.mode, job.status, job.step, job.message], ['local', 'succeeded', 'succeeded', 'Local animation saved']);
    assert.equal(job.prompt, 'Local bounce animation of starfish.png');
    assert.deepEqual([job.animated, job.motion, job.transparent], [true, 'bounce', true]);
    assert.deepEqual([job.startUrl, job.conversationUrl, job.references, job.copies], [null, null, [], []]);
    assert.equal(job.createdAt, job.startedAt); assert.equal(job.createdAt, job.finishedAt);
    const [im] = job.images;
    assert.deepEqual([im.path, im.width, im.height, im.bytes, im.full, im.aspect, im.png, im.alpha], [file, 12, 8, image.length, null, null, null, null]);
    assert.deepEqual(im.gif, { frames: 16, durationMs: 800, delaysMs: Array(16).fill(50), loop: 0,
      transparent: true, transparentFrames: 16, truncated: false });
    assert.deepEqual(im.previewFrames, { shown: 16, total: 16 });
    assert.equal(path.basename(im.preview), `${job.id}-1.png`);
    assert.deepEqual(await nextFromHost('gallery_changed'), { type: 'gallery_changed' });
    const page = await call('gallery_list', { limit: 1 });
    assert.equal(page.total, before + 1);
    assert.deepEqual([page.items[0].jobId, page.items[0].format, page.items[0].frames, page.items[0].durationMs, page.items[0].conversationUrl], [job.id, 'GIF', 16, 800, null]);
    assert.deepEqual(await call('gallery_thumb', { jobId: job.id, n: 1 }), { data: b64(preview), mime: 'image/png' });
    assert.deepEqual(await call('gallery_animation', { jobId: job.id, n: 1 }), { data: b64(image), mime: 'image/gif' });
    const status = await call('status');
    assert.equal(status.running, null); assert.deepEqual(status.queued, []);
    assert.equal(status.recent[0].motion, 'bounce');
    assert.equal(fromHost.filter(m => m.type === 'run').length, runs);
    const stored = JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'jobs.json'), 'utf8')).find(j => j.id === job.id);
    assert.equal(stored.project, null); assert.deepEqual(stored.images, job.images);
    const added = await call('collection_add_job_image', { jobId: job.id, n: 1, collection: 'Local motions', create: true });
    assert.deepEqual(fs.readFileSync(path.join(REFS, 'Local motions', added.file)), image);
    assert.equal(fs.existsSync(path.join(REFS, 'Local motions', 'thumbs', `${added.file}.jpg`)), false);
  });

  await t.test('sprite sheet animations require kind sheet, accept sheet motions and use the sprite prompt', async () => {
    const file = path.join(DIR, 'sprite-walk.gif'); fs.writeFileSync(file, gif({ frames: [{}, {}], loop: 0 }));
    const params = { path: file, sourcePath: path.join(DIR, 'frog.png'), motion: 'walk', background: 'transparent' };
    const before = (await call('gallery_list')).total;
    for (const extra of [{}, { kind: 'unknown' }, { kind: null }, { kind: 'light' }, { kind: 'sheet', motion: 'bounce' }]) {
      await assert.rejects(call('add_local_animation', { ...params, ...extra }), { code: 'BAD_REQUEST' });
    }
    assert.equal((await call('gallery_list')).total, before);
    const job = await call('add_local_animation', { ...params, kind: 'sheet' });
    assert.equal(job.prompt, 'Sprite sheet walk animation of frog.png'); assert.equal(job.motion, 'walk');
    assert.equal(job.mode, 'local'); assert.equal(job.status, 'succeeded'); assert.equal(job.images[0].gif.frames, 2);
    assert.deepEqual(await nextFromHost('gallery_changed'), { type: 'gallery_changed' });
    assert.equal((await call('gallery_list')).total, before + 1);
  });

  await t.test('recreated local GIFs replace the record with a new id, preview bytes and gallery notifications', async () => {
    const file = path.join(DIR, 'recreated.gif');
    const original = gif({ width: 12, height: 8, frames: [{}, {}] });
    const preview = png(6, { width: 12, height: 8 });
    fs.writeFileSync(file, original);
    const before = (await call('gallery_list')).total;
    const first = await call('add_local_animation', { path: file, sourcePath: 'old.png', motion: 'idle', background: 'transparent',
      preview: b64(preview), previewFrames: { shown: 2, total: 2 } });
    assert.deepEqual(await nextFromHost('gallery_changed'), { type: 'gallery_changed' });
    assert.equal((await call('gallery_list')).total, before + 1);
    assert.equal(fs.existsSync(first.images[0].preview), true);
    fs.unlinkSync(file);
    const replacement = gif({ width: 24, height: 16, frames: [{}, {}, {}, {}] });
    const newPreview = png(6, { width: 24, height: 16 });
    assert.notDeepEqual(replacement, original); assert.notDeepEqual(newPreview, preview);
    fs.writeFileSync(file, replacement);
    const second = await call('add_local_animation', { path: path.join(DIR, 'sub', '..', path.basename(file)), sourcePath: 'new.png', motion: 'sway', background: 'white',
      preview: b64(newPreview), previewFrames: { shown: 4, total: 4 } });
    assert.deepEqual(await nextFromHost('gallery_changed'), { type: 'gallery_changed' });
    assert.notEqual(second.id, first.id); assert.notEqual(second.images[0].preview, first.images[0].preview);
    await assert.rejects(call('job', { jobId: first.id }), { code: 'NOT_FOUND' });
    assert.equal(fs.existsSync(first.images[0].preview), false);
    assert.deepEqual([second.motion, second.transparent, second.prompt], ['sway', false, 'Local sway animation of new.png']);
    assert.deepEqual([second.images[0].width, second.images[0].height, second.images[0].bytes, second.images[0].gif.frames],
      [24, 16, replacement.length, 4]);
    assert.notEqual(second.images[0].bytes, first.images[0].bytes);
    assert.deepEqual(second.images[0].previewFrames, { shown: 4, total: 4 });
    assert.deepEqual(await call('gallery_thumb', { jobId: second.id, n: 1 }), { data: b64(newPreview), mime: 'image/png' });
    const secondPage = await call('gallery_list');
    assert.equal(secondPage.total, before + 1); assert.equal(secondPage.items[0].jobId, second.id);
    assert.deepEqual(await call('job', { jobId: second.id }), second);
    const lines = resultLines(await call('job', { jobId: second.id }));
    assert.ok(lines.every(line => typeof line === 'string'));
    assert.match(lines.join('\n'), /^SUCCESS/); assert.ok(lines.join('\n').includes(file));
    assert.match(lines.join('\n'), /4 frames/);
    const stored = () => JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'jobs.json'), 'utf8'))
      .filter(j => j.mode === 'local' && j.images.some(im => path.resolve(im.path) === path.resolve(file)));
    assert.equal(stored().length, 1); assert.equal(stored()[0].id, second.id); assert.deepEqual(stored()[0].images, second.images);
    const withoutPreview = await call('add_local_animation', { path: file, motion: 'nod', background: 'white' });
    assert.deepEqual(await nextFromHost('gallery_changed'), { type: 'gallery_changed' });
    assert.notEqual(withoutPreview.id, second.id);
    assert.equal(withoutPreview.images[0].preview, null); assert.equal(withoutPreview.images[0].previewFrames, null);
    await assert.rejects(call('job', { jobId: second.id }), { code: 'NOT_FOUND' });
    assert.equal(fs.existsSync(second.images[0].preview), false);
    assert.equal(stored().length, 1); assert.equal(stored()[0].id, withoutPreview.id);
    assert.equal(stored()[0].images[0].preview, null);
    const withoutPreviewPage = await call('gallery_list');
    assert.equal(withoutPreviewPage.total, before + 1); assert.equal(withoutPreviewPage.items[0].jobId, withoutPreview.id);
  });

  await t.test('add_local_animation rejects invalid paths, incomplete GIFs and unsupported metadata before adding records', async () => {
    const file = path.join(DIR, 'valid-local.gif'); fs.writeFileSync(file, gif());
    const notGif = path.join(DIR, 'not-gif.gif'); fs.writeFileSync(notGif, png(6));
    const cut = path.join(DIR, 'cut-local.gif'); fs.writeFileSync(cut, gif().subarray(0, -1));
    const empty = path.join(DIR, 'empty-local.gif'); fs.writeFileSync(empty, gif({ frames: [] }));
    const big = path.join(DIR, 'big-local.gif'); fs.writeFileSync(big, ''); fs.truncateSync(big, MAX_ANIMATION_BYTES + 1);
    const folder = path.join(DIR, 'folder.gif'); fs.mkdirSync(folder);
    const before = (await call('gallery_list')).total;
    for (const override of [
      { path: 'relative.gif' }, { path: path.join(DIR, 'wrong.png') }, { path: path.join(DIR, 'missing.gif') },
      { path: null }, { path: 42 }, { path: notGif }, { path: cut }, { path: empty }, { path: folder }, { path: big },
      { motion: 'walk' }, { background: 'black' }, { sourcePath: 42 },
    ]) await assert.rejects(call('add_local_animation', { path: file, motion: 'idle', background: 'white', ...override }), { code: 'BAD_REQUEST' });
    assert.equal((await call('gallery_list')).total, before);
  });

  await t.test('local previews are optional PNGs and frame counts must match the GIF, with at most 64 saved delays', async () => {
    const animation = gif({ frames: Array.from({ length: 65 }, () => ({ delayCs: 2 })) });
    const preview = b64(png(6));
    const cases = [
      { preview: b64(JPEG), previewFrames: { shown: 16, total: 65 } },
      { preview: 'not base64 PNG', previewFrames: { shown: 16, total: 65 } },
      { preview: b64(Buffer.concat([png(6), Buffer.alloc(MAX_PREVIEW_BYTES)])) },
      ...[{}, { shown: '16', total: 65 }, { shown: 16, total: '65' }, { shown: 1, total: 65 },
        { shown: 17, total: 65 }, { shown: 15, total: 65 }, { shown: 16, total: 64 }, { shown: 16, total: 513 }]
        .map(previewFrames => ({ preview, previewFrames })),
      { preview, previewFrames: { shown: 16, total: 65 } },
      {},
    ];
    for (const [i, options] of cases.entries()) {
      const file = path.join(DIR, `preview-local-${i}.gif`); fs.writeFileSync(file, animation);
      const job = await call('add_local_animation', { path: file, motion: 'idle', background: 'white', ...options });
      assert.equal(job.transparent, false);
      const im = job.images[0];
      assert.equal(im.gif.delaysMs.length, 64); assert.equal(im.gif.frames, 65); assert.equal(im.gif.durationMs, 1300);
      assert.equal(!!im.preview, options.preview === preview);
      assert.deepEqual(im.previewFrames, i === cases.length - 2 ? { shown: 16, total: 65 } : null);
    }
  });

  const sheetBytes = name => fs.readFileSync(path.join(__dirname, 'fixtures', `frog-${name}.png`));
  const sheetReply = (jobId, name, conversationUrl = CHAT_URL) => toHost({ type: 'result', jobId, ok: true,
    conversationUrl, assistantText: 'Raw sheet reply', images: [{ mime: 'image/png', data: b64(sheetBytes(name)),
      preview: b64(Buffer.concat([JPEG, Buffer.from(name)])),
      crop: { data: b64(png(6, { width: 256, height: 256 })), width: 256, height: 256 } }] });
  const readStored = id => JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'jobs.json'), 'utf8')).find(j => j.id === id);
  const followingJob = async cancelledId => {
    const next = await call('generate', { prompt: 'A normal job after sprite cancellation' });
    assert.equal((await nextFromHost('run')).job.id, next.id);
    toHost({ type: 'result', jobId: next.id, ok: true, images: [{ mime: 'image/png', data: b64(png(6, { width: 256, height: 256 })) }] });
    const done = await finished(next.id);
    assert.equal(done.status, 'succeeded', done.error);
    assert.equal(fromHost.filter(m => m.type === 'run' && m.job.id === cancelledId).length, 0);
    assert.deepEqual((await call('status')).queued, []);
  };

  await t.test('sprite parameters are validated before queuing and status advertises support', async () => {
    assert.ok((await call('status')).features.includes('sprite'));
    const before = JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'jobs.json'), 'utf8')).length;
    for (const sprite of [null, [], false, 'walk', {}, { motion: 'fly' }, { motion: 'toString' },
      { motion: 'walk', frames: 9 }, { motion: 'walk', frames: '8' }, { motion: 'walk', view: 'back' },
      { motion: 'walk', size: 63 }, { motion: 'walk', size: 1025 }, { motion: 'walk', size: 64.5 },
      { motion: 'walk', size: null }, { motion: 'walk', background: 'black' }]) {
      await assert.rejects(call('generate', { prompt: 'frog', sprite }), { code: 'BAD_REQUEST' });
    }
    for (const conflict of [{ mode: 'collect' }, { startUrl: CHAT_URL }, { motion: 'walk' },
      { animated: false }, { sendAsIs: false }]) {
      await assert.rejects(call('generate', { prompt: 'frog', sprite: { motion: 'walk' }, ...conflict }), { code: 'BAD_REQUEST' });
    }
    await assert.rejects(call('generate', { prompt: '..!!', sprite: { motion: 'walk' } }), { code: 'BAD_REQUEST' });
    assert.equal(JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'jobs.json'), 'utf8')).length, before);
    assert.deepEqual((await call('status')).queued, []);
  });

  await t.test('sprite without a saved sheet preserves failed ChatGPT statuses and reply text', async () => {
    for (const status of ['failed', 'text_reply', 'needs_reference', 'cancelled']) {
      const job = await call('generate', { prompt: 'A frog', sprite: { motion: 'walk' } });
      await nextFromHost('run');
      toHost({ type: 'result', jobId: job.id, ok: false, status, assistantText: 'No sheet was generated', error: 'No image' });
      const done = await finished(job.id);
      assert.equal(done.status, status); assert.equal(done.assistantText, 'No sheet was generated');
      assert.equal(done.sprite.attempts.length, 0); assert.equal(done.sprite.regenerated, false);
      assert.match(resultLines(done).join('\n'), /No sheet was generated/);
    }
  });

  await t.test('cancelling the first sprite generation stays cancelled even when ChatGPT returns a sheet', async () => {
    for (const lateSheet of [false, true]) {
      const job = await call('generate', { prompt: 'A frog', sprite: { motion: 'walk' } });
      assert.equal((await nextFromHost('run')).job.id, job.id);
      await call('cancel', { jobId: job.id });
      assert.deepEqual(await nextFromHost('cancel'), { type: 'cancel', jobId: job.id });
      assert.equal(readStored(job.id).cancelRequested, true);
      if (lateSheet) sheetReply(job.id, 'jump-4x4');
      else toHost({ type: 'result', jobId: job.id, ok: false, status: 'cancelled' });
      const done = await finished(job.id);
      assert.equal(done.status, 'cancelled'); assert.equal(done.sprite.attempts.length, 0);
      assert.equal(done.sprite.regenerated, false); assert.deepEqual(done.images, []);
      assert.equal(done.error, 'Cancelled.'); assert.equal(done.message, 'Cancelled.');
      assert.equal((await call('cancel', { jobId: job.id })).status, 'cancelled');
      await followingJob(job.id);
    }
  });

  await t.test('cancelling a queued regeneration preserves the processed first sheet and never sends another run', async () => {
    const job = await call('generate', { prompt: 'A frog', sprite: { motion: 'walk' } });
    assert.equal((await nextFromHost('run')).job.id, job.id);
    const blocker = await call('generate', { prompt: 'Keep Chrome busy while the sprite is processed' });
    sheetReply(job.id, 'jump-4x4');
    assert.equal((await nextFromHost('run')).job.id, blocker.id);
    const queued = await call('job', { jobId: job.id });
    assert.equal(queued.status, 'queued', JSON.stringify(queued));
    const done = await call('cancel', { jobId: job.id });
    assert.equal(done.status, 'cancelled'); assert.equal(done.sprite.attempts.length, 1);
    assert.equal(done.sprite.regenerated, true); assert.equal(readStored(job.id).cancelRequested, true);
    const attempt = done.sprite.attempts[0];
    assert.deepEqual(done.images.map(i => i.path), [attempt.sheetPath]);
    assert.deepEqual(fs.readFileSync(attempt.sheetPath), sheetBytes('jump-4x4'));
    for (const file of ['atlas.png', 'manifest.json', 'frames', 'contact.png']) assert.ok(fs.existsSync(path.join(attempt.folder, file)));
    assert.equal(done.error, `Cancelled. Saved sprite sheet(s): ${attempt.sheetPath}`);
    assert.equal(done.message, done.error);
    assert.equal((await call('status')).running.id, blocker.id);
    assert.equal(fromHost.filter(m => m.type === 'cancel' && m.jobId === job.id).length, 0);
    toHost({ type: 'result', jobId: blocker.id, ok: false, error: 'Blocker finished' });
    await finished(blocker.id);
    await followingJob(job.id);
  });

  await t.test('cancelling a running regeneration keeps the first sheet instead of succeeding or retrying', async () => {
    for (const mode of ['requested', 'extension', 'late-sheet']) {
      const job = await call('generate', { prompt: 'A frog', sprite: { motion: 'walk' } });
      assert.equal((await nextFromHost('run')).job.id, job.id);
      sheetReply(job.id, 'jump-4x4');
      assert.equal((await nextFromHost('run')).job.id, job.id);
      if (mode !== 'extension') {
        await call('cancel', { jobId: job.id });
        assert.deepEqual(await nextFromHost('cancel'), { type: 'cancel', jobId: job.id });
      }
      if (mode === 'late-sheet') sheetReply(job.id, 'walk-4x2');
      else toHost({ type: 'result', jobId: job.id, ok: false, status: 'cancelled' });
      const done = await finished(job.id), attempt = done.sprite.attempts[0];
      assert.equal(done.status, 'cancelled'); assert.equal(done.sprite.attempts.length, 1);
      assert.deepEqual(done.images.map(i => i.path), [attempt.sheetPath]);
      assert.deepEqual(fs.readFileSync(attempt.sheetPath), sheetBytes('jump-4x4'));
      assert.ok(fs.existsSync(path.join(attempt.folder, 'manifest.json')));
      assert.equal(done.error, `Cancelled. Saved sprite sheet(s): ${attempt.sheetPath}`);
      assert.equal(done.message, done.error);
      await followingJob(job.id);
    }
  });

  await t.test('sprite walk processes automatically, keeps original sheet bytes, and lists GIF and sheet in gallery', async () => {
    const job = await call('generate', { prompt: 'A frog with a red scarf.', sprite: { motion: 'walk' } });
    const { job: run } = await nextFromHost('run');
    assert.equal(run.id, job.id); assert.equal(run.startUrl, PROJECT.url);
    assert.match(run.text, /^Generate an image/); assert.match(run.text, /Sprite sheet of A frog with a red scarf, side view facing right, walk cycle/);
    assert.match(run.text, /8 frames in a 4 x 2 grid/); assert.match(run.text, /Aspect ratio: 3:2/);
    assert.match(run.text, /Background: fully transparent/); assert.equal(run.animated, false);
    sheetReply(job.id, 'walk-4x2');
    const done = await finished(job.id);
    assert.equal(done.status, 'succeeded', done.error);
    assert.equal(done.sprite.regenerated, false); assert.equal(done.sprite.chosen, 0);
    assert.equal(done.sprite.attempts.length, 1); assert.equal(done.images.length, 2);
    const [animation, source] = done.images, attempt = done.sprite.attempts[0];
    assert.equal(animation.gif.frames, 8); assert.match(animation.path, /\.gif$/);
    assert.equal(path.basename(animation.preview), `${job.id}-1.png`);
    assert.deepEqual(animation.previewFrames, { shown: 8, total: 8 });
    assert.equal(done.assistantText, null); assert.equal(attempt.assistantText, undefined);
    for (const file of ['atlas.png', 'manifest.json', 'frames', 'contact.png']) assert.ok(fs.existsSync(path.join(attempt.folder, file)));
    assert.ok(attempt.gates.every(g => g.passed), JSON.stringify(attempt.gates));
    const items = (await call('gallery_list', { limit: 100 })).items.filter(i => i.jobId === job.id);
    assert.deepEqual(items.map(i => i.path), [animation.path, source.path]);
    const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
    assert.equal(sha(fs.readFileSync(items[1].path)), sha(sheetBytes('walk-4x2')));
    assert.equal(readStored(job.id).sprite.attempts[0].result.sheet, undefined);
    assert.deepEqual(await nextFromHost('gallery_changed'), { type: 'gallery_changed' });
  });

  await t.test('sprite output_dir copies complete walk and idle exports, preserves central files and updates gallery paths', async () => {
    for (const motion of ['walk', 'idle']) {
      const output = path.join(DIR, `sprite-output-${motion}`);
      const job = await call('generate', { prompt: 'A frog', sprite: { motion, background: 'white', size: 128 }, copyTo: output });
      await nextFromHost('run'); sheetReply(job.id, 'walk-4x2');
      const central = await finished(job.id), original = central.sprite.attempts[0];
      const collision = path.join(output, path.basename(original.folder));
      fs.mkdirSync(collision, { recursive: true });
      fs.writeFileSync(path.join(collision, 'keep.txt'), 'leave existing outputs alone');
      const copied = await copyResults(central), attempt = copied.sprite.attempts[0];
      assert.equal(copied.copyError, undefined);
      assert.notEqual(attempt.folder, collision);
      assert.equal(path.dirname(attempt.folder), output);
      assert.equal(fs.readFileSync(path.join(collision, 'keep.txt'), 'utf8'), 'leave existing outputs alone');
      for (const key of ['gif', 'transparentGif', 'sheetPath', 'contact']) {
        assert.equal(path.dirname(attempt[key]), attempt.folder, key);
        assert.deepEqual(fs.readFileSync(attempt[key]), fs.readFileSync(original[key]), key);
      }
      const manifest = JSON.parse(fs.readFileSync(path.join(attempt.folder, 'manifest.json'), 'utf8'));
      assert.equal(manifest.frameCount, 8);
      for (const file of ['atlas.png', 'manifest.json', 'contact.png', ...manifest.frames.map(f => f.file)]) {
        assert.deepEqual(fs.readFileSync(path.join(attempt.folder, file)), fs.readFileSync(path.join(original.folder, file)), file);
      }
      assert.deepEqual(fs.readFileSync(path.join(attempt.folder, manifest.source.file)), sheetBytes('walk-4x2'));
      assert.equal((await call('gallery_list', { limit: 100 })).items.filter(i => i.jobId === job.id).every(i => path.dirname(i.path) === attempt.folder), true);
      assert.equal((await call('job', { jobId: job.id })).sprite.attempts[0].folder, attempt.folder);
      assert.equal(readStored(job.id).sprite.attempts[0].result.paths.frames.every(f => path.dirname(f) === path.join(attempt.folder, 'frames')), true);
      const text = resultLines(copied).join('\n');
      assert.ok(text.includes(`Folder: ${attempt.folder}`)); assert.ok(text.includes(`GIF: ${attempt.gif}`));
      assert.ok(text.includes(`Sprite sheet from ChatGPT: ${attempt.sheetPath}`));
      assert.deepEqual((await copyResults(copied)).copies, copied.copies);
      assert.equal(fs.readdirSync(output).length, 2, 'polling does not copy again');
    }
  });

  await t.test('sprite without output_dir keeps central paths and does not copy', async () => {
    const job = await call('generate', { prompt: 'A frog', sprite: { motion: 'idle' } });
    await nextFromHost('run'); sheetReply(job.id, 'walk-4x2');
    const done = await finished(job.id);
    assert.deepEqual(await copyResults(done), done);
    assert.deepEqual(done.copies, []);
    assert.equal(path.dirname(done.sprite.attempts[0].folder), IMAGES);
    assert.equal(path.dirname(done.images[1].path), IMAGES);
    assert.equal(done.images[0].centralPath, undefined);
  });

  await t.test('incomplete sprite exports report a copy error without marking success or losing central files', async () => {
    const output = path.join(DIR, 'sprite-incomplete-output');
    const job = await call('generate', { prompt: 'A frog', sprite: { motion: 'walk' }, copyTo: output });
    await nextFromHost('run'); sheetReply(job.id, 'walk-4x2');
    const done = await finished(job.id), attempt = done.sprite.attempts[0];
    fs.unlinkSync(path.join(attempt.folder, 'frames', 'frame_08.png'));
    const result = await copyResults(done);
    assert.match(result.copyError, /frame_08\.png/);
    assert.deepEqual(result.copies, []);
    assert.deepEqual(fs.readdirSync(output), []);
    assert.deepEqual((await call('job', { jobId: job.id })).images, done.images);
    assert.ok(fs.existsSync(attempt.gif)); assert.ok(fs.existsSync(attempt.sheetPath));
  });

  await t.test('sprite copy rejects missing white or transparent GIFs without changing host paths', async () => {
    for (const key of ['gif', 'transparentGif']) {
      const output = path.join(DIR, `sprite-missing-${key}`);
      const job = await call('generate', { prompt: 'A frog', sprite: { motion: 'walk', background: 'white' }, copyTo: output });
      await nextFromHost('run'); sheetReply(job.id, 'walk-4x2');
      const done = await finished(job.id), attempt = done.sprite.attempts[0];
      fs.unlinkSync(attempt[key]);
      const result = await copyResults(done);
      assert.ok(result.copyError?.includes(path.basename(attempt[key])), key);
      assert.deepEqual(result.copies, []);
      assert.deepEqual(fs.readdirSync(output), []);
      const stored = await call('job', { jobId: job.id });
      assert.deepEqual(stored.images, done.images);
      assert.deepEqual(stored.sprite, done.sprite);
    }
  });

  await t.test('sprite copy cleans up earlier exports if an unselected retry GIF is missing', async () => {
    const output = path.join(DIR, 'sprite-missing-retry-gif');
    const job = await call('generate', { prompt: 'A frog', sprite: { motion: 'walk', background: 'white' }, copyTo: output });
    await nextFromHost('run'); sheetReply(job.id, 'jump-4x4');
    await nextFromHost('run'); sheetReply(job.id, 'jump-4x4');
    const done = await finished(job.id), [first, second] = done.sprite.attempts;
    assert.equal(done.sprite.chosen, 0); assert.equal(done.sprite.attempts.length, 2);
    fs.unlinkSync(second.transparentGif);
    const result = await copyResults(done);
    assert.ok(result.copyError?.includes(path.basename(second.transparentGif)));
    assert.deepEqual(result.copies, []);
    assert.deepEqual(fs.readdirSync(output), [], 'the already copied first export is removed');
    const stored = await call('job', { jobId: job.id });
    assert.deepEqual(stored.images, done.images); assert.deepEqual(stored.sprite, done.sprite);
    assert.ok(fs.existsSync(first.gif)); assert.ok(fs.existsSync(first.transparentGif));
  });

  await t.test('sprite copy cleans up files after a write fails partway through an export', async () => {
    const output = path.join(DIR, 'sprite-write-failure');
    const job = await call('generate', { prompt: 'A frog', sprite: { motion: 'walk' }, copyTo: output });
    await nextFromHost('run'); sheetReply(job.id, 'walk-4x2');
    const done = await finished(job.id), copy = fs.copyFileSync;
    let writes = 0, result;
    fs.copyFileSync = (source, dest, flags) => {
      if (dest.startsWith(output + path.sep) && ++writes === 3) throw new Error('Simulated sprite copy write failure');
      return copy(source, dest, flags);
    };
    try { result = await copyResults(done); } finally { fs.copyFileSync = copy; }
    assert.equal(writes, 3);
    assert.match(result.copyError, /Simulated sprite copy write failure/);
    assert.deepEqual(result.copies, []);
    assert.deepEqual(fs.readdirSync(output), []);
    assert.deepEqual((await call('job', { jobId: job.id })).images, done.images);
    assert.ok(fs.existsSync(done.sprite.attempts[0].gif));
  });

  await t.test('sprite regenerates once in a new chat, reattaches the same references and picks the passing sheet', async () => {
    const refs = [{ name: 'frog.png', mime: 'image/png', data: b64(sheetBytes('walk-4x2')) }];
    const job = await call('generate', { prompt: 'A frog', sprite: { motion: 'walk', background: 'white', size: 128 }, references: refs,
      copyTo: path.join(DIR, 'sprite-retried-output') });
    const first = (await nextFromHost('run')).job;
    sheetReply(job.id, 'jump-4x4');
    const second = (await nextFromHost('run')).job;
    assert.equal(second.id, job.id); assert.equal(second.text, first.text); assert.equal(second.startUrl, PROJECT.url);
    assert.equal(fromHost.filter(m => m.type === 'chat_done' && m.jobId === job.id).length, 0);
    const refChunks = fromHost.filter(m => m.type === 'ref_chunk' && m.jobId === job.id);
    assert.equal(refChunks.length, 2); assert.equal(refChunks[0].data, refChunks[1].data);
    assert.match((await call('job', { jobId: job.id })).message, /Regenerating.*count:/);
    assert.equal(readStored(job.id).sprite.regenerated, true);
    const secondUrl = CHAT_URL.replace('6812a3b4', '7812a3b4');
    sheetReply(job.id, 'walk-4x2', secondUrl);
    const done = await finished(job.id);
    assert.equal(done.status, 'succeeded', done.error); assert.equal(done.sprite.regenerated, true);
    assert.equal(done.sprite.attempts.length, 2); assert.equal(done.sprite.chosen, 1);
    assert.match(done.sprite.regenerateReason, /count:/); assert.equal(done.images.length, 3);
    assert.equal(done.conversationUrl, secondUrl); assert.equal(done.images[0].gif.transparent, false);
    const chatDone = await until(() => fromHost.find(m => m.type === 'chat_done' && m.jobId === job.id), 'sprite chat_done');
    assert.deepEqual(Object.keys(chatDone).sort(), ['chats', 'jobId', 'type']);
    assert.deepEqual(chatDone.chats, [
      { id: '6812a3b4-1c2d-8000-9e8f-0123456789ab', url: CHAT_URL },
      { id: '7812a3b4-1c2d-8000-9e8f-0123456789ab', url: secondUrl },
    ]);
    assert.ok(fs.existsSync(done.sprite.attempts[1].transparentGif));
    assert.deepEqual(fs.readFileSync(done.images[1].path), sheetBytes('walk-4x2'));
    assert.deepEqual(fs.readFileSync(done.images[2].path), sheetBytes('jump-4x4'));
    assert.notEqual(done.images[1].preview, done.images[2].preview);
    assert.deepEqual(fs.readFileSync(done.images[1].preview), Buffer.concat([JPEG, Buffer.from('walk-4x2')]));
    assert.deepEqual(fs.readFileSync(done.images[2].preview), Buffer.concat([JPEG, Buffer.from('jump-4x4')]));
    const copied = await copyResults(done);
    assert.equal(copied.copyError, undefined);
    assert.equal(copied.sprite.chosen, 1);
    for (const attempt of copied.sprite.attempts) {
      assert.equal(path.dirname(attempt.folder), done.copyTo);
      assert.equal(path.dirname(attempt.sheetPath), attempt.folder);
      assert.ok(fs.existsSync(path.join(attempt.folder, 'manifest.json')));
    }
    assert.deepEqual(copied.images.map(im => im.path), [copied.sprite.attempts[1].gif, copied.sprite.attempts[1].sheetPath, copied.sprite.attempts[0].sheetPath]);
  });

  await t.test('two failing count gates still finish with warnings and never queue a third run', async () => {
    const job = await call('generate', { prompt: 'A frog', sprite: { motion: 'walk' } });
    const runs = [];
    for (let i = 0; i < 2; i++) {
      runs.push((await nextFromHost('run')).job);
      sheetReply(job.id, 'jump-4x4');
    }
    const done = await finished(job.id);
    assert.equal(done.status, 'succeeded', done.error); assert.equal(done.sprite.attempts.length, 2);
    assert.equal(done.sprite.chosen, 0); assert.equal(done.images.length, 3);
    assert.match(resultLines(done).join('\n'), /WARNING.*count:/);
    await sleep(150);
    assert.equal(runs.filter(r => r.id === job.id).length + fromHost.filter(m => m.type === 'run' && m.job.id === job.id).length, 2);
  });

  await t.test('a failed second ChatGPT reply keeps the processed first attempt with a warning', async () => {
    for (const status of ['failed', 'text_reply', 'needs_reference']) {
      const job = await call('generate', { prompt: 'A frog', sprite: { motion: 'walk' } });
      await nextFromHost('run'); sheetReply(job.id, 'jump-4x4'); await nextFromHost('run');
      toHost({ type: 'result', jobId: job.id, ok: false, status, error: 'Second chat failed' });
      const done = await finished(job.id);
      assert.equal(done.status, 'succeeded', done.error); assert.equal(done.sprite.chosen, 0);
      assert.match(done.sprite.warning, /Could not regenerate.*Second chat failed/);
      assert.equal(done.conversationUrl, CHAT_URL); assert.equal(done.images.length, 2);
      assert.match(resultLines(done).join('\n'), /Tried to regenerate once.*second attempt did not finish; used attempt 1\./);
      assert.doesNotMatch(resultLines(done).join('\n'), /Regenerated once/);
    }
  });

  await t.test('processing errors retry once, prefer a valid sheet and preserve both raw paths on total failure', async () => {
    for (const recover of [true, false]) {
      const job = await call('generate', { prompt: 'A frog', sprite: { motion: 'walk' } });
      for (let i = 0; i < 2; i++) {
        await nextFromHost('run');
        if (i === 1 && recover) sheetReply(job.id, 'walk-4x2');
        else toHost({ type: 'result', jobId: job.id, ok: true, images: [{ mime: 'image/png', data: b64(png(6, { width: 256, height: 256 })) }] });
      }
      const done = await finished(job.id);
      assert.equal(done.sprite.attempts.length, 2);
      if (recover) {
        assert.equal(done.status, 'succeeded', done.error); assert.equal(done.sprite.chosen, 1);
      } else {
        assert.equal(done.status, 'failed'); assert.match(done.error, /animate_sheet/);
        assert.equal(done.message, 'Sprite processing failed');
        assert.equal(done.images.length, 2);
        for (const image of done.images) { assert.ok(fs.existsSync(image.path)); assert.ok(done.error.includes(image.path)); }
      }
    }
  });

  await t.test('Chrome closing during regeneration finishes the saved first attempt without another run', async () => {
    const job = await call('generate', { prompt: 'A frog', sprite: { motion: 'walk' } });
    await nextFromHost('run'); sheetReply(job.id, 'jump-4x4'); await nextFromHost('run');
    child.stdin.end(); await exited;
    const done = readStored(job.id);
    assert.equal(done.status, 'succeeded', done.error); assert.equal(done.sprite.chosen, 0);
    assert.equal(done.images.length, 2); assert.match(done.sprite.warning, /Chrome closed \/ the bridge restarted/);
    assert.equal(done.sprite.attempts.length, 1);
  });

  await t.test('startup completes saved processing and interrupted retries without Chrome or reference bytes', async () => {
    const history = JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'jobs.json'), 'utf8'));
    const walk = history.find(j => j.sprite?.attempts.length === 1 && !j.sprite.regenerated);
    const retried = history.find(j => j.sprite?.attempts.length === 2 && j.sprite.chosen === 1);
    const failed = history.find(j => j.sprite?.attempts.length === 2 && j.status === 'failed');
    const make = (source, id, state, status = 'running') => {
      const job = JSON.parse(JSON.stringify(source));
      Object.assign(job, { id, status, step: state, finishedAt: null, error: null, images: [] });
      Object.assign(job.sprite, { state, chosen: null, warning: null });
      return job;
    };
    const passing = make(walk, 'img_0000aa01', 'processing'); passing.sprite.attempts[0].result = null;
    const count = make(retried, 'img_0000aa02', 'processing');
    count.sprite.attempts = [count.sprite.attempts[0]]; count.sprite.attempts[0].result = null; count.sprite.regenerated = false;
    const queued = make(retried, 'img_0000aa03', 'generating', 'queued'); queued.sprite.attempts = [queued.sprite.attempts[0]];
    const running = make(queued, 'img_0000aa04', 'generating');
    const second = make(retried, 'img_0000aa05', 'processing'); second.sprite.attempts[1].result = null;
    const noSheet = make(walk, 'img_0000aa06', 'generating'); noSheet.sprite.attempts = [];
    const error = make(failed, 'img_0000aa07', 'processing');
    error.sprite.attempts = [error.sprite.attempts[0]]; error.sprite.attempts[0].result = null; error.sprite.regenerated = false;
    const cancelledNoSheet = make(noSheet, 'img_0000aa08', 'generating'); cancelledNoSheet.cancelRequested = true;
    const cancelledSheet = make(queued, 'img_0000aa09', 'generating', 'queued'); cancelledSheet.cancelRequested = true;
    fs.writeFileSync(path.join(DIR, 'data', 'jobs.json'), JSON.stringify([
      passing, count, queued, running, second, noSheet, error, cancelledNoSheet, cancelledSheet,
    ]));
    const restart = spawn(process.execPath, [path.join(DIR, 'host.js')], { cwd: DIR,
      env: { ...process.env, [identity.PIPE_ENV]: PIPE }, stdio: ['pipe', 'ignore', 'ignore'] });
    const restartExited = new Promise(resolve => restart.once('exit', resolve));
    try {
      for (let i = 0; ; i++) {
        try { await call('status'); break; } catch (e) { if (i >= 500) throw e; await sleep(30); }
      }
      for (const job of [passing, count, queued, running, second]) {
        const done = await call('job', { jobId: job.id });
        assert.equal(done.status, 'succeeded', done.error);
        assert.ok(done.images[0].gif); assert.ok(fs.existsSync(done.images[0].preview));
        assert.equal(done.sprite.attempts.length, job.sprite.attempts.length);
        if ([count, queued, running].includes(job)) assert.match(done.sprite.warning, /Chrome closed \/ the bridge restarted/);
        else assert.equal(done.sprite.warning, null);
        assert.equal(done.sprite.chosen, job === second ? 1 : 0);
      }
      assert.match((await call('job', { jobId: noSheet.id })).error, /Interrupted:/);
      const failedJob = await call('job', { jobId: error.id });
      assert.equal(failedJob.status, 'failed'); assert.match(failedJob.error, /animate_sheet/);
      assert.equal(failedJob.images.length, 1); assert.ok(fs.existsSync(failedJob.images[0].path));
      for (const job of [cancelledNoSheet, cancelledSheet]) {
        const done = await call('job', { jobId: job.id });
        assert.equal(done.status, 'cancelled'); assert.equal(done.message, done.error);
        assert.deepEqual(done.images.map(i => i.path), job.sprite.attempts.map(a => a.sheet.path));
        assert.equal(done.error, job === cancelledNoSheet ? 'Cancelled.' : `Cancelled. Saved sprite sheet(s): ${job.sprite.attempts[0].sheet.path}`);
      }
      assert.deepEqual((await call('status')).queued, []);
    } finally { restart.stdin.end(); await restartExited; }
  });
});

test('cleanup reservations block referenced jobs, allow other chats and resume on mark, release or expiry', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(ROOT, 'host.js'), 'utf8').split('// ---------------------------------------------------------------- start')[0];
  const a = '6812a3b4-1c2d-8000-9e8f-0123456789ab';
  const b = '7812a3b4-1c2d-8000-9e8f-0123456789ab';
  const url = id => `https://chatgpt.com/c/${id}`;
  for (const end of ['archived', 'deleted', 'gone', 'release', 'expiry']) {
    let time = 100000;
    const timers = [], immediates = [], messages = [];
    class Clock extends Date { static now() { return time; } }
    const context = { module: { exports: {} }, Buffer, Date: Clock,
      process: { stdout: { write: frame => messages.push(JSON.parse(frame.subarray(4).toString('utf8'))) } },
      require: name => {
        if (name === './shared') return { LOG_DIR: DIR, readJson: (_file, fallback) => fallback, writeJson() {} };
        if (name === 'fs') return { mkdirSync() {}, statSync: () => ({ size: 0 }), appendFileSync() {} };
        if (name === 'net') return { createServer: () => ({}) };
        return require(name.startsWith('.') ? path.join(ROOT, name) : name);
      },
      setTimeout: (callback, ms) => { const timer = { callback, ms, cleared: false }; timers.push(timer); return timer; },
      clearTimeout: timer => { if (timer) timer.cleared = true; },
      setImmediate: callback => immediates.push(callback),
    };
    vm.runInNewContext(source + '\nmodule.exports = { jobs, handlers, pump, finishJob, createJob, ' +
      'connect: () => { extension = { version: "test" }; } };', context);
    const api = context.module.exports;
    api.connect();
    api.jobs.push({ id: 'owner', mode: 'generate', startUrl: null, status: 'succeeded', conversationUrl: url(a), images: [{}] });
    const check = reserve => api.handlers.chat_cleanup_check({ ids: [a], reserve });
    check(false);
    assert.equal(timers.length, 0);
    api.handlers.chat_cleanup_check({ ids: [a, b], reserve: true });
    assert.equal(timers.length, 0);
    assert.deepEqual(Array.from(check(true).eligible), [a]);
    const waiting = api.createJob({ prompt: 'Reserved chat', startUrl: url(a) });
    assert.equal(waiting.status, 'queued');
    assert.equal(messages.some(m => m.type === 'run'), false);
    const other = api.createJob({ prompt: 'Another chat', startUrl: url(b) });
    assert.equal(other.status, 'running');
    assert.deepEqual(messages.filter(m => m.type === 'run').map(m => m.job.id), [other.id]);
    api.finishJob(other, { status: 'failed' });
    while (immediates.length) immediates.shift()();
    assert.equal(waiting.status, 'queued');
    if (end === 'release') api.handlers.chat_cleanup_release({ id: a.toUpperCase() });
    else if (end === 'expiry') {
      const timer = timers.find(timer => timer.ms === 180000 && !timer.cleared);
      assert.ok(timer);
      time += 180000;
      timer.callback();
    } else api.handlers.chat_cleanup_mark({ id: a, state: end });
    while (immediates.length) immediates.shift()();
    assert.equal(timers.filter(timer => timer.ms === 180000 && !timer.cleared).length, 0);
    if (end === 'deleted' || end === 'gone') {
      assert.equal(waiting.status, 'failed');
      assert.equal(waiting.reason, end === 'gone' ? 'chat_gone' : 'chat_deleted');
      assert.equal(waiting.error, end === 'gone'
        ? 'This ChatGPT conversation no longer exists in ChatGPT. Start a new chat and pass the saved image in reference_images instead.'
        : 'This ChatGPT conversation was deleted by Backdraw chat cleanup. Start a new chat and pass the saved image in reference_images instead.');
      assert.equal(messages.some(m => m.type === 'run' && m.job.id === waiting.id), false);
    } else {
      assert.equal(waiting.status, 'running', end);
      assert.equal(messages.filter(m => m.type === 'run' && m.job.id === waiting.id).length, 1);
    }
  }
});

test('sprite cancellation clears its fallback and previews, and stale callbacks cannot disturb another run', () => {
  const vm = require('node:vm');
  // Load the real handlers without starting a pipe or touching persistent files.
  const source = fs.readFileSync(path.join(ROOT, 'host.js'), 'utf8').split('// ---------------------------------------------------------------- start')[0];
  const timers = [], immediates = [], messages = [];
  const context = { module: { exports: {} }, Buffer,
    process: { stdout: { write: frame => messages.push(JSON.parse(frame.subarray(4).toString('utf8'))) } },
    require: name => {
      if (name === './shared') return { LOG_DIR: DIR, readJson: (_file, fallback) => fallback, writeJson() {} };
      if (name === 'fs') return { mkdirSync() {}, statSync: () => ({ size: 0 }), appendFileSync() {} };
      if (name === 'net') return { createServer: () => ({}) };
      return require(name.startsWith('.') ? path.join(ROOT, name) : name);
    },
    setTimeout: (callback, ms) => { const timer = { callback, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimeout: timer => { if (timer) timer.cleared = true; },
    setImmediate: callback => immediates.push(callback),
  };
  vm.runInNewContext(source + '\nmodule.exports = { jobs, cancelJob, onResult, processSpriteJob, finishJob, cancelTimers, pump, ' +
    'connect: () => { extension = { version: "test" }; }, running: () => runningId, setRunning: id => { runningId = id; } };', context);
  const api = context.module.exports;
  const makeJob = id => ({ id, status: 'running', prompt: 'A frog', references: [], images: [],
    sprite: { state: 'generating', attempts: [], regenerated: false } });
  const job = makeJob('cancelled-sprite');
  const result = { gates: [] };
  Object.defineProperty(result, 'sheet', { value: { png: Buffer.alloc(100) }, configurable: true });
  job.sprite.attempts.push({ sheet: { path: 'saved-sheet.png' }, result });
  api.jobs.push(job); api.setRunning(job.id);
  api.cancelJob(job.id); api.cancelJob(job.id);
  assert.equal(job.cancelRequested, true);
  assert.equal(timers.length, 1); assert.equal(timers[0].ms, 20000);
  assert.equal(messages.filter(m => m.type === 'cancel').length, 2);
  api.onResult({ jobId: job.id, status: 'cancelled' });
  assert.equal(job.status, 'cancelled'); assert.equal(api.running(), null);
  assert.equal(timers[0].cleared, true); assert.equal(api.cancelTimers.size, 0);
  assert.equal(Object.hasOwn(result, 'sheet'), false);
  const next = makeJob('next-sprite'); api.jobs.push(next); api.setRunning(next.id);
  const queuedCallbacks = immediates.length;
  timers[0].callback();
  assert.equal(job.status, 'cancelled'); assert.equal(next.status, 'running');
  assert.equal(api.running(), next.id); assert.equal(immediates.length, queuedCallbacks);
  // Even an unfinished old job cannot release a different job's current run.
  job.status = 'running'; timers[0].callback();
  assert.equal(job.status, 'running'); assert.equal(api.running(), next.id);
  job.status = 'cancelled';

  const processing = makeJob('processing-sprite');
  processing.sprite.state = 'processing'; processing.cancelRequested = true;
  processing.sprite.attempts.push({ sheet: { path: 'unprocessed-sheet.png' }, result: null });
  api.jobs.push(processing);
  api.processSpriteJob(processing);
  assert.equal(processing.status, 'cancelled'); assert.equal(processing.sprite.regenerated, false);
  assert.equal(processing.sprite.attempts[0].result, null);
  assert.equal(processing.images[0].path, 'unprocessed-sheet.png');
  assert.equal(api.running(), next.id);

  for (const status of ['succeeded', 'failed']) {
    const terminal = makeJob(`finished-${status}`), summary = {};
    Object.defineProperty(summary, 'sheet', { value: { png: Buffer.alloc(100) }, configurable: true });
    terminal.sprite.attempts.push({ sheet: { path: 'raw-sheet.png' }, result: summary });
    api.finishJob(terminal, { status });
    assert.equal(Object.hasOwn(summary, 'sheet'), false); assert.equal(terminal.sprite.state, 'done');
  }

  const failed = makeJob('disk-error');
  failed.sprite.attempts.push({ sheet: { path: 'disk-error-sheet.png' }, result: { error: 'Disk full', code: 'ENOSPC', retryable: false } });
  api.processSpriteJob(failed);
  assert.equal(failed.status, 'failed'); assert.equal(failed.sprite.regenerated, false);
  assert.equal(failed.sprite.attempts.length, 1); assert.equal(failed.message, 'Sprite processing failed');
  assert.match(failed.error, /Disk full.*disk-error-sheet.png/);
  assert.equal(api.running(), next.id);

  const fallback = makeJob('no-extension-reply'); api.jobs.push(fallback); api.setRunning(fallback.id);
  api.cancelJob(fallback.id);
  const fallbackTimer = timers.at(-1);
  assert.equal(fallbackTimer.ms, 20000); fallbackTimer.callback();
  assert.equal(fallback.status, 'cancelled'); assert.equal(fallback.message, 'Cancelled.');
  assert.equal(api.running(), null); assert.equal(fallbackTimer.cleared, true);
  assert.equal(api.cancelTimers.size, 0);

  // A watchdog expiring just after cancel_job must also honor the pending cancellation.
  next.status = 'succeeded';
  const timeout = { ...makeJob('watchdog-race'), status: 'queued', project: PROJECT, timeoutSec: 60 };
  api.jobs.push(timeout); api.connect(); api.pump();
  assert.equal(api.running(), timeout.id);
  const watchdogTimer = timers.at(-1);
  api.cancelJob(timeout.id);
  const cancellationTimer = timers.at(-1);
  watchdogTimer.callback();
  assert.equal(timeout.status, 'cancelled'); assert.equal(timeout.error, 'Cancelled.');
  assert.equal(api.running(), null); assert.equal(cancellationTimer.cleared, true);
});

test('chat cleanup host API and completion messages survive a restart', async t => {
  const tag = `${TAG}-cleanup`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`));
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\${tag}` : path.join(os.tmpdir(), `${tag}.sock`);
  const a = '9812a3b4-1c2d-8000-9e8f-0123456789ab';
  const b = 'a812a3b4-1c2d-8000-9e8f-0123456789ab';
  const unknown = 'b812a3b4-1c2d-8000-9e8f-0123456789ab';
  const url = id => `https://chatgpt.com/c/${id}`;
  const messages = [], traffic = [];
  let host, exit;
  for (const f of ['host.js', 'shared.js', 'identity.js', 'package.json', 'lib', 'platform', 'extension/gifframes.js']) {
    fs.cpSync(path.join(ROOT, f), path.join(dir, f), { recursive: true });
  }
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data', 'config.json'), JSON.stringify({
    project: PROJECT, outputDir: path.join(dir, 'images'), collectionsDir: path.join(dir, 'refs'),
  }));
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const sock = net.connect(pipe);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('error', reject);
    sock.on('connect', () => sock.write(JSON.stringify({ id: 1, method, params }) + '\n'));
    sock.on('data', chunk => {
      buf += chunk;
      if (!buf.includes('\n')) return;
      sock.destroy();
      const reply = JSON.parse(buf.slice(0, buf.indexOf('\n')));
      if (reply.error) reject(Object.assign(new Error(reply.error.message), { code: reply.error.code }));
      else resolve(reply.result);
    });
  });
  const send = msg => {
    traffic.push(msg);
    const body = Buffer.from(JSON.stringify(msg)), head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    host.stdin.write(Buffer.concat([head, body]));
  };
  const receive = predicate => until(() => {
    const i = messages.findIndex(predicate);
    return i >= 0 && messages.splice(i, 1)[0];
  }, 'cleanup host message');
  let seq = 0;
  const extensionCall = async (method, params = {}) => {
    const reqId = `cleanup-${++seq}`;
    send({ type: 'call', reqId, method, params });
    const reply = await receive(msg => msg.type === 'reply' && msg.reqId === reqId);
    if (!reply.ok) throw Object.assign(new Error(reply.error), { code: reply.code });
    return reply.result;
  };
  const start = async () => {
    let buffer = Buffer.alloc(0);
    host = spawn(process.execPath, [path.join(dir, 'host.js')], { cwd: dir,
      env: { ...process.env, [identity.PIPE_ENV]: pipe }, stdio: ['pipe', 'pipe', 'ignore'] });
    exit = new Promise(resolve => host.once('exit', resolve));
    host.stdout.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
        const size = buffer.readUInt32LE(0);
        const msg = JSON.parse(buffer.subarray(4, size + 4).toString('utf8'));
        messages.push(msg); traffic.push(msg);
        buffer = buffer.subarray(size + 4);
      }
    });
    await until(asyncReady, 'cleanup host startup');
    send({ type: 'hello', version: 'test' });
    await receive(msg => msg.type === 'welcome');
  };
  let ready = false, checking = false;
  const asyncReady = () => {
    if (!checking && !ready) {
      checking = true;
      request('status').then(() => { ready = true; }, () => {}).finally(() => { checking = false; });
    }
    return ready;
  };
  const stop = async () => { host.stdin.end(); await exit; ready = false; };
  const finish = async (job, conversationUrl, ok = true) => {
    await receive(msg => msg.type === 'run' && msg.job.id === job.id);
    send({ type: 'result', jobId: job.id, conversationUrl, ok, status: ok ? 'succeeded' : 'failed',
      ...(ok ? { images: [{ data: b64(JPEG), mime: 'image/jpeg' }] } : { error: 'Test failure' }) });
    let done;
    await until(() => {
      if (!checking) {
        checking = true;
        request('job', { jobId: job.id }).then(value => { done = value; }).finally(() => { checking = false; });
      }
      return done && !['queued', 'running'].includes(done.status) && done;
    }, 'cleanup job completion');
    return done;
  };
  try {
    await start();
    let owner, returning;
    await t.test('success sends only the documented completion fields; failure and existing chats do not', async () => {
      owner = await request('generate', { prompt: 'Cleanup image' });
      assert.equal(owner.chatStates, null);
      await finish(owner, url(a));
      const msg = await receive(m => m.type === 'chat_done' && m.jobId === owner.id);
      assert.deepEqual(Object.keys(msg).sort(), ['chats', 'jobId', 'type']);
      assert.deepEqual(msg, { type: 'chat_done', jobId: owner.id, chats: [{ id: a, url: url(a) }] });
      assert.deepEqual(Object.keys(msg.chats[0]).sort(), ['id', 'url']);
      const failed = await request('generate', { prompt: 'Failed cleanup image' });
      await finish(failed, url(b), false);
      returning = await request('generate', { prompt: 'Existing cleanup chat', startUrl: url(a) });
      await finish(returning, url(a));
      await extensionCall('chat_cleanup_list');
      assert.equal(traffic.filter(m => m.type === 'chat_done').length, 1);
    });
    await t.test('check validates ids and rechecks a queued start URL before marking', async () => {
      for (const ids of [null, {}, Array(201).fill(a)]) {
        await assert.rejects(extensionCall('chat_cleanup_check', { ids }), { code: 'BAD_REQUEST' });
      }
      assert.deepEqual(await extensionCall('chat_cleanup_check', { ids: [a.toUpperCase(), unknown, null, 1, 'short'] }), { eligible: [a] });
      const blocker = await request('generate', { prompt: 'Queue blocker' });
      await receive(m => m.type === 'run' && m.job.id === blocker.id);
      const queued = await request('generate', { prompt: 'Queued cleanup reference', startUrl: url(a) });
      assert.equal(queued.status, 'queued');
      assert.deepEqual(await extensionCall('chat_cleanup_check', { ids: [a] }), { eligible: [] });
      await request('cancel', { jobId: queued.id });
      send({ type: 'result', jobId: blocker.id, ok: false, status: 'failed', error: 'Blocker complete' });
      // A reply on the same stdio stream confirms the preceding result was handled.
      await extensionCall('chat_cleanup_list');
      assert.equal((await request('job', { jobId: blocker.id })).status, 'failed');
      const recovered = await request('generate', { prompt: 'Cleanup reference recovery', startUrl: url(a) });
      await finish(recovered, url(a));
      assert.deepEqual(await extensionCall('chat_cleanup_check', { ids: [a] }), { eligible: [a] });
    });
    await t.test('mark validates ownership and state, copies state to every reference and persists it', async () => {
      for (const id of [null, 'short', 12]) {
        await assert.rejects(extensionCall('chat_cleanup_mark', { id, state: 'deleted' }), { code: 'BAD_REQUEST' });
      }
      await assert.rejects(extensionCall('chat_cleanup_mark', { id: unknown, state: 'deleted' }), {
        code: 'BAD_REQUEST', message: 'Not a chat this bridge opened.',
      });
      await assert.rejects(extensionCall('chat_cleanup_mark', { id: a, state: 'invalid' }), { code: 'BAD_REQUEST' });
      await extensionCall('chat_cleanup_mark', { id: a, state: 'failed', error: 'x'.repeat(250) });
      await receive(m => m.type === 'gallery_changed');
      const failed = (await request('job', { jobId: owner.id })).chatStates[a];
      assert.equal(failed.error, 'not_confirmed');
      await extensionCall('chat_cleanup_mark', { id: a, state: 'failed', error: 'Private title: free text' });
      await receive(m => m.type === 'gallery_changed');
      assert.equal((await request('job', { jobId: owner.id })).chatStates[a].error, 'not_confirmed');
      await extensionCall('chat_cleanup_mark', { id: a, state: 'failed', error: 'title_mismatch' });
      await receive(m => m.type === 'gallery_changed');
      assert.equal((await request('job', { jobId: owner.id })).chatStates[a].error, 'title_mismatch');
      assert.equal(failed.state, 'failed'); assert.ok(Number.isFinite(Date.parse(failed.at)));
      assert.deepEqual(await extensionCall('chat_cleanup_check', { ids: [a] }), { eligible: [a] });
      assert.deepEqual(await extensionCall('chat_cleanup_mark', { id: a.toUpperCase(), state: 'archived', error: 'Ignored' }), { id: a, state: 'archived' });
      await receive(m => m.type === 'gallery_changed');
      assert.equal((await request('job', { jobId: owner.id })).chatStates[a].error, null);
      const archivedReturn = await request('generate', { prompt: 'Archived chat remains usable', startUrl: url(a) });
      await finish(archivedReturn, url(a));
      assert.deepEqual(await extensionCall('chat_cleanup_mark', { id: a, state: 'deleted' }), { id: a, state: 'deleted' });
      await receive(m => m.type === 'gallery_changed');
      const stored = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'jobs.json'), 'utf8'));
      for (const job of stored.filter(j => j.startUrl === url(a) || j.conversationUrl === url(a))) {
        assert.deepEqual(job.chatStates[a], stored.find(j => j.id === owner.id).chatStates[a]);
      }
      await stop(); await start();
      const plan = await extensionCall('chat_cleanup_list');
      assert.equal(plan.maxJobs, 100);
      assert.deepEqual(plan.cleaned, { archived: 0, deleted: 1, gone: 0 });
      assert.deepEqual(plan.eligible, []);
      assert.equal((await request('job', { jobId: returning.id })).chatStates[a].state, 'deleted');
    });
    await t.test('deleted conversations reject new jobs without adding history', async () => {
      const before = (await extensionCall('chat_cleanup_list')).jobsScanned;
      await assert.rejects(request('generate', { prompt: 'Deleted chat', startUrl: url(a) }), {
        code: 'CHAT_DELETED',
        message: 'This ChatGPT conversation was deleted by Backdraw chat cleanup. Start a new chat and pass the saved image in reference_images instead.',
      });
      assert.equal((await extensionCall('chat_cleanup_list')).jobsScanned, before);
    });
    await t.test('gone conversations are final: marks are refused, new jobs are rejected and queued jobs fail', async () => {
      const goneMessage = 'This ChatGPT conversation no longer exists in ChatGPT. Start a new chat and pass the saved image in reference_images instead.';
      // A queued job that references the chat before ChatGPT is found to have lost it.
      const blocker = await request('generate', { prompt: 'Gone blocker' });
      await receive(m => m.type === 'run' && m.job.id === blocker.id);
      const queued = await request('generate', { prompt: 'Queued before gone', startUrl: url(b) });
      assert.equal(queued.status, 'queued');
      assert.deepEqual(await extensionCall('chat_cleanup_mark', { id: b, state: 'gone', error: 'Private title: free text' }), { id: b, state: 'gone' });
      await receive(m => m.type === 'gallery_changed');
      const lost = await request('job', { jobId: queued.id });
      assert.equal(lost.chatStates[b].state, 'gone');
      assert.equal(lost.chatStates[b].error, null);
      send({ type: 'result', jobId: blocker.id, ok: false, status: 'failed', error: 'Blocker complete' });
      let failedQueued;
      for (let i = 0; i < 100 && failedQueued?.status !== 'failed'; i++) {
        if (i) await sleep(20);
        failedQueued = await request('job', { jobId: queued.id });
      }
      assert.equal(failedQueued.reason, 'chat_gone');
      assert.equal(failedQueued.error, goneMessage);
      assert.equal(traffic.some(m => m.type === 'run' && m.job.id === queued.id), false);
      // Final: no later mark, no new job, no cleanup list entry.
      for (const state of ['archived', 'deleted', 'failed', 'gone']) {
        await assert.rejects(extensionCall('chat_cleanup_mark', { id: b, state }), { code: 'BAD_REQUEST', message: 'This chat is already gone from ChatGPT.' });
      }
      const before = (await extensionCall('chat_cleanup_list')).jobsScanned;
      await assert.rejects(request('generate', { prompt: 'Gone chat', startUrl: url(b) }), { code: 'CHAT_GONE', message: goneMessage });
      const plan = await extensionCall('chat_cleanup_list');
      assert.equal(plan.jobsScanned, before);
      assert.deepEqual(plan.cleaned, { archived: 0, deleted: 1, gone: 1 });
      assert.deepEqual(await extensionCall('chat_cleanup_check', { ids: [b], action: 'delete' }), { eligible: [] });
    });
    await t.test('cleanup traffic and scratch host logs contain no session secrets', () => {
      const forbidden = /\x74oken|\x63ookie|\x41uthorization/i;
      assert.doesNotMatch(JSON.stringify(traffic), forbidden);
      const log = fs.readFileSync(path.join(dir, 'logs', 'host.log'), 'utf8');
      assert.doesNotMatch(log, forbidden);
      const marks = log.split('\n').filter(line => line.includes(`chat ${a} `));
      assert.equal(marks.length, 5); // three original marks plus two extra failed marks for the error-code checks
      for (const line of marks) assert.match(line, new RegExp(`\\[info\\] chat ${a} (failed|archived|deleted)$`));
    });
  } finally {
    if (host && host.exitCode === null) await stop();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith(`${tag}-`));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanup check honors the action, archived chats are deletable and deleted chats are final', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(ROOT, 'host.js'), 'utf8').split('// ---------------------------------------------------------------- start')[0];
  const a = '6812a3b4-1c2d-8000-9e8f-0123456789ab';
  const b = '7812a3b4-1c2d-8000-9e8f-0123456789ab';
  const url = id => `https://chatgpt.com/c/${id}`;
  const timers = [];
  const context = { module: { exports: {} }, Buffer, Date,
    process: { stdout: { write() {} } },
    require: name => {
      if (name === './shared') {
        class BridgeError extends Error { constructor(message, code) { super(message); this.code = code; } }
        return { LOG_DIR: DIR, readJson: (_file, fallback) => fallback, writeJson() {}, BridgeError };
      }
      if (name === 'fs') return { mkdirSync() {}, statSync: () => ({ size: 0 }), appendFileSync() {} };
      if (name === 'net') return { createServer: () => ({}) };
      return require(name.startsWith('.') ? path.join(ROOT, name) : name);
    },
    setTimeout: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; },
    clearTimeout() {}, setImmediate() {},
  };
  vm.runInNewContext(source + '\nmodule.exports = { jobs, handlers, connect: () => { extension = { version: "test" }; } };', context);
  const api = context.module.exports;
  api.connect();
  api.jobs.push({ id: 'one', mode: 'generate', startUrl: null, status: 'succeeded', conversationUrl: url(a), images: [{}] });
  api.jobs.push({ id: 'two', mode: 'generate', startUrl: null, status: 'succeeded', conversationUrl: url(b), images: [{}] });
  const check = (action, extra = {}) => api.handlers.chat_cleanup_check({ ids: [a, b], ...(action ? { action } : {}), ...extra }).eligible;
  assert.deepEqual(check(), [a, b]);
  assert.deepEqual(check('delete'), [a, b]);
  api.handlers.chat_cleanup_mark({ id: a, state: 'archived' });
  assert.deepEqual(check(), [b]);
  assert.deepEqual(check('archive'), [b]);
  assert.deepEqual(check('delete'), [a, b]);
  const list = api.handlers.chat_cleanup_list();
  assert.deepEqual(list.eligible.map(chat => chat.id), [b]);
  assert.deepEqual(list.deletable.map(chat => [chat.id, !!chat.archived]), [[a, true], [b, false]]);
  // A delete check reserves the archived chat like any other.
  assert.equal(check('delete', { ids: [a], reserve: true }).length, 1);
  const marked = api.handlers.chat_cleanup_mark({ id: a, state: 'deleted' });
  assert.deepEqual({ id: marked.id, state: marked.state }, { id: a, state: 'deleted' });
  assert.throws(() => api.handlers.chat_cleanup_mark({ id: a, state: 'archived' }), { code: 'BAD_REQUEST', message: 'This chat was already deleted.' });
  assert.throws(() => api.handlers.chat_cleanup_mark({ id: a, state: 'failed' }), { code: 'BAD_REQUEST' });
  assert.deepEqual(check('delete'), [b]);
  assert.deepEqual(check('archive'), [b]);
  const after = api.handlers.chat_cleanup_list();
  assert.deepEqual(after.deletable.map(chat => chat.id), [b]);
  assert.deepEqual(after.eligible.map(chat => chat.id), [b]);
  assert.deepEqual(after.cleaned, { archived: 0, deleted: 1, gone: 0 });
});

test('a chat found gone leaves every cleanup list, takes archived to gone and is final', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(ROOT, 'host.js'), 'utf8').split('// ---------------------------------------------------------------- start')[0];
  const a = '6812a3b4-1c2d-8000-9e8f-0123456789ab';
  const b = '7812a3b4-1c2d-8000-9e8f-0123456789ab';
  const url = id => `https://chatgpt.com/c/${id}`;
  const context = { module: { exports: {} }, Buffer, Date,
    process: { stdout: { write() {} } },
    require: name => {
      if (name === './shared') {
        class BridgeError extends Error { constructor(message, code) { super(message); this.code = code; } }
        return { LOG_DIR: DIR, readJson: (_file, fallback) => fallback, writeJson() {}, BridgeError };
      }
      if (name === 'fs') return { mkdirSync() {}, statSync: () => ({ size: 0 }), appendFileSync() {} };
      if (name === 'net') return { createServer: () => ({}) };
      return require(name.startsWith('.') ? path.join(ROOT, name) : name);
    },
    setTimeout: (callback, ms) => ({ callback, ms }), clearTimeout() {}, setImmediate() {},
  };
  vm.runInNewContext(source + '\nmodule.exports = { jobs, handlers, createJob, connect: () => { extension = { version: "test" }; } };', context);
  const api = context.module.exports;
  api.connect();
  api.jobs.push({ id: 'one', mode: 'generate', startUrl: null, status: 'succeeded', conversationUrl: url(a), images: [{}] });
  api.jobs.push({ id: 'two', mode: 'generate', startUrl: null, status: 'succeeded', conversationUrl: url(b), images: [{}] });
  api.handlers.chat_cleanup_mark({ id: a, state: 'archived' });
  const marked = api.handlers.chat_cleanup_mark({ id: a, state: 'gone', error: 'not_confirmed' });
  assert.deepEqual({ id: marked.id, state: marked.state }, { id: a, state: 'gone' });
  assert.equal(api.jobs[0].chatStates[a].state, 'gone');
  assert.equal(api.jobs[0].chatStates[a].error, null);
  for (const state of ['archived', 'deleted', 'failed', 'gone']) {
    assert.throws(() => api.handlers.chat_cleanup_mark({ id: a, state }), { code: 'BAD_REQUEST', message: 'This chat is already gone from ChatGPT.' });
  }
  assert.deepEqual(Array.from(api.handlers.chat_cleanup_check({ ids: [a, b], action: 'delete' }).eligible), [b]);
  assert.deepEqual(Array.from(api.handlers.chat_cleanup_check({ ids: [a, b], action: 'archive' }).eligible), [b]);
  const list = api.handlers.chat_cleanup_list();
  assert.deepEqual(list.eligible.map(chat => chat.id), [b]);
  assert.deepEqual(list.deletable.map(chat => chat.id), [b]);
  assert.deepEqual(list.cleaned, { archived: 0, deleted: 0, gone: 1 });
  assert.throws(() => api.createJob({ prompt: 'Gone chat', startUrl: url(a) }), {
    code: 'CHAT_GONE',
    message: 'This ChatGPT conversation no longer exists in ChatGPT. Start a new chat and pass the saved image in reference_images instead.',
  });
});
