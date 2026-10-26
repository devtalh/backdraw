'use strict';
// Native messaging host. Chrome starts it when the extension connects and ends it when Chrome
// closes. It owns the job queue, hands jobs to the extension one at a time, saves the images and
// answers the MCP server / CLI over a per-user named pipe. It never sees cookies or passwords:
// the extension only sends prompts, progress, chat links and image bytes.
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const identity = require('./identity');
const shared = require('./shared');
const { stamp, slugify, sniffExt } = require('./lib/naming');
const { normName, parseProjectUrl, pickProject } = require('./lib/projects');
const { buildText } = require('./lib/prompt');
const { aspectOption } = require('./lib/aspect');
const { pngInfo } = require('./lib/png');
const { MAX_REFS, MAX_REF_BYTES, MAX_REFS_TOTAL_BYTES, MAX_COLLECTION_BYTES } = require('./lib/limits');
const { withCollection } = require('./lib/collections');
const store = require('./lib/collection-store');
const { callAssembler, answerCall } = require('./lib/extension-calls');
const gallery = require('./lib/gallery');
const platform = require('./platform');

const VERSION = shared.VERSION;
const LOG_FILE = path.join(shared.LOG_DIR, 'host.log');
const MAX_JOBS = 100;
// needs_reference: ChatGPT asked for the image to be uploaded again; text_reply: it answered in text.
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'needs_reference', 'text_reply']);
const CHUNK = 600000; // base64 chars per message; Chrome caps host->extension messages at 1 MB

let config = loadConfig();
let jobs = shared.readJson(shared.JOBS_FILE, []);
let extension = null;
let runningId = null;
let watchdog = null;
let reqSeq = 0;
let saveTimer = null;
const pending = new Map();
const refStore = new Map(); // jobId -> reference images (kept in memory only, until the job ends)

function now() { return new Date().toISOString(); }

function log(level, msg, data) {
  try {
    fs.mkdirSync(shared.LOG_DIR, { recursive: true });
    try { if (fs.statSync(LOG_FILE).size > 4 * 1024 * 1024) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`); } catch {}
    let extra = '';
    if (data !== undefined) {
      extra = ' ' + (typeof data === 'string' ? data : JSON.stringify(data));
      if (extra.length > 40000) extra = extra.slice(0, 40000) + '…';
    }
    fs.appendFileSync(LOG_FILE, `${now()} [${level}] ${msg}${extra}\n`);
  } catch {}
}

function loadConfig() {
  const c = shared.readJson(shared.CONFIG_FILE, {});
  return {
    project: c.project || null,
    outputDir: c.outputDir || path.join(os.homedir(), 'Pictures', identity.IMAGES_DIR_NAME),
    collectionsDir: c.collectionsDir || path.join(os.homedir(), 'Pictures', identity.IMAGES_DIR_NAME, identity.COLLECTIONS_DIR_NAME),
    debug: !!c.debug,
    imagesCentralized: !!c.imagesCentralized,
  };
}

function saveConfig() { shared.writeJson(shared.CONFIG_FILE, config); }

function saveJobs() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try { shared.writeJson(shared.JOBS_FILE, jobs.slice(-MAX_JOBS)); } catch (e) { log('error', 'saving jobs failed', String(e)); }
}

function saveJobsSoon() { if (!saveTimer) saveTimer = setTimeout(saveJobs, 1000); }

// ---------------------------------------------------------------- Chrome native messaging (stdio)

let inChunks = [];
let inLen = 0;

function drainInput() {
  while (inLen >= 4) {
    if (inChunks[0].length < 4) inChunks = [Buffer.concat(inChunks, inLen)];
    const size = inChunks[0].readUInt32LE(0);
    if (inLen < 4 + size) return;
    const all = inChunks.length === 1 ? inChunks[0] : Buffer.concat(inChunks, inLen);
    const body = all.subarray(4, 4 + size);
    const rest = all.subarray(4 + size);
    inChunks = rest.length ? [rest] : [];
    inLen = rest.length;
    let msg;
    try { msg = JSON.parse(body.toString('utf8')); } catch (e) { log('error', 'unreadable message from extension', String(e)); continue; }
    try { onExtensionMessage(msg); } catch (e) { log('error', 'extension message handler failed', e.stack); }
  }
}

function toExtension(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

function onExtensionMessage(msg) {
  switch (msg.type) {
    case 'hello':
      extension = { version: msg.version || '?', connectedAt: now() };
      log('info', `extension connected (v${extension.version})`);
      // home: the extension shows paths with the home folder (it holds the user's name) as "~".
      toExtension({ type: 'welcome', hostVersion: VERSION, project: config.project, collections: collectionSummaries(), home: os.homedir() });
      pump();
      break;
    case 'progress': onProgress(msg); break;
    case 'result': onResult(msg); break;
    case 'response': {
      const p = pending.get(msg.reqId);
      if (!p) break;
      pending.delete(msg.reqId);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new shared.BridgeError(msg.error || 'The extension reported an error.', msg.code || 'EXTENSION'));
      break;
    }
    case 'set_project':
      try { setProject(msg.project); } catch (e) { log('warn', 'project from popup rejected', e.message); }
      break;
    case 'log': log(msg.level || 'ext', `[ext] ${msg.msg}`, msg.data); break;
    case 'call_chunk': extensionCalls.chunk(msg); break;
    case 'call':
      answerCall(msg, handlers, extensionCalls.take(msg.reqId), MAX_COLLECTION_BYTES / 1024 / 1024).then(toExtension);
      break;
    default: log('warn', 'unknown message from extension', msg.type);
  }
}

function askExtension(action, params = {}, timeoutMs = 120000) {
  if (!extension) return Promise.reject(new shared.BridgeError('The Chrome extension has not connected yet.', 'NO_EXTENSION'));
  const reqId = `r${++reqSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(new shared.BridgeError(`The extension did not finish "${action}" in time.`, 'TIMEOUT'));
    }, timeoutMs);
    pending.set(reqId, { resolve, reject, timer });
    toExtension({ type: 'request', reqId, action, params });
  });
}

// Calls from the extension itself (collections); lib/extension-calls.js keeps them to its allow-list.
const extensionCalls = callAssembler(Math.ceil(MAX_COLLECTION_BYTES / 3) * 4 + 4);

// ---------------------------------------------------------------- jobs

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

function findJob(id) {
  const job = jobs.find(j => j.id === id);
  if (!job) throw new shared.BridgeError(`Unknown job id "${id}".`, 'NOT_FOUND');
  return job;
}

function createJob(p) {
  // mode "collect" only downloads the images of an existing conversation; nothing is sent.
  const mode = p.mode === 'collect' ? 'collect' : 'generate';
  const prompt = String(p.prompt || '').trim();
  if (!prompt && mode === 'generate') throw new shared.BridgeError('The prompt is empty.', 'BAD_REQUEST');
  const startUrl = p.startUrl ? String(p.startUrl).trim() : null;
  if (startUrl && !/^https:\/\/chatgpt\.com\//i.test(startUrl)) {
    throw new shared.BridgeError('conversation_url must be a https://chatgpt.com/ link.', 'BAD_REQUEST');
  }
  if (mode === 'collect' && !/\/c\/[0-9a-f-]{8,}/i.test(startUrl || '')) {
    throw new shared.BridgeError('A ChatGPT conversation link (https://chatgpt.com/…/c/…) is required.', 'BAD_REQUEST');
  }
  if (!startUrl && !config.project) {
    throw new shared.BridgeError('No ChatGPT project is selected yet. Call list_projects, then select_project ' +
      "with the user's images project.", 'NO_PROJECT');
  }
  for (const key of ['outputDir', 'copyTo']) {
    if (p[key] && !path.isAbsolute(p[key])) throw new shared.BridgeError('output_dir must be an absolute folder path.', 'BAD_REQUEST');
  }
  const refs = Array.isArray(p.references) ? p.references : [];
  if (refs.length > MAX_REFS) throw new shared.BridgeError(`At most ${MAX_REFS} reference images per request.`, 'BAD_REQUEST');
  for (const r of refs) {
    if (!r || !r.data || !/^image\//.test(r.mime || '')) throw new shared.BridgeError('Each reference must be an image file.', 'BAD_REQUEST');
    if (r.data.length * 0.75 > MAX_REF_BYTES) throw new shared.BridgeError(`Reference "${r.name}" is larger than ${MAX_REF_BYTES / 1048576} MB.`, 'BAD_REQUEST');
  }
  if (refs.reduce((sum, r) => sum + r.data.length * 0.75, 0) > MAX_REFS_TOTAL_BYTES) {
    throw new shared.BridgeError(`The reference images together are larger than ${MAX_REFS_TOTAL_BYTES / 1048576} MB.`, 'BAD_REQUEST');
  }
  if (mode === 'collect' && refs.length) throw new shared.BridgeError('Reference images cannot be used when only fetching images.', 'BAD_REQUEST');
  let aspect;
  try { aspect = aspectOption(p.aspect); } catch (e) { throw new shared.BridgeError(e.message, 'BAD_REQUEST'); }
  const job = {
    id: `img_${crypto.randomBytes(4).toString('hex')}`,
    mode, status: 'queued', step: 'queued', message: 'Waiting for its turn',
    prompt, sendAsIs: !!p.sendAsIs, aspect, transparent: !!p.transparent, startUrl, project: startUrl ? null : config.project,
    // outputDir: legacy clients, the host writes a copy there. copyTo: the MCP server copies itself
    // (it runs in the caller's context, so the copy lands where the caller can see it).
    outputDir: p.outputDir || null, copyTo: p.copyTo || null, copies: [],
    // Names the saved files instead of the prompt (whose opening may be instructions, not the subject).
    filenameHint: String(p.filenameHint || '').trim().slice(0, 200) || null,
    references: refs.map(r => ({ name: r.name, bytes: Math.round(r.data.length * 0.75) })), autoReattach: !!p.autoReattach,
    timeoutSec: clamp(Number(p.timeoutSec) || 600, 60, 1800),
    createdAt: now(), startedAt: null, finishedAt: null,
    conversationUrl: null, images: [], assistantText: null, error: null, reason: null, editCheck: null, reattached: false,
  };
  if (refs.length) refStore.set(job.id, refs.map(r => ({ name: String(r.name || 'reference.png'), mime: r.mime, data: r.data })));
  jobs.push(job);
  if (jobs.length > MAX_JOBS) jobs = jobs.filter((j, i) => i >= jobs.length - MAX_JOBS || !TERMINAL.has(j.status));
  saveJobs();
  log('info', `job ${job.id} queued`, { prompt: prompt.slice(0, 300), start: startUrl || job.project.url });
  pump();
  return job;
}

function pump() {
  if (runningId || !extension) return;
  const job = jobs.find(j => j.status === 'queued');
  if (!job) return;
  runningId = job.id;
  Object.assign(job, { status: 'running', step: 'starting', message: 'Starting', startedAt: now() });
  saveJobs();
  // Reference images go first, in pieces; the extension puts them together when "run" arrives.
  (refStore.get(job.id) || []).forEach((r, index) => {
    const total = Math.max(1, Math.ceil(r.data.length / CHUNK));
    for (let seq = 0; seq < total; seq++) {
      toExtension({ type: 'ref_chunk', jobId: job.id, index, name: r.name, mime: r.mime, seq, total, data: r.data.slice(seq * CHUNK, (seq + 1) * CHUNK) });
    }
  });
  toExtension({
    type: 'run',
    job: {
      id: job.id, mode: job.mode, text: job.mode === 'collect' ? '' : buildText(job), startUrl: job.startUrl || job.project.url,
      timeoutSec: job.timeoutSec, debug: config.debug, autoReattach: job.autoReattach,
      aspect: job.aspect ? job.aspect.target : null, transparent: !!job.transparent,
    },
  });
  clearTimeout(watchdog);
  // Generous: a login/CAPTCHA pause may add up to 10 minutes on top of the job timeout.
  watchdog = setTimeout(() => {
    if (runningId !== job.id) return;
    toExtension({ type: 'cancel', jobId: job.id });
    finishJob(job, { status: 'failed', reason: 'timeout', error: 'The extension stopped reporting on this job.' });
  }, (job.timeoutSec + 900) * 1000);
}

function finishJob(job, fields) {
  if (TERMINAL.has(job.status)) return;
  Object.assign(job, fields, { finishedAt: now() });
  job.step = job.status;
  refStore.delete(job.id);
  if (runningId === job.id) { runningId = null; clearTimeout(watchdog); }
  saveJobs();
  log('info', `job ${job.id} ${job.status}`, { error: job.error, conversation: job.conversationUrl, files: job.images.map(i => i.path) });
  setImmediate(pump);
}

function onProgress(msg) {
  const job = jobs.find(j => j.id === msg.jobId);
  if (!job || TERMINAL.has(job.status)) return;
  job.status = msg.needsHuman ? 'needs_human' : 'running';
  if (msg.step) job.step = msg.step;
  if (msg.message) job.message = msg.message;
  if (msg.conversationUrl) job.conversationUrl = msg.conversationUrl;
  job.updatedAt = now();
  saveJobsSoon();
}

function onResult(msg) {
  const job = jobs.find(j => j.id === msg.jobId);
  if (job && !TERMINAL.has(job.status)) {
    if (msg.conversationUrl) job.conversationUrl = msg.conversationUrl;
    if (msg.assistantText) job.assistantText = String(msg.assistantText).slice(0, 4000);
    job.reattached = !!msg.reattached;
    if (msg.ok && Array.isArray(msg.images) && msg.images.length) {
      try {
        const images = saveImages(job, msg.images, msg.title);
        finishJob(job, { status: 'succeeded', images, editCheck: msg.editCheck || null, message: `${images.length} image(s) saved` });
      } catch (e) {
        finishJob(job, { status: 'failed', reason: 'save_failed', error: `The image was generated but could not be saved: ${e.message}` });
      }
    } else if (msg.status === 'needs_reference' || msg.status === 'text_reply') {
      finishJob(job, { status: msg.status, reason: msg.status, error: msg.error, message: msg.error });
    } else if (msg.status === 'cancelled') {
      finishJob(job, { status: 'cancelled', error: 'Cancelled.', message: 'Cancelled' });
    } else {
      const error = msg.error || 'ChatGPT did not return an image.';
      finishJob(job, { status: 'failed', reason: msg.reason || null, error, message: error });
    }
  }
  if (runningId === msg.jobId) {
    runningId = null;
    clearTimeout(watchdog);
    setImmediate(pump);
  }
}

function cancelJob(id) {
  const job = findJob(id);
  if (TERMINAL.has(job.status)) return job;
  if (job.status === 'queued') {
    finishJob(job, { status: 'cancelled', error: 'Cancelled before it started.', message: 'Cancelled' });
    return job;
  }
  job.message = 'Cancelling…';
  toExtension({ type: 'cancel', jobId: job.id });
  // If the extension never answers, don't leave the job hanging.
  setTimeout(() => finishJob(job, { status: 'cancelled', error: 'Cancelled.', message: 'Cancelled' }), 20000);
  return job;
}

// ---------------------------------------------------------------- saving images

function uniquePath(dir, base, ext) {
  let file = path.join(dir, `${base}.${ext}`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${base}_${n}.${ext}`);
  return file;
}

// Every image is saved in the central images folder. A legacy outputDir request gets an extra copy.
// When the extension cropped an image to the asked aspect ratio, the crop is the main file and
// ChatGPT's original is kept next to it as <name>_full.
function saveImages(job, images, title) {
  fs.mkdirSync(config.outputDir, { recursive: true });
  fs.mkdirSync(shared.PREVIEW_DIR, { recursive: true });
  // Named after filename_hint, else the prompt; when only collecting (no prompt) ChatGPT's chat title.
  const usefulTitle = title && !/^(chatgpt\b|generate an image|update the image)/i.test(title.trim()) ? title : '';
  const base = `${stamp()}_${slugify(job.filenameHint || job.prompt || usefulTitle)}`;
  return images.map((img, i) => {
    const buf = Buffer.from(img.data || '', 'base64');
    if (buf.length < 100) throw new Error('empty image data');
    const mimeExt = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[String(img.mime).split(';')[0]];
    const name = images.length > 1 ? `${base}-${i + 1}` : base;
    const ext = sniffExt(buf) || mimeExt || 'png';
    const cropped = img.crop ? Buffer.from(img.crop.data || '', 'base64') : null;
    const crop = cropped && cropped.length >= 100 ? cropped : null;
    const main = crop || buf;
    const mainExt = crop ? 'png' : ext;
    const file = uniquePath(config.outputDir, name, mainExt);
    fs.writeFileSync(file, main);
    let full = null;
    if (crop) {
      const fullFile = uniquePath(config.outputDir, `${path.basename(file, `.${mainExt}`)}_full`, ext);
      fs.writeFileSync(fullFile, buf);
      full = { path: fullFile, width: img.width || null, height: img.height || null, bytes: buf.length };
    }
    if (job.outputDir && path.resolve(job.outputDir) !== path.resolve(config.outputDir)) {
      try {
        fs.mkdirSync(job.outputDir, { recursive: true });
        const copy = uniquePath(job.outputDir, name, mainExt);
        fs.writeFileSync(copy, main);
        job.copies.push(copy);
      } catch (e) { log('warn', 'copy to output_dir failed', e.message); }
    }
    let preview = null;
    if (img.preview) {
      preview = path.join(shared.PREVIEW_DIR, `${job.id}-${i + 1}.jpg`);
      fs.writeFileSync(preview, Buffer.from(img.preview, 'base64'));
    }
    // From ChatGPT's own bytes: a cropped copy is always RGBA, so only the original tells whether
    // ChatGPT sent an alpha channel.
    const info = pngInfo(buf);
    return {
      path: file, width: (crop ? img.crop.width : img.width) || null, height: (crop ? img.crop.height : img.height) || null,
      bytes: main.length, preview, full, aspect: job.aspect ? job.aspect.target.label : null,
      png: info && { colorType: info.colorType, alphaChannel: info.alphaChannel, trns: info.trns }, alpha: img.alpha || null,
    };
  });
}

// Images this bridge already saved from the same ChatGPT conversation, newest first.
function chatId(url) { const m = String(url || '').match(/\/c\/([0-9a-f-]{8,})/i); return m ? m[1].toLowerCase() : null; }
function imagesFromChat(job) {
  const id = chatId(job.conversationUrl || job.startUrl);
  if (!id) return [];
  return jobs.filter(j => j !== job && j.status === 'succeeded' && chatId(j.conversationUrl) === id)
    .flatMap(j => j.images.map(im => ({ job: j.id, path: im.path, createdAt: j.createdAt, prompt: j.prompt.slice(0, 100) })))
    .reverse().slice(0, 8);
}

// v1.0 saved images straight into the caller's output_dir only. Keep a copy of every image in the
// central folder too, and point the job there (callers may rename or move their own copies). This
// runs once: changing the images folder later must not copy the whole history into the new one.
function centralizeLegacyImages() {
  if (config.imagesCentralized) return;
  const central = path.resolve(config.outputDir).toLowerCase();
  let changed = false;
  for (const j of jobs) {
    if (j.status !== 'succeeded' || !Array.isArray(j.images)) continue;
    for (const im of j.images) {
      if (!im.path || path.dirname(path.resolve(im.path)).toLowerCase() === central) continue;
      if (!fs.existsSync(im.path)) {
        // Moved away by its caller, but a copy with the same name may already be in the folder.
        const same = path.join(config.outputDir, path.basename(im.path));
        if (fs.existsSync(same)) {
          j.copies = Array.from(new Set([...(j.copies || []), im.path]));
          im.path = same;
          changed = true;
        }
        continue;
      }
      try {
        fs.mkdirSync(config.outputDir, { recursive: true });
        const ext = path.extname(im.path);
        const dest = uniquePath(config.outputDir, path.basename(im.path, ext), ext.slice(1) || 'png');
        fs.copyFileSync(im.path, dest);
        j.copies = Array.from(new Set([...(j.copies || []), im.path]));
        im.path = dest;
        changed = true;
        log('info', `copied ${path.basename(dest)} into the images folder`);
      } catch (e) {
        log('warn', 'could not copy an older image into the images folder', { path: im.path, error: e.message });
      }
    }
  }
  if (changed) saveJobs();
  config.imagesCentralized = true;
  try { saveConfig(); } catch (e) { log('warn', 'saving the config failed', String(e)); }
}

function cleanupPreviews() {
  try {
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(shared.PREVIEW_DIR)) {
      const full = path.join(shared.PREVIEW_DIR, f);
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    }
  } catch {}
}

// ---------------------------------------------------------------- projects

function setProject(p) {
  const parsed = parseProjectUrl(p && p.url);
  if (!parsed) throw new shared.BridgeError('That is not a ChatGPT project link (expected https://chatgpt.com/g/g-p-…/project).', 'BAD_REQUEST');
  config.project = { id: parsed.id, name: String(p.name || parsed.slug || parsed.id).trim(), url: parsed.url, selectedAt: now() };
  saveConfig();
  if (extension) toExtension({ type: 'config', project: config.project });
  log('info', 'project selected', config.project);
  return config.project;
}

async function selectProject(p) {
  if (p.url) return { project: setProject({ url: p.url, name: p.name }) };
  if (!normName(p.name)) throw new shared.BridgeError('Give the project name (or its URL).', 'BAD_REQUEST');
  const projects = await askExtension('list_projects', {}, 120000);
  const { project: best, error, ties } = pickProject(projects, p.name);
  const names = projects.map(x => x.name).join(', ') || '(none)';
  if (error === 'NOT_FOUND') throw new shared.BridgeError(`No ChatGPT project matches "${p.name}". Available projects: ${names}`, 'NOT_FOUND');
  if (error === 'AMBIGUOUS') throw new shared.BridgeError(`"${p.name}" matches several projects: ${ties.map(x => x.name).join(', ')}. Use the exact name or URL.`, 'AMBIGUOUS');
  const chosen = best.url ? best : await askExtension('resolve_project', { name: best.name }, 120000);
  return { project: setProject(chosen), available: projects.map(x => x.name) };
}

// ---------------------------------------------------------------- reference collections

function collectionSummaries() {
  try {
    return store.list(config.collectionsDir).map(x => ({ name: x.name, count: x.count }));
  } catch (e) {
    log('warn', 'could not read the collections folder', { dir: config.collectionsDir, error: e.message });
    return [];
  }
}

// The extension rebuilds its right-click menu from the list it gets after every change.
function collectionsChanged(what, result) {
  log('info', `collections: ${what}`, result);
  if (extension) toExtension({ type: 'collections', collections: collectionSummaries() });
  return result;
}

// reference_collection: the host reads the chosen images itself (it owns the folder) and attaches
// them after the caller's own reference images (lib/collections.js decides which).
function createWithCollection(p) {
  const dir = config.collectionsDir;
  const { params, collection } = withCollection(p, { find: name => store.find(dir, name), read: (col, im) => store.readImage(dir, col, im) });
  const job = createJob(params);
  if (collection) {
    job.collection = collection;
    saveJobs();
    log('info', `job ${job.id} uses collection "${collection.name}"`, { used: collection.used, skipped: collection.skipped });
  }
  return job;
}

// ---------------------------------------------------------------- gallery (the extension's side panel)

// The panel names an image by job id and number only; the file is always the one the job saved.
function galleryImage(p, needFile) {
  const found = gallery.findJobImage(jobs, p.jobId, p.n);
  if (!found) throw new shared.BridgeError('That image is not in the gallery any more.', 'NOT_FOUND');
  if (needFile && !gallery.fileExists(found.image.path)) {
    throw new shared.BridgeError(`The image file was moved or deleted: ${found.image.path}`, 'NOT_FOUND');
  }
  return found;
}

// Like a right-click add, with the chat as the source; the size limit applies before the file is read.
// The panel's small JPEG (checked by the store like any thumbnail) or else the saved preview becomes
// the collection's thumbnail; the store drops a preview over its thumbnail limit (256 KB), so then
// there is none.
function addJobImage(p) {
  const { job, image } = galleryImage(p, true);
  if (fs.statSync(image.path).size > MAX_COLLECTION_BYTES) {
    throw new shared.BridgeError(`The image is larger than ${MAX_COLLECTION_BYTES / 1024 / 1024} MB.`, 'TOO_LARGE');
  }
  const thumb = typeof p.thumb === 'string' && p.thumb ? p.thumb : gallery.readPreview(shared.PREVIEW_DIR, image).data;
  const params = {
    collection: p.collection, create: !!p.create, data: fs.readFileSync(image.path).toString('base64'), thumb,
    sourceUrl: job.conversationUrl, pageUrl: job.conversationUrl, width: image.width, height: image.height,
  };
  const fileName = path.basename(image.path, path.extname(image.path));
  return collectionsChanged('add from the gallery', store.add(config.collectionsDir, params, new Date(), { fileName }));
}

// ---------------------------------------------------------------- local API (named pipe)

function publicJob(j) {
  if (!j) return null;
  return {
    id: j.id, mode: j.mode, status: j.status, step: j.step, message: j.message,
    prompt: j.prompt.length > 300 ? `${j.prompt.slice(0, 300)}…` : j.prompt,
    conversationUrl: j.conversationUrl, startUrl: j.startUrl, images: j.images, assistantText: j.assistantText,
    error: j.error, reason: j.reason, createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt,
    references: j.references || [], reattached: !!j.reattached, editCheck: j.editCheck || null,
    aspect: j.aspect ? j.aspect.target.label : null, transparent: !!j.transparent,
    copyTo: j.copyTo || null, copies: j.copies || [],
    collection: j.collection || null,
    chatImages: j.status === 'needs_reference' || j.status === 'text_reply' ? imagesFromChat(j) : undefined,
    queuePosition: j.status === 'queued' ? jobs.filter(x => x.status === 'queued').indexOf(j) + 1 : undefined,
  };
}

function statusInfo() {
  return {
    hostVersion: VERSION,
    extension,
    project: config.project,
    outputDir: config.outputDir,
    collectionsDir: config.collectionsDir,
    debug: config.debug,
    running: publicJob(jobs.find(j => j.id === runningId)),
    queued: jobs.filter(j => j.status === 'queued').map(j => j.id),
    recent: jobs.slice(-5).reverse().map(j => ({
      id: j.id, status: j.status, createdAt: j.createdAt, prompt: j.prompt.slice(0, 80), conversationUrl: j.conversationUrl,
    })),
  };
}

const handlers = {
  status: () => statusInfo(),
  generate: p => publicJob(createWithCollection(p)),
  job: p => publicJob(findJob(p.jobId)),
  // The MCP server copies finished images into the caller's output_dir and records it here once.
  mark_copied: p => {
    const job = findJob(p.jobId);
    job.copies = Array.from(new Set([...(job.copies || []), ...(p.paths || [])]));
    saveJobs();
    return publicJob(job);
  },
  cancel: p => publicJob(cancelJob(p.jobId)),
  list_projects: async () => ({ projects: await askExtension('list_projects', {}, 120000), selected: config.project }),
  select_project: p => selectProject(p),
  set_config: p => {
    if (p.outputDir !== undefined) {
      if (!path.isAbsolute(String(p.outputDir))) throw new shared.BridgeError('outputDir must be absolute.', 'BAD_REQUEST');
      config.outputDir = String(p.outputDir);
    }
    if (p.collectionsDir !== undefined) {
      if (!path.isAbsolute(String(p.collectionsDir))) throw new shared.BridgeError('collectionsDir must be absolute.', 'BAD_REQUEST');
      config.collectionsDir = String(p.collectionsDir);
    }
    if (p.debug !== undefined) config.debug = !!p.debug;
    saveConfig();
    if (p.collectionsDir !== undefined) collectionsChanged('folder set', { dir: config.collectionsDir });
    return config;
  },
  diagnose: p => askExtension('diagnose', p, 180000),
  // ChatGPT sign-in as the extension last saw it ({ loggedIn, challenge, checkedAt }); opens no tab.
  chatgpt_state: () => askExtension('chatgpt_state', {}, 10000),
  reload_extension: () => {
    if (!extension) throw new shared.BridgeError('The extension is not connected.', 'NO_EXTENSION');
    toExtension({ type: 'reload' });
    return { ok: true };
  },
  // summary: without the image lists (the popup only needs names and counts).
  list_collections: p => {
    const list = store.list(config.collectionsDir);
    return p.summary ? list.map(({ images, ...rest }) => rest) : list;
  },
  collection_add: p => collectionsChanged('add', store.add(config.collectionsDir, p)),
  rename_collection: p => collectionsChanged('rename', store.rename(config.collectionsDir, p.name, p.newName)),
  delete_collection: p => collectionsChanged('delete', store.remove(config.collectionsDir, p.name)),
  delete_collection_image: p => collectionsChanged('delete image', store.removeImage(config.collectionsDir, p.name, p.file)),
  collection_thumbs: p => store.thumbs(config.collectionsDir, p.name, p.offset),
  gallery_list: p => gallery.listGallery(jobs, p.offset, p.limit, gallery.fileExists),
  gallery_thumb: p => gallery.readPreview(shared.PREVIEW_DIR, galleryImage(p).image),
  reveal_image: p => {
    platform.revealInFolder(galleryImage(p, true).image.path);
    return { ok: true };
  },
  collection_add_job_image: p => addJobImage(p),
};

async function answer(sock, line) {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  let reply;
  try {
    const fn = handlers[req.method];
    if (!fn) throw new shared.BridgeError(`Unknown method "${req.method}".`, 'BAD_REQUEST');
    reply = { id: req.id, result: await fn(req.params || {}) };
  } catch (e) {
    reply = { id: req.id, error: { message: e.message, code: e.code || 'ERROR' } };
  }
  if (!sock.destroyed) sock.write(JSON.stringify(reply) + '\n');
}

const server = net.createServer(sock => {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) answer(sock, line);
    }
  });
  sock.on('error', () => {});
});

function shutdown(reason) {
  log('info', `host stopping: ${reason}`);
  for (const j of jobs) {
    if (!TERMINAL.has(j.status)) Object.assign(j, { status: 'failed', step: 'failed', error: `Interrupted: ${reason}.`, finishedAt: now() });
  }
  saveJobs();
  try { server.close(); } catch {}
  process.exit(0);
}

// ---------------------------------------------------------------- start

for (const j of jobs) {
  if (!TERMINAL.has(j.status)) {
    Object.assign(j, { status: 'failed', step: 'failed', finishedAt: now(),
      error: 'Interrupted: Chrome or the bridge restarted while this job was in progress.' });
  }
}
saveJobs();
centralizeLegacyImages();
cleanupPreviews();

process.on('uncaughtException', e => log('error', 'uncaught exception', e.stack));
process.on('unhandledRejection', e => log('error', 'unhandled rejection', String((e && e.stack) || e)));
process.stdin.on('data', chunk => { inChunks.push(chunk); inLen += chunk.length; drainInput(); });
process.stdin.on('end', () => shutdown('Chrome closed the connection'));
process.stdout.on('error', () => shutdown('Chrome stopped reading'));

server.on('error', e => log('error', `named pipe unavailable (${e.code || e.message}) — is the bridge already running in another Chrome profile?`));
server.listen(shared.PIPE_PATH, () => log('info', `host v${VERSION} listening (pid ${process.pid})`));
