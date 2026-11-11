'use strict';
// Paths, small file helpers and the named-pipe client shared by the MCP server and the CLI.
const fs = require('fs');
const net = require('net');
const path = require('path');
const identity = require('./identity');
const platform = require('./platform');
const { MAX_REFS, MAX_REF_BYTES, MAX_REFS_TOTAL_BYTES } = require('./lib/limits');

const ROOT = __dirname;
// Single version source; install.js copies package.json next to these files.
const VERSION = require('./package.json').version;
const DATA_DIR = path.join(ROOT, 'data');
const LOG_DIR = path.join(ROOT, 'logs');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const PREVIEW_DIR = path.join(DATA_DIR, 'previews');

// Resolved on first use, so loading this module works on every OS. BACKDRAW_PIPE override: tests only.
let pipePath = null;
function getPipePath() { return pipePath || (pipePath = process.env[identity.PIPE_ENV] || platform.pipePath()); }

const NOT_RUNNING =
  'The ChatGPT bridge is not running: Google Chrome is closed, or the browser extension ' +
  'is not loaded/enabled. Ask the user to open Chrome; the extension connects by itself.';

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

class BridgeError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// One request per connection: write a JSON line, read one JSON line back.
function call(method, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(getPipePath());
    let buf = '';
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err); else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new BridgeError(`The bridge did not answer "${method}" within ${Math.round(timeoutMs / 1000)}s.`, 'TIMEOUT')),
      timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify({ id: 1, method, params }) + '\n'));
    sock.on('data', chunk => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let msg;
      try { msg = JSON.parse(buf.slice(0, nl)); } catch (e) { return finish(e); }
      if (msg.error) finish(new BridgeError(msg.error.message, msg.error.code));
      else finish(null, msg.result);
    });
    sock.on('error', e => finish(['ENOENT', 'ECONNREFUSED', 'EPIPE'].includes(e.code) ? new BridgeError(NOT_RUNNING, 'NOT_RUNNING') : e));
    sock.on('close', () => finish(new BridgeError('The bridge closed the connection unexpectedly.', 'CLOSED')));
  });
}

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

// Reads reference images in the caller's own context (relative paths = its working folder).
function readReferences(list) {
  if (!list) return [];
  if (!Array.isArray(list)) list = [list];
  if (list.length > MAX_REFS) throw new Error(`At most ${MAX_REFS} reference images per request.`);
  let total = 0;
  return list.map(p => {
    const file = path.resolve(String(p));
    const mime = IMAGE_TYPES[path.extname(file).toLowerCase()];
    if (!mime) throw new Error(`Reference is not a png/jpg/webp/gif image: ${file}`);
    let buf;
    try { buf = fs.readFileSync(file); } catch (e) { throw new Error(`Cannot read reference image ${file} (${e.code || e.message}).`); }
    if (buf.length > MAX_REF_BYTES) throw new Error(`Reference image is larger than ${MAX_REF_BYTES / 1048576} MB: ${file}`);
    if ((total += buf.length) > MAX_REFS_TOTAL_BYTES) throw new Error(`The reference images together are larger than ${MAX_REFS_TOTAL_BYTES / 1048576} MB.`);
    return { name: path.basename(file), mime, data: buf.toString('base64') };
  });
}

// Copies a finished job's images into the folder the caller asked for (once), from the caller's
// own process so the copy lands where the caller can see it.
async function copyResults(job) {
  if (job.status !== 'succeeded' || !job.copyTo || (job.copies && job.copies.length)) return job;
  try {
    fs.mkdirSync(job.copyTo, { recursive: true });
    if (job.sprite) {
      const { copies, spriteCopies } = copySpriteResults(job);
      return await call('mark_copied', { jobId: job.id, paths: copies, spriteCopies });
    }
    const copies = job.images.map(im => {
      const ext = path.extname(im.path);
      const base = path.basename(im.path, ext);
      let dest = path.join(job.copyTo, `${base}${ext}`);
      for (let n = 2; fs.existsSync(dest); n++) dest = path.join(job.copyTo, `${base}_${n}${ext}`);
      fs.copyFileSync(im.path, dest);
      return dest;
    });
    return await call('mark_copied', { jobId: job.id, paths: copies });
  } catch (e) {
    return { ...job, copyError: e.message };
  }
}

// Keep each export together: manifest paths are relative to its folder. Reserve a new folder
// before writing, so repeated names never overwrite another sprite or its frame files.
function copySpriteResults(job) {
  const moved = new Map(), owned = [];
  const filesIn = folder => fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) return filesIn(file);
    if (!entry.isFile()) throw new Error(`Cannot copy sprite artifact: ${file}`);
    return [file];
  });
  try {
    for (const attempt of job.sprite.attempts) {
      if (!attempt.folder || attempt.error) continue;
      const required = ['atlas.png', 'manifest.json', 'contact.png', ...Array.from({ length: attempt.frames },
        (_, i) => `frames/frame_${String(i + 1).padStart(2, '0')}.png`)];
      for (const file of new Set([attempt.gif, attempt.transparentGif, ...required.map(relative => path.join(attempt.folder, relative))])) {
        if (!fs.statSync(file).isFile()) throw new Error(`Missing sprite artifact: ${file}`);
      }
      // Snapshot first, including when output_dir happens to be inside the source folder.
      const files = filesIn(attempt.folder);
      const base = path.join(job.copyTo, path.basename(attempt.folder));
      let folder;
      for (let n = 1; ; n++) {
        const candidate = n === 1 ? base : `${base}_${n}`;
        try { fs.mkdirSync(candidate); folder = candidate; break; }
        catch (e) { if (e.code !== 'EEXIST') throw e; }
      }
      owned.push(folder);
      moved.set(attempt.folder, folder);
      for (const source of [...files, attempt.sheetPath]) {
        const relative = source === attempt.sheetPath ? path.basename(source) : path.relative(attempt.folder, source);
        const dest = path.join(folder, relative);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL);
        moved.set(source, dest);
      }
    }
    const copies = job.images.map(im => {
      if (moved.has(im.path)) return moved.get(im.path);
      const ext = path.extname(im.path), base = path.basename(im.path, ext);
      for (let n = 1; ; n++) {
        const dest = path.join(job.copyTo, `${base}${n === 1 ? '' : `_${n}`}${ext}`);
        try { fs.copyFileSync(im.path, dest, fs.constants.COPYFILE_EXCL); owned.push(dest); moved.set(im.path, dest); return dest; }
        catch (e) { if (e.code !== 'EEXIST') throw e; }
      }
    });
    return { copies, spriteCopies: [...moved] };
  } catch (e) {
    for (const file of owned.reverse()) fs.rmSync(file, { recursive: true, force: true });
    throw e;
  }
}

module.exports = {
  VERSION, ROOT, DATA_DIR, LOG_DIR, CONFIG_FILE, JOBS_FILE, PREVIEW_DIR,
  NOT_RUNNING, BridgeError, readJson, writeJson, call, readReferences, copyResults,
  get PIPE_PATH() { return getPipePath(); },
};
