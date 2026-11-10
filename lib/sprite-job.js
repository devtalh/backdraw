'use strict';
const { animateSheet } = require('./sprite-export');
const RETRY_GATES = Object.freeze(['count', 'empty', 'identity']);

function processSheet(sheetPath, sprite) {
  try {
    const result = animateSheet({ imagePath: sheetPath, motion: sprite.motion, columns: sprite.columns,
      rows: sprite.rows, frames: sprite.frames, size: sprite.size ?? undefined, background: sprite.background });
    const { folder, paths, frames, durationMs, width, height, bytes } = result;
    const summary = { folder, paths, frames, durationMs, width, height, bytes,
      gates: result.gates.map(({ id, passed, message, details }) => ({ id, passed, message,
        ...(details?.frames ? { details: { frames: details.frames } } : {}) })) };
    // The preview belongs in PREVIEW_DIR, never in the persistent job JSON.
    Object.defineProperty(summary, 'sheet', { value: result.sheet, configurable: true });
    return summary;
  } catch (err) {
    // animateSheet wraps source read failures as BAD_REQUEST; they are not extraction failures.
    const retryable = err.code === 'BAD_PNG' || (err.code === 'BAD_REQUEST' &&
      !err.message.includes('try a smaller size') && !/^cannot (read|save) /.test(err.message));
    return { error: err.message, code: err.code, retryable };
  }
}

function retryReasons(result) {
  if (result.error) return result.retryable ? result.error : '';
  return result.gates.filter(g => RETRY_GATES.includes(g.id) && !g.passed)
    .map(g => `${g.id}: ${g.message}`).join('; ');
}

function pickBest(attempts) {
  const score = a => a.result?.error || !a.result ? [1, 0, 0] : [0,
    a.result.gates.filter(g => RETRY_GATES.includes(g.id) && !g.passed).length,
    a.result.gates.filter(g => !g.passed).length];
  let best = 0;
  attempts.forEach((a, i) => {
    const current = score(a), previous = score(attempts[best]);
    const first = current.findIndex((v, k) => v !== previous[k]);
    if (first >= 0 && current[first] < previous[first]) best = i;
  });
  return best;
}

module.exports = { RETRY_GATES, processSheet, retryReasons, pickBest };
