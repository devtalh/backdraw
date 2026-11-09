'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { MAX_REF_BYTES, MAX_ANIMATION_BYTES } = require('./limits');
const { decodePng } = require('./png-codec');
const { encodeGif } = require('./gif-writer');
const { gifInfo } = require('./gif');
const { motionSpec, renderLightMotion } = require('./light-motion');
const { contactSheet } = require('./contact-sheet');
const { decodeGifFrames } = require('../extension/gifframes');
const bad = message => Object.assign(new Error(message), { code: 'BAD_REQUEST' });

function animateImage({ imagePath, motion, size = 384, background = 'transparent', maxOutputBytes = MAX_ANIMATION_BYTES }) {
  if (typeof imagePath !== 'string' || !path.isAbsolute(imagePath)) throw bad('imagePath must be an absolute path');
  motionSpec(motion);
  if (!Number.isInteger(size) || size < 64 || size > 1024) throw bad('size must be an integer from 64 to 1024');
  if (!['transparent', 'white'].includes(background)) throw bad('background must be transparent or white');
  if (!Number.isFinite(maxOutputBytes) || maxOutputBytes < 0) throw bad('maxOutputBytes must be a non-negative finite number');
  let stat;
  try { stat = fs.statSync(imagePath); } catch (err) { throw bad(`cannot read ${imagePath}: ${err.message}`); }
  if (!stat.isFile()) throw bad(`cannot read ${imagePath}: not a file`);
  if (stat.size > MAX_REF_BYTES) throw bad(`cannot read ${imagePath}: source exceeds ${MAX_REF_BYTES / 1024 / 1024} MB`);
  let bytes;
  try { bytes = fs.readFileSync(imagePath); } catch (err) { throw bad(`cannot read ${imagePath}: ${err.message}`); }
  let source;
  try { source = decodePng(bytes); } catch (err) {
    throw Object.assign(new Error(`${imagePath} is not a PNG file that can be decoded: ${err.message}`), { code: 'BAD_PNG' });
  }
  const rendered = renderLightMotion(source, { motion, size, background });
  const gif = encodeGif(rendered.frames, { width: rendered.width, height: rendered.height,
    delayMs: rendered.delaysMs, loop: 0, transparent: background === 'transparent' });
  const info = gifInfo(gif.data);
  if (!info || info.frames !== rendered.frames.length || info.truncated !== false) throw new Error('Encoded GIF failed self-check');
  const decoded = decodeGifFrames(gif.data, { maxFrames: 16 });
  if (decoded.total !== rendered.frames.length) throw new Error('Encoded GIF failed self-check');
  if (gif.data.length > maxOutputBytes) {
    const suggested = Math.max(64, Math.min(size - 1, Math.floor(size * Math.sqrt(maxOutputBytes / gif.data.length) * 0.9)));
    const advice = size > 64 ? `try a smaller size such as ${suggested}` : 'size is already at the minimum of 64; increase maxOutputBytes';
    throw bad(`GIF is ${(gif.data.length / 1024 / 1024).toFixed(3)} MB, exceeding ${(maxOutputBytes / 1024 / 1024).toFixed(3)} MB; ${advice}`);
  }
  // Build the sheet from GIF pixels so Claude sees exactly what the saved file plays.
  const decodedFrames = decoded.frames.map(frame => new Uint8Array(
    frame.rgba.buffer, frame.rgba.byteOffset, frame.rgba.byteLength));
  const sheet = contactSheet(decodedFrames, decoded.width, decoded.height);
  const stem = path.join(path.dirname(imagePath), path.parse(imagePath).name);
  let outputPath, saved = false;
  const maxNames = 1000;
  for (let suffix = 1; suffix <= maxNames; suffix++) {
    outputPath = `${stem}_${motion}${suffix === 1 ? '' : `_${suffix}`}.gif`;
    let fd;
    try {
      fd = fs.openSync(outputPath, 'wx');
      fs.writeFileSync(fd, gif.data);
      fs.closeSync(fd); fd = undefined;
      saved = true;
      break;
    } catch (err) {
      // Only a successful exclusive open establishes ownership of this partial file.
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(outputPath); } catch {}
      } else if (err.code === 'EEXIST') continue;
      throw Object.assign(new Error(`cannot write ${outputPath}: ${err.message}`), { code: err.code });
    }
  }
  if (!saved) throw bad(`cannot save GIF: all ${maxNames} output filenames for ${stem}_${motion} already exist`);
  return { path: outputPath, sourcePath: imagePath, motion, width: rendered.width, height: rendered.height,
    frames: rendered.frames.length, delaysMs: info.delaysMs, durationMs: info.durationMs, bytes: gif.data.length,
    background, pixelArt: rendered.pixelArt, pixelScale: rendered.pixelScale,
    opaqueSource: rendered.opaqueSource, sheet };
}

function animationResultLines(result, gallery) {
  const lines = [
    `SUCCESS \u2014 animated ${path.basename(result.sourcePath)} locally with "${result.motion}" (no ChatGPT, nothing was sent).`,
    `Saved: ${result.path}`,
    `Animated GIF: ${result.frames} frames, ${result.durationMs} ms per loop (${result.delaysMs[0]} ms per frame), loops forever; ${result.width} x ${result.height} px; ${(result.bytes / 1024).toFixed(1)} KB.`,
    result.background === 'transparent'
      ? 'Background: transparent (1-bit: pixels at least half opaque are kept with their own color, the rest are fully transparent).'
      : 'Background: white.',
    result.pixelArt
      ? `Pixel art detected (${result.pixelScale} px blocks): moved on its pixel grid and scaled with nearest neighbor, so edges stay sharp.`
      : 'Smooth image: resampled with premultiplied alpha, so edges get no halo.',
  ];
  if (result.opaqueSource) lines.push('WARNING \u2014 the PNG has no transparent pixels, so the whole rectangle moves. For a sticker, first make a transparent PNG (generate_image with transparent_background=true).');
  lines.push(
    `The attached preview shows all ${result.frames} frames in order, numbered from 1, over a checkerboard where the GIF is transparent. Check the loop and the edges.`,
    gallery.added ? `Gallery: added (${gallery.jobId}).` : `Gallery: not added \u2014 ${gallery.reason}. The GIF is saved.`,
    'The source PNG was not changed.',
  );
  return lines;
}

module.exports = { animateImage, animationResultLines };
