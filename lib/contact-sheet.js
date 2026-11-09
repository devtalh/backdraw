'use strict';
const { encodePng } = require('./png-codec');
// Share Phase 2a's layout with the extension rather than maintaining a second layout.
const { contactLayout } = require('../extension/gifframes');

const DIGITS = [
  ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
];

function drawNumber(rgba, width, x, y, number) {
  for (const digit of String(number)) {
    DIGITS[Number(digit)].forEach((row, yy) => {
      for (let xx = 0; xx < 5; xx++) if (row[xx] === '1') {
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const i = ((y + yy * 2 + dy) * width + x + xx * 2 + dx) * 4;
          rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
        }
      }
    });
    x += 12;
  }
}

function drawFrame(page, pageW, frame, width, height, left, top, outW, outH) {
  const shrink = outW < width || outH < height;
  for (let y = 0; y < outH; y++) for (let x = 0; x < outW; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    if (shrink) {
      const x0 = x * width / outW, x1 = (x + 1) * width / outW;
      const y0 = y * height / outH, y1 = (y + 1) * height / outH;
      const area = (x1 - x0) * (y1 - y0);
      // Integrate premultiplied samples over the exact destination footprint.
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const weight = (Math.min(x1, sx + 1) - Math.max(x0, sx)) *
            (Math.min(y1, sy + 1) - Math.max(y0, sy)) / area;
          const i = (sy * width + sx) * 4, alpha = frame[i + 3] / 255 * weight;
          r += frame[i] * alpha; g += frame[i + 1] * alpha; b += frame[i + 2] * alpha; a += alpha;
        }
      }
    } else {
      const i = (Math.floor((y + 0.5) * height / outH) * width + Math.floor((x + 0.5) * width / outW)) * 4;
      a = frame[i + 3] / 255; r = frame[i] * a; g = frame[i + 1] * a; b = frame[i + 2] * a;
    }
    const checker = (Math.floor(x / 16) + Math.floor(y / 16)) % 2 === 0 ? 226 : 255;
    const dst = ((top + y) * pageW + left + x) * 4, bg = checker * (1 - a);
    page[dst] = Math.round(r + bg); page[dst + 1] = Math.round(g + bg); page[dst + 2] = Math.round(b + bg);
  }
}

function contactSheet(frames, width, height, { maxBytes = 600 * 1024 } = {}) {
  if (!Array.isArray(frames) || frames.length < 1 || frames.length > 16 ||
      !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      !frames.every(frame => frame instanceof Uint8Array && frame.length === width * height * 4) ||
      !Number.isFinite(maxBytes) || maxBytes < 0) throw new Error('Invalid contact sheet frames or limits');
  let result;
  for (const max of [1024, 768, 512]) {
    const layout = contactLayout(width, height, frames.length, max);
    const page = new Uint8Array(layout.width * layout.height * 4).fill(255);
    frames.forEach((frame, index) => {
      const x = layout.gap + index % layout.columns * (layout.cellWidth + layout.gap);
      const y = layout.gap + Math.floor(index / layout.columns) * (layout.cellHeight + layout.gap);
      const left = x + Math.floor((layout.cellWidth - layout.imageWidth) / 2);
      drawFrame(page, layout.width, frame, width, height, left, y + layout.label, layout.imageWidth, layout.imageHeight);
      drawNumber(page, layout.width, x + 4, y + 4, index + 1);
    });
    result = { png: encodePng(layout.width, layout.height, page), width: layout.width, height: layout.height, shown: frames.length };
    if (result.png.length <= maxBytes) break;
  }
  return result;
}

module.exports = { contactSheet };
