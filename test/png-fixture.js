'use strict';
// Builds real PNG files for the tests: zlib-compressed rows and CRC-checked chunks.
const zlib = require('node:zlib');

// zlib.crc32 only exists since Node 20.15 / 22.2.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data = Buffer.alloc(0)) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

// A width x height, 8-bit PNG of the color type (all samples zero); `extra` chunks (PLTE, tRNS)
// go between IHDR and IDAT, `after` chunks between IDAT and IEND.
function png(colorType, { width = 4, height = 3, extra = [], after = [] } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const rows = Buffer.alloc((1 + width * CHANNELS[colorType]) * height); // filter byte 0 per row
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), ...extra, chunk('IDAT', zlib.deflateSync(rows)), ...after, chunk('IEND')]);
}

function rgbaPng(width, height, pixels) {
  if (pixels.length !== width * height * 4) throw new Error('RGBA pixel data has the wrong length');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = Buffer.alloc((1 + width * 4) * height);
  for (let y = 0; y < height; y++) Buffer.from(pixels).copy(rows, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND')]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodePng(input) {
  const bytes = Buffer.from(input);
  if (bytes.length < SIGNATURE.length || !bytes.subarray(0, SIGNATURE.length).equals(SIGNATURE)) throw new Error('Invalid PNG signature');
  let width;
  let height;
  let colorType;
  const idat = [];
  for (let offset = SIGNATURE.length; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (offset + 12 + length > bytes.length) throw new Error('Truncated PNG chunk');
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || ![2, 6].includes(data[9]) || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        throw new Error('Only non-interlaced 8-bit RGB and RGBA PNGs are supported');
      }
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (!width || !height || colorType === undefined || !idat.length) throw new Error('Incomplete PNG');
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const packed = zlib.inflateSync(Buffer.concat(idat));
  if (packed.length !== height * (stride + 1)) throw new Error('Unexpected PNG data length');
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = packed[y * (stride + 1)];
    if (filter > 4) throw new Error(`Unsupported PNG filter ${filter}`);
    for (let x = 0; x < stride; x++) {
      const value = packed[y * (stride + 1) + 1 + x];
      const left = x >= channels ? raw[y * stride + x - channels] : 0;
      const up = y ? raw[(y - 1) * stride + x] : 0;
      const upperLeft = y && x >= channels ? raw[(y - 1) * stride + x - channels] : 0;
      const predictor = filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : filter === 4 ? paeth(left, up, upperLeft) : 0;
      raw[y * stride + x] = (value + predictor) & 0xff;
    }
  }
  const data = new Uint8ClampedArray(width * height * 4);
  for (let src = 0, dst = 0; src < raw.length; src += channels, dst += 4) {
    data[dst] = raw[src];
    data[dst + 1] = raw[src + 1];
    data[dst + 2] = raw[src + 2];
    data[dst + 3] = channels === 4 ? raw[src + 3] : 255;
  }
  return { width, height, data, colorType };
}

module.exports = { crc32, chunk, png, rgbaPng, decodePng };
