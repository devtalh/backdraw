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
const { MOTION_NAMES } = require('./lib/motion');
const { LIGHT_MOTIONS } = require('./lib/light-motion');
const { SHEET_MOTIONS } = require('./lib/sprite-sheet');
const { SPRITE_MOTIONS, spriteGrid, buildSpritePrompt } = require('./lib/sprite-prompt');
const { processSheet, retryReasons, pickBest } = require('./lib/sprite-job');
const { aspectOption } = require('./lib/aspect');
const { pngInfo } = require('./lib/png');
const { gifInfo } = require('./lib/gif');
const { MAX_REFS, MAX_REF_BYTES, MAX_REFS_TOTAL_BYTES, MAX_COLLECTION_BYTES, MAX_ANIMATION_BYTES } = require('./lib/limits');
const { withCollection, isInside } = require('./lib/collections');
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
const cancelTimers = new Map();

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
  let sprite = null;
  if (p.sprite !== undefined) {
    const bad = message => new shared.BridgeError(message, 'BAD_REQUEST');
    if (!p.sprite || typeof p.sprite !== 'object' || Array.isArray(p.sprite)) throw bad('sprite must be an object.');
    if (p.mode === 'collect' || p.startUrl != null || p.motion != null || p.animated !== undefined || p.sendAsIs !== undefined) {
      throw bad('sprite cannot be combined with collect, startUrl, motion, animated or sendAsIs.');
    }
    const { motion, frames = 8, view = 'side', size, background = 'transparent' } = p.sprite;
    if (!SPRITE_MOTIONS.includes(motion)) throw bad(`Unknown motion. Use: ${SPRITE_MOTIONS.join(', ')}.`);
    let grid;
    try { grid = spriteGrid(frames); } catch (e) { throw bad(e.message); }
    if (!['side', 'front'].includes(view)) throw bad('Unknown view. Use: side, front.');
    if (size !== undefined && (!Number.isInteger(size) || size < 64 || size > 1024)) throw bad('size must be an integer from 64 to 1024.');
    if (!['transparent', 'white'].includes(background)) throw bad('background must be transparent or white.');
    const character = String(p.prompt || '').trim().replace(/[.!\s]+$/u, '');
    if (!character) throw bad('The character description is empty.');
    sprite = { character, motion, frames, columns: grid.columns, rows: grid.rows, view, size: size ?? null,
      background, attempts: [], chosen: null, regenerated: false, regenerateReason: null, warning: null, state: 'generating' };
  }
  // mode "collect" only downloads the images of an existing conversation; nothing is sent.
  const mode = p.mode === 'collect' ? 'collect' : 'generate';
  const motion = p.motion == null || p.motion === '' ? null : p.motion;
  if (motion !== null && !MOTION_NAMES.includes(motion)) {
    throw new shared.BridgeError(`Unknown motion. Use: ${MOTION_NAMES.join(', ')}.`, 'BAD_REQUEST');
  }
  if (mode === 'collect' && motion !== null) {
    throw new shared.BridgeError('motion cannot be used when only fetching images.', 'BAD_REQUEST');
  }
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
    prompt, sendAsIs: !!p.sendAsIs, aspect, transparent: !!p.transparent, animated: !!p.animated || motion !== null, motion, startUrl, project: startUrl ? null : config.project,
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
  if (sprite) {
    job.sprite = sprite;
    job.prompt = buildSpritePrompt({ ...sprite, hasReferences: refs.length > 0 });
    job.aspect = aspectOption(spriteGrid(sprite.frames).aspect);
    job.transparent = true;
    job.animated = false;
    job.motion = null;
    job.filenameHint = String(p.filenameHint || `${sprite.character} ${sprite.motion} sprite sheet`).trim().slice(0, 200);
  }
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
  Object.assign(job, { status: 'running', step: 'starting', message: job.sprite?.regenerated ? `Regenerating the sprite sheet once in a new chat: ${job.sprite.regenerateReason}` : 'Starting', startedAt: now() });
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
      aspect: job.aspect ? job.aspect.target : null, transparent: !!job.transparent, animated: !!job.animated,
    },
  });
  clearTimeout(watchdog);
  // Generous: a login/CAPTCHA pause may add up to 10 minutes on top of the job timeout.
  watchdog = setTimeout(() => {
    if (runningId !== job.id) return;
    toExtension({ type: 'cancel', jobId: job.id });
    if (job.sprite && job.cancelRequested) cancelSpriteJob(job);
    else if (job.sprite?.attempts.length) completeSpriteJob(job, 'Could not regenerate: the extension stopped reporting on this job.');
    else finishJob(job, { status: 'failed', reason: 'timeout', error: 'The extension stopped reporting on this job.' });
  }, (job.timeoutSec + 900) * 1000);
}

function finishJob(job, fields) {
  if (TERMINAL.has(job.status)) return;
  clearTimeout(cancelTimers.get(job.id));
  cancelTimers.delete(job.id);
  Object.assign(job, fields, { finishedAt: now() });
  job.step = job.status;
  if (job.sprite) {
    job.sprite.state = 'done';
    for (const attempt of job.sprite.attempts) if (attempt.result) delete attempt.result.sheet;
  }
  refStore.delete(job.id);
  if (runningId === job.id) { runningId = null; clearTimeout(watchdog); }
  saveJobs();
  log('info', `job ${job.id} ${job.status}`, { error: job.error, conversation: job.conversationUrl, files: job.images.map(i => i.path) });
  setImmediate(pump);
}

function onProgress(msg) {
  const job = jobs.find(j => j.id === msg.jobId);
  if (!job || TERMINAL.has(job.status)) return;
  if (job.sprite?.state === 'processing') return;
  job.status = msg.needsHuman ? 'needs_human' : 'running';
  if (msg.step) job.step = msg.step;
  if (msg.message) job.message = msg.message;
  if (msg.conversationUrl) job.conversationUrl = msg.conversationUrl;
  job.updatedAt = now();
  saveJobsSoon();
}

function onResult(msg) {
  const job = jobs.find(j => j.id === msg.jobId);
  if (job?.sprite?.state === 'processing' && !job.cancelRequested && msg.status !== 'cancelled') return;
  if (job && !TERMINAL.has(job.status)) {
    if (msg.conversationUrl) job.conversationUrl = msg.conversationUrl;
    if (msg.assistantText) job.assistantText = String(msg.assistantText).slice(0, 4000);
    job.reattached = !!msg.reattached;
    job.animatedRetry = !!msg.animatedRetry;
    job.referencesTransparent = Number.isSafeInteger(msg.referencesTransparent) && msg.referencesTransparent > 0 ? msg.referencesTransparent : 0;
    job.referencesMatted = Number.isSafeInteger(msg.referencesMatted) && msg.referencesMatted > 0 ? msg.referencesMatted : 0;
    if (job.sprite && (job.cancelRequested || msg.status === 'cancelled')) {
      cancelSpriteJob(job);
    } else if (msg.ok && Array.isArray(msg.images) && msg.images.length) {
      try {
        const images = saveImages(job, msg.images, msg.title);
        if (job.sprite) {
          job.sprite.attempts.push({ attempt: job.sprite.attempts.length + 1, sheet: images[0],
            conversationUrl: job.conversationUrl, assistantText: job.assistantText, result: null });
          job.images = job.sprite.attempts.map(a => a.sheet);
          Object.assign(job, { status: 'running', step: 'processing', message: 'Cutting and aligning the sprite sheet' });
          job.sprite.state = 'processing';
          saveJobs();
          if (runningId === job.id) { runningId = null; clearTimeout(watchdog); }
          setImmediate(pump);
          setImmediate(() => processSpriteJob(job));
        } else finishJob(job, { status: 'succeeded', images, editCheck: msg.editCheck || null, message: `${images.length} image(s) saved` });
      } catch (e) {
        if (job.sprite?.attempts.length) completeSpriteJob(job, `Could not regenerate: ${e.message}`);
        else finishJob(job, { status: 'failed', reason: 'save_failed', error: `The image was generated but could not be saved: ${e.message}` });
      }
    } else if (job.sprite?.attempts.length) {
      completeSpriteJob(job, `Could not regenerate: ${msg.error || msg.status || 'ChatGPT did not return an image.'}`);
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

// The host alone owns the queue and jobs.json: persisting attempts before processing
// guarantees one regeneration across MCP clients, independently of job_status polling.
// Pure Node processing also finishes saved sheets at shutdown and on the next startup.
function processSpriteJob(job, interrupted = false) {
  if (TERMINAL.has(job.status)) return;
  if (job.cancelRequested) return cancelSpriteJob(job);
  const sprite = job.sprite;
  for (const attempt of sprite.attempts) {
    if (attempt.result) continue;
    attempt.result = processSheet(attempt.sheet.path, sprite);
  }
  const latest = sprite.attempts.at(-1).result;
  const reason = retryReasons(latest);
  if (reason && sprite.attempts.length === 1 && !sprite.regenerated) {
    if (interrupted) return completeSpriteJob(job, 'Could not regenerate: Chrome closed / the bridge restarted.');
    if (job.references.length && !refStore.has(job.id)) {
      return completeSpriteJob(job, 'Could not regenerate: reference images are no longer available after the bridge restarted.');
    }
    Object.assign(sprite, { regenerated: true, regenerateReason: reason, state: 'generating' });
    Object.assign(job, { status: 'queued', step: 'queued',
      message: `Regenerating the sprite sheet once in a new chat: ${reason}`, conversationUrl: null, assistantText: null });
    saveJobs();
    pump();
    return;
  }
  completeSpriteJob(job, interrupted && sprite.regenerated && sprite.attempts.length === 1 ? 'Could not regenerate: Chrome closed / the bridge restarted.' : null);
}

function completeSpriteJob(job, warning = null) {
  if (TERMINAL.has(job.status)) return;
  if (job.cancelRequested) return cancelSpriteJob(job);
  const sprite = job.sprite;
  if (warning) sprite.warning = warning;
  sprite.chosen = pickBest(sprite.attempts);
  const chosen = sprite.attempts[sprite.chosen], result = chosen.result;
  job.images = [chosen.sheet, ...sprite.attempts.filter(a => a !== chosen).map(a => a.sheet)];
  job.conversationUrl = chosen.conversationUrl;
  sprite.state = 'done';
  if (!result || result.error) {
    finishJob(job, { status: 'failed', reason: 'sprite_processing', message: 'Sprite processing failed',
      error: `${result?.error || 'Sprite processing failed'}. Source sheets: ${job.images.map(i => i.path).join(', ')}. Try animate_sheet manually.` });
    return;
  }
  try {
    const file = result.paths.whiteGif || result.paths.gif, buf = fs.readFileSync(file), gif = gifInfo(buf);
    const preview = result.sheet?.png || fs.readFileSync(result.paths.contact);
    job.images.unshift(animationImage(job.id, file, buf, gif, preview.toString('base64'),
      { shown: Math.min(16, result.frames), total: result.frames }));
    finishJob(job, { status: 'succeeded', error: null, message: 'Sprite animation saved' });
    if (extension) toExtension({ type: 'gallery_changed' });
  } catch (e) {
    finishJob(job, { status: 'failed', message: `Sprite processing failed: ${e.message}`,
      error: `${e.message}. Source sheets: ${job.images.map(i => i.path).join(', ')}. Try animate_sheet manually.` });
  }
}

function recoverSpriteJob(job) {
  if (!job.sprite) return false;
  if (job.cancelRequested) { cancelSpriteJob(job); return true; }
  if (!job.sprite.attempts.length) return false;
  processSpriteJob(job, true);
  return true;
}

function cancelSpriteJob(job) {
  if (TERMINAL.has(job.status)) return;
  job.images = job.sprite.attempts.map(a => a.sheet);
  const message = job.images.length ? `Cancelled. Saved sprite sheet(s): ${job.images.map(i => i.path).join(', ')}` : 'Cancelled.';
  finishJob(job, { status: 'cancelled', error: message, message });
}

function cancelJob(id) {
  const job = findJob(id);
  if (TERMINAL.has(job.status)) return job;
  if (job.sprite) {
    job.cancelRequested = true;
    saveJobs();
    if (job.status === 'queued' || job.sprite.state === 'processing') {
      cancelSpriteJob(job);
      return job;
    }
  }
  if (job.status === 'queued') {
    finishJob(job, { status: 'cancelled', error: 'Cancelled before it started.', message: 'Cancelled' });
    return job;
  }
  job.message = 'Cancelling…';
  toExtension({ type: 'cancel', jobId: job.id });
  // If the extension never answers, don't leave the job hanging.
  if (!cancelTimers.has(job.id)) cancelTimers.set(job.id, setTimeout(() => {
    if (TERMINAL.has(job.status) || runningId !== job.id) return;
    if (job.sprite) cancelSpriteJob(job);
    else finishJob(job, { status: 'cancelled', error: 'Cancelled.', message: 'Cancelled' });
  }, 20000));
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
    const signature = buf.toString('latin1', 0, 6);
    const isGif = signature === 'GIF87a' || signature === 'GIF89a';
    const gif = isGif ? gifInfo(buf) : null;
    const cropped = !job.sprite && !isGif && img.crop ? Buffer.from(img.crop.data || '', 'base64') : null;
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
      const key = job.sprite ? `${job.id}-sheet-${job.sprite.attempts.length + 1}` : job.id;
      preview = path.join(shared.PREVIEW_DIR, `${key}-${i + 1}.jpg`);
      fs.writeFileSync(preview, Buffer.from(img.preview, 'base64'));
    }
    // From ChatGPT's own bytes: a cropped copy is always RGBA, so only the original tells whether
    // ChatGPT sent an alpha channel.
    const info = pngInfo(buf);
    const pf = img.previewFrames;
    const previewFrames = preview && gif && !gif.truncated && pf && Number.isInteger(pf.shown) && Number.isInteger(pf.total) &&
      pf.shown >= 2 && pf.shown <= 16 && pf.total >= pf.shown && pf.total <= 512 &&
      pf.total === gif.frames && pf.shown === Math.min(16, pf.total) ? { shown: pf.shown, total: pf.total } : null;
    return {
      path: file, width: (crop ? img.crop.width : img.width) || (gif && gif.width) || null,
      height: (crop ? img.crop.height : img.height) || (gif && gif.height) || null,
      bytes: main.length, preview, previewFrames, full, aspect: job.aspect ? job.aspect.target.label : null,
      png: info && { colorType: info.colorType, alphaChannel: info.alphaChannel, trns: info.trns }, alpha: img.alpha || null,
      gif: gif && { frames: gif.frames, durationMs: gif.durationMs, delaysMs: gif.delaysMs.slice(0, 64), loop: gif.loop,
        transparent: gif.transparent, transparentFrames: gif.transparentFrames, truncated: gif.truncated },
    };
  });
}

function animationImage(id, file, buf, gif, previewData, pfInput) {
  let preview = null;
  if (typeof previewData === 'string' && previewData.length <= Math.ceil(gallery.MAX_PREVIEW_BYTES / 3) * 4) {
    const png = Buffer.from(previewData, 'base64');
    if (png.length < gallery.MAX_PREVIEW_BYTES && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      fs.mkdirSync(shared.PREVIEW_DIR, { recursive: true });
      preview = path.join(shared.PREVIEW_DIR, `${id}-1.png`);
      fs.writeFileSync(preview, png);
    }
  }
  const pf = pfInput;
  const previewFrames = preview && pf && Number.isInteger(pf.shown) && Number.isInteger(pf.total) &&
    pf.shown >= 2 && pf.shown <= 16 && pf.total >= pf.shown && pf.total <= 512 &&
    pf.total === gif.frames && pf.shown === Math.min(16, pf.total) ? { shown: pf.shown, total: pf.total } : null;
  return { path: file, width: gif.width, height: gif.height, bytes: buf.length, preview, previewFrames,
      full: null, aspect: null, png: null, alpha: null,
      gif: { frames: gif.frames, durationMs: gif.durationMs, delaysMs: gif.delaysMs.slice(0, 64), loop: gif.loop,
        transparent: gif.transparent, transparentFrames: gif.transparentFrames, truncated: gif.truncated } };
}

// Local files are registered only after the host checks their bytes itself. No Chrome job is queued.
function addLocalAnimation(p) {
  const bad = message => new shared.BridgeError(message, 'BAD_REQUEST');
  if (typeof p.path !== 'string' || !path.isAbsolute(p.path) || path.extname(p.path).toLowerCase() !== '.gif') {
    throw bad('path must be an absolute GIF file path.');
  }
  const kind = p.kind === undefined ? 'light' : p.kind;
  if (!['light', 'sheet'].includes(kind)) throw bad('kind must be light or sheet.');
  const motions = kind === 'sheet' ? SHEET_MOTIONS : LIGHT_MOTIONS;
  if (!motions.includes(p.motion)) throw bad(`Unknown motion. Use: ${motions.join(', ')}.`);
  if (!['transparent', 'white'].includes(p.background)) throw bad('background must be transparent or white.');
  if (p.sourcePath !== undefined && typeof p.sourcePath !== 'string') throw bad('sourcePath must be a string.');
  const file = path.resolve(p.path);
  let buf, gif;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw bad('path must point to a file.');
    if (stat.size > MAX_ANIMATION_BYTES) throw bad('GIF exceeds the 8 MB animation limit.');
    buf = fs.readFileSync(file);
    if (buf.length > MAX_ANIMATION_BYTES) throw bad('GIF exceeds the 8 MB animation limit.');
    const signature = buf.toString('latin1', 0, 6);
    gif = (signature === 'GIF87a' || signature === 'GIF89a') && gifInfo(buf);
    if (!gif || gif.truncated !== false || gif.frames < 1) throw bad('The file must be a complete GIF with at least one frame.');
  } catch (e) { throw bad(`Cannot register local animation: ${e.message}`); }
  const samePath = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const existingIndex = jobs.findIndex(j => j.mode === 'local' && j.status === 'succeeded' &&
    j.images.some(im => samePath(im.path) === samePath(file)));
  const existing = jobs[existingIndex];
  if (existing) {
    const oldPreview = existing.images[0] && existing.images[0].preview;
    if (typeof oldPreview === 'string' && isInside(shared.PREVIEW_DIR, oldPreview)) {
      try { fs.unlinkSync(oldPreview); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    jobs.splice(existingIndex, 1);
  }
  // A new id invalidates the panel's jobId:n caches and moves the recreated animation to the top.
  let id;
  do { id = `img_${crypto.randomBytes(4).toString('hex')}`; }
  while ((existing && id === existing.id) || jobs.some(j => j.id === id));
  const time = now();
  const job = {
    id, mode: 'local', status: 'succeeded', step: 'succeeded', message: 'Local animation saved',
    prompt: `${kind === 'sheet' ? 'Sprite sheet' : 'Local'} ${p.motion} animation of ${path.basename(p.sourcePath || file)}`.slice(0, 300),
    animated: true, motion: p.motion, transparent: p.background === 'transparent', aspect: null,
    project: null, startUrl: null, conversationUrl: null, references: [], copies: [],
    createdAt: time, startedAt: time, finishedAt: time, assistantText: null, error: null, reason: null,
    images: [animationImage(id, file, buf, gif, p.preview, p.previewFrames)],
  };
  jobs.push(job);
  if (jobs.length > MAX_JOBS) jobs = jobs.filter((j, i) => i >= jobs.length - MAX_JOBS || !TERMINAL.has(j.status));
  saveJobs();
  log('info', `job ${id} local animation saved`, { path: file, motion: p.motion });
  if (extension) toExtension({ type: 'gallery_changed' });
  return publicJob(job);
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
    if (j.mode === 'local' || j.sprite || j.status !== 'succeeded' || !Array.isArray(j.images)) continue;
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
// there is none. PNG contact sheets are also dropped: decodeThumb accepts only JPEG thumbnails.
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
    conversationUrl: j.conversationUrl, startUrl: j.startUrl, images: j.images, assistantText: j.sprite?.attempts.length ? null : j.assistantText,
    error: j.error, reason: j.reason, createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt,
    references: j.references || [], reattached: !!j.reattached, editCheck: j.editCheck || null,
    referencesTransparent: j.referencesTransparent || 0, referencesMatted: j.referencesMatted || 0,
    aspect: j.aspect ? j.aspect.target.label : null, transparent: !!j.transparent, animated: !!j.animated, animatedRetry: !!j.animatedRetry, motion: j.motion || null,
    copyTo: j.copyTo || null, copies: j.copies || [],
    collection: j.collection || null,
    sprite: j.sprite ? {
      ...Object.fromEntries(['motion', 'frames', 'columns', 'rows', 'view', 'background', 'regenerated',
        'regenerateReason', 'warning', 'chosen'].map(key => [key, j.sprite[key]])),
      attempts: j.sprite.attempts.map(a => ({ attempt: a.attempt, sheetPath: a.sheet.path, conversationUrl: a.conversationUrl,
        folder: a.result?.folder ?? null, gif: a.result ? a.result.paths?.whiteGif || a.result.paths?.gif || null : null,
        transparentGif: a.result?.paths?.gif ?? null, contact: a.result?.paths?.contact ?? null,
        frames: a.result?.frames ?? null, durationMs: a.result?.durationMs ?? null, width: a.result?.width ?? null,
        height: a.result?.height ?? null, bytes: a.result?.bytes ?? null,
        gates: (a.result?.gates || []).map(({ id, passed, message }) => ({ id, passed, message })), error: a.result?.error ?? null })),
    } : undefined,
    chatImages: j.status === 'needs_reference' || j.status === 'text_reply' ? imagesFromChat(j) : undefined,
    queuePosition: j.status === 'queued' ? jobs.filter(x => x.status === 'queued').indexOf(j) + 1 : undefined,
  };
}

function statusInfo() {
  return {
    hostVersion: VERSION,
    features: ['sprite'],
    extension,
    project: config.project,
    outputDir: config.outputDir,
    collectionsDir: config.collectionsDir,
    debug: config.debug,
    running: publicJob(jobs.find(j => j.id === runningId)),
    queued: jobs.filter(j => j.status === 'queued').map(j => j.id),
    recent: jobs.slice(-5).reverse().map(j => ({
      id: j.id, status: j.status, createdAt: j.createdAt, prompt: j.prompt.slice(0, 80), conversationUrl: j.conversationUrl, animated: !!j.animated, motion: j.motion || null,
    })),
  };
}

const handlers = {
  status: () => statusInfo(),
  add_local_animation: p => addLocalAnimation(p),
  generate: p => publicJob(createWithCollection(p)),
  job: p => publicJob(findJob(p.jobId)),
  // The MCP server copies finished images into the caller's output_dir and records it here once.
  mark_copied: p => {
    const job = findJob(p.jobId);
    if (job.sprite && job.status === 'succeeded' && p.spriteCopies) {
      const moved = new Map(p.spriteCopies);
      const relocate = file => moved.get(file) || file;
      for (const image of job.images) {
        image.centralPath = image.centralPath || image.path;
        image.path = relocate(image.path);
      }
      for (const attempt of job.sprite.attempts) {
        attempt.sheet.path = relocate(attempt.sheet.path);
        if (!attempt.result?.paths) continue;
        attempt.result.folder = relocate(attempt.result.folder);
        for (const [key, value] of Object.entries(attempt.result.paths)) {
          attempt.result.paths[key] = Array.isArray(value) ? value.map(relocate) : relocate(value);
        }
      }
    }
    job.copies = Array.from(new Set([...(job.copies || []), ...(p.paths || [])]));
    saveJobs();
    if (job.sprite && extension) toExtension({ type: 'gallery_changed' });
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
  gallery_animation: p => gallery.readAnimation(galleryImage(p).image),
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
  extension = null;
  for (const j of jobs) {
    if (!TERMINAL.has(j.status) && !recoverSpriteJob(j)) Object.assign(j, { status: 'failed', step: 'failed', error: `Interrupted: ${reason}.`, finishedAt: now() });
  }
  saveJobs();
  try { server.close(); } catch {}
  process.exit(0);
}

// ---------------------------------------------------------------- start

for (const j of jobs) {
  if (!TERMINAL.has(j.status) && !recoverSpriteJob(j)) {
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
