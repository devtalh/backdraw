'use strict';
const SPRITE_MOTIONS = Object.freeze(['walk', 'run', 'idle', 'jump', 'dance', 'wave', 'attack']);
const SPRITE_FRAMES = Object.freeze([8, 16]);
const POSES = {
  walk: 'walk cycle (contact, down, passing, up for each leg)',
  run: 'run cycle (contact, push-off, airborne, landing for each leg)',
  idle: 'idle breathing loop (rise, hold, settle, one blink)',
  jump: 'jump (crouch, launch, rise, peak, fall, landing squash, recover)',
  dance: 'dance loop (step left, bounce, step right, bounce, arms swing)',
  wave: 'wave (one hand waves side to side, body still)',
  attack: 'attack (wind-up, strike, follow-through, recover)',
};

function spriteGrid(frames) {
  if (!SPRITE_FRAMES.includes(frames)) throw new RangeError('Unknown frames. Use: 8, 16.');
  return { columns: 4, rows: frames === 8 ? 2 : 4, aspect: frames === 8 ? '3:2' : '1:1' };
}

function buildSpritePrompt({ character, motion, frames = 8, view = 'side', hasReferences = false }) {
  if (!SPRITE_MOTIONS.includes(motion)) throw new RangeError(`Unknown motion. Use: ${SPRITE_MOTIONS.join(', ')}.`);
  const { columns, rows } = spriteGrid(frames);
  if (!['side', 'front'].includes(view)) throw new RangeError('Unknown view. Use: side, front.');
  character = String(character ?? '').trim().replace(/[.!\s]+$/u, '');
  if (!character) throw new Error('The character description is empty.');
  return `Sprite sheet of ${character}, ${view === 'side' ? 'side view facing right' : 'front view'}, ${POSES[motion]} in place. ` +
    (hasReferences ? 'Same character as the reference, do not redesign. ' : '') +
    `${frames} frames in a ${columns} x ${rows} grid, read left to right, top to bottom; the last frame leads back into the first. ` +
    'Same character, same size and same ground line in every frame, full body inside each cell with wide empty margins between cells. ' +
    'Transparent background. No text, numbers, grid lines, borders or shadows.';
}

module.exports = { SPRITE_MOTIONS, SPRITE_FRAMES, spriteGrid, buildSpritePrompt };
