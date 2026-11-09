'use strict';
// Shared-palette GIF89a animation, without filesystem access or dependencies.

function bad(message) {
  return Object.assign(new Error(message), { code: 'BAD_REQUEST' });
}

function colorKey(frame, offset, transparent) {
  if (transparent || frame[offset + 3] === 255) return (frame[offset] << 16) | (frame[offset + 1] << 8) | frame[offset + 2];
  const alpha = frame[offset + 3];
  const blend = channel => Math.round((frame[offset + channel] * alpha + 255 * (255 - alpha)) / 255);
  return (blend(0) << 16) | (blend(1) << 8) | blend(2);
}

const BUCKETS = 64 ** 3;
const bucketKey = key => ((key >>> 18) << 12) | (((key >>> 10) & 63) << 6) | ((key >>> 2) & 63);

function paletteFor(frames, transparent, alphaThreshold) {
  const limit = transparent ? 255 : 256, offset = transparent ? 1 : 0;
  const exact = new Map();
  // Abandon exact RGB as soon as it cannot fit. Never retain a photo's distinct colors.
  scan: for (const frame of frames) for (let i = 0; i < frame.length; i += 4) {
    if (transparent && frame[i + 3] < alphaThreshold) continue;
    const key = colorKey(frame, i, transparent);
    exact.set(key, (exact.get(key) || 0) + 1);
    if (exact.size > limit) break scan;
  }
  if (exact.size <= limit) {
    const keys = [...exact.keys()].sort((a, b) => a - b);
    const colors = keys.map(key => [key >>> 16, (key >>> 8) & 255, key & 255]);
    const indices = new Map(keys.map((key, i) => [key, i + offset]));
    return { colors, index: key => indices.get(key) };
  }
  // Fixed storage: counts plus channel sums/means, independent of frames and RGB diversity.
  // Float64 sums also cover 64 full 4096x4096 frames without Uint32 overflow.
  const counts = new Uint32Array(BUCKETS);
  const red = new Float64Array(BUCKETS), green = new Float64Array(BUCKETS), blue = new Float64Array(BUCKETS);
  for (const frame of frames) for (let i = 0; i < frame.length; i += 4) {
    if (transparent && frame[i + 3] < alphaThreshold) continue;
    const key = colorKey(frame, i, transparent), bucket = bucketKey(key);
    counts[bucket]++;
    red[bucket] += key >>> 16; green[bucket] += (key >>> 8) & 255; blue[bucket] += key & 255;
  }
  let used = 0;
  for (let i = 0; i < BUCKETS; i++) if (counts[i]) used++;
  const entries = new Uint32Array(used), channels = [red, green, blue];
  for (let i = 0, j = 0; i < BUCKETS; i++) if (counts[i]) {
    entries[j++] = i;
    for (const channel of channels) channel[i] /= counts[i];
  }
  const colors = quantize(entries, counts, channels, limit);
  const lookup = new Uint8Array(BUCKETS);
  for (const key of entries) {
    let best = 0, distance = Infinity;
    for (let i = 0; i < colors.length; i++) {
      const rgb = colors[i], d = (red[key] - rgb[0]) ** 2 + (green[key] - rgb[1]) ** 2 + (blue[key] - rgb[2]) ** 2;
      if (d < distance) { distance = d; best = i; }
    }
    lookup[key] = best + offset;
  }
  return { colors, index: key => lookup[bucketKey(key)] };
}

function quantize(colors, counts, channels, limit) {
  const box = entries => {
    const low = [255, 255, 255], high = [0, 0, 0];
    let count = 0;
    for (const key of entries) {
      count += counts[key];
      for (let i = 0; i < 3; i++) { low[i] = Math.min(low[i], channels[i][key]); high[i] = Math.max(high[i], channels[i][key]); }
    }
    const ranges = high.map((value, i) => value - low[i]);
    const axis = ranges.indexOf(Math.max(...ranges));
    return { entries, count, axis, score: ranges[axis] ** 2 * count };
  };
  const boxes = [box(colors)];
  while (boxes.length < limit) {
    let chosen = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].entries.length > 1 && (chosen === -1 || boxes[i].score > boxes[chosen].score)) chosen = i;
    }
    if (chosen === -1) break;
    const current = boxes[chosen], axis = current.axis;
    current.entries.sort((a, b) => channels[axis][a] - channels[axis][b] || a - b);
    let weight = 0, split = 0;
    // Split at the weighted median, keeping at least one distinct color on each side.
    do { weight += counts[current.entries[split++]]; } while (weight < current.count / 2 && split < current.entries.length - 1);
    boxes.splice(chosen, 1, box(current.entries.subarray(0, split)), box(current.entries.subarray(split)));
  }
  return boxes.map(({ entries, count }) => {
    const sum = [0, 0, 0];
    for (const key of entries) for (let i = 0; i < 3; i++) sum[i] += channels[i][key] * counts[key];
    return sum.map(value => Math.round(value / count));
  });
}

function lzw(indices, minimum) {
  const clear = 1 << minimum, end = clear + 1;
  let dictionary = new Map(), next = end + 1;
  let size = minimum + 1, decoderNext = end + 1, previous = false;
  // At most one 12-bit data code per pixel plus dictionary clears and EOI.
  // Two bytes per pixel plus padding bound the scratch space without a growing JS array.
  const bytes = Buffer.allocUnsafe(indices.length * 2 + 16);
  let written = 0;
  let pending = 0, bits = 0;
  const emit = code => {
    pending |= code << bits;
    bits += size;
    while (bits >= 8) { bytes[written++] = pending & 255; pending >>>= 8; bits -= 8; }
    // Track the decoder's dictionary, which is one insertion behind the encoder.
    // Width grows exactly when its next code reaches 1 << size, including before EOI.
    if (code === clear) { size = minimum + 1; decoderNext = end + 1; previous = false; }
    else if (code !== end) {
      if (previous && decoderNext < 4096) {
        decoderNext++;
        if (decoderNext === (1 << size) && size < 12) size++;
      }
      previous = true;
    }
  };
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const symbol = indices[i], key = prefix * 256 + symbol;
    const joined = dictionary.get(key);
    if (joined !== undefined) { prefix = joined; continue; }
    emit(prefix);
    if (next < 4096) dictionary.set(key, next++);
    else { emit(clear); dictionary = new Map(); next = end + 1; }
    prefix = symbol;
  }
  emit(prefix); emit(end);
  if (bits) bytes[written++] = pending & 255;
  const data = bytes.subarray(0, written), parts = [Buffer.from([minimum])];
  for (let pos = 0; pos < data.length; pos += 255) {
    const block = data.subarray(pos, pos + 255);
    parts.push(Buffer.from([block.length]), block);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function rectangle(indices, previous, width, height, transparent) {
  if (!transparent && !previous) return { x: 0, y: 0, w: width, h: height, indices };
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    if (transparent ? indices[i] !== 0 : indices[i] !== previous[i]) {
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  if (right < 0) return { x: 0, y: 0, w: 1, h: 1, indices: Uint8Array.of(indices[0]) };
  const w = right - left + 1, h = bottom - top + 1;
  const cropped = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) cropped.set(indices.subarray((top + y) * width + left, (top + y) * width + left + w), y * w);
  return { x: left, y: top, w, h, indices: cropped };
}

function encodeGif(frames, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw bad('Invalid GIF options');
  const { width, height, delayMs, loop = 0, transparent = true, alphaThreshold = 128 } = options;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096) {
    throw bad('GIF dimensions must be integers from 1 to 4096');
  }
  if (!Array.isArray(frames) || frames.length < 1 || frames.length > 64) throw bad('GIF requires 1 to 64 frames');
  for (const frame of frames) {
    if (!(frame instanceof Uint8Array) || frame.length !== width * height * 4) throw bad('Invalid GIF RGBA frame length');
  }
  if (typeof transparent !== 'boolean' || !Number.isInteger(alphaThreshold) || alphaThreshold < 0 || alphaThreshold > 255) {
    throw bad('Invalid GIF transparency options');
  }
  if (!Number.isInteger(loop) || loop < 0 || loop > 65535) throw bad('GIF loop must be an integer from 0 to 65535');
  const delays = Array.isArray(delayMs) ? delayMs : Array(frames.length).fill(delayMs);
  if (delays.length !== frames.length || !Array.from(delays).every(value =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && Math.round(value / 10) <= 65535)) {
    throw bad('Invalid GIF delay or delay array length');
  }
  const delaysMs = delays.map(value => Math.max(20, Math.round(value / 10) * 10));
  // GIF has 1-bit alpha. Keep straight RGB above the threshold; never matte those edges.
  // Opaque output instead composites all pixels onto white before palette construction.
  const { colors, index: nearest } = paletteFor(frames, transparent, alphaThreshold);
  const offset = transparent ? 1 : 0;
  const count = colors.length + offset;
  const tableBits = Math.max(1, Math.ceil(Math.log2(Math.max(2, count))));
  const tableSize = 1 << tableBits, table = Buffer.alloc(tableSize * 3);
  colors.forEach((color, i) => table.set(color, (i + offset) * 3));
  // No dithering: every frame uses the same palette and precomputed mapping.
  const header = Buffer.alloc(13);
  header.write('GIF89a', 0, 'latin1');
  header.writeUInt16LE(width, 6); header.writeUInt16LE(height, 8);
  header[10] = 0xf0 | (tableBits - 1); // Global table, 8-bit source color resolution.
  const app = Buffer.from([0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0]);
  app.writeUInt16LE(loop, 16);
  const parts = [header, table, app];
  let previous;
  frames.forEach((frame, index) => {
    const indices = new Uint8Array(width * height);
    for (let i = 0; i < indices.length; i++) {
      indices[i] = transparent && frame[i * 4 + 3] < alphaThreshold ? 0 : nearest(colorKey(frame, i * 4, transparent));
    }
    const rect = rectangle(indices, previous, width, height, transparent);
    // Disposal 2 clears the complete opaque bounds before the next transparent frame.
    // Disposal 1 preserves the opaque canvas so only changed indices need to be written.
    const gce = Buffer.from([0x21, 0xf9, 4, transparent ? 9 : 4, 0, 0, 0, 0]);
    gce.writeUInt16LE(delaysMs[index] / 10, 4);
    const descriptor = Buffer.alloc(10);
    descriptor[0] = 0x2c;
    descriptor.writeUInt16LE(rect.x, 1); descriptor.writeUInt16LE(rect.y, 3);
    descriptor.writeUInt16LE(rect.w, 5); descriptor.writeUInt16LE(rect.h, 7);
    parts.push(gce, descriptor, lzw(rect.indices, Math.max(2, tableBits)));
    previous = indices;
  });
  parts.push(Buffer.from([0x3b]));
  return { data: Buffer.concat(parts), palette: tableSize, transparentIndex: transparent ? 0 : null, delaysMs };
}

module.exports = { encodeGif };
