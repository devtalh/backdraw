'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { FINAL, DEFAULT_WAIT, EDIT_INTENT, waitSeconds, editCheckLines, imageLines, referenceLines, resultLines } = require('../lib/results');

const CHAT_URL = 'https://chatgpt.com/g/g-p-67a1b2c3d4e5f60718293a4b5c6d7e8f-images/c/6812a3b4-1c2d-8000-9e8f-0123456789ab';
const job = fields => ({ id: 'img_1a2b3c4d', prompt: 'a void mage', images: [], copies: [], references: [], ...fields });
const check = (...similarities) => ({ results: similarities.map((similarity, i) => ({ similarity, against: `ref${i + 1}.png` })) });
const text = j => resultLines(j).join('\n');

test('final statuses and the default wait', () => {
  assert.deepEqual([...FINAL].sort(), ['cancelled', 'failed', 'needs_reference', 'succeeded', 'text_reply']);
  assert.equal(DEFAULT_WAIT, 45);
});

test('waitSeconds: 45 unless wait_seconds is a number, clamped to 0-900', () => {
  assert.equal(waitSeconds({}), 45);
  assert.equal(waitSeconds({ wait_seconds: null }), 45);
  assert.equal(waitSeconds({ wait_seconds: '' }), 45);
  assert.equal(waitSeconds({ wait_seconds: 'soon' }), 45);
  assert.equal(waitSeconds({ wait_seconds: 5000 }), 900);
  assert.equal(waitSeconds({ wait_seconds: -1 }), 0);
  assert.equal(waitSeconds({ wait_seconds: 0 }), 0);
  assert.equal(waitSeconds({ wait_seconds: '30' }), 30);
  assert.equal(waitSeconds({ wait_seconds: 12.6 }), 13);
});

test('editCheckLines: no check, nothing to say', () => {
  assert.deepEqual(editCheckLines(job({})), []);
  assert.deepEqual(editCheckLines(job({ editCheck: { results: [] } })), []);
});

test('editCheckLines: 75% or more unchanged is a real edit', () => {
  const lines = editCheckLines(job({ prompt: 'edit: close the eyes', editCheck: check(0.75) }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^Edit check: 75% of the image is unchanged compared with ref1\.png/);
  assert.match(lines[0], /\(edited: true\)/);
  assert.match(editCheckLines(job({ editCheck: check(0.98) }))[0], /98%.*edited: true/);
});

test('editCheckLines: under 75% with an edit request warns', () => {
  const [line] = editCheckLines(job({ prompt: 'Edit the image: only change the sky', editCheck: check(0.4) }));
  assert.match(line, /EDIT CHECK \(edited: false\)/);
  assert.match(line, /only 40% of the image matches ref1\.png/);
  assert.match(line, /reference_images=\[the original image file\]/);
});

test('editCheckLines: at the 75% boundary the verdict follows the shown percentage', () => {
  assert.match(editCheckLines(job({ prompt: 'keep everything else', editCheck: check(0.7449) }))[0], /EDIT CHECK \(edited: false\): only 74% /);
  assert.match(editCheckLines(job({ prompt: 'keep everything else', editCheck: check(0.74) }))[0], /EDIT CHECK \(edited: false\): only 74% /);
  // The extension rounds to hundredths; anything shown as 75% counts as an edit.
  assert.match(editCheckLines(job({ prompt: 'keep everything else', editCheck: check(0.7499) }))[0], /^Edit check: 75% .*\(edited: true\)/);
});

test('editCheckLines: under 75% without an edit request is a neutral note', () => {
  const [line] = editCheckLines(job({ prompt: 'a castle at night', editCheck: check(0.3) }));
  assert.equal(line, 'Similarity to ref1.png: 30% (a local edit keeps ~95-100%, a redraw is usually under 60%).');
  assert.equal(editCheckLines(job({ prompt: undefined, editCheck: check(0.3) }))[0], line);
});

test('editCheckLines: only collection images attached is never a failed edit', () => {
  const col = { name: 'Cats', used: ['002_b.png', '001_a.png'], total: 2 };
  const refs = names => names.map(name => ({ name, bytes: 1 }));
  const neutral = 'Similarity to ref1.png: 30% (a local edit keeps ~95-100%, a redraw is usually under 60%).';
  const onlyCol = { prompt: 'the same character from my collection riding a bike', references: refs(['002_b.png', '001_a.png']), collection: col };
  assert.deepEqual(editCheckLines(job({ ...onlyCol, editCheck: check(0.3) })), [neutral]);
  assert.match(editCheckLines(job({ ...onlyCol, editCheck: check(0.9) }))[0], /^Similarity to ref1\.png: 90% /);
  // An own image to edit next to the collection images: the warning still applies.
  const withOwn = { ...onlyCol, references: refs(['mine.png', '002_b.png', '001_a.png']), editCheck: check(0.3) };
  assert.match(editCheckLines(job(withOwn))[0], /EDIT CHECK \(edited: false\)/);
});

test('editCheckLines: the least similar output decides', () => {
  const [line] = editCheckLines(job({ prompt: 'edit it', editCheck: check(0.97, 0.5, 0.9) }));
  assert.match(line, /EDIT CHECK \(edited: false\): only 50% of the image matches ref2\.png/);
  assert.match(editCheckLines(job({ editCheck: check(0.9, 0.8) }))[0], /80% .* ref2\.png .*edited: true/);
});

test('edit intent: English and Turkish wording', () => {
  for (const p of ['Edit this', 'modify the colors', 'retouch the face', 'change only the hat', 'keep the rest', 'same pose, new outfit',
    'pixel-identical except the eyes', 'Make these edits: close the eyes', 'editing the photo: remove the hat', 'the edited version',
    'modifying the light', 'it modifies the sky', 'retouched skin', 'inpainting the sky', 'change the background only',
    'Gözleri kapat, gerisini düzenle', 'arka planı değiştir', 'karakter aynı kalsın',
    'yüzü aynı bırak', 'rengi koru', 'yüzü koruyarak yeniden çiz']) {
    assert.ok(EDIT_INTENT.test(p), p);
  }
  for (const p of ['a castle at night', 'credit card', 'korusun', 'a new image of a dragon', 'a video editor at her desk', 'an editorial photo',
    'a credited author', 'a chameleon that can change color']) assert.ok(!EDIT_INTENT.test(p), p);
  const [line] = editCheckLines(job({ prompt: 'sadece gözleri değiştir', editCheck: check(0.2) }));
  assert.match(line, /EDIT CHECK \(edited: false\)/);
});

test('resultLines: succeeded with saved files, copies and a copy error', () => {
  const lines = resultLines(job({
    status: 'succeeded', conversationUrl: CHAT_URL,
    images: [{ path: 'C:\\Pictures\\Backdraw\\a.png', width: 1024, height: 1536 }, { path: 'C:\\Pictures\\Backdraw\\b.png' }],
    copies: ['D:\\game\\assets\\a.png'], copyError: 'EACCES: permission denied',
    references: [{ name: 'ref.png' }], assistantText: 'Here is your image.',
  }));
  assert.deepEqual(lines, [
    'SUCCESS — ChatGPT generated 2 image(s). Job img_1a2b3c4d.',
    `ChatGPT conversation: ${CHAT_URL}`,
    'Reference images attached: ref.png',
    'Saved: C:\\Pictures\\Backdraw\\a.png (1024x1536)',
    'Saved: C:\\Pictures\\Backdraw\\b.png',
    'Copied to: D:\\game\\assets\\a.png',
    'Could not copy into output_dir: EACCES: permission denied',
    "ChatGPT's text: Here is your image.",
  ]);
});

test('resultLines: succeeded after a re-attach notes it', () => {
  assert.match(text(job({ status: 'succeeded', reattached: true, images: [{ path: 'a.png' }] })), /the bridge re-attached it and asked once more/);
  assert.doesNotMatch(text(job({ status: 'failed', reattached: true, error: 'x' })), /re-attached it and asked once more/);
});

test('resultLines: queued shows the queue position and how to keep waiting', () => {
  const t = text(job({ status: 'queued', queuePosition: 2 }));
  assert.match(t, /^QUEUED — position 2 in the queue \(position 1 starts as soon as the running job, if any, is done\)\. Job img_1a2b3c4d\./);
  assert.match(t, /Call job_status with job_id="img_1a2b3c4d" and wait_seconds=45 again \(repeat until it finishes\), or cancel_job to stop it\./);
});

test('resultLines: queued without a known position says so', () => {
  const t = text(job({ status: 'queued' }));
  assert.match(t, /^QUEUED — position \? in the queue/);
  assert.match(t, /job_status with job_id="img_1a2b3c4d"/);
});

test('resultLines: running (and any other unfinished status) says STILL RUNNING', () => {
  assert.equal(resultLines(job({ status: 'running', step: 'generating', message: 'ChatGPT is generating the image' }))[0],
    'STILL RUNNING — ChatGPT is generating the image. Job img_1a2b3c4d. Call job_status with job_id="img_1a2b3c4d" and wait_seconds=45 again (repeat until it finishes), or cancel_job to stop it.');
  const t = text(job({ status: 'running', step: 'uploading', conversationUrl: CHAT_URL }));
  assert.match(t, /^STILL RUNNING — uploading\./);
  assert.match(t, /job_status/);
  assert.match(t, /wait_seconds=45/);
  assert.match(t, new RegExp(`ChatGPT conversation: ${CHAT_URL.replace(/[.?]/g, '\\$&')}`));
  assert.match(text(job({ status: 'starting', step: 'starting' })), /^STILL RUNNING — starting\./);
});

test('resultLines: needs_human asks for the user and how to check again', () => {
  const lines = resultLines(job({ status: 'needs_human', message: 'ChatGPT shows a human-verification page' }));
  assert.equal(lines[0], 'NEEDS USER ACTION — ChatGPT shows a human-verification page (job img_1a2b3c4d)');
  assert.match(lines[1], /open the ChatGPT tab in Chrome and complete it themselves; do not try to get around it/);
  assert.match(lines[1], /job_status\(job_id="img_1a2b3c4d", wait_seconds=45\)/);
});

test('resultLines: needs_reference lists the images already saved from the chat', () => {
  const lines = resultLines(job({
    status: 'needs_reference', reattached: true, conversationUrl: CHAT_URL,
    chatImages: [{ job: 'img_old1', path: 'C:\\Pictures\\Backdraw\\old.png', prompt: 'the first mage' }],
  }));
  assert.match(lines[0], /^NEEDS REFERENCE IMAGE — .*\(job img_1a2b3c4d\)\. It still asked after the bridge re-attached the image\.$/);
  assert.match(lines[1], /^Do NOT resend the same prompt\. .*auto_reattach=true/);
  assert.deepEqual(lines.slice(-2), [
    'Images already saved from this chat (newest first) — usable as reference_images:',
    '- C:\\Pictures\\Backdraw\\old.png  (img_old1: "the first mage")',
  ]);
  assert.doesNotMatch(resultLines(job({ status: 'needs_reference' }))[0], /re-attached/);
});

test('resultLines: text_reply shows ChatGPT\'s whole reply', () => {
  const reply = `Which aspect ratio would you like?\n${'x'.repeat(4000)}`;
  const lines = resultLines(job({ status: 'text_reply', assistantText: reply, conversationUrl: CHAT_URL }));
  assert.match(lines[0], /^CHATGPT REPLIED WITHOUT AN IMAGE \(job img_1a2b3c4d\)\./);
  assert.match(lines[0], /send_as_is=true/);
  assert.equal(lines[2], `ChatGPT's reply:\n${reply.slice(0, 3000)}`);
});

test('resultLines: failed and cancelled', () => {
  assert.equal(resultLines(job({ status: 'failed', error: 'ChatGPT did not return an image.' }))[0],
    'FAILED — ChatGPT did not return an image. (job img_1a2b3c4d)');
  assert.equal(resultLines(job({ status: 'failed' }))[0], 'FAILED — unknown error (job img_1a2b3c4d)');
  assert.deepEqual(resultLines(job({ status: 'cancelled' })), ['CANCELLED — job img_1a2b3c4d.']);
});

test('resultLines: a succeeded edit includes the edit check', () => {
  const t = text(job({ status: 'succeeded', prompt: 'düzenle: gözleri kapat', images: [{ path: 'a.png' }], editCheck: check(0.3) }));
  assert.match(t, /EDIT CHECK \(edited: false\)/);
});

// ---------------------------------------------------------------- aspect ratio and transparency

const DIR = 'C:\\Pictures\\Backdraw\\';
const RGBA = { colorType: 6, alphaChannel: true, trns: false };
const RGB = { colorType: 2, alphaChannel: false, trns: false };
const alpha = transparentShare => ({ transparentShare, opaqueShare: 1 - transparentShare });
const succeeded = (images, fields) => job({ status: 'succeeded', images, ...fields });
const RETRY = 'Tell the user; retry once in a fresh chat or remove the background with another tool.';

test('resultLines: a cropped image shows both files', () => {
  const lines = resultLines(succeeded([{
    path: `${DIR}banner.png`, width: 2172, height: 543, aspect: '4:1', png: RGB, alpha: null,
    full: { path: `${DIR}banner_full.png`, width: 2172, height: 724, bytes: 1 },
  }]));
  assert.deepEqual(lines, [
    'SUCCESS — ChatGPT generated 1 image(s). Job img_1a2b3c4d.',
    `Saved: ${DIR}banner.png (2172x543, cropped from the centre to 4:1)`,
    `Full image before cropping: ${DIR}banner_full.png (2172x724)`,
  ]);
});

test('resultLines: a crop that cut more than ChatGPT was told warns', () => {
  const lines = (aspect, [w, h], [fw, fh]) => imageLines(job({}), { path: 'a.png', width: w, height: h, aspect, full: { path: 'a_full.png', width: fw, height: fh } });
  const CHECK = 'Check the saved image for cut-off subjects or text; the full image is kept too.';
  // A 4:1 job is drawn at 3:1 with the top and bottom 12.5% allowed to go; a 5:2 image loses more.
  assert.equal(lines('4:1', [1983, 496], [1983, 793])[2],
    `⚠ ChatGPT drew 1983x793 instead of 3:1, so the crop removed 37.5% of the height (18.7% at the top and bottom each; it was told only 12.5% each may be cut off). ${CHECK}`);
  assert.match(lines('4:1', [1536, 384], [1536, 1024])[2], /^⚠ ChatGPT drew 1536x1024 instead of 3:1, so the crop removed 62\.5% of the height \(31\.3% at the top and bottom each; /);
  assert.match(lines('1:4', [362, 1448], [1086, 1448])[2], /^⚠ ChatGPT drew 1086x1448 instead of 1:3, so the crop removed 66\.7% of the width \(33\.3% at the left and right each; it was told only 12\.5% /);
  // A ratio ChatGPT draws itself: nothing was meant to be cut.
  assert.equal(lines('16:9', [1024, 576], [1024, 1536])[2],
    `⚠ ChatGPT drew 1024x1536 instead of 16:9, so the crop removed 62.5% of the height (31.3% at the top and bottom each). ${CHECK}`);
  assert.match(lines('16:9', [1410, 793], [1983, 793])[2], /^⚠ ChatGPT drew 1983x793 instead of 16:9, so the crop removed 28\.9% of the width \(14\.4% at the left and right each\)\. /);
  // Within 1% of the shape ChatGPT was asked for: as promised, no warning.
  assert.equal(lines('4:1', [2172, 543], [2172, 724]).length, 2);
  assert.equal(lines('4:1', [2172, 543], [2172, 730]).length, 2);
  assert.equal(lines('4:1', [2160, 540], [2160, 730]).length, 3);
  assert.equal(lines('100:27', [2172, 586], [2172, 724]).length, 2);
  // Sizes unknown: nothing to compare.
  assert.equal(imageLines(job({}), { path: 'a.png', aspect: '4:1', full: { path: 'a_full.png' } }).length, 2);
});

test('resultLines: an aspect ratio already within 1% is not cropped', () => {
  assert.deepEqual(resultLines(succeeded([{ path: `${DIR}a.png`, width: 1672, height: 941, aspect: '16:9', full: null }])).slice(1), [
    `Saved: ${DIR}a.png (1672x941)`,
    'Aspect ratio: 16:9 requested, got 1672x941 (within 1%, not cropped).',
  ]);
  assert.match(text(succeeded([{ path: 'a.png', width: 1010, height: 1000, aspect: '1:1' }])), /got 1010x1000 \(within 1%, not cropped\)/);
});

test('resultLines: an image that should have been cropped but was not says so', () => {
  assert.match(text(succeeded([{ path: 'a.png', width: 1254, height: 1254, aspect: '16:9' }])),
    /^⚠ Aspect ratio: 16:9 requested, got 1254x1254; it could not be cropped\.$/m);
  assert.match(text(succeeded([{ path: 'a.png', aspect: '16:9' }])), /^Aspect ratio: 16:9 requested; the image size is unknown, so it was not cropped\.$/m);
});

test('resultLines: no aspect asked, no aspect line', () => {
  assert.deepEqual(resultLines(succeeded([{ path: 'a.png', width: 1254, height: 1254, aspect: null, full: null, png: RGBA, alpha: null }])).slice(1),
    ['Saved: a.png (1254x1254)']);
});

test('resultLines: transparent background present', () => {
  assert.equal(resultLines(succeeded([{ path: 'a.png', width: 2, height: 2, png: RGBA, alpha: alpha(0.6123) }], { transparent: true }))[2],
    'Transparent background: yes — PNG with an alpha channel, 61% of the pixels are transparent.');
  // A palette PNG with tRNS can be transparent too.
  assert.match(text(succeeded([{ path: 'a.png', png: { colorType: 3, alphaChannel: false, trns: true }, alpha: alpha(0.3) }], { transparent: true })),
    /Transparent background: yes — PNG with an alpha channel, 30% of the pixels are transparent\./);
  // A WebP has no PNG header: the measured pixels decide.
  assert.match(text(succeeded([{ path: 'a.webp', png: null, alpha: alpha(0.4) }], { transparent: true })), /Transparent background: yes — WebP with an alpha channel, 40%/);
});

test('resultLines: transparent background asked but no alpha channel', () => {
  const missing = format => `⚠ TRANSPARENT BACKGROUND MISSING: ChatGPT returned an image without an alpha channel (${format}), so the background is not transparent. ${RETRY}`;
  const line = im => resultLines(succeeded([im], { transparent: true }))[2];
  assert.equal(line({ path: 'a.png', png: RGB, alpha: alpha(0) }), missing('RGB PNG'));
  assert.equal(line({ path: 'a.png', png: { colorType: 0, alphaChannel: false, trns: false }, alpha: alpha(0) }), missing('grayscale PNG'));
  assert.equal(line({ path: 'a.png', png: { colorType: 3, alphaChannel: false, trns: false }, alpha: alpha(0) }), missing('palette PNG'));
  assert.equal(line({ path: 'a.jpg', png: null, alpha: alpha(0) }), missing('JPEG'));
  assert.equal(line({ path: 'a.webp', png: null, alpha: alpha(0) }), missing('WebP'));
  // A JPEG is never transparent, whatever the measurement says.
  assert.equal(line({ path: 'a.jpg', png: null, alpha: alpha(0.5) }), missing('JPEG'));
});

test("resultLines: a cropped image is judged by ChatGPT's original file", () => {
  const lines = resultLines(succeeded([{
    path: 'banner.png', width: 2172, height: 543, aspect: '4:1', png: RGB, alpha: alpha(0),
    full: { path: 'banner_full.png', width: 2172, height: 724 },
  }], { transparent: true }));
  assert.equal(lines.length, 4);
  assert.match(lines[3], /^⚠ TRANSPARENT BACKGROUND MISSING: ChatGPT returned an image without an alpha channel \(RGB PNG\)/);
  assert.match(text(succeeded([{ path: 'b.png', aspect: '4:1', png: null, alpha: alpha(0.2), full: { path: 'b_full.jpg' } }], { transparent: true })),
    /without an alpha channel \(JPEG\)/);
});

test('resultLines: an alpha channel without transparent pixels', () => {
  const line = share => resultLines(succeeded([{ path: 'a.png', png: RGBA, alpha: alpha(share) }], { transparent: true }))[2];
  assert.equal(line(0), `⚠ TRANSPARENT BACKGROUND MISSING: the PNG has an alpha channel but every pixel is opaque. ${RETRY}`);
  assert.match(line(0.02), /^⚠ TRANSPARENT BACKGROUND MISSING: the PNG has an alpha channel but almost every pixel is opaque\./);
  assert.match(line(0.021), /^Transparent background: yes — PNG with an alpha channel, 2% of the pixels/);
});

test('resultLines: alpha channel but no measurement', () => {
  assert.match(text(succeeded([{ path: 'a.png', png: RGBA, alpha: null }], { transparent: true })),
    /^Transparent background: PNG with an alpha channel; how much of it is transparent could not be measured\.$/m);
});

test('resultLines: no PNG header and no measurement: no verdict on the background', () => {
  // The extension could not decode the image, or is too old to measure it.
  const line = im => resultLines(succeeded([im], { transparent: true }))[2];
  assert.equal(line({ path: 'a.webp', png: null, alpha: null }), 'Transparent background: WebP; whether it is transparent could not be measured.');
  assert.equal(line({ path: 'a.gif', png: null }), 'Transparent background: GIF; whether it is transparent could not be measured.');
  assert.equal(line({ path: 'a.bin', png: null, alpha: null }), 'Transparent background: image; whether it is transparent could not be measured.');
  // A JPEG has no alpha channel, measured or not.
  assert.match(line({ path: 'a.jpg', png: null, alpha: null }), /^⚠ TRANSPARENT BACKGROUND MISSING: .*\(JPEG\)/);
});

test('resultLines: no transparency asked, no transparency line', () => {
  assert.doesNotMatch(text(succeeded([{ path: 'a.png', png: RGB, alpha: alpha(0) }])), /TRANSPARENT|Transparent/);
  assert.doesNotMatch(text(succeeded([{ path: 'a.png', png: RGB }], { transparent: false })), /TRANSPARENT|Transparent/);
});

test('resultLines: several images keep their lines together', () => {
  const lines = resultLines(succeeded([
    { path: 'a.png', width: 1983, height: 496, aspect: '4:1', png: RGBA, alpha: alpha(0.5), full: { path: 'a_full.png', width: 1983, height: 793 } },
    { path: 'b.png', width: 1672, height: 941, aspect: '4:1', png: RGB, alpha: alpha(0), full: null },
  ], { transparent: true, copies: ['D:\\x\\a.png'] }));
  assert.deepEqual(lines.slice(1).map(l => l.slice(0, 24)), [
    'Saved: a.png (1983x496, ', 'Full image before croppi', '⚠ ChatGPT drew 1983x793 ', 'Transparent background: ',
    'Saved: b.png (1672x941)', '⚠ Aspect ratio: 4:1 requ', '⚠ TRANSPARENT BACKGROUND',
    'Copied to: D:\\x\\a.png',
  ]);
});

test('resultLines: a failed job with an aspect ratio says how to fetch it cropped the same way', () => {
  const hint = 'If the chat finishes later, fetch_images(conversation_url=<the link above>, aspect_ratio="4:1") saves the image cropped the same way.';
  const failed = fields => resultLines(job({ status: 'failed', error: 'ChatGPT did not finish in time.', reason: 'timeout', ...fields }));
  assert.deepEqual(failed({ conversationUrl: CHAT_URL, aspect: '4:1' }).slice(1), [`ChatGPT conversation: ${CHAT_URL}`, hint]);
  assert.ok(!failed({ conversationUrl: CHAT_URL, aspect: null }).some(l => l.includes('fetch_images')));
  assert.ok(!failed({ aspect: '4:1' }).some(l => l.includes('fetch_images')));
  assert.ok(!resultLines(job({ status: 'succeeded', conversationUrl: CHAT_URL, aspect: '4:1' })).some(l => l.includes('fetch_images')));
});

test('imageLines: one image on its own', () => {
  assert.deepEqual(imageLines(job({}), { path: 'a.png', width: 1, height: 1 }), ['Saved: a.png (1x1)']);
});

test('fetched (collect) images are cropped without blaming ChatGPT for the shape', () => {
  const im = { path: 'C:\\out\\a.png', width: 941, height: 941, aspect: '1:1', full: { path: 'C:\\out\\a_full.png', width: 1672, height: 941 } };
  const fetched = resultLines({ id: 'img_c', mode: 'collect', status: 'succeeded', images: [im] }).join('\n');
  assert.match(fetched, /cropped from the centre to 1:1/);
  assert.doesNotMatch(fetched, /ChatGPT drew/);
  const generated = resultLines({ id: 'img_g', mode: 'generate', status: 'succeeded', images: [im] }).join('\n');
  assert.match(generated, /⚠ ChatGPT drew 1672x941 instead of 1:1/);
});

test("referenceLines: the caller's own images and the collection images are reported apart", () => {
  const refs = names => names.map(name => ({ name, bytes: 1 }));
  assert.deepEqual(referenceLines(job({})), []);
  assert.deepEqual(referenceLines(job({ references: refs(['a.png', 'b.png']) })), ['Reference images attached: a.png, b.png']);
  const col = { name: 'Cats', used: ['003_c.png', '002_b.png'], total: 9 };
  assert.deepEqual(referenceLines(job({ references: refs(['own.png', '003_c.png', '002_b.png']), collection: col })), [
    'Reference images attached: own.png',
    'References: collection "Cats": used 2 of 9 (003_c.png, 002_b.png)',
  ]);
  // Only collection images: no "attached" line, and the same name as an own image is no problem.
  assert.deepEqual(referenceLines(job({ references: refs(['003_c.png', '002_b.png']), collection: col })), [
    'References: collection "Cats": used 2 of 9 (003_c.png, 002_b.png)',
  ]);
  assert.match(text(job({ status: 'succeeded', images: [{ path: 'a.png' }], references: refs(['003_c.png', '002_b.png']), collection: col })),
    /^References: collection "Cats": used 2 of 9 \(003_c\.png, 002_b\.png\)$/m);
  // Images left out are named with the reason.
  assert.deepEqual(referenceLines(job({ references: refs(['003_c.png']), collection: { ...col, used: ['003_c.png'], skipped: ['004_d.png (larger than 20 MB)'] } })), [
    'References: collection "Cats": used 1 of 9 (003_c.png); left out: 004_d.png (larger than 20 MB)',
  ]);
});
