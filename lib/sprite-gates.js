'use strict';
// Advisory quality checks on source components and the aligned, played frames.
const { median, near } = require('./sprite-sheet');
const gate = (id, passed, message, details = {}) => ({ id, passed, message, details });

function countGate({ components, options }) {
  const found = components.length, expected = options.expected;
  const rows = Array.from({ length: options.rows || 0 }, (_, i) => ({ row: i + 1,
    found: components.filter(c => c.row === i + 1).length }));
  const wrongRows = rows.filter(r => r.found !== options.columns);
  const passed = (expected === undefined || found === expected) && !wrongRows.length;
  return gate('count', passed, `${found} frames${expected === undefined ? ' (automatic)' : `; expected ${expected}`}` +
    (wrongRows.length ? `; row counts differ: ${wrongRows.map(r => `${r.row} (${r.found}, expected ${options.columns})`).join(', ')}` : ''),
  { found, expected: expected ?? null, wrongRows });
}

function emptyGate({ components }) {
  const area = median(components.map(c => c.area));
  const frames = components.flatMap((c, i) => c.area < 0.25 * area ? [i + 1] : []);
  return gate('empty', !frames.length, frames.length ? `Very small frames: ${frames.join(', ')}` : 'No very small frames', { frames, medianArea: area });
}

function sizeGate({ components, options }) {
  const motion = options.motion, width = median(components.map(c => c.bbox.w)), height = median(components.map(c => c.bbox.h));
  const heightTolerance = ['walk', 'run', 'idle'].includes(motion) ? 0.15 : ['dance', 'wave'].includes(motion) ? 0.25 : 0.45;
  const widthTolerance = motion === 'idle' ? 0.15 : ['walk', 'run'].includes(motion) ? 0.25 : 0.5;
  const frames = components.flatMap((c, i) => {
    const widthRatio = c.bbox.w / width, heightRatio = c.bbox.h / height;
    return Math.abs(widthRatio - 1) > widthTolerance + 1e-12 || Math.abs(heightRatio - 1) > heightTolerance + 1e-12
      ? [{ index: i + 1, widthRatio, heightRatio }] : [];
  });
  return gate('size', !frames.length, frames.length
    ? `Size outliers: ${frames.map(f => `${f.index} (width ${f.widthRatio.toFixed(2)}x, height ${f.heightRatio.toFixed(2)}x)`).join(', ')}`
    : 'Frame sizes are within motion tolerances', { frames, widthTolerance, heightTolerance });
}

function identityGate({ frames }) {
  const histograms = frames.map(frame => {
    const hist = new Float64Array(64); let count = 0;
    for (let i = 0; i < frame.length; i += 4) if (frame[i + 3]) {
      hist[(frame[i] >> 6) * 16 + (frame[i + 1] >> 6) * 4 + (frame[i + 2] >> 6)]++; count++;
    }
    if (count) for (let k = 0; k < 64; k++) hist[k] /= count;
    return hist;
  });
  const average = new Float64Array(64);
  for (const h of histograms) for (let k = 0; k < 64; k++) average[k] += h[k] / histograms.length;
  const intersections = histograms.map(h => h.reduce((sum, v, k) => sum + Math.min(v, average[k]), 0));
  const outliers = intersections.flatMap((score, i) => score < 0.75 ? [{ index: i + 1, score }] : []);
  return gate('identity', !outliers.length, outliers.length
    ? `Color identity differs: ${outliers.map(f => `${f.index} (${f.score.toFixed(3)})`).join(', ')}`
    : 'Color identity is consistent', { intersections, outliers });
}

function frameDifference(a, b) {
  let xor = 0, rgb = 0, shared = 0;
  for (let i = 0; i < a.length; i += 4) {
    const aa = a[i + 3] !== 0, bb = b[i + 3] !== 0;
    if (aa !== bb) xor++;
    if (aa && bb) { shared++; for (let c = 0; c < 3; c++) rgb += Math.abs(a[i + c] - b[i + c]); }
  }
  // Score = mask XOR pixel count + mean absolute RGB difference at shared opaque
  // pixels. Only the RGB term is normalized to [0,1]; no shared pixels gives 0 RGB.
  return xor + (shared ? rgb / (shared * 3 * 255) : 0);
}

function seamGate({ frames }) {
  if (frames.length < 3) return gate('seam', true, 'skipped (fewer than 3 frames)', { seam_ratio: 0 });
  const adjacent = frames.slice(1).map((frame, i) => frameDifference(frames[i], frame));
  const seam = frameDifference(frames.at(-1), frames[0]), denominator = median(adjacent);
  const ratio = denominator === 0 ? 0 : seam / denominator;
  return gate('seam', ratio <= 1.8, `Loop seam ratio ${ratio.toFixed(3)} (maximum 1.8)`, { seam_ratio: ratio, seam, medianDifference: denominator });
}

function edgesGate({ frames, width, height, notes }) {
  let edges = 0, pale = 0;
  for (const frame of frames) for (let p = 0; p < width * height; p++) {
    const i = p * 4, alpha = frame[i + 3];
    if (alpha !== 0 && alpha !== 255) throw new Error('Sprite frame has non-binary alpha');
    if (!alpha) continue;
    const x = p % width, y = Math.floor(p / width);
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1 ||
        !frame[i - 1] || !frame[i + 7] || !frame[i - width * 4 + 3] || !frame[i + width * 4 + 3]) {
      edges++;
      const rgb = [frame[i], frame[i + 1], frame[i + 2]];
      if (Math.min(...rgb) >= 230 || (notes.opaqueFallback && near(rgb, notes.backgroundColor))) pale++;
    }
  }
  const ratio = edges ? pale / edges : 0;
  return gate('edges', ratio <= 0.25, `${(notes.sourceSemiTransparent * 100).toFixed(2)}% source pixels were semi-transparent (1-bit mask applied); ` +
    `${(ratio * 100).toFixed(2)}% pale/background-colored edge pixels${ratio > 0.25 ? ' (possible halo)' : ''}`,
  { sourceSemiTransparent: notes.sourceSemiTransparent, haloRatio: ratio });
}

function spriteGates(rendered) {
  return [countGate, emptyGate, sizeGate, identityGate, seamGate, edgesGate].map(check => check(rendered));
}

module.exports = { countGate, emptyGate, sizeGate, identityGate, frameDifference, seamGate, edgesGate, spriteGates };
