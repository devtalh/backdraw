'use strict';
// Periodic affine motion and inverse sampling, without filesystem access.
const SPECS = Object.freeze({
  bounce: [16, 50], idle: [16, 110], sway: [16, 80],
  nod: [12, 80], squash: [12, 60], wiggle: [10, 40],
});
const LIGHT_MOTIONS = Object.freeze(Object.keys(SPECS));
const bad = message => Object.assign(new Error(message), { code: 'BAD_REQUEST' });

function motionSpec(name) {
  if (!LIGHT_MOTIONS.includes(name)) throw bad(`Unknown motion. Use: ${LIGHT_MOTIONS.join(', ')}.`);
  const [frames, delayMs] = SPECS[name];
  return { name, frames, delayMs };
}

function motionAt(name, t) {
  motionSpec(name);
  if (!Number.isFinite(t)) throw bad('Motion time must be finite');
  t = ((t % 1) + 1) % 1;
  const wave = Math.sin(2 * Math.PI * t), breath = (1 - Math.cos(2 * Math.PI * t)) / 2;
  const p = { angle: 0, sx: 1, sy: 1, dx: 0, lift: 0 };
  if (name === 'bounce') {
    const d = Math.min(t, 1 - t);
    if (d <= 0.1) {
      const q = (1 + Math.cos(Math.PI * d / 0.1)) / 2;
      p.sy = 1 - 0.14 * q; p.sx = 1 + 0.10 * q;
    } else {
      const u = (t - 0.1) / 0.8;
      p.lift = 0.18 * 4 * u * (1 - u);
    }
  } else if (name === 'idle') {
    p.sy = 1 + 0.035 * breath; p.sx = 1 - 0.015 * breath;
  } else if (name === 'sway') p.angle = 7 * wave;
  else if (name === 'nod') { p.angle = 9 * breath; p.sy = 1 - 0.04 * breath; }
  else if (name === 'squash') { p.sy = 1 - 0.14 * wave; p.sx = 1 + 0.10 * wave; }
  else { p.angle = 5 * wave; p.dx = 0.025 * wave; }
  return p;
}

function detectPixelArt(rgba, width, height) {
  // Scan image transitions once; test candidate grids using coordinate histograms.
  const horizontal = new Uint32Array(width), vertical = new Uint32Array(height);
  let hx = 0, vy = 0;
  const differs = (a, b) => Math.abs(rgba[a] - rgba[b]) > 24 ||
    Math.abs(rgba[a + 1] - rgba[b + 1]) > 24 || Math.abs(rgba[a + 2] - rgba[b + 2]) > 24 ||
    Math.abs(rgba[a + 3] - rgba[b + 3]) > 24;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    if (x && differs(i, i - 4)) { horizontal[x]++; hx++; }
    if (y && differs(i, i - width * 4)) { vertical[y]++; vy++; }
  }
  const none = { pixelArt: false, scale: 1, offsetX: 0, offsetY: 0 };
  if (hx < 24 || vy < 24) return none;
  for (let k = Math.min(32, Math.floor(Math.min(width, height) / 2)); k >= 2; k--) {
    const xs = new Float64Array(k), ys = new Float64Array(k);
    for (let x = 1; x < width; x++) xs[x % k] += horizontal[x];
    for (let y = 1; y < height; y++) ys[y % k] += vertical[y];
    const mx = Math.max(...xs), my = Math.max(...ys);
    if (mx / hx >= 0.97 && my / vy >= 0.97) {
      return { pixelArt: true, scale: k, offsetX: xs.indexOf(mx), offsetY: ys.indexOf(my) };
    }
  }
  return none;
}

function subject(source) {
  const { width, height, rgba } = source;
  let left = width, top = height, right = 0, bottom = 0, opaqueSource = true;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const alpha = rgba[(y * width + x) * 4 + 3];
    if (alpha < 255) opaqueSource = false;
    if (alpha < 16) continue;
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
  }
  if (right <= left) throw bad('the PNG is fully transparent');
  return { left, top, right, bottom, w: right - left, h: bottom - top,
    px: (left + right) / 2, py: bottom, opaqueSource };
}

function geometry(box, poses, natural) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  const transforms = poses.map(p => {
    const c = Math.cos(p.angle * Math.PI / 180), s = Math.sin(p.angle * Math.PI / 180);
    const tx = box.px + p.dx * box.w, ty = box.py - p.lift * box.h;
    for (const x of [box.left, box.right]) for (const y of [box.top, box.bottom]) {
      const xx = (x - box.px) * p.sx, yy = (y - box.py) * p.sy;
      const fx = tx + c * xx - s * yy, fy = ty + s * xx + c * yy;
      left = Math.min(left, fx); right = Math.max(right, fx);
      top = Math.min(top, fy); bottom = Math.max(bottom, fy);
    }
    return { ...p, c, s, tx, ty };
  });
  const margin = Math.max(2, Math.max(box.w, box.h) * 0.06);
  left -= margin; right += margin; top -= margin; bottom += margin;
  if (natural) { left = Math.floor(left); top = Math.floor(top); right = Math.ceil(right); bottom = Math.ceil(bottom); }
  return { left, top, width: right - left, height: bottom - top, transforms };
}

function naturalSource(source, grid) {
  const k = grid.scale;
  const ox = grid.offsetX ? grid.offsetX - k : 0, oy = grid.offsetY ? grid.offsetY - k : 0;
  const width = Math.ceil((source.width - ox) / k), height = Math.ceil((source.height - oy) / k);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const xx = Math.max(0, Math.min(source.width - 1, Math.floor(ox + (x + 0.5) * k)));
    const yy = Math.max(0, Math.min(source.height - 1, Math.floor(oy + (y + 0.5) * k)));
    const i = (yy * source.width + xx) * 4;
    rgba.set(source.rgba.subarray(i, i + 4), (y * width + x) * 4);
  }
  return { width, height, rgba };
}

function boxReduce(source, factor) {
  if (factor === 1) return { ...source, factor, premultiplied: false };
  const width = Math.ceil(source.width / factor), height = Math.ceil(source.height / factor);
  const rgba = new Float32Array(width * height * 4);
  const weight = 1 / (factor * factor);
  for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
    const i = (y * source.width + x) * 4, j = (Math.floor(y / factor) * width + Math.floor(x / factor)) * 4;
    const a = source.rgba[i + 3];
    for (let c = 0; c < 3; c++) rgba[j + c] += source.rgba[i + c] * a / 255 * weight;
    rgba[j + 3] += a * weight;
  }
  return { width, height, rgba, factor, premultiplied: true };
}

function sampleSmooth(source, x, y, output, dst) {
  x = x / source.factor - 0.5; y = y / source.factor - 0.5;
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  let r = 0, g = 0, b = 0, alpha = 0;
  for (let yy = 0; yy < 2; yy++) for (let xx = 0; xx < 2; xx++) {
    const sx = ix + xx, sy = iy + yy;
    if (sx < 0 || sy < 0 || sx >= source.width || sy >= source.height) continue;
    const i = (sy * source.width + sx) * 4, weight = (xx ? fx : 1 - fx) * (yy ? fy : 1 - fy);
    const a = source.rgba[i + 3], w = weight * (source.premultiplied ? 1 : a / 255);
    r += source.rgba[i] * w; g += source.rgba[i + 1] * w; b += source.rgba[i + 2] * w;
    alpha += a * weight;
  }
  if (alpha > 0) {
    output[dst] = Math.round(r * 255 / alpha); output[dst + 1] = Math.round(g * 255 / alpha);
    output[dst + 2] = Math.round(b * 255 / alpha); output[dst + 3] = Math.round(alpha);
  }
}

function nearestResize(frame, width, height, outW, outH) {
  const out = new Uint8Array(outW * outH * 4);
  for (let y = 0; y < outH; y++) for (let x = 0; x < outW; x++) {
    const i = (Math.floor((y + 0.5) * height / outH) * width + Math.floor((x + 0.5) * width / outW)) * 4;
    out.set(frame.subarray(i, i + 4), (y * outW + x) * 4);
  }
  return out;
}

function renderLightMotion(source, { motion, size, background }) {
  const spec = motionSpec(motion);
  if (!Number.isInteger(size) || size < 64 || size > 1024) throw bad('size must be an integer from 64 to 1024');
  if (!['transparent', 'white'].includes(background)) throw bad('background must be transparent or white');
  if (!source || !Number.isInteger(source.width) || !Number.isInteger(source.height) ||
      source.width < 1 || source.height < 1 || !(source.rgba instanceof Uint8Array) ||
      source.rgba.length !== source.width * source.height * 4) throw bad('Invalid source RGBA dimensions');
  const originalBox = subject(source), grid = detectPixelArt(source.rgba, source.width, source.height);
  if (grid.pixelArt) source = naturalSource(source, grid);
  const box = grid.pixelArt ? subject(source) : originalBox;
  const poses = Array.from({ length: spec.frames }, (_, i) => motionAt(motion, i / spec.frames));
  const canvas = geometry(box, poses, grid.pixelArt), long = Math.max(canvas.width, canvas.height);
  const scale = grid.pixelArt ? 1 : size / long;
  const renderW = grid.pixelArt ? canvas.width : Math.max(1, Math.round(canvas.width * scale));
  const renderH = grid.pixelArt ? canvas.height : Math.max(1, Math.round(canvas.height * scale));
  const multiplier = Math.max(1, Math.floor(size / long));
  const finalScale = long > size ? size / long : multiplier;
  const width = grid.pixelArt ? Math.max(1, Math.round(renderW * finalScale)) : renderW;
  const height = grid.pixelArt ? Math.max(1, Math.round(renderH * finalScale)) : renderH;
  const samples = grid.pixelArt ? source : boxReduce(source, scale < 0.5 ? Math.ceil(0.5 / scale) : 1);
  const frames = canvas.transforms.map(p => {
    const frame = new Uint8Array(renderW * renderH * 4);
    for (let y = 0; y < renderH; y++) for (let x = 0; x < renderW; x++) {
      const xx = canvas.left + (x + 0.5) / scale - p.tx;
      const yy = canvas.top + (y + 0.5) / scale - p.ty;
      const sx = box.px + (p.c * xx + p.s * yy) / p.sx;
      const sy = box.py + (-p.s * xx + p.c * yy) / p.sy;
      const dst = (y * renderW + x) * 4;
      if (grid.pixelArt) {
        const ix = Math.floor(sx), iy = Math.floor(sy);
        if (ix >= 0 && iy >= 0 && ix < source.width && iy < source.height) {
          const i = (iy * source.width + ix) * 4;
          frame.set(source.rgba.subarray(i, i + 4), dst);
        }
      } else sampleSmooth(samples, sx, sy, frame, dst);
    }
    return grid.pixelArt ? nearestResize(frame, renderW, renderH, width, height) : frame;
  });
  return { width, height, frames, delaysMs: Array(spec.frames).fill(spec.delayMs),
    durationMs: spec.frames * spec.delayMs, pixelArt: grid.pixelArt,
    pixelScale: grid.pixelArt ? grid.scale : null, opaqueSource: originalBox.opaqueSource };
}

module.exports = { LIGHT_MOTIONS, motionSpec, motionAt, detectPixelArt, renderLightMotion };
