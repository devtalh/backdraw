// ImageDecoder is unavailable in MV3 service workers; an offscreen document would need a new
// permission. Decode GIFs here without dependencies, also exposing the pure helpers to Node tests.
(() => {
  'use strict';

  // ChatGPT GIFs are typically <= 1024 px; cap canvas copies and total decoding work in the worker.
  const MAX_CANVAS_EDGE = 4096;
  const MAX_CANVAS_PIXELS = 2048 * 2048;
  const MAX_DECODED_PIXELS = 64 * 1024 * 1024;

  function lzw(data, minimum, length) {
    if (minimum < 2 || minimum > 8) throw new Error('Invalid GIF LZW minimum code size');
    const clear = 1 << minimum;
    const end = clear + 1;
    const prefix = new Uint16Array(4096);
    const suffix = new Uint8Array(4096);
    const stack = new Uint8Array(4096);
    const output = new Uint8Array(length);
    let bits = 0, size = minimum + 1, next = end + 1, previous = -1, first = 0, written = 0;
    let cleared = false;
    while (bits + size <= data.length * 8) {
      let code = 0;
      for (let i = 0; i < size; i++, bits++) code |= ((data[bits >> 3] >> (bits & 7)) & 1) << i;
      if (code === clear) {
        size = minimum + 1; next = end + 1; previous = -1; cleared = true;
        continue;
      }
      if (!cleared) throw new Error('GIF LZW stream has no initial clear code');
      if (code === end) {
        if (written !== length) throw new Error('Incomplete GIF pixels');
        return output;
      }
      const original = code;
      let top = 0;
      if (code === next && previous !== -1) { stack[top++] = first; code = previous; }
      else if (code >= next) throw new Error('Invalid GIF LZW code');
      while (code >= clear) {
        if (code <= end || code >= next || top >= stack.length) throw new Error('Invalid GIF LZW chain');
        stack[top++] = suffix[code];
        code = prefix[code];
      }
      first = code;
      if (top >= stack.length) throw new Error('GIF LZW chain too long');
      stack[top++] = first;
      if (written + top > length) throw new Error('Too many GIF pixels');
      while (top) output[written++] = stack[--top];
      if (written === length) return output;
      if (previous !== -1 && next < 4096) {
        prefix[next] = previous; suffix[next++] = first;
        if (next === (1 << size) && size < 12) size++;
      }
      previous = original;
    }
    throw new Error('Truncated GIF LZW stream');
  }

  function decodeGifFrames(bytes, { maxFrames = 16 } = {}) {
    if (!Number.isInteger(maxFrames) || maxFrames < 2 || maxFrames > 16) throw new Error('Invalid GIF sample limit');
    let pos = 0;
    const need = n => { if (pos + n > bytes.length) throw new Error('Truncated GIF'); };
    const byte = () => { need(1); return bytes[pos++]; };
    const word = () => byte() | (byte() << 8);
    const table = packed => {
      if (!(packed & 128)) return null;
      const n = 3 * (1 << ((packed & 7) + 1));
      need(n); const result = bytes.subarray(pos, pos + n); pos += n; return result;
    };
    const blocks = () => {
      const parts = [];
      let length = 0;
      for (let n; (n = byte()) !== 0;) {
        need(n); parts.push(bytes.subarray(pos, pos + n)); pos += n; length += n;
      }
      const result = new Uint8Array(length);
      let offset = 0;
      for (const part of parts) { result.set(part, offset); offset += part.length; }
      return result;
    };
    need(13);
    const signature = String.fromCharCode(...bytes.subarray(0, 6)); pos = 6;
    if (signature !== 'GIF87a' && signature !== 'GIF89a') throw new Error('Invalid GIF header');
    const width = word(), height = word();
    if (!width || !height || width > MAX_CANVAS_EDGE || height > MAX_CANVAS_EDGE || width * height > MAX_CANVAS_PIXELS) {
      throw new Error('GIF canvas exceeds limits');
    }
    const packed = byte(); byte(); byte();
    const globalTable = table(packed);
    const images = [];
    let decodedPixels = 0;
    let control = { disposal: 0, transparent: -1, delay: 0 };
    while (true) {
      const marker = byte();
      if (marker === 0x3b) break;
      if (marker === 0x21) {
        const label = byte();
        if (label === 0xf9) {
          if (byte() !== 4) throw new Error('Invalid GIF control size');
          const flags = byte(), delay = word(), transparent = byte();
          const disposal = (flags >> 2) & 7;
          if (byte() !== 0 || disposal > 3) throw new Error('Invalid GIF control');
          control = { disposal, delay, transparent: flags & 1 ? transparent : -1 };
        } else {
          blocks();
          // A plain-text block consumes its preceding graphic control too.
          if (label === 0x01) throw new Error('GIF plain-text rendering is unsupported');
        }
        continue;
      }
      if (marker !== 0x2c) throw new Error('Invalid GIF block');
      if (images.length >= 512) throw new Error('GIF frame count exceeds limits');
      const x = word(), y = word(), w = word(), h = word(), flags = byte();
      if (!w || !h || x + w > width || y + h > height) throw new Error('Invalid GIF frame rectangle');
      decodedPixels += w * h;
      if (decodedPixels > MAX_DECODED_PIXELS) throw new Error('GIF decoded pixel budget exceeds limits');
      const palette = table(flags) || globalTable;
      if (!palette) throw new Error('Invalid GIF color table');
      if (control.transparent >= palette.length / 3) control.transparent = -1;
      const minimum = byte(), data = blocks();
      images.push({ x, y, w, h, interlace: !!(flags & 64), palette, minimum, data, ...control });
      control = { disposal: 0, transparent: -1, delay: 0 };
    }
    const total = images.length;
    if (!total) throw new Error('GIF has no frames');
    const count = Math.min(total, maxFrames);
    const selected = new Set(Array.from({ length: count }, (_, i) => count === 1 ? 0 : Math.round(i * (total - 1) / (count - 1))));
    const canvas = new Uint8ClampedArray(width * height * 4);
    const frames = [];
    for (let index = 0; index < total; index++) {
      const im = images[index];
      const indices = lzw(im.data, im.minimum, im.w * im.h);
      const restore = im.disposal === 3 ? canvas.slice() : null;
      const rows = [];
      if (im.interlace) {
        for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let row = start; row < im.h; row += step) rows.push(row);
      } else for (let row = 0; row < im.h; row++) rows.push(row);
      let pixel = 0;
      for (const row of rows) for (let x = 0; x < im.w; x++) {
        const color = indices[pixel++];
        if (color >= im.palette.length / 3) throw new Error('GIF pixel exceeds color table');
        if (color === im.transparent) continue;
        const dst = ((im.y + row) * width + im.x + x) * 4;
        canvas[dst] = im.palette[color * 3]; canvas[dst + 1] = im.palette[color * 3 + 1];
        canvas[dst + 2] = im.palette[color * 3 + 2]; canvas[dst + 3] = 255;
      }
      if (selected.has(index)) frames.push({ index, rgba: canvas.slice() });
      if (restore) canvas.set(restore);
      else if (im.disposal === 2) for (let row = im.y; row < im.y + im.h; row++) {
        canvas.fill(0, (row * width + im.x) * 4, (row * width + im.x + im.w) * 4);
      }
    }
    return { width, height, total, frames };
  }

  // Maximize each frame's scale, with a fixed label strip and gutters. Ties prefer less empty area.
  function contactLayout(frameW, frameH, count, max = 1024) {
    if (![frameW, frameH, count, max].every(Number.isInteger) || frameW < 1 || frameH < 1 || count < 1 || count > 16 || max < 64) {
      throw new Error('Invalid contact sheet dimensions');
    }
    const gap = 8, label = 24;
    let best = null;
    for (let columns = 1; columns <= count; columns++) {
      const rows = Math.ceil(count / columns);
      const scale = Math.min((max - gap * (columns + 1)) / columns / frameW,
        ((max - gap * (rows + 1)) / rows - label) / frameH);
      if (scale <= 0) continue;
      const imageWidth = Math.max(1, Math.floor(frameW * scale));
      const imageHeight = Math.max(1, Math.floor(frameH * scale));
      const cellWidth = Math.max(40, imageWidth), cellHeight = imageHeight + label;
      const width = columns * cellWidth + (columns + 1) * gap;
      const height = rows * cellHeight + (rows + 1) * gap;
      if (width > max || height > max) continue;
      if (!best || scale > best.scale || (scale === best.scale && width * height < best.width * best.height)) {
        best = { columns, rows, cellWidth, cellHeight, imageWidth, imageHeight, width, height, gap, label, scale };
      }
    }
    if (!best) throw new Error('Contact sheet cannot fit');
    return best;
  }

  const api = { decodeGifFrames, contactLayout };
  if (typeof self !== 'undefined') self.BackdrawGif = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
