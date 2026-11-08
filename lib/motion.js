'use strict';
// Web GIFs in the research used 6-9 frames at roughly 180-250 ms; the API accepts 2-16 frames.
// kiki-pixel-gif suggests idle ~6.7 fps, walk ~12, run ~18, dance/wave ~10. These 8-12 frame,
// 80-150 ms hints keep poses readable in short loops; ChatGPT may choose different timing.
const MOTIONS = Object.freeze({
  idle: Object.freeze({ frames: 8, frameMs: 150, poses: 'gentle breathing: rise, hold, settle, blink once' }),
  walk: Object.freeze({ frames: 8, frameMs: 100, poses: 'walk in place, side view: contact, down, passing, up per leg' }),
  run: Object.freeze({ frames: 8, frameMs: 80, poses: 'run in place, side view: contact, push-off, airborne, landing' }),
  jump: Object.freeze({ frames: 10, frameMs: 90, poses: 'jump in place: crouch, launch, rise, peak, fall, squash landing, recover' }),
  wave: Object.freeze({ frames: 8, frameMs: 100, poses: 'one hand waves side to side, body still' }),
  dance: Object.freeze({ frames: 10, frameMs: 100, poses: 'dance: step left, bounce, step right, bounce, arms swing' }),
  bounce: Object.freeze({ frames: 8, frameMs: 90, poses: 'bounce in place: squash on landing, stretch going up' }),
  wiggle: Object.freeze({ frames: 8, frameMs: 100, poses: 'wiggle side to side: lean left, center, lean right, center' }),
  spin: Object.freeze({ frames: 12, frameMs: 80, poses: 'full turn in place: front, three-quarter, side, back, front' }),
});

const MOTION_NAMES = Object.freeze(Object.keys(MOTIONS));

function motionText(name, hasReferences) {
  if (!MOTION_NAMES.includes(name)) throw new RangeError(`Unknown motion. Use: ${MOTION_NAMES.join(', ')}.`);
  const { frames, frameMs, poses } = MOTIONS[name];
  const identity = hasReferences
    ? 'Animate the reference character as drawn, no redesign; same size and position each frame, centered with margin, still camera.'
    : 'Same character, size and position in every frame, centered with margin, still camera.';
  return `Motion: ${poses}; about ${frames} frames at ${frameMs} ms, seamless loop. ${identity} Plain light solid background, no scene, ground, shadow or text.`;
}

module.exports = { MOTIONS, MOTION_NAMES, motionText };
