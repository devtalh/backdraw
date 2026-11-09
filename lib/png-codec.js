'use strict';
// Non-interlaced PNG pixels, using only Node's built-in zlib.
const zlib = require('node:zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  return c >>> 0;
});

function bad(message) {
  return Object.assign(new Error(message), { code: 'BAD_PNG' });
}

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data = Buffer.alloc(0)) {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  result.write(type, 4, 'latin1');
  result.set(data, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
  return da <= db && da <= dc ? a : db <= dc ? b : c;
}

function decodePng(buf, options = {}) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) {
      throw bad('not a PNG file');
    }
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw bad('Invalid PNG options');
    const { maxPixels = 4096 * 4096, maxEdge = 8192 } = options;
    if (!Number.isSafeInteger(maxPixels) || maxPixels < 1 || !Number.isSafeInteger(maxEdge) || maxEdge < 1) {
      throw bad('Invalid PNG size limits');
    }
    let width, height, depth, type, palette, trns;
    let ended = false, idatEnded = false;
    const idat = [];
    for (let pos = 8; pos < buf.length;) {
      if (pos + 12 > buf.length) throw bad('PNG data is truncated');
      const length = buf.readUInt32BE(pos);
      const name = buf.toString('latin1', pos + 4, pos + 8);
      if (length > 0x7fffffff || pos + length + 12 > buf.length) throw bad('PNG data is truncated');
      const data = buf.subarray(pos + 8, pos + 8 + length);
      if (crc32(buf.subarray(pos + 4, pos + 8 + length)) !== buf.readUInt32BE(pos + 8 + length)) {
        throw bad('PNG chunk CRC mismatch');
      }
      if (!/^[A-Za-z]{4}$/.test(name) || (buf[pos + 6] & 32)) throw bad('Invalid PNG chunk type');
      if (pos === 8 && name !== 'IHDR') throw bad('PNG IHDR must be the first chunk');
      if (name !== 'IDAT' && idat.length) idatEnded = true;
      if (name === 'IHDR') {
        if (pos !== 8 || length !== 13) throw bad('Invalid PNG IHDR');
        width = data.readUInt32BE(0); height = data.readUInt32BE(4);
        depth = data[8]; type = data[9];
        // Check dimensions before collecting compressed data or attempting inflation.
        if (!width || !height) throw bad('PNG dimensions must be greater than zero');
        if (width > maxEdge || height > maxEdge) throw bad(`PNG edge is larger than ${maxEdge}`);
        if (width * height > maxPixels) throw bad(`PNG is larger than ${maxPixels} pixels`);
        if (!DEPTHS[type]?.includes(depth)) throw bad('Unsupported PNG color type or bit depth');
        if (data[10] !== 0 || data[11] !== 0) throw bad('Unsupported PNG compression or filter method');
        if (data[12] === 1) throw bad('interlaced PNG is not supported');
        if (data[12] !== 0) throw bad('Invalid PNG interlace method');
      } else if (name === 'PLTE') {
        if (palette || trns || idat.length || type === 0 || type === 4 || !length || length % 3 || length > 768 ||
            (type === 3 && length / 3 > 2 ** depth)) throw bad('Invalid PNG PLTE');
        palette = data;
      } else if (name === 'tRNS') {
        if (trns || idat.length || (type === 3 && (!palette || !length || length > palette.length / 3)) ||
            (type === 0 && length !== 2) || (type === 2 && length !== 6) || type === 4 || type === 6) {
          throw bad('Invalid PNG tRNS');
        }
        if (type !== 3) for (let i = 0; i < length; i += 2) {
          if (data.readUInt16BE(i) >= 2 ** depth) throw bad('PNG tRNS sample exceeds bit depth');
        }
        trns = data;
      } else if (name === 'IDAT') {
        if (idatEnded) throw bad('PNG IDAT chunks must be consecutive');
        if (type === 3 && !palette) throw bad('PNG palette is missing PLTE');
        idat.push(data);
      } else if (name === 'IEND') {
        if (length) throw bad('Invalid PNG IEND');
        if (pos + 12 !== buf.length) throw bad('Unexpected data after PNG IEND');
        ended = true;
        break;
      } else if (!(buf[pos + 4] & 32)) throw bad(`Unsupported PNG critical chunk ${name}`);
      pos += length + 12;
    }
    if (!ended) throw bad('PNG data is truncated (missing IEND)');
    if (!idat.length) throw bad('PNG is missing IDAT');
    const channels = CHANNELS[type];
    const stride = Math.ceil(width * channels * depth / 8);
    const bpp = Math.max(1, Math.ceil(channels * depth / 8));
    const expected = height * (stride + 1);
    let packed;
    try {
      packed = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 });
    } catch (err) {
      throw bad(`Invalid PNG compressed data or output length: ${err.message}`);
    }
    if (packed.length !== expected) throw bad('PNG decompressed data has an unexpected length');
    const raw = Buffer.alloc(height * stride);
    for (let y = 0; y < height; y++) {
      const filter = packed[y * (stride + 1)];
      if (filter > 4) throw bad(`Unknown PNG filter ${filter}`);
      for (let x = 0; x < stride; x++) {
        const dst = y * stride + x;
        const left = x >= bpp ? raw[dst - bpp] : 0;
        const up = y ? raw[dst - stride] : 0;
        const corner = y && x >= bpp ? raw[dst - stride - bpp] : 0;
        const predictor = filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 :
          filter === 4 ? paeth(left, up, corner) : 0;
        raw[dst] = (packed[y * (stride + 1) + x + 1] + predictor) & 255;
      }
    }
    const rgba = new Uint8Array(width * height * 4);
    const sample = (row, index) => depth === 16 ? raw.readUInt16BE(row + index * 2) : depth === 8 ? raw[row + index] :
      (raw[row + ((index * depth) >> 3)] >> (8 - depth - ((index * depth) & 7))) & ((1 << depth) - 1);
    const byte = value => depth === 16 ? value >>> 8 : depth === 8 ? value : value * 255 / ((1 << depth) - 1);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const row = y * stride, src = x * channels, dst = (y * width + x) * 4;
      const a = sample(row, src);
      let alpha = 255;
      if (type === 3) {
        if (a >= palette.length / 3) throw bad('PNG pixel index exceeds palette');
        rgba.set(palette.subarray(a * 3, a * 3 + 3), dst);
        alpha = trns && a < trns.length ? trns[a] : 255;
      } else if (type === 0 || type === 4) {
        rgba[dst] = rgba[dst + 1] = rgba[dst + 2] = byte(a);
        if (type === 4) alpha = byte(sample(row, src + 1));
        else if (trns && a === trns.readUInt16BE(0)) alpha = 0;
      } else {
        const g = sample(row, src + 1), b = sample(row, src + 2);
        rgba[dst] = byte(a); rgba[dst + 1] = byte(g); rgba[dst + 2] = byte(b);
        if (type === 6) alpha = byte(sample(row, src + 3));
        else if (trns && a === trns.readUInt16BE(0) && g === trns.readUInt16BE(2) && b === trns.readUInt16BE(4)) alpha = 0;
      }
      rgba[dst + 3] = alpha;
    }
    return { width, height, rgba };
  } catch (err) {
    if (err.code === 'BAD_PNG') throw err;
    throw bad(`Invalid PNG data: ${err.message}`);
  }
}

function encodePng(width, height, rgba) {
  try {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
        width > 0x7fffffff || height > 0x7fffffff || !Number.isSafeInteger(width * height * 4)) {
      throw bad('Invalid PNG dimensions');
    }
    if (!(rgba instanceof Uint8Array) || rgba.length !== width * height * 4) throw bad('Invalid PNG RGBA length');
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 6;
    const stride = width * 4;
    const rows = Buffer.alloc(height * (stride + 1));
    for (let y = 0; y < height; y++) rows.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND')]);
  } catch (err) {
    if (err.code === 'BAD_PNG') throw err;
    throw bad(`Cannot encode PNG: ${err.message}`);
  }
}

module.exports = { decodePng, encodePng, crc32 };
