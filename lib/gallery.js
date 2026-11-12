'use strict';
// The gallery of the extension's side panel: the images of succeeded jobs. The panel names an image by
// its job id and number (1-based, like the preview files) only; every path comes from the host's own
// job records, never from the extension.
const fs = require('fs');
const path = require('path');
const { cut, chars, isInside } = require('./collections');
const { parseAspect, withinAspect } = require('./aspect');
const { chatIdFromUrl } = require('./chat-cleanup');

const PAGE_MAX = 100;
const MAX_PROMPT = 300;
// A preview goes to the extension in one native message, which Chrome caps at 1 MB (base64 adds a third).
const MAX_PREVIEW_BYTES = 640 * 1024;

const succeeded = j => !!j && j.status === 'succeeded' && Array.isArray(j.images);
// A hand-edited jobs.json may hold anything: only absolute paths count as images.
const usable = im => !!im && typeof im.path === 'string' && path.isAbsolute(im.path);
const shortPrompt = s => (chars(s || '').length > MAX_PROMPT ? `${cut(s, MAX_PROMPT)}…` : String(s || ''));

function imageFormat(file) {
  const ext = path.extname(file).toLowerCase();
  return ({ '.png': 'PNG', '.jpg': 'JPG', '.jpeg': 'JPG', '.webp': 'WEBP', '.gif': 'GIF' })[ext] || null;
}

function appliedAspect(im, format) {
  if (format === 'GIF' || im.gif !== undefined && im.gif !== null) return null;
  try {
    const aspect = parseAspect(im.aspect);
    return im.full || withinAspect(im.width, im.height, aspect) ? aspect.label : null;
  } catch {
    return null;
  }
}

function fileExists(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

// Newest job first, a job's own images in their order. exists(path), when given, marks the files that
// are gone (moved or deleted by hand); only the page asked for is checked.
function listGallery(jobs, offset = 0, limit = 12, exists = null) {
  const all = [];
  for (const j of (Array.isArray(jobs) ? jobs : []).slice().reverse()) {
    if (succeeded(j)) j.images.forEach((im, i) => { if (usable(im)) all.push({ j, im, n: i + 1 }); });
  }
  const from = Math.max(0, Math.floor(Number(offset)) || 0);
  const size = Math.min(PAGE_MAX, Math.max(1, Math.floor(Number(limit)) || 12));
  const items = all.slice(from, from + size).map(({ j, im, n }) => {
    const format = imageFormat(im.path);
    const frames = im.gif && Number.isInteger(im.gif.frames) && im.gif.frames > 0 ? im.gif.frames : null;
    const durationMs = im.gif && Number.isFinite(im.gif.durationMs) && im.gif.durationMs >= 0 ? im.gif.durationMs : null;
    const state = j.chatStates?.[chatIdFromUrl(j.conversationUrl)]?.state;
    return {
      jobId: j.id, n, createdAt: j.createdAt || null, prompt: shortPrompt(j.prompt), conversationUrl: j.conversationUrl || null,
      chatState: state === 'archived' || state === 'deleted' ? state : null,
      path: im.path, width: im.width || null, height: im.height || null, format, frames, durationMs,
      aspect: appliedAspect(im, format), preview: !!im.preview,
      ...(exists ? { missing: !exists(im.path) } : {}),
    };
  });
  const end = from + items.length;
  return { total: all.length, items, next: end < all.length ? end : null };
}

// { job, image } or null. n must be a whole number: "1" or 1.5 never match.
function findJobImage(jobs, jobId, n) {
  if (typeof jobId !== 'string' || !Number.isInteger(n) || n < 1) return null;
  const job = (Array.isArray(jobs) ? jobs : []).find(j => j && j.id === jobId);
  if (!succeeded(job)) return null;
  const image = job.images[n - 1];
  return usable(image) ? { job, image } : null;
}

// The preview JPEG or PNG the host saved while it is still there (the host deletes previews
// after 7 days): { data: base64 | null, mime }. Only files inside the previews folder are read.
function readPreview(previewDir, image) {
  const file = image && image.preview;
  try {
    if (typeof file === 'string' && isInside(previewDir, file) && fs.statSync(file).size <= MAX_PREVIEW_BYTES) {
      const buf = fs.readFileSync(file);
      if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { data: buf.toString('base64'), mime: 'image/jpeg' };
      if (buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { data: buf.toString('base64'), mime: 'image/png' };
    }
  } catch {}
  return { data: null, mime: null };
}

// The saved GIF itself, for animating its gallery card. It must still fit in one native message.
function readAnimation(image) {
  const file = image && image.path;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_PREVIEW_BYTES) return { data: null, mime: null };
    const buf = fs.readFileSync(file);
    const signature = buf.subarray(0, 6).toString('latin1');
    if (signature === 'GIF87a' || signature === 'GIF89a') return { data: buf.toString('base64'), mime: 'image/gif' };
  } catch {}
  return { data: null, mime: null };
}

module.exports = { PAGE_MAX, MAX_PROMPT, MAX_PREVIEW_BYTES, fileExists, listGallery, findJobImage, readPreview, readAnimation };
