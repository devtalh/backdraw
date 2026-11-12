'use strict';
// Reference collections, the pure part: names, folder and file names, path checks, lookups, which
// images a job attaches and the MCP listing. The file system side is lib/collection-store.js.
const path = require('path');
const { slugify } = require('./naming');
const { normName } = require('./projects');
const { MAX_REFS, MAX_REF_BYTES, MAX_REFS_TOTAL_BYTES } = require('./limits');

const MAX_NAME = 64;
const IMAGE_EXTS = ['png', 'jpg', 'webp', 'gif'];
// The only host methods the extension may call over its native port ({type: 'call'}).
const EXTENSION_METHODS = new Set([
  'list_collections', 'collection_add', 'rename_collection', 'delete_collection', 'delete_collection_image', 'collection_thumbs',
  // The side panel's gallery (lib/gallery.js): images named by job id and number, never by a path.
  'gallery_list', 'gallery_thumb', 'gallery_animation', 'reveal_image', 'collection_add_job_image',
  'chat_cleanup_list', 'chat_cleanup_check', 'chat_cleanup_mark', 'chat_cleanup_release',
]);
// Windows device names; "CON.txt" or "con .x" open the device too.
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)(?=\s*(\.|$))/i;

const chars = s => Array.from(String(s)); // code points, so an emoji is never cut in half
const cut = (s, n) => chars(s).slice(0, n).join('');
const tidyName = s => String(s ?? '').replace(/\s/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/ +/g, ' ').trim();
const stripEnds = s => s.replace(/^[\s.]+|[\s.]+$/g, '');

// A collection name: 1-64 visible characters once control characters and extra spaces are gone.
function validateName(name) {
  const clean = tidyName(name);
  const n = chars(clean).length;
  if (!n) return { error: 'The collection name is empty.' };
  if (n > MAX_NAME) return { error: `The collection name is longer than ${MAX_NAME} characters.` };
  return { name: clean };
}

// The folder a collection gets. It never holds a path separator, never starts or ends with a dot or
// space and is never a device name, so it always stays a plain folder inside the collections folder.
function safeFolderName(name) {
  let s = stripEnds(cut(stripEnds(tidyName(String(name ?? '').replace(/[<>:"/\\|?*]/g, ''))), MAX_NAME));
  if (RESERVED.test(s)) s = stripEnds(cut(s.replace(RESERVED, '$1_'), MAX_NAME));
  return s || 'collection';
}

// A bare file name as the host writes them (no folder part, no device name, nothing Windows refuses).
function isPlainFile(f) {
  return typeof f === 'string' && /^[^<>:"/\\|?*\u0000-\u001f]{1,200}$/.test(f) && !/^\.+$/.test(f) && !/[ .]$/.test(f) && !RESERVED.test(f);
}

function isInside(root, p) {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel !== '' && !path.isAbsolute(rel) && rel.split(/[\\/]/)[0] !== '..';
}

// Exact name first, then ignoring case, then (loose) the normalized name used for ChatGPT projects.
// Returns { collection } or { error: 'NOT_FOUND' | 'AMBIGUOUS', ties }.
function findCollection(list, name, { loose = true } = {}) {
  const wanted = tidyName(name);
  const steps = [c => c.name === wanted, c => c.name.toLowerCase() === wanted.toLowerCase()];
  if (loose && normName(wanted)) steps.push(c => normName(c.name) === normName(wanted));
  for (const step of steps) {
    const hits = list.filter(step);
    if (hits.length === 1) return { collection: hits[0] };
    if (hits.length > 1) return { error: 'AMBIGUOUS', ties: hits };
  }
  return { error: 'NOT_FOUND' };
}

// Ties (the same or no addedAt, e.g. a hand-edited manifest) go by the file number, which grows with
// every image added, so sorting a sorted list again never changes it.
function newestFirst(images) {
  const num = im => parseInt(im.file, 10) || 0;
  return images.slice().sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')) || num(b) - num(a) ||
    String(b.file).localeCompare(String(a.file)));
}

const fileOf = f => String(f).split(/[\\/]/).pop().trim(); // a path works as its file name

// The images a job attaches: the files the caller picked (in that order), else the newest ones.
// unknown lists picked names the collection doesn't have.
function pickRefs(images, max, chosenFiles) {
  const room = Math.max(0, max);
  const picked = (chosenFiles || []).map(fileOf).filter(Boolean);
  if (!picked.length) return { used: newestFirst(images).slice(0, room), unknown: [] };
  const byName = new Map(images.map(im => [im.file.toLowerCase(), im]));
  return {
    used: [...new Set(picked.map(f => byName.get(f.toLowerCase())).filter(Boolean))].slice(0, room),
    unknown: picked.filter(f => !byName.has(f.toLowerCase())),
  };
}

const mb = n => `${n / 1048576} MB`;
const refBytes = r => String((r && r.data) || '').length * 0.75; // base64, measured like the host's createJob
const refError = message => Object.assign(new Error(message), { code: 'BAD_REQUEST' });

// generate with reference_collection: the request with the collection's images after the caller's own
// references, and what was used (job.collection). find(name) gives the collection (store.find) and
// read(col, im) one image as a reference ({ name, mime, data }); both throw. The newest images fill the
// free slots: one that is too large or can't be read is left out for the next one, and adding stops
// before the references together pass the total limit. Images picked with reference_files are all
// attached, or the request is refused.
function withCollection(p, { find, read }, limits = {}) {
  const { max = MAX_REFS, maxBytes = MAX_REF_BYTES, maxTotal = MAX_REFS_TOTAL_BYTES } = limits;
  const files = [].concat(p.referenceFiles ?? []).map(fileOf).filter(Boolean);
  if (!p.referenceCollection) {
    if (files.length) throw refError('reference_files needs reference_collection.');
    return { params: p, collection: null };
  }
  let col;
  try { col = find(String(p.referenceCollection)); } catch (e) { throw refError(e.message); }
  const own = Array.isArray(p.references) ? p.references : [];
  const room = max - own.length;
  if (room < 1) throw refError(`reference_images already use all ${max} reference slots, so no collection image fits.`);
  let budget = maxTotal - own.reduce((sum, r) => sum + refBytes(r), 0);
  if (budget <= 0) throw refError(`reference_images together already reach ${mb(maxTotal)}, so no collection image fits.`);
  const { used: wanted, unknown } = pickRefs(col.images, Infinity, files);
  if (unknown.length) {
    throw refError(`Collection "${col.name}" has no ${unknown.map(f => `"${f}"`).join(', ')}. ` +
      `Its files (newest first): ${col.images.slice(0, 40).map(im => im.file).join(', ') || '(none)'}`);
  }
  if (!col.images.length) throw refError(`Collection "${col.name}" has no images yet.`);
  const picked = files.length > 0;
  if (picked && wanted.length > room) throw refError(`reference_files picks ${wanted.length} images, but only ${room} fit (${max} references per request).`);
  const refs = [];
  const used = [];
  const skipped = [];
  for (const im of wanted) {
    if (refs.length >= room) break;
    let ref;
    try { ref = read(col, im); } catch (e) {
      if (picked) throw refError(e.message);
      skipped.push(`${im.file} (cannot be read)`);
      continue;
    }
    const size = refBytes(ref);
    if (size > maxBytes) {
      if (picked) throw refError(`"${im.file}" in collection "${col.name}" is larger than ${mb(maxBytes)}, the most one reference may be.`);
      skipped.push(`${im.file} (larger than ${mb(maxBytes)})`);
      continue;
    }
    if (size > budget) {
      if (picked) throw refError(`The picked images and reference_images together are larger than ${mb(maxTotal)}; pick fewer.`);
      skipped.push(`${im.file} (all references together would pass ${mb(maxTotal)})`);
      break;
    }
    budget -= size;
    refs.push(ref);
    used.push(im.file);
  }
  if (!refs.length) throw refError(`No image of collection "${col.name}" can be attached: ${skipped.join(', ')}.`);
  return { params: { ...p, references: [...own, ...refs] }, collection: { name: col.name, used, total: col.count, skipped } };
}

// NNN_<slug of the source file name>.<ext>; nothing of it is taken from the request as is. name (the
// host's own, e.g. a generated image's file name) is used instead of the source URL's when given.
function fileNameFor(index, srcUrl, ext, name = '') {
  let base = String(name || '');
  try {
    const u = new URL(String(srcUrl));
    if (!base && /^https?:$/.test(u.protocol)) base = decodeURIComponent(u.pathname.split('/').pop() || '');
  } catch {}
  base = base.replace(/\.[a-z0-9]{1,5}$/i, '');
  return `${String(index).padStart(3, '0')}_${slugify(base)}.${IMAGE_EXTS.includes(ext) ? ext : 'png'}`;
}

function siteOf(url) {
  try {
    const u = new URL(String(url));
    return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, '') : u.protocol.replace(':', '');
  } catch { return null; }
}

// The list_collections tool text.
function describeCollections(list, maxRefs, maxFiles = 100) {
  if (!list.length) {
    return 'No reference collections yet. The user makes them in Chrome: right-click an image, "Add to Backdraw", "New collection…".';
  }
  const lines = [`Reference collections (${list.length}, most recently changed first):`];
  for (const c of list) {
    lines.push(`- "${c.name}": ${c.count} image(s), folder ${c.path}`);
    for (const im of c.images.slice(0, maxFiles)) {
      const site = siteOf(im.pageUrl) || siteOf(im.sourceUrl) || 'unknown source';
      lines.push(`  - ${im.file} (${site}${im.width ? `, ${im.width}x${im.height}` : ''}, added ${String(im.addedAt || '').slice(0, 10) || '?'})`);
    }
    if (c.images.length > maxFiles) lines.push(`  - … ${c.images.length - maxFiles} more in the folder`);
  }
  lines.push(`Use one with generate_image(reference_collection="<name>"): its newest images are attached after any reference_images, up to ${maxRefs} references in total. ` +
    'Pass reference_files=[file names above] to pick specific images instead.');
  return lines.join('\n');
}

module.exports = {
  MAX_NAME, IMAGE_EXTS, EXTENSION_METHODS, chars, cut, validateName, safeFolderName, isPlainFile, isInside,
  findCollection, newestFirst, pickRefs, withCollection, fileNameFor, siteOf, describeCollections,
};
