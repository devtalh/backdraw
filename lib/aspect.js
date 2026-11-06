'use strict';
// Aspect ratios (pure): reading the caller's W:H and telling ChatGPT how to draw it. ChatGPT makes
// any ratio from 1:3 to 3:1 itself (about 1.57 MP in the asked shape). Up to 1:4 / 4:1 is accepted:
// those are drawn at 1:3 / 3:1 and cropped from the centre afterwards (extension/aspect.js).

const TOLERANCE = 0.01; // within 1% of the target counts as exact; extension/aspect.js uses the same
const NATIVE = 3; // ChatGPT draws 1:3 .. 3:1
const LIMIT = 4; // accepted 1:4 .. 4:1
const MAX_TERM = 100;
const ALIASES = { square: '1:1', landscape: '3:2', portrait: '2:3', wide: '16:9', tall: '9:16', 'discord-banner': '5:2' };

const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const orientation = (w, h) => (w === h ? 'square' : w > h ? 'landscape' : 'portrait');
const pct = x => `${Math.round(x * 1000) / 10}%`;

// Whether an image already has the requested shape. Callers validate/parse the ratio first; keeping
// this comparison here makes saved-result reporting and the gallery use the same tolerance.
function withinAspect(width, height, aspect) {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0 ||
      !aspect || !Number.isFinite(aspect.w) || aspect.w <= 0 || !Number.isFinite(aspect.h) || aspect.h <= 0) return false;
  return Math.abs(width * aspect.h - height * aspect.w) <= TOLERANCE * height * aspect.w;
}

// "16:9", "16x9", "16/9", "1920:1080" (reduced to 16:9) or an alias. Throws with a hint on anything else.
function parseAspect(input) {
  const text = String(input === undefined || input === null ? '' : input).trim().toLowerCase();
  const alias = text.replace(/[\s_]+/g, '-');
  const m = (Object.hasOwn(ALIASES, alias) ? ALIASES[alias] : text).match(/^(\d{1,5}(?:\.\d{1,3})?)\s*[:x×/]\s*(\d{1,5}(?:\.\d{1,3})?)$/);
  if (!m) throw new Error(`aspect_ratio "${input}" is not a ratio: use W:H with whole numbers, e.g. 16:9, 4:5 or 1:1 (or ${Object.keys(ALIASES).join(', ')}).`);
  const decimals = Math.max(...[m[1], m[2]].map(s => (s.split('.')[1] || '').length));
  let w = Math.round(Number(m[1]) * 10 ** decimals);
  let h = Math.round(Number(m[2]) * 10 ** decimals);
  if (!w || !h) throw new Error(`aspect_ratio "${input}": both sides must be at least 1.`);
  const g = gcd(w, h);
  w /= g;
  h /= g;
  // Before the decimals hint, which would otherwise suggest a whole-number ratio that is refused too.
  if (w > LIMIT * h || h > LIMIT * w) {
    throw new Error(`aspect_ratio ${w}:${h} is outside the supported range 1:${LIMIT} to ${LIMIT}:1 (ChatGPT itself draws 1:${NATIVE} to ${NATIVE}:1).`);
  }
  if (decimals) throw new Error(`aspect_ratio "${input}" must use whole numbers${w <= MAX_TERM && h <= MAX_TERM ? `: use ${w}:${h} instead` : ', e.g. 16:9'}.`);
  if (w > MAX_TERM || h > MAX_TERM) throw new Error(`aspect_ratio "${input}" (${w}:${h}) is too precise: use a simpler ratio with numbers up to ${MAX_TERM}, e.g. 16:9 or 21:9.`);
  return { w, h, ratio: w / h, label: `${w}:${h}`, orientation: orientation(w, h) };
}

// What to ask ChatGPT for: the target itself, or for a ratio it can't draw the range bound on the
// same side (cropped to the target afterwards).
function plan(aspect) {
  const target = { w: aspect.w, h: aspect.h, label: aspect.label };
  const native = aspect.w <= NATIVE * aspect.h && aspect.h <= NATIVE * aspect.w;
  const generate = native ? { ...target } : aspect.w > aspect.h ? { w: NATIVE, h: 1, label: `${NATIVE}:1` } : { w: 1, h: NATIVE, label: `1:${NATIVE}` };
  return { target, native, generate };
}

// For a cropped ratio: the side that gets cut and the share of it the centre crop keeps (4:1 from
// 3:1 keeps the middle 75% of the height). null when nothing is cut.
function safeBand(p) {
  if (p.native) return null;
  const want = p.target.w / p.target.h;
  const made = p.generate.w / p.generate.h;
  return want > made ? { axis: 'height', share: made / want } : { axis: 'width', share: want / made };
}

// The lines added to the ChatGPT message for a job's aspect plan (or null) and transparent flag.
function promptLines(p, transparent) {
  const lines = [];
  if (p) {
    const shape = `${p.generate.label} (${orientation(p.generate.w, p.generate.h)})`;
    const band = safeBand(p);
    // "Fill the whole frame" would ask for the very background a transparent image must not have.
    const fill = transparent ? 'Compose the subject to suit this frame; everything around it stays transparent, with no borders.' : null;
    if (!band) {
      lines.push(`Aspect ratio: ${shape}. ${fill || 'Fill the whole frame, no borders or letterboxing.'}`);
    } else {
      const edges = band.axis === 'height' ? 'top and bottom' : 'left and right';
      lines.push(`Aspect ratio: make the image ${shape}. It will be cropped from the centre to exactly ${p.target.label} afterwards, ` +
        `so keep every important element (subjects, faces, text, logos) inside the middle ${pct(band.share)} of the ${band.axis}; ` +
        `the ${edges} ${pct((1 - band.share) / 2)} may be cut off. ${fill || 'Fill the whole frame, no borders.'}`);
    }
  }
  if (transparent) {
    lines.push('Background: fully transparent (PNG with an alpha channel). Show only the subject: no background colour, no scenery, no floor shadow, no white or checkerboard box.');
  }
  return lines;
}

// A job's aspect_ratio argument as a plan, or null when none was given. Throws on an invalid one.
function aspectOption(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  return plan(parseAspect(value));
}

module.exports = { TOLERANCE, ALIASES, pct, withinAspect, parseAspect, plan, safeBand, promptLines, aspectOption };
