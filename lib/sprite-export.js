'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { MAX_REF_BYTES, MAX_ANIMATION_BYTES } = require('./limits');
const { decodePng, encodePng } = require('./png-codec');
const { encodeGif } = require('./gif-writer');
const { gifInfo } = require('./gif');
const { decodeGifFrames } = require('../extension/gifframes');
const { contactSheet } = require('./contact-sheet');
const { renderSheet, sheetOptions, median } = require('./sprite-sheet');
const { spriteGates } = require('./sprite-gates');
const bad = message => Object.assign(new Error(message), { code: 'BAD_REQUEST' });

function scaleFrames(rendered, size) {
  const long = Math.max(rendered.width, rendered.height);
  const scale = size === undefined ? 1 : long > size ? size / long : Math.max(1, Math.floor(size / long));
  const sampling = scale === 1 ? 'native' : scale > 1 ? 'nearest' : 'smooth';
  const width = Math.max(1, Math.round(rendered.width * scale)), height = Math.max(1, Math.round(rendered.height * scale));
  if (scale === 1) return { width, height, scale, sampling, frames: rendered.frames };
  const frames = rendered.frames.map(frame => {
    const output = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const dst = (y * width + x) * 4;
      if (sampling === 'nearest') {
        const src = (Math.floor(y / scale) * rendered.width + Math.floor(x / scale)) * 4;
        output.set(frame.subarray(src, src + 4), dst);
        continue;
      }
      const x0 = x * rendered.width / width, x1 = (x + 1) * rendered.width / width;
      const y0 = y * rendered.height / height, y1 = (y + 1) * rendered.height / height;
      let alpha = 0; const rgb = [0, 0, 0];
      // Exact area integration with premultiplied alpha; transparent RGB never bleeds.
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
        const src = (yy * rendered.width + xx) * 4;
        const weight = (Math.min(x1, xx + 1) - Math.max(x0, xx)) * (Math.min(y1, yy + 1) - Math.max(y0, yy));
        const a = frame[src + 3] * weight;
        alpha += a; for (let c = 0; c < 3; c++) rgb[c] += frame[src + c] * a;
      }
      if (alpha) for (let c = 0; c < 3; c++) output[dst + c] = Math.round(rgb[c] / alpha);
      output[dst + 3] = Math.round(alpha / ((x1 - x0) * (y1 - y0)));
    }
    return output;
  });
  return { width, height, scale, sampling, frames };
}

// decodeGifFrames samples across an entire loop. A complete GIF prefix lets it
// decode exactly the first 16 saved frames, with the original palette/disposal.
function firstFramesGif(data, count) {
  let pos = 13, found = 0;
  const table = packed => { if (packed & 128) pos += 3 * (1 << ((packed & 7) + 1)); };
  const blocks = () => {
    for (;;) {
      if (pos >= data.length) throw new Error('Encoded GIF prefix failed self-check');
      const length = data[pos++];
      if (!length) return;
      pos += length;
    }
  };
  table(data[10]);
  for (;;) {
    if (pos >= data.length) throw new Error('Encoded GIF prefix failed self-check');
    const marker = data[pos++];
    if (marker === 0x21) { pos++; blocks(); }
    else if (marker === 0x2c) {
      const packed = data[pos + 8]; pos += 9; table(packed); pos++; blocks();
      if (++found === count) return Buffer.concat([data.subarray(0, pos), Buffer.from([0x3b])]);
    } else if (marker === 0x3b) break;
    else throw new Error('Encoded GIF prefix failed self-check');
  }
  return data;
}

function checkedGif(rendered, transparent, maxOutputBytes) {
  const gif = encodeGif(rendered.frames, { width: rendered.width, height: rendered.height,
    delayMs: rendered.durationsMs, transparent, loop: 0 });
  if (gif.data.length > maxOutputBytes) throw bad(`GIF is ${(gif.data.length / 1024 / 1024).toFixed(3)} MB, ` +
    `exceeding ${(maxOutputBytes / 1024 / 1024).toFixed(3)} MB; try a smaller size`);
  const info = gifInfo(gif.data);
  if (!info || info.frames !== rendered.frames.length || info.truncated !== false) throw new Error('Encoded GIF failed self-check');
  let decoded;
  try { decoded = decodeGifFrames(gif.data); } catch (err) {
    if (/limits|budget/.test(err.message)) throw bad(`${err.message}; try a smaller size`);
    throw err;
  }
  if (decoded.total !== rendered.frames.length) throw new Error('Encoded GIF failed self-check');
  if (decoded.total > 16) decoded = decodeGifFrames(firstFramesGif(gif.data, 16));
  return { data: gif.data, info, decoded };
}

function animateSheet(input) {
  const options = sheetOptions(input), { imagePath, motion, background, maxOutputBytes = MAX_ANIMATION_BYTES } = options;
  if (typeof imagePath !== 'string' || !path.isAbsolute(imagePath)) throw bad('imagePath must be an absolute path');
  if (!Number.isFinite(maxOutputBytes) || maxOutputBytes < 0) throw bad('maxOutputBytes must be a non-negative finite number');
  let bytes;
  try {
    const stat = fs.statSync(imagePath);
    if (!stat.isFile()) throw new Error('not a file');
    if (stat.size > MAX_REF_BYTES) throw new Error(`source exceeds ${MAX_REF_BYTES / 1024 / 1024} MB`);
    bytes = fs.readFileSync(imagePath);
    if (bytes.length > MAX_REF_BYTES) throw new Error(`source exceeds ${MAX_REF_BYTES / 1024 / 1024} MB`);
  } catch (err) { throw bad(`cannot read ${imagePath}: ${err.message}`); }
  let source;
  try { source = decodePng(bytes); } catch (err) {
    throw Object.assign(new Error(`${imagePath} is not a PNG file that can be decoded: ${err.message}`), { code: 'BAD_PNG' });
  }
  const rendered = renderSheet(source, options), gates = spriteGates(rendered);
  const scaled = { ...scaleFrames(rendered, options.size), durationsMs: rendered.durationsMs };
  const transparent = checkedGif(scaled, true, maxOutputBytes);
  const white = background === 'white' ? checkedGif(scaled, false, maxOutputBytes) : null;
  const selected = white || transparent;
  const sheet = contactSheet(selected.decoded.frames.map(f => new Uint8Array(f.rgba.buffer, f.rgba.byteOffset, f.rgba.byteLength)), scaled.width, scaled.height);
  const name = path.parse(imagePath).name, stem = `${name}_${motion}`, count = rendered.frames.length;
  const columns = options.columns ?? Math.ceil(Math.sqrt(count)), rows = Math.ceil(count / columns);
  const aw = columns * rendered.width, ah = rows * rendered.height, atlas = new Uint8Array(aw * ah * 4);
  const files = new Map();
  const frames = rendered.frames.map((rgba, i) => {
    const x = i % columns * rendered.width, y = Math.floor(i / columns) * rendered.height;
    for (let yy = 0; yy < rendered.height; yy++) atlas.set(rgba.subarray(yy * rendered.width * 4, (yy + 1) * rendered.width * 4), ((y + yy) * aw + x) * 4);
    const file = `frames/frame_${String(i + 1).padStart(2, '0')}.png`;
    files.set(file, encodePng(rendered.width, rendered.height, rgba));
    return { index: i + 1, file, rect: { x, y, w: rendered.width, h: rendered.height }, durationMs: transparent.info.delaysMs[i],
      lift: rendered.lifts[i], sourceRect: rendered.components[i].bbox, row: rendered.components[i].row, col: rendered.components[i].col };
  });
  const gifFile = `${stem}.gif`, whiteFile = white ? `${stem}_white.gif` : null;
  const manifest = {
    format: 'backdraw-sprite-sheet', version: 1,
    source: { file: path.basename(imagePath), width: source.width, height: source.height, sha256: crypto.createHash('sha256').update(bytes).digest('hex') },
    motion, frameCount: count, fps: Number((1000 / median(transparent.info.delaysMs)).toFixed(2)), loop: true,
    cell: { width: rendered.width, height: rendered.height }, groundY: rendered.groundY, anchor: { x: rendered.anchorX, y: rendered.groundY },
    atlas: { file: 'atlas.png', width: aw, height: ah, columns, rows },
    gif: { file: gifFile, width: scaled.width, height: scaled.height, scale: scaled.scale, sampling: scaled.sampling },
    ...(rendered.jump ? { jump: rendered.jump } : {}), frames, gates, notes: rendered.notes,
  };
  files.set(gifFile, transparent.data);
  if (white) files.set(whiteFile, white.data);
  files.set('atlas.png', encodePng(aw, ah, atlas));
  files.set('contact.png', sheet.png);
  files.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  // All pixels, encoded outputs and self-checks are ready before owning a directory.
  let folder;
  const base = path.join(path.dirname(imagePath), `${stem}_sheet`);
  for (let suffix = 1; suffix <= 1000; suffix++) {
    const candidate = `${base}${suffix === 1 ? '' : `_${suffix}`}`;
    try { fs.mkdirSync(candidate); folder = candidate; break; } catch (err) { if (err.code !== 'EEXIST') throw err; }
  }
  if (!folder) throw bad(`cannot save sheet: all 1000 output folders for ${stem}_sheet already exist`);
  const ownedFiles = [], ownedDirs = [folder];
  try {
    const frameDir = path.join(folder, 'frames'); fs.mkdirSync(frameDir); ownedDirs.push(frameDir);
    for (const [file, data] of files) {
      const dest = path.join(folder, file), fd = fs.openSync(dest, 'wx');
      ownedFiles.push(dest);
      try { fs.writeFileSync(fd, data); } finally { fs.closeSync(fd); }
    }
  } catch (err) {
    const cleanupErrors = [];
    for (const file of ownedFiles.reverse()) { try { fs.unlinkSync(file); } catch (e) { cleanupErrors.push(e); } }
    for (const dir of ownedDirs.reverse()) { try { fs.rmdirSync(dir); } catch (e) { cleanupErrors.push(e); } }
    if (cleanupErrors.length) throw Object.assign(new AggregateError([err, ...cleanupErrors],
      `${err.message}; output cleanup failed: ${cleanupErrors.map(e => e.message).join('; ')}`, { cause: err }), { code: err.code });
    throw err;
  }
  const paths = { gif: path.join(folder, gifFile), whiteGif: whiteFile ? path.join(folder, whiteFile) : null,
    atlas: path.join(folder, 'atlas.png'), manifest: path.join(folder, 'manifest.json'), contact: path.join(folder, 'contact.png'),
    frames: frames.map(f => path.join(folder, f.file)) };
  return { folder, paths, path: paths.whiteGif || paths.gif, sourcePath: imagePath, motion, background,
    frames: count, durationsMs: transparent.info.delaysMs, durationMs: transparent.info.durationMs,
    width: scaled.width, height: scaled.height, cell: manifest.cell, groundY: rendered.groundY, anchorX: rendered.anchorX,
    scale: scaled.scale, sampling: scaled.sampling, bytes: selected.data.length, gates, notes: rendered.notes, jump: rendered.jump, sheet, manifest };
}

function sheetResultLines(result, gallery) {
  const lines = [
    `SUCCESS \u2014 animated sprite sheet ${path.basename(result.sourcePath)} locally with "${result.motion}" (no ChatGPT or Chrome).`,
    `Saved folder: ${result.folder}`,
    `Transparent GIF: ${result.paths.gif}`,
    ...(result.paths.whiteGif ? [`White GIF: ${result.paths.whiteGif}`] : []),
    `Animated GIF: ${result.frames} frames, ${result.durationMs} ms per loop, loops forever; ${result.width} x ${result.height} px; ${(result.bytes / 1024).toFixed(1)} KB.`,
    `Alignment: common ground line y=${result.groundY} and horizontal alpha center of mass x=${result.anchorX}; source frames were translated, not scaled (${result.cell.width} x ${result.cell.height} cells).`,
    `GIF sampling: ${result.sampling}, scale ${result.scale}; atlas and frame PNGs remain at source scale.`,
  ];
  if (result.jump) lines.push(`Jump arc: air frames ${result.jump.airFrames.join('-')} (1-based), peak ${result.jump.peak} source pixels, rule ${result.jump.rule}.`);
  if (result.notes.opaqueFallback) lines.push(`Opaque background removed from the edges: RGB ${result.notes.backgroundColor.join(', ')}.`);
  lines.push(`Extraction: ${result.notes.discardedSpecks} discarded specks (${result.notes.discardedSpeckArea} pixels), ${result.notes.splitTouching} touching-frame splits.`);
  const failed = result.gates.filter(g => !g.passed);
  if (!failed.length) lines.push(`QUALITY: all ${result.gates.length} checks passed (${result.gates.map(g => g.id).join(', ')}).`);
  else for (const g of failed) lines.push(`WARNING \u2014 ${g.id}: ${g.message}`);
  lines.push(`Edges: ${result.gates.find(g => g.id === 'edges').message}.`,
    `Loop seam: ${result.gates.find(g => g.id === 'seam').message}.`,
    `Contact preview: ${result.paths.contact}; shows ${result.frames > 16 ? 'only the first 16' : `all ${result.frames}`} frames in order, numbered from 1, over a checkerboard.`,
    `Atlas, manifest and source-scale frame PNGs: ${result.folder}`,
    gallery.added ? `Gallery: added (${gallery.jobId}).` : `Gallery: not added \u2014 ${gallery.reason}. The GIF is saved.`,
    'The source PNG was not changed.');
  return lines;
}

module.exports = { animateSheet, sheetResultLines, scaleFrames, firstFramesGif };
