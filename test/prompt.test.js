'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { buildText } = require('../lib/prompt');
const { transparentReferenceLine } = require('../lib/prompt');
const { aspectOption } = require('../lib/aspect');

const CHAT_URL = 'https://chatgpt.com/g/g-p-67a1b2c3d4e5f60718293a4b5c6d7e8f-images/c/6812a3b4-1c2d-8000-9e8f-0123456789ab';
const PROJECT_URL = 'https://chatgpt.com/g/g-p-67a1b2c3d4e5f60718293a4b5c6d7e8f-images/project';
const ref = name => ({ name, bytes: 1000 });

test('transparent reference line: only animated, wrapped prompts with references qualify', () => {
  const job = { prompt: 'A fox', animated: true, references: [ref('fox.png')] };
  assert.equal(transparentReferenceLine(job), 'Keep the background transparent.');
  assert.equal(transparentReferenceLine({ ...job, sendAsIs: true }), null);
  assert.equal(transparentReferenceLine({ ...job, animated: false }), null);
  assert.equal(transparentReferenceLine({ ...job, references: [] }), null);
  assert.equal(transparentReferenceLine({ ...job, references: undefined }), null);
  assert.doesNotMatch(buildText(job), /Keep the background transparent/);
});

test('send_as_is: the prompt goes out verbatim, whatever else is set', () => {
  assert.equal(buildText({ prompt: 'Yes, 16:9 please.', sendAsIs: true }), 'Yes, 16:9 please.');
  assert.equal(buildText({ prompt: 'p', sendAsIs: true, references: [ref('a.png')], startUrl: CHAT_URL }), 'p');
});

test('one reference image', () => {
  const text = buildText({ prompt: 'Close the eyes.', references: [ref('a.png')] });
  assert.match(text, /^The attached image is the reference\. /);
  assert.match(text, /change only what is asked and keep everything else identical/);
  assert.match(text, /Don't ask follow-up questions; generate the image directly\.\n\nClose the eyes\.$/);
});

test('several reference images', () => {
  const text = buildText({ prompt: 'Same character, bust sprite.', references: [ref('a.png'), ref('b.png')] });
  assert.match(text, /^The attached images are references\. /);
  assert.ok(text.endsWith('\n\nSame character, bust sprite.'));
});

test('references win over continuing a chat', () => {
  assert.match(buildText({ prompt: 'p', references: [ref('a.png')], startUrl: CHAT_URL }), /^The attached image is the reference/);
});

test('continuing a chat (/c/<id>) asks for an updated image', () => {
  assert.equal(buildText({ prompt: 'Make it night.', startUrl: CHAT_URL, references: [] }),
    'Update the image with the changes below and generate the new image directly, without follow-up questions.\n\nMake it night.');
});

test('a project link without a chat is a new image', () => {
  assert.match(buildText({ prompt: 'p', startUrl: PROJECT_URL }), /^Generate an image from the description below\./);
});

test('plain new image', () => {
  assert.equal(buildText({ prompt: 'A void mage.' }),
    "Generate an image from the description below. Don't ask follow-up questions; create the image directly.\n\nA void mage.");
  assert.equal(buildText({ prompt: 'A void mage.', references: [], startUrl: null }), buildText({ prompt: 'A void mage.' }));
});

const wide = aspectOption('16:9');
const banner = aspectOption('4:1');
const ASPECT_16_9 = 'Aspect ratio: 16:9 (landscape). Fill the whole frame, no borders or letterboxing.';
const TRANSPARENT = /^Background: fully transparent \(PNG with an alpha channel\)\. Show only the subject: /;

test('aspect ratio: one line after the prompt, for every kind of message', () => {
  assert.equal(buildText({ prompt: 'A void mage.', aspect: wide }),
    `Generate an image from the description below. Don't ask follow-up questions; create the image directly.\n\nA void mage.\n\n${ASPECT_16_9}`);
  assert.ok(buildText({ prompt: 'Close the eyes.', references: [ref('a.png')], aspect: wide }).endsWith(`\n\nClose the eyes.\n\n${ASPECT_16_9}`));
  assert.ok(buildText({ prompt: 'Make it night.', startUrl: CHAT_URL, aspect: wide }).endsWith(`\n\nMake it night.\n\n${ASPECT_16_9}`));
  assert.match(buildText({ prompt: 'p', aspect: banner }), /\n\np\n\nAspect ratio: make the image 3:1 \(landscape\)\. It will be cropped from the centre to exactly 4:1 afterwards/);
});

test('transparent background: its own line, after the shape', () => {
  const lines = buildText({ prompt: 'A fox sticker.', transparent: true }).split('\n');
  assert.equal(lines[lines.length - 3], 'A fox sticker.');
  assert.match(lines[lines.length - 1], TRANSPARENT);
  const both = buildText({ prompt: 'A fox sticker.', aspect: aspectOption('1:1'), transparent: true }).split('\n\n');
  assert.equal(both.length, 3);
  assert.deepEqual(both[2].split('\n').map(l => l.slice(0, 13)), ['Aspect ratio:', 'Background: f']);
});

test('send_as_is gets no aspect or background lines', () => {
  assert.equal(buildText({ prompt: 'Yes, 16:9 please.', sendAsIs: true, aspect: wide, transparent: true }), 'Yes, 16:9 please.');
});

test('no aspect and no transparency: the message is unchanged', () => {
  const plain = "Generate an image from the description below. Don't ask follow-up questions; create the image directly.\n\nA void mage.";
  assert.equal(buildText({ prompt: 'A void mage.', aspect: null, transparent: false }), plain);
  assert.equal(buildText({ prompt: 'A void mage.', aspect: undefined }), plain);
});

test('animated: trims trailing spaces, dots and exclamation marks and skips aspect/background lines', () => {
  const expected = "Create an animated GIF: A fox waves, one clear motion, still camera, seamless loop. Don't ask follow-up questions; create the GIF directly.";
  for (const ending of ['.', '!!!', ' .! \n']) {
    assert.equal(buildText({ prompt: `A fox waves${ending}`, animated: true, aspect: wide, transparent: true, startUrl: CHAT_URL }), expected);
  }
});

test('animated: references precede the GIF prompt with one blank line', () => {
  const expected = buildText({ prompt: 'A fox waves.', animated: true });
  assert.equal(buildText({ prompt: 'A fox waves.', animated: true, references: [ref('a.png')], startUrl: CHAT_URL }),
    `The attached image is the reference.\n\n${expected}`);
  assert.equal(buildText({ prompt: 'A fox waves.', animated: true, references: [ref('a.png'), ref('b.png')] }),
    `The attached images are references.\n\n${expected}`);
});

test('animated: send_as_is takes priority; false keeps the original still-image prompt', () => {
  const prompt = 'A fox waves.!  ';
  assert.equal(buildText({ prompt, animated: true, sendAsIs: true, references: [ref('a.png')], aspect: wide, transparent: true }), prompt);
  assert.equal(buildText({ prompt, animated: false, aspect: wide, transparent: true }), buildText({ prompt, aspect: wide, transparent: true }));
});
