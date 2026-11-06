'use strict';
// GIF block facts (pure): walk tables and sub-blocks without decoding LZW image data.

function gifInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 13) return null;
  const signature = buf.toString('latin1', 0, 6);
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return null;
  const info = { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), frames: 0,
    delaysMs: [], durationMs: 0, loop: null, transparent: false, transparentFrames: 0, truncated: true };
  let pos = 13;
  let delayMs = 0;
  let transparent = false;

  function skipTable(packed) {
    if (packed & 0x80) pos += 3 * 2 ** ((packed & 7) + 1);
    return pos <= buf.length;
  }

  function subBlocks(visit) {
    let index = 0;
    while (pos < buf.length) {
      const size = buf[pos++];
      if (size === 0) return true;
      if (pos + size > buf.length) return false;
      if (visit) visit(pos, size, index++);
      pos += size;
    }
    return false;
  }

  if (!skipTable(buf[10])) return info;
  while (pos < buf.length) {
    const block = buf[pos++];
    if (block === 0x3b) { info.truncated = false; break; }
    if (block === 0x21) {
      if (pos >= buf.length) break;
      const label = buf[pos++];
      if (label === 0xf9) {
        // A GCE has exactly four payload bytes and a zero terminator.
        if (pos + 6 > buf.length || buf[pos] !== 4 || buf[pos + 5] !== 0) break;
        delayMs = buf.readUInt16LE(pos + 2) * 10;
        transparent = Boolean(buf[pos + 1] & 1);
        pos += 6;
      } else if (label === 0xff) {
        let loopExtension = false;
        if (!subBlocks((start, size, index) => {
          if (index === 0) {
            const id = buf.toString('latin1', start, start + size);
            loopExtension = id === 'NETSCAPE2.0' || id === 'ANIMEXTS1.0';
          } else if (loopExtension && size >= 3 && buf[start] === 1) {
            info.loop = buf.readUInt16LE(start + 1);
          }
        })) break;
      } else if (!subBlocks()) break;
    } else if (block === 0x2c) {
      if (pos + 9 > buf.length) break;
      const packed = buf[pos + 8];
      pos += 9;
      info.frames++;
      // Browsers often play 0 or 10 ms as 100 ms; report the raw delay unchanged.
      info.delaysMs.push(delayMs);
      info.durationMs += delayMs;
      if (transparent) { info.transparent = true; info.transparentFrames++; }
      delayMs = 0;
      transparent = false;
      if (!skipTable(packed) || pos >= buf.length) break;
      pos++; // LZW minimum code size
      if (!subBlocks()) break;
    } else break; // Unknown block introducer: stop with the facts collected so far.
  }
  return info;
}

module.exports = { gifInfo };
