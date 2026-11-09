'use strict';
// Sprite extraction and source-resolution alignment. No filesystem access.
const SHEET_MOTIONS = Object.freeze(['idle', 'walk', 'run', 'jump', 'dance', 'wave', 'attack', 'custom']);
const bad = message => Object.assign(new Error(message), { code: 'BAD_REQUEST' });
const median = values => {
  const a = [...values].sort((x, y) => x - y), n = a.length;
  return n ? (a[Math.floor((n - 1) / 2)] + a[Math.floor(n / 2)]) / 2 : 0;
};
const near = (a, b) => a.every((v, c) => Math.abs(v - b[c]) <= 24);

function sheetOptions(options) {
  const o = { ...options };
  if (!SHEET_MOTIONS.includes(o.motion)) throw bad(`Unknown motion. Use: ${SHEET_MOTIONS.join(', ')}.`);
  const integer = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  if ((o.columns === undefined) !== (o.rows === undefined)) throw bad('columns and rows must be provided together');
  if (o.columns !== undefined && (!integer(o.columns, 1, 16) || !integer(o.rows, 1, 16) ||
      !integer(o.columns * o.rows, 2, 64))) throw bad('columns and rows must be 1-16, with 2-64 cells');
  if (o.frames !== undefined && !integer(o.frames, 2, 64)) throw bad('frames must be an integer from 2 to 64');
  if (o.frames !== undefined && o.columns !== undefined && o.frames !== o.columns * o.rows) throw bad('frames conflicts with columns and rows');
  if (o.fps !== undefined && (typeof o.fps !== 'number' || !Number.isFinite(o.fps) || o.fps < 1 || o.fps > 50)) throw bad('fps must be from 1 to 50');
  if (o.durations_ms !== undefined && (!Array.isArray(o.durations_ms) || !o.durations_ms.length ||
      !Array.from(o.durations_ms).every(v => integer(v, 20, 5000)))) throw bad('durations_ms must contain integers from 20 to 5000');
  if (o.fps !== undefined && o.durations_ms !== undefined) throw bad('fps and durations_ms cannot be used together');
  if (o.jump_height !== undefined && (!integer(o.jump_height, 0, 2048) || o.motion !== 'jump')) throw bad('jump_height requires jump and an integer from 0 to 2048');
  if (o.air_frames !== undefined && (o.motion !== 'jump' || !Array.isArray(o.air_frames) || o.air_frames.length !== 2 ||
      !Array.from(o.air_frames).every(v => integer(v, 1, 64)) || o.air_frames[0] > o.air_frames[1])) throw bad('air_frames requires jump and an inclusive [first, last] range');
  if (o.size !== undefined && !integer(o.size, 64, 1024)) throw bad('size must be an integer from 64 to 1024');
  if (o.background === undefined) o.background = 'transparent';
  if (!['transparent', 'white'].includes(o.background)) throw bad('background must be transparent or white');
  if (o.include_preview !== undefined && typeof o.include_preview !== 'boolean') throw bad('include_preview must be a boolean');
  o.expected = o.frames ?? (o.columns === undefined ? undefined : o.columns * o.rows);
  return o;
}

function sheetMask({ width, height, rgba }) {
  const count = width * height, mask = new Uint8Array(count);
  let transparent = 0, semi = 0;
  for (let p = 0; p < count; p++) {
    const a = rgba[p * 4 + 3];
    if (a < 128) transparent++;
    if (a > 0 && a < 255) semi++;
    mask[p] = a >= 128 ? 1 : 0;
  }
  const notes = { opaqueFallback: false, sourceSemiTransparent: semi / count };
  if (transparent / count >= 0.01) return { mask, notes };
  const edges = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!x || !y || x === width - 1 || y === height - 1) edges.push(y * width + x);
  }
  const rgb = p => [rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2]];
  // A >60% color cluster contains the per-channel median. Verify the actual
  // tolerance against every border pixel rather than trusting a quantized mode.
  const color = [0, 1, 2].map(c => Math.round(median(edges.map(p => rgba[p * 4 + c]))));
  if (edges.filter(p => near(rgb(p), color)).length < edges.length * 0.6) {
    throw bad('no transparent background and no flat background color found at the edges');
  }
  const queue = new Int32Array(count), seen = new Uint8Array(count);
  let head = 0, tail = 0;
  const add = p => {
    if (!seen[p] && near(rgb(p), color)) { seen[p] = 1; mask[p] = 0; queue[tail++] = p; }
  };
  edges.forEach(add);
  while (head < tail) {
    const p = queue[head++], x = p % width;
    if (x) add(p - 1);
    if (x + 1 < width) add(p + 1);
    if (p >= width) add(p - width);
    if (p + width < count) add(p + width);
  }
  return { mask, notes: { ...notes, opaqueFallback: true, backgroundColor: color } };
}

function component(pixels, source) {
  const { width, rgba } = source;
  let x = width, y = source.height, right = -1, bottom = -1, mass = 0, mx = 0, my = 0, maskX = 0;
  for (const p of pixels) {
    const xx = p % width, yy = Math.floor(p / width), a = rgba[p * 4 + 3];
    x = Math.min(x, xx); y = Math.min(y, yy); right = Math.max(right, xx); bottom = Math.max(bottom, yy);
    mass += a; mx += xx * a; my += yy * a;
    maskX += xx;
  }
  return { pixels, area: pixels.length, bbox: { x, y, w: right - x + 1, h: bottom - y + 1 },
    cx: mx / mass, cy: my / mass, maskCx: maskX / pixels.length };
}

function connectedComponents(source, mask) {
  const { width, height } = source, seen = new Uint8Array(mask.length), queue = new Int32Array(mask.length), result = [];
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p] || seen[p]) continue;
    let head = 0, tail = 1;
    queue[0] = p; seen[p] = 1;
    while (head < tail) {
      const q = queue[head++], x = q % width, y = Math.floor(q / width);
      for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx++) {
          const k = yy * width + xx;
          if (mask[k] && !seen[k]) { seen[k] = 1; queue[tail++] = k; }
        }
      }
    }
    result.push(component(queue.slice(0, tail), source));
  }
  return result;
}

function bboxDistance(a, b) {
  return Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w), a.y - (b.y + b.h), b.y - (a.y + a.h));
}

function extractFrames(source, options) {
  const { mask, notes } = sheetMask(source), all = connectedComponents(source, mask);
  const sorted = [...all].sort((a, b) => b.area - a.area);
  // Prevent specks lowering the median when fewer real frames exist than expected.
  const reference = options.expected
    ? Math.max(median(sorted.slice(0, options.expected).map(c => c.area)), 0.5 * (sorted[0]?.area ?? 0))
    : median(sorted.filter(c => c.area >= sorted[0].area * 0.1).map(c => c.area));
  let large = all.filter(c => c.area >= reference * 0.02);
  const small = all.filter(c => c.area < reference * 0.02);
  const distance = Math.max(4, Math.round(0.15 * median(large.map(c => c.bbox.h))));
  notes.discardedSpecks = 0; notes.discardedSpeckArea = 0; notes.splitTouching = 0;
  for (const speck of small) {
    let chosen = -1, best = Infinity;
    large.forEach((c, i) => { const d = bboxDistance(c.bbox, speck.bbox); if (d < best) { best = d; chosen = i; } });
    if (chosen >= 0 && best <= distance) {
      const pixels = new Int32Array(large[chosen].area + speck.area);
      pixels.set(large[chosen].pixels); pixels.set(speck.pixels, large[chosen].area);
      large[chosen] = component(pixels, source);
    } else { notes.discardedSpecks++; notes.discardedSpeckArea += speck.area; }
  }
  while (options.expected && large.length < options.expected) {
    const mw = options.columns
      ? (Math.max(...large.map(c => c.bbox.x + c.bbox.w)) - Math.min(...large.map(c => c.bbox.x))) / options.columns
      : median(large.map(c => c.bbox.w));
    const mh = options.rows
      ? (Math.max(...large.map(c => c.bbox.y + c.bbox.h)) - Math.min(...large.map(c => c.bbox.y))) / options.rows
      : median(large.map(c => c.bbox.h));
    const candidates = large.filter(c => c.bbox.w >= 1.6 * mw || c.bbox.h >= 1.6 * mh)
      .sort((a, b) => b.bbox.w - a.bbox.w || b.bbox.h - a.bbox.h);
    let divided = false;
    for (const c of candidates) {
      const horizontal = c.bbox.w >= 1.6 * mw, length = horizontal ? c.bbox.w : c.bbox.h;
      const start = horizontal ? c.bbox.x : c.bbox.y, counts = new Uint32Array(length);
      const coordinate = p => horizontal ? p % source.width : Math.floor(p / source.width);
      for (const p of c.pixels) counts[coordinate(p) - start]++;
      let cut = -1;
      for (let k = Math.ceil(length * 0.25); k < length * 0.75; k++) {
        if (cut < 0 || counts[k] < counts[cut] || (counts[k] === counts[cut] && Math.abs(k - length / 2) < Math.abs(cut - length / 2))) cut = k;
      }
      const a = c.pixels.filter(p => coordinate(p) < start + cut), b = c.pixels.filter(p => coordinate(p) >= start + cut);
      if (!a.length || !b.length) continue;
      large.splice(large.indexOf(c), 1, component(a, source), component(b, source));
      notes.splitTouching++; divided = true; break;
    }
    if (!divided) break;
  }
  if (large.length < 2 || large.length > 64) throw bad(`Found ${large.length} frames; animation requires 2-64 frames`);
  large.sort((a, b) => a.bbox.y - b.bbox.y || a.cx - b.cx);
  let rows = [], bottom = -Infinity;
  for (const c of large) {
    if (c.bbox.y >= bottom) rows.push([]);
    rows[rows.length - 1].push(c);
    bottom = Math.max(bottom, c.bbox.y + c.bbox.h);
  }
  if (options.rows && rows.length !== options.rows) {
    large.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
    const gaps = large.slice(1).map((c, i) => ({ index: i + 1, gap: c.cy - large[i].cy }));
    const breaks = new Set(gaps.sort((a, b) => b.gap - a.gap).slice(0, options.rows - 1).map(g => g.index));
    rows = [[]];
    large.forEach((c, i) => { if (breaks.has(i)) rows.push([]); rows[rows.length - 1].push(c); });
  }
  large = rows.flatMap((row, r) => row.sort((a, b) => a.cx - b.cx).map((c, i) => ({ ...c, row: r + 1, col: i + 1 })));
  return { components: large, notes };
}

function jumpArc(components, options) {
  const n = components.length, lifts = Array(n).fill(0);
  if (options.motion !== 'jump') return { lifts };
  let first, last, rule = 'auto';
  if (options.air_frames) {
    [first, last] = options.air_frames.map(v => v - 1); rule = 'air_frames';
    if (last >= n) throw bad('air_frames exceeds the found frame count');
  } else {
    const heights = components.map(c => c.bbox.h), crouched = heights.map(h => h < 0.85 * median(heights));
    const runs = [];
    for (let i = 0; i < n;) {
      if (!crouched[i]) { i++; continue; }
      const start = i;
      while (i + 1 < n && crouched[i + 1]) i++;
      runs.push({ first: start, last: i++ });
    }
    if (runs.length >= 2) {
      const candidateFirst = runs[0].last + 1, candidateLast = runs[runs.length - 1].first - 1;
      if (candidateLast - candidateFirst + 1 >= 2) { first = candidateFirst; last = candidateLast; }
    }
    if (first === undefined && runs.length) {
      let start = 0, best = 0;
      for (let i = 0; i <= n; i++) {
        if (i === n || crouched[i]) {
          if (i - start > best) { best = i - start; first = start; last = i - 1; }
          start = i + 1;
        }
      }
      if (best < 2) first = last = undefined;
    }
    if (first === undefined) {
      first = Math.floor(n / 4); last = Math.floor(3 * n / 4) - 1; rule = 'fallback';
    }
  }
  const peak = options.jump_height ?? Math.round(0.5 * median(components.map(c => c.bbox.h)));
  for (let i = first; i <= last; i++) {
    const t = (i - first + 1) / (last - first + 2);
    lifts[i] = Math.round(peak * 4 * t * (1 - t));
  }
  return { lifts, jump: { airFrames: [first + 1, last + 1], peak, rule } };
}

function frameDurations(components, options, jump) {
  const n = components.length;
  if (options.durations_ms) {
    if (options.durations_ms.length !== n) throw bad('durations_ms length must equal the found frame count');
    return [...options.durations_ms];
  }
  if (options.fps !== undefined) return Array(n).fill(1000 / options.fps);
  const base = { idle: 150, walk: 83, run: 55, dance: 100, wave: 100, custom: 100, attack: 70, jump: 90 };
  const times = Array(n).fill(base[options.motion]);
  if (jump) {
    const [first, last] = jump.airFrames.map(v => v - 1);
    for (let i = first; i <= last; i++) times[i] = 60;
    if (first) times[first - 1] = 150;
    if (last + 1 < n) times[last + 1] = 150;
  } else if (options.motion === 'attack') {
    const hit = components.findIndex(c => c.bbox.w === Math.max(...components.map(c => c.bbox.w)));
    times[hit] = 220; if (hit) times[hit - 1] = 140;
  }
  return times;
}

function renderSheet(source, input) {
  if (!source || !Number.isInteger(source.width) || !Number.isInteger(source.height) ||
      source.width < 1 || source.height < 1 || !(source.rgba instanceof Uint8Array) ||
      source.rgba.length !== source.width * source.height * 4) throw bad('Invalid source RGBA dimensions');
  const options = sheetOptions(input);
  const { components, notes } = extractFrames(source, options), { lifts, jump } = jumpArc(components, options);
  const pad = Math.max(2, Math.round(0.05 * Math.max(...components.map(c => Math.max(c.bbox.w, c.bbox.h)))));
  // The extracted pixels have binary alpha. Align their final alpha centroid,
  // retaining the original alpha-weighted component centroids for source ordering.
  const extent = Math.max(...components.flatMap(c => [Math.round(c.maskCx) - c.bbox.x, c.bbox.x + c.bbox.w - Math.round(c.maskCx)]));
  const width = 2 * extent + 2 * pad, height = pad + Math.max(...components.map((c, i) => c.bbox.h + lifts[i])) + pad;
  const anchorX = width / 2, groundY = height - pad - 1;
  const frames = components.map((c, i) => {
    const rgba = new Uint8Array(width * height * 4), dx = anchorX - Math.round(c.maskCx), dy = groundY - lifts[i] - (c.bbox.y + c.bbox.h - 1);
    for (const p of c.pixels) {
      const dest = ((Math.floor(p / source.width) + dy) * width + p % source.width + dx) * 4;
      rgba.set(source.rgba.subarray(p * 4, p * 4 + 3), dest); rgba[dest + 3] = 255;
    }
    return rgba;
  });
  return { width, height, anchorX, groundY, frames, components, lifts, jump, notes,
    durationsMs: frameDurations(components, options, jump), options };
}

module.exports = { SHEET_MOTIONS, median, near, sheetOptions, sheetMask, connectedComponents, extractFrames, jumpArc, frameDurations, renderSheet };
