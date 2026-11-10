'use strict';
// Small source rasters, kept in memory unless a caller copies them to OS temp.
function raster(width = 180, height = 120) {
  return { width, height, rgba: new Uint8Array(width * height * 4) };
}
function rect(source, x, y, w, h, color = [30, 150, 70, 255]) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
    source.rgba.set(color, (yy * source.width + xx) * 4);
  }
  return source;
}
function grid(columns = 3, rows = 2, { colored = false, heights } = {}) {
  const source = raster(columns * 60, rows * 60);
  for (let i = 0; i < columns * rows; i++) {
    const h = heights ? heights[i] : 20;
    rect(source, i % columns * 60 + 12 + i % 3, Math.floor(i / columns) * 60 + 35 - h + i % 2 * 3, 20, h,
      colored ? [20 + i * 25, 50 + i * 12, 90 + i * 8, 255] : undefined);
  }
  return source;
}
function bounds(rgba, width) {
  let left = width, right = -1, top = rgba.length / 4 / width, bottom = -1, mass = 0, mx = 0;
  for (let p = 0; p < rgba.length / 4; p++) if (rgba[p * 4 + 3]) {
    const x = p % width, y = Math.floor(p / width);
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    mx += x; mass++;
  }
  return { left, right, top, bottom, cx: mx / mass, area: mass };
}
module.exports = { raster, rect, grid, bounds };
