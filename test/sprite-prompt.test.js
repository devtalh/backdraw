'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { SPRITE_MOTIONS, SPRITE_FRAMES, spriteGrid, buildSpritePrompt } = require('../lib/sprite-prompt');
const { buildText } = require('../lib/prompt');
const { aspectOption } = require('../lib/aspect');

const poses = [
  'walk cycle (contact, down, passing, up for each leg)',
  'run cycle (contact, push-off, airborne, landing for each leg)',
  'idle breathing loop (rise, hold, settle, one blink)',
  'jump (crouch, launch, rise, peak, fall, landing squash, recover)',
  'dance loop (step left, bounce, step right, bounce, arms swing)',
  'wave (one hand waves side to side, body still)',
  'attack (wind-up, strike, follow-through, recover)',
];
const reference = 'Same character as the reference, do not redesign.';
test('sprite motion and frame presets are ordered and grids match the generation aspect', () => {
  assert.deepEqual(SPRITE_MOTIONS, ['walk', 'run', 'idle', 'jump', 'dance', 'wave', 'attack']);
  assert.deepEqual(SPRITE_FRAMES, [8, 16]);
  assert.deepEqual(spriteGrid(8), { columns: 4, rows: 2, aspect: '3:2' });
  assert.deepEqual(spriteGrid(16), { columns: 4, rows: 4, aspect: '1:1' });
});

for (const [index, motion] of SPRITE_MOTIONS.entries()) for (const frames of SPRITE_FRAMES) {
  for (const view of ['side', 'front']) for (const hasReferences of [false, true]) {
    test(`${motion}/${frames}/${view}/references=${hasReferences}: exact short template and normal image envelope`, () => {
      const character = 'a frog with a red scarf';
      const prompt = buildSpritePrompt({ character, motion, frames, view, hasReferences });
      const first = `Sprite sheet of ${character}, ${view === 'side' ? 'side view facing right' : 'front view'}, ${poses[index]} in place.`;
      const expected = `${first} ${hasReferences ? reference + ' ' : ''}${frames} frames in a 4 x ${frames === 8 ? 2 : 4} grid, read left to right, top to bottom; the last frame leads back into the first. Same character, same size and same ground line in every frame, full body inside each cell with wide empty margins between cells. Transparent background. No text, numbers, grid lines, borders or shadows.`;
      assert.equal(prompt, expected);
      assert.equal(prompt.includes(reference), hasReferences);
      if (hasReferences) assert.equal(prompt.indexOf(reference), first.length + 1);
      assert.ok(prompt.length - character.length <= 520);
      assert.doesNotMatch(prompt, /\b(code|python|script|program|file|download|zip|json|svg|html|canvas)\b|Keep the background transparent/i);
      const aspect = spriteGrid(frames).aspect;
      const text = buildText({ prompt, transparent: true, animated: false, motion: null,
        references: hasReferences ? [{ name: 'frog.png' }] : [], aspect: aspectOption(aspect) });
      assert.ok(text.includes(`\n\n${prompt}\n\nAspect ratio: ${aspect}`));
      assert.match(text, /^Generate an image|^The attached image is the reference/);
      assert.match(text, /\nBackground: fully transparent/);
    });
  }
}

test('defaults, trailing punctuation and invalid sprite prompt inputs', () => {
  assert.equal(buildSpritePrompt({ character: '  frog.!!  ', motion: 'walk' }),
    buildSpritePrompt({ character: 'frog', motion: 'walk', frames: 8, view: 'side' }));
  for (const character of ['', '   ', '...!!', undefined]) {
    assert.throws(() => buildSpritePrompt({ character, motion: 'walk' }), /character description is empty/);
  }
  for (const motion of ['fly', 'WALK', 'toString', '__proto__', false, null]) {
    assert.throws(() => buildSpritePrompt({ character: 'frog', motion }), /Unknown motion\. Use:/);
  }
  for (const frames of [0, 7, 9, '8', null, 8.5]) {
    assert.throws(() => buildSpritePrompt({ character: 'frog', motion: 'walk', frames }), /Unknown frames\. Use: 8, 16/);
  }
  for (const view of ['', 'back', null, false]) {
    assert.throws(() => buildSpritePrompt({ character: 'frog', motion: 'walk', view }), /Unknown view\. Use: side, front/);
  }
});
