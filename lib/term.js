'use strict';
// Terminal output for setup and doctor: a status symbol per line, in colour only on a terminal that
// wants it (NO_COLOR, a pipe or a file get plain text, which stays readable).

const SYMBOLS = { ok: '✓', warn: '⚠', fail: '✗', info: '·' };
const COLORS = { ok: 32, warn: 33, fail: 31, info: 90, bold: 1, dim: 90 };

function useColor(stream = process.stdout, env = process.env) {
  return !!(stream && stream.isTTY) && !('NO_COLOR' in env) && env.TERM !== 'dumb';
}

function painter(color) {
  return (kind, text) => (color && COLORS[kind] ? `\x1b[${COLORS[kind]}m${text}\x1b[0m` : text);
}

// "✓ Label   detail", with the symbol coloured.
function line(paint, status, label, detail, width = 0) {
  const head = `${paint(status, SYMBOLS[status])} ${width ? label.padEnd(width) : label}`;
  return detail ? `${head} ${detail}` : head;
}

module.exports = { SYMBOLS, useColor, painter, line };
