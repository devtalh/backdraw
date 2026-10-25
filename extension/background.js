// Service worker. Keeps a native-messaging connection to the local host and runs ChatGPT jobs in a
// tab it opens in the background: the tab is never activated and no window is ever focused.
// Only prompts, reference images, progress, chat links and image bytes cross the bridge; cookies,
// tokens and passwords are never read.
importScripts('aspect.js', 'i18n.js', 'menus.js', 'collections.js'); // crop maths; right-click reference collections

const { cropRect } = self.BackdrawAspect;
const HOST = 'io.github.muhammedtalha04.backdraw'; // identity.js HOST_NAME
const VERSION = chrome.runtime.getManifest().version;
const HOME = 'https://chatgpt.com/';
const HUMAN_WAIT_MS = 10 * 60 * 1000;

// ChatGPT asking for the image to be (re)uploaded because it can't reach the one it should edit.
const REUPLOAD = /(tekrar|yeniden)\s+(yükle|ekle|gönder|paylaş)|sohbete ekle|erişilebilir (olarak )?görmüyor|erişemiyorum|göremiyorum|re-?upload|upload (it|the image|the picture|that image|this image) again|please (re-?)?(upload|attach|share|provide|send) (the|your|that|this)?\s*(image|picture|photo|sprite)|can.?t (access|see|find) (the|that|this) (image|picture|file)|(don.?t|do not) have access to (the|that|this) (image|picture)/i;

let port = null;
let hostReady = false;
let lastError = null;
let project = null;
let reconnectTimer = null;
let reconnectDelay = 2000;
let current = null;
let workerTabId = null;
let closeTimer = null;
const recent = [];
const refParts = new Map(); // jobId -> [{ name, mime, parts[] }] while reference images arrive in chunks

const sleep = ms => new Promise(r => setTimeout(r, ms));

class Cancelled extends Error {
  constructor() { super('Cancelled'); this.name = 'Cancelled'; }
}

function fail(reason, message) {
  const e = new Error(message);
  e.reason = reason;
  return e;
}

function check(ctx) { if (ctx.cancelled) throw new Cancelled(); }

function post(msg) {
  if (!port) return false;
  try { port.postMessage(msg); return true; } catch { return false; }
}

function log(level, msg, data) {
  (level === 'error' ? console.error : console.log)(`[bridge] ${msg}`, data === undefined ? '' : data);
  post({ type: 'log', level, msg, data });
}

// ---------------------------------------------------------------- native host connection

function connect() {
  if (port) return;
  clearTimeout(reconnectTimer);
  let p;
  try {
    p = chrome.runtime.connectNative(HOST);
  } catch (e) {
    onDisconnected(null, String((e && e.message) || e));
    return;
  }
  port = p;
  p.onMessage.addListener(msg => {
    onHostMessage(msg).catch(e => log('error', 'host message failed', String((e && e.stack) || e)));
  });
  p.onDisconnect.addListener(() => onDisconnected(p, (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'disconnected'));
  p.postMessage({ type: 'hello', version: VERSION });
}

function onDisconnected(p, error) {
  if (p && port !== p) return;
  port = null;
  hostReady = false;
  lastError = error;
  refParts.clear();
  if (current) current.cancelled = true; // the host that owned the job is gone
  setBadge();
  collectionsOffline();
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 60000);
}

async function onHostMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      hostReady = true;
      lastError = null;
      reconnectDelay = 2000;
      project = msg.project || null;
      hostHome = msg.home || null;
      setBadge();
      collectionsOnline(msg.collections);
      break;
    case 'config':
      project = msg.project || null;
      break;
    case 'ref_chunk': {
      // Native messages from the host are limited to 1 MB, so reference images come in pieces
      // just before the job that uses them.
      const files = refParts.get(msg.jobId) || [];
      const f = files[msg.index] || (files[msg.index] = { name: msg.name, mime: msg.mime, parts: new Array(msg.total) });
      f.parts[msg.seq] = msg.data;
      refParts.set(msg.jobId, files);
      break;
    }
    case 'run': {
      const files = refParts.get(msg.job.id) || [];
      refParts.delete(msg.job.id);
      msg.job.refs = files.map(f => {
        let complete = true;
        for (let i = 0; i < f.parts.length; i++) if (typeof f.parts[i] !== 'string') complete = false;
        return { name: f.name, mime: f.mime, data: complete ? f.parts.join('') : '', complete };
      });
      runJob(msg.job);
      break;
    }
    case 'cancel':
      if (current && current.job.id === msg.jobId) current.cancelled = true;
      break;
    case 'request':
      handleRequest(msg);
      break;
    case 'reply':
      settleHostCall(msg);
      break;
    case 'collections':
      collectionsChanged(msg.collections);
      break;
    case 'reload':
      setTimeout(() => chrome.runtime.reload(), 300);
      break;
  }
}

// ---------------------------------------------------------------- tabs

async function createBackgroundTab(url) {
  let win = null;
  try { win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }); } catch {}
  let tab;
  if (win && win.type === 'normal') {
    tab = await chrome.tabs.create({ windowId: win.id, url, active: false });
  } else {
    // No browser window is open: use a minimized one that never takes focus.
    const w = await chrome.windows.create({ url, focused: false, state: 'minimized' });
    tab = w.tabs[0];
  }
  try { await chrome.tabs.update(tab.id, { autoDiscardable: false, muted: true }); } catch {}
  return tab;
}

async function openWorker(url) {
  clearTimeout(closeTimer);
  let tab = null;
  if (workerTabId !== null) tab = await chrome.tabs.get(workerTabId).catch(() => null);
  if (tab) {
    await chrome.tabs.update(tab.id, { url });
  } else {
    tab = await createBackgroundTab(url);
    workerTabId = tab.id;
    await chrome.storage.session.set({ workerTabId });
  }
  return tab.id;
}

function forgetWorker() {
  workerTabId = null;
  chrome.storage.session.remove('workerTabId').catch(() => {});
}

async function closeTabQuietly(id) {
  try {
    const t = await chrome.tabs.get(id);
    if (t.active) return; // the user is looking at it: leave it alone
    await chrome.tabs.remove(id);
  } catch {}
}

function scheduleWorkerClose(keep) {
  clearTimeout(closeTimer);
  if (keep) { forgetWorker(); return; } // left open for the user (e.g. a CAPTCHA)
  closeTimer = setTimeout(() => {
    if (current || workerTabId === null) return;
    const id = workerTabId;
    forgetWorker();
    closeTabQuietly(id);
  }, 5000);
}

async function withHelperTab(url, fn) {
  const tab = await createBackgroundTab(url);
  try { return await fn(tab.id); } finally { closeTabQuietly(tab.id); }
}

// Runs one helper from inpage.js inside the tab and returns its (JSON) result.
async function pageCall(tabId, fn, ...args) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['inpage.js'] });
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (name, params) => {
      const lib = globalThis.__cgb;
      if (!lib || typeof lib[name] !== 'function') return { __error: `page helper missing: ${name}` };
      try {
        return Promise.resolve(lib[name](...params)).catch(e => ({ __error: String((e && e.stack) || e) }));
      } catch (e) {
        return { __error: String((e && e.stack) || e) };
      }
    },
    args: [fn, args],
  });
  const value = res ? res.result : undefined;
  if (value && value.__error) throw new Error(`page.${fn}: ${value.__error}`);
  if (fn === 'probe') noteChatgpt(value);
  return value;
}

async function probeTab(ctx, baseline) {
  try {
    return await pageCall(ctx.tabId, 'probe', baseline);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/no tab with id|tab was closed|closed tab/i.test(msg)) throw fail('tab_closed', 'The background ChatGPT tab was closed.');
    ctx.lastProbeError = msg; // usually: the page is still loading
    return null;
  }
}

const isChatUrl = url => /\/c\/[0-9a-f-]{8,}/i.test(url || '');
const cleanUrl = url => { const u = new URL(url); return u.origin + u.pathname; };
const comparable = s => String(s || '').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();

// Is the newest user message in the chat the one we sent? (Same opening text.)
function isOurMessage(shown, sent) {
  const a = comparable(shown);
  const b = comparable(sent);
  const n = Math.min(150, a.length, b.length);
  return n >= 20 && a.slice(0, n) === b.slice(0, n);
}

function describe(st) {
  if (!st) return 'page not loaded';
  return `url=${st.url} title="${st.title}" composer=${st.composer} login=${st.login} challenge=${st.challenge} dialogs=${(st.dialogs || []).length}`;
}

function compact(st) {
  const c = { ...st };
  if (c.images) c.images = c.images.map(i => ({ ...i, src: i.src.slice(0, 120) }));
  if (c.text) c.text = c.text.slice(0, 300);
  return c;
}

// ---------------------------------------------------------------- jobs

async function runJob(job) {
  if (current) {
    post({ type: 'result', jobId: job.id, ok: false, status: 'failed', reason: 'busy', error: 'The extension is busy with another job.' });
    return;
  }
  const ctx = current = {
    job, cancelled: false, tabId: null, conversationUrl: null, lastText: '', sent: false, keepTab: false,
    step: 'starting', message: '', deadline: Date.now() + (job.timeoutSec || 600) * 1000, refs: job.refs || [],
    startedAt: Date.now(),
  };
  ctx.progress = (step, message, extra = {}) => {
    ctx.step = step;
    ctx.message = message;
    post({ type: 'progress', jobId: job.id, step, message, ...extra });
  };
  setBadge();
  remember(job.id, 'running');
  try {
    if (ctx.refs.some(r => !r.complete)) throw fail('ref_transfer', 'A reference image did not arrive completely; please try again.');
    ctx.progress('opening', 'Opening ChatGPT in a background tab');
    ctx.tabId = await openWorker(job.startUrl);
    const ready = await waitUntilReady(ctx);
    let outcome;
    let attached = ctx.refs;
    if (job.mode === 'collect') {
      // Only read an existing conversation: nothing is typed or sent.
      ctx.collect = true;
      if (isChatUrl(ready.url)) ctx.conversationUrl = cleanUrl(ready.url);
      outcome = await waitForReply(ctx, { users: 0, images: 0 });
    } else {
      outcome = await sendAndWait(ctx, ready, job.text, attached);
      // In long chats ChatGPT can lose track of earlier images and asks for them to be uploaded
      // again instead of editing. With auto_reattach: attach it (or the given references) once.
      if (outcome.kind === 'needs_reference' && job.autoReattach) {
        attached = ctx.refs.length ? ctx.refs : await latestImageAsFile(ctx);
        if (attached.length) {
          ctx.progress('reattaching', 'ChatGPT asked for the image again: attaching it and asking once more', { conversationUrl: ctx.conversationUrl });
          const now = (await probeTab(ctx, null)) || { counts: { users: 0, images: 0 } };
          outcome = await sendAndWait(ctx, now, `I attached the image again.\n\n${job.text}`, attached);
          outcome.reattached = true;
        }
      }
    }
    if (outcome.kind !== 'images') {
      post({
        type: 'result', jobId: job.id, ok: false, status: outcome.kind, reason: outcome.kind,
        error: outcome.kind === 'needs_reference'
          ? 'ChatGPT could not access the image it should edit and asked for it to be uploaded again.'
          : 'ChatGPT replied with text and did not create an image.',
        conversationUrl: ctx.conversationUrl, assistantText: outcome.text || null, reattached: !!outcome.reattached,
      });
      remember(job.id, outcome.kind);
      return;
    }
    let editCheck = null;
    if (!ctx.collect && (attached.length || isChatUrl(job.startUrl))) {
      // Best effort: never let the comparison hold up the result.
      editCheck = await Promise.race([
        pageCall(ctx.tabId, 'editCheck', attached.map(r => ({ name: r.name, mime: r.mime, data: r.data }))),
        sleep(20000).then(() => { throw new Error('timed out'); }),
      ]).catch(e => { log('warn', 'edit check skipped', String(e)); return null; });
    }
    ctx.progress('downloading', 'Downloading the image', { conversationUrl: ctx.conversationUrl });
    const images = await downloadImages(ctx, outcome.images);
    post({
      type: 'result', jobId: job.id, ok: true, status: 'succeeded', conversationUrl: ctx.conversationUrl,
      assistantText: outcome.text, title: outcome.title, images, editCheck, reattached: !!outcome.reattached,
      references: attached.length,
    });
    remember(job.id, 'succeeded');
  } catch (e) {
    const cancelled = e instanceof Cancelled || ctx.cancelled;
    if (cancelled && ctx.tabId !== null && !ctx.collect) {
      try {
        await pageCall(ctx.tabId, ctx.sent ? 'clickStop' : 'clearComposer');
        if (!ctx.sent) await pageCall(ctx.tabId, 'removeAttachments');
        await sleep(1500);
        if (ctx.job.debug) log('debug', `cancelled (${ctx.sent ? 'pressed Stop' : 'before sending'})`, await pageCall(ctx.tabId, 'composerState'));
      } catch {}
    }
    if (!cancelled) log('warn', `job ${job.id} failed: ${e.message}`, { reason: e.reason });
    post({
      type: 'result', jobId: job.id, ok: false, status: cancelled ? 'cancelled' : 'failed',
      reason: cancelled ? 'cancelled' : e.reason || 'error', error: cancelled ? 'Cancelled.' : e.message,
      conversationUrl: ctx.conversationUrl, assistantText: ctx.lastText || null,
    });
    remember(job.id, cancelled ? 'cancelled' : 'failed');
  } finally {
    current = null;
    setBadge();
    scheduleWorkerClose(ctx.keepTab);
  }
}

async function sendAndWait(ctx, before, text, files) {
  if (files.length) await attachRefs(ctx, files);
  ctx.progress('typing', 'Writing the prompt');
  await typePrompt(ctx, text);
  ctx.progress('sending', 'Sending the prompt');
  ctx.sentText = text;
  await sendPrompt(ctx, before.counts, files.length > 0);
  ctx.progress('generating', 'ChatGPT is generating the image', { conversationUrl: ctx.conversationUrl });
  return waitForReply(ctx, before.counts);
}

// Waits (without giving up) while ChatGPT shows a login or human-verification page. It never
// interacts with that page; the user has to complete it.
async function humanGate(ctx, st) {
  const kind = st.challenge ? 'verification' : st.login ? 'login' : null;
  if (!kind) return false;
  const message = kind === 'login'
    ? 'ChatGPT is not logged in in Chrome. The user must log in to chatgpt.com in Chrome (they can use the background ChatGPT tab).'
    : 'ChatGPT is showing a human verification (CAPTCHA) page. The user must open the background ChatGPT tab in Chrome and complete it.';
  ctx.progress('needs_human', message, { needsHuman: true });
  log('warn', `waiting for the user: ${kind}`, { url: st.url, title: st.title });
  ctx.deadline += HUMAN_WAIT_MS;
  const until = Date.now() + HUMAN_WAIT_MS;
  while (Date.now() < until) {
    check(ctx);
    await sleep(3000);
    const now = await probeTab(ctx, null);
    if (now && !now.challenge && !now.login && now.composer) {
      ctx.progress('resuming', 'The page is available again, continuing');
      return true;
    }
  }
  ctx.keepTab = true;
  throw fail('needs_human', `${message} (Stopped waiting after 10 minutes.)`);
}

async function waitUntilReady(ctx) {
  const projectId = (ctx.job.startUrl.match(/\/g\/(g-p-[0-9a-f]+)/i) || [])[1];
  const until = Date.now() + 60000;
  let readySince = 0;
  let offTargetSince = 0;
  let last = null;
  await sleep(1500);
  for (;;) {
    check(ctx);
    const st = await probeTab(ctx, null);
    if (st) {
      last = st;
      if (await humanGate(ctx, st)) {
        await chrome.tabs.update(ctx.tabId, { url: ctx.job.startUrl });
        await sleep(2000);
        continue;
      }
      const onTarget = !projectId || st.url.includes(projectId);
      if (st.composer && onTarget) {
        if (!readySince) readySince = Date.now();
        else if (Date.now() - readySince >= 1500) return st;
      } else {
        readySince = 0;
      }
      if (st.composer && !onTarget) {
        if (!offTargetSince) offTargetSince = Date.now();
        else if (Date.now() - offTargetSince > 6000) {
          throw fail('project_unavailable', `ChatGPT did not open the project (it went to ${st.url}). Was it deleted or renamed? Select it again with select_project.`);
        }
      } else {
        offTargetSince = 0;
      }
    }
    if (Date.now() > until) {
      throw fail('page_not_ready', `ChatGPT did not finish loading (no message box). ${describe(last)}${ctx.lastProbeError ? ` | ${ctx.lastProbeError}` : ''}`);
    }
    await sleep(1000);
  }
}

// Puts the reference images on the composer and waits until ChatGPT has uploaded all of them.
// Right after a page load the file input may not react yet, so the chips are checked and the
// files attached again if they don't show up.
async function attachRefs(ctx, files) {
  ctx.progress('attaching', `Attaching ${files.length} reference image(s)`);
  const payload = files.map(f => ({ name: f.name, mime: f.mime, data: f.data }));
  let s = null;
  await sleep(2000);
  for (let attempt = 1; attempt <= 4; attempt++) {
    check(ctx);
    const r = await pageCall(ctx.tabId, 'attachFiles', payload);
    if (r.ok) {
      const shownBy = Date.now() + 8000;
      do {
        await sleep(800);
        s = await pageCall(ctx.tabId, 'attachmentState');
      } while (s.count < files.length && Date.now() < shownBy);
      if (s.count >= files.length) break;
    }
    if (ctx.job.debug) log('debug', `attach attempt ${attempt} did not show up`, { result: r, state: s });
    if (s && s.count) await pageCall(ctx.tabId, 'removeAttachments'); // start clean, no duplicates
    await sleep(1500 * attempt);
  }
  if (!s || s.count < files.length) throw fail('attach_failed', `ChatGPT did not accept the reference image(s) (${s ? s.count : 0}/${files.length} shown).`);
  const until = Date.now() + 120000;
  while (s.uploading) {
    check(ctx);
    if (s.failed.length) throw fail('attach_failed', `ChatGPT could not upload: ${s.failed.join(', ')}`);
    if (Date.now() > until) throw fail('attach_failed', 'The reference image(s) did not finish uploading.');
    await sleep(1000);
    s = await pageCall(ctx.tabId, 'attachmentState');
  }
  if (s.failed.length) throw fail('attach_failed', `ChatGPT could not upload: ${s.failed.join(', ')}`);
  if (ctx.job.debug) log('debug', 'reference images attached', s);
}

// The newest image the chat already has, as a file to attach again.
async function latestImageAsFile(ctx) {
  const info = await pageCall(ctx.tabId, 'latestEarlierImage').catch(() => null);
  if (!info) return [];
  const r = await pageCall(ctx.tabId, 'fetchImage', info.src).catch(e => ({ error: e.message }));
  if (!r || r.error) { log('warn', 'could not read the previous image to re-attach', r && r.error); return []; }
  const ext = /png/.test(r.mime) ? 'png' : /webp/.test(r.mime) ? 'webp' : 'jpg';
  return [{ name: `previous-image.${ext}`, mime: r.mime || 'image/png', data: r.data }];
}

async function typePrompt(ctx, text) {
  const want = comparable(text);
  for (const method of ['insertText', 'paste', 'dom']) {
    check(ctx);
    await pageCall(ctx.tabId, 'clearComposer');
    await sleep(250);
    await pageCall(ctx.tabId, 'setPrompt', text, method);
    await sleep(600);
    const st = await pageCall(ctx.tabId, 'composerState');
    const got = comparable(st.text);
    if (got === want || (got.includes(want.slice(0, 40)) && Math.abs(got.length - want.length) <= Math.max(5, want.length * 0.03))) {
      if (ctx.job.debug) log('debug', `prompt written via ${method}`);
      return method;
    }
    log('warn', `writing the prompt via ${method} did not stick`, { got: String(st.text).slice(0, 160), dialogs: st.dialogs });
    await pageCall(ctx.tabId, 'dismissDialogs').catch(() => {});
    await sleep(500);
  }
  throw fail('type_failed', "Couldn't write the prompt into ChatGPT's message box.");
}

async function sendPrompt(ctx, baseline, withFiles) {
  const startPath = new URL(ctx.job.startUrl).pathname;
  for (const how of ['click', 'enter']) {
    check(ctx);
    if (how === 'click') {
      // With attachments the send button stays disabled until the upload has finished.
      for (let i = 0, n = withFiles ? 240 : 20; i < n; i++) {
        const s = await pageCall(ctx.tabId, 'composerState');
        if (s.stop || (s.send && !s.send.disabled)) break;
        await sleep(250);
      }
      const r = await pageCall(ctx.tabId, 'clickSend');
      if (!r.ok) log('warn', `send button: ${r.error}`);
    } else {
      await pageCall(ctx.tabId, 'pressEnter');
    }
    const t0 = Date.now();
    let emptyCount = 0;
    while (Date.now() - t0 < 12000) {
      await sleep(600);
      check(ctx);
      const st = await probeTab(ctx, baseline);
      if (!st) continue;
      const moved = isChatUrl(st.url) && new URL(st.url).pathname !== startPath;
      if (st.userTurns > 0 || st.stop || moved) {
        ctx.sent = true;
        ctx.sentAt = Date.now();
        if (isChatUrl(st.url)) ctx.conversationUrl = cleanUrl(st.url);
        return st;
      }
      if (st.composer && !st.composerText) emptyCount++;
    }
    if (emptyCount >= 3) {
      // The box was emptied, so the message most likely went out; never risk sending it twice.
      log('warn', 'message box emptied without a visible reply yet; assuming it was sent');
      ctx.sent = true;
      ctx.sentAt = Date.now();
      return null;
    }
  }
  throw fail('send_failed', "ChatGPT didn't accept the message (the send button had no effect).");
}

async function reloadWorker(ctx) {
  if (ctx.conversationUrl) await chrome.tabs.update(ctx.tabId, { url: ctx.conversationUrl });
  else await chrome.tabs.reload(ctx.tabId);
  await sleep(3000);
  for (let i = 0; i < 25; i++) {
    check(ctx);
    const st = await probeTab(ctx, null);
    if (st && st.composer && st.counts.users + st.counts.images > 0) return;
    await sleep(1000);
  }
}

// Waits for ChatGPT's answer to our message. Returns {kind: 'images', images, text, title} or, when
// ChatGPT answered in text only, {kind: 'needs_reference' | 'text_reply', text}.
async function waitForReply(ctx, baseline) {
  // Temporary chats are not stored, so re-opening one would lose it: no confirmation reloads there.
  const canReload = !/temporary-chat=true/i.test(ctx.job.startUrl);
  const verdict = text => ({ kind: REUPLOAD.test(text) ? 'needs_reference' : 'text_reply', text });
  let lastProgress = null;
  let lastSig = '';
  let lastChange = Date.now();
  let lastReload = 0;
  let textSeen = null; // the text-only reply seen before a confirmation reload
  let verified = !!ctx.collect || !canReload; // a chat that was just opened already shows the server's state
  for (;;) {
    check(ctx);
    if (Date.now() > ctx.deadline) {
      throw fail('timeout', `ChatGPT did not finish in time.${ctx.conversationUrl ? ` It may still finish in the chat: ${ctx.conversationUrl}` : ''}`);
    }
    const st = await probeTab(ctx, baseline);
    if (!st) { await sleep(1500); continue; }
    if (st.challenge || st.login) {
      await humanGate(ctx, st);
      await reloadWorker(ctx);
      continue;
    }
    if (isChatUrl(st.url) && cleanUrl(st.url) !== ctx.conversationUrl) {
      ctx.conversationUrl = cleanUrl(st.url);
      ctx.progress(ctx.step, ctx.message, { conversationUrl: ctx.conversationUrl });
    }
    // Everything below the newest user message is the reply, so that message must be ours (long
    // chats only render their latest turns, so turns are never counted from the top).
    const ours = ctx.collect || isOurMessage(st.lastUserText, ctx.sentText) || Date.now() - (ctx.sentAt || 0) > 90000;
    if (ours && st.text) ctx.lastText = st.text;
    const pct = st.progress && (st.progress.match(/\d{1,3}/) || [])[0];
    if (pct && pct !== lastProgress) {
      lastProgress = pct;
      ctx.progress('generating', `ChatGPT is generating the image (${pct}%)`, { conversationUrl: ctx.conversationUrl });
    }
    const sig = `${ours}#${st.sig}`;
    if (sig !== lastSig) {
      lastSig = sig;
      lastChange = Date.now();
      if (ctx.job.debug) {
        const tab = await chrome.tabs.get(ctx.tabId).catch(() => ({}));
        log('debug', 'reply changed', { tabActive: tab.active, ours, ...compact(st) });
      }
    }
    const quiet = Date.now() - lastChange;
    const idle = ours && !st.stop && !st.busy;
    const images = ours ? st.images || [] : [];
    let finals = images.filter(i => !i.blurred);
    // After a fresh load the server only has final images; a hidden tab may never un-blur them.
    if (!finals.length && verified && quiet >= 15000) finals = images;

    if (idle && finals.length && quiet >= (verified ? 3000 : 5000)) {
      if (verified) return { kind: 'images', images: finals, text: st.text, title: st.title };
      // Re-open the chat once, so the image is taken from the server's final state and never
      // from an in-progress preview.
      ctx.progress('verifying', 'Image ready, checking the final version', { conversationUrl: ctx.conversationUrl });
      await reloadWorker(ctx);
      verified = true;
      lastSig = '';
      lastReload = Date.now();
      continue;
    }

    // A finished reply without an image (its action bar is shown, or a "failed" line): confirm
    // once with a fresh load, then report the text so the caller can see what ChatGPT said.
    if (idle && !images.length && st.replyCount > 0 && quiet >= 5000 && (st.done || st.failed || quiet >= 20000)) {
      if (textSeen === null && canReload) {
        textSeen = st.text || st.failed || '';
        await reloadWorker(ctx);
        lastSig = '';
        lastReload = Date.now();
        continue;
      }
      return verdict(st.text || st.failed || '');
    }
    // The reload came back without the conversation: go with the reply seen before it.
    if (textSeen !== null && st.counts.users === 0 && !st.text && Date.now() - lastReload > 15000) return verdict(textSeen);

    // A hidden tab can miss live updates; reload if nothing changed for a long time.
    if (canReload && quiet > 120000 && Date.now() - lastReload > 120000) {
      if (ctx.job.debug) log('debug', 'no change for 2 minutes, reloading', compact(st));
      await reloadWorker(ctx);
      lastSig = '';
      lastReload = Date.now();
      continue;
    }
    await sleep(2000);
  }
}

// ---------------------------------------------------------------- image download + preview

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const blobToB64 = async blob => bytesToB64(new Uint8Array(await blob.arrayBuffer()));

// The part r of the image on a canvas of its own size.
function drawPart(bmp, r) {
  const canvas = new OffscreenCanvas(r.width, r.height);
  canvas.getContext('2d', { willReadFrequently: true }).drawImage(bmp, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
  return canvas;
}

// Share of the pixels that are see-through (alpha < 250) and fully opaque, from every 4th pixel.
function measureAlpha(canvas) {
  const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
  let n = 0;
  let clear = 0;
  let opaque = 0;
  for (let i = 3; i < data.length; i += 16) {
    n++;
    if (data[i] < 250) clear++;
    else if (data[i] === 255) opaque++;
  }
  const share = x => (n ? Math.round((x / n) * 10000) / 10000 : 0);
  return { transparentShare: share(clear), opaqueShare: share(opaque) };
}

// A JPEG of at most 1024 px. Transparent parts show over a light checkerboard, as image editors
// show them, so a see-through background can be told apart from a white one.
async function makePreview(bmp, r, checker) {
  const scale = Math.min(1, 1024 / Math.max(r.width, r.height));
  const w = Math.max(1, Math.round(r.width * scale));
  const h = Math.max(1, Math.round(r.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, w, h);
  if (checker) {
    const size = 16;
    g.fillStyle = '#e2e2e2';
    for (let y = 0; y < h; y += size) for (let x = (y / size) % 2 ? size : 0; x < w; x += 2 * size) g.fillRect(x, y, size, size);
  }
  g.drawImage(bmp, r.x, r.y, r.width, r.height, 0, 0, w, h);
  return blobToB64(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.86 }));
}

// Decodes a downloaded image once. With an aspect ratio it is cropped from the centre (exported as
// PNG, which keeps any alpha); a transparent job measures the alpha of the (cropped) image; the
// preview shows the cropped version.
async function processImage(b64, mime, job) {
  const bmp = await createImageBitmap(new Blob([b64ToBytes(b64)], { type: mime || 'image/png' }));
  try {
    const out = { width: bmp.width, height: bmp.height, crop: null, alpha: null, preview: null };
    const rect = job.aspect ? cropRect(bmp.width, bmp.height, job.aspect.w, job.aspect.h) : null;
    const r = rect || { x: 0, y: 0, width: bmp.width, height: bmp.height };
    let canvas = null;
    if (rect) {
      canvas = drawPart(bmp, rect);
      out.crop = { data: await blobToB64(await canvas.convertToBlob({ type: 'image/png' })), mime: 'image/png', width: rect.width, height: rect.height };
    }
    if (job.transparent) out.alpha = measureAlpha(canvas || drawPart(bmp, r));
    out.preview = await makePreview(bmp, r, !!out.alpha && out.alpha.transparentShare > 0)
      .catch(e => { log('warn', 'preview failed', String(e)); return null; });
    return out;
  } finally {
    bmp.close();
  }
}

async function fetchFromWorker(src) {
  const res = await fetch(src, { credentials: 'include' });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const blob = await res.blob();
  return { data: bytesToB64(new Uint8Array(await blob.arrayBuffer())), mime: blob.type };
}

async function downloadImages(ctx, images) {
  const out = [];
  for (const im of images.slice(0, 4)) {
    check(ctx);
    let r = await pageCall(ctx.tabId, 'fetchImage', im.src).catch(e => ({ error: e.message }));
    if (!r || r.error) {
      const pageError = r && r.error;
      r = await fetchFromWorker(im.src).catch(e => ({ error: e.message }));
      if (r.error) { log('warn', 'image download failed', { page: pageError, worker: r.error }); continue; }
    }
    if (ctx.job.debug) log('debug', `image downloaded via ${r.via || 'worker'}`, { bytes: r.size, mime: r.mime });
    let meta = {};
    try { meta = await processImage(r.data, r.mime, ctx.job); } catch (e) { log('warn', 'image processing failed', String(e)); }
    out.push({
      data: r.data, mime: r.mime, width: meta.width || im.w || null, height: meta.height || im.h || null, preview: meta.preview || null,
      crop: meta.crop || null, alpha: meta.alpha || null,
    });
  }
  if (!out.length) throw fail('download_failed', `The image was generated but could not be downloaded. Open the chat: ${ctx.conversationUrl}`);
  return out;
}

// ---------------------------------------------------------------- requests from the host

async function handleRequest(msg) {
  try {
    let data;
    if (msg.action === 'list_projects') data = await listProjects();
    else if (msg.action === 'resolve_project') data = await resolveProject((msg.params || {}).name);
    else if (msg.action === 'diagnose') data = await diagnose(msg.params || {});
    else if (msg.action === 'chatgpt_state') data = chatgptState; // what the last look at chatgpt.com showed (backdraw doctor)
    else throw new Error(`Unknown action ${msg.action}`);
    post({ type: 'response', reqId: msg.reqId, ok: true, data });
  } catch (e) {
    post({ type: 'response', reqId: msg.reqId, ok: false, error: String((e && e.message) || e), code: e && e.reason });
  }
}

// The sidebar fills in lazily in a background tab, so poll for the project rows. If the user keeps
// the sidebar closed it is opened here; the caller closes it again (sidebarOpened).
async function projectRows(tabId) {
  const until = Date.now() + 45000;
  let sidebarOpened = false;
  let last = null;
  await sleep(2500);
  while (Date.now() < until) {
    const st = await pageCall(tabId, 'probe', null).catch(() => null);
    if (st) {
      last = st;
      if (st.login) throw fail('needs_human', 'ChatGPT is not logged in in Chrome. Log in at chatgpt.com first.');
      if (st.challenge) throw fail('needs_human', 'ChatGPT is showing a human verification page in Chrome; complete it first.');
      if (st.composer) {
        const rows = await pageCall(tabId, 'listProjects').catch(() => []);
        if (rows.length) return { rows, sidebarOpened };
        if (!sidebarOpened && st.sidebarOpen === false && Date.now() > until - 25000) {
          const r = await pageCall(tabId, 'sidebar', true).catch(() => ({}));
          sidebarOpened = !!r.clicked;
        }
      }
    }
    await sleep(1500);
  }
  if (sidebarOpened) await pageCall(tabId, 'sidebar', false).catch(() => {});
  throw fail('not_found', `No projects were found in ChatGPT's sidebar (${describe(last)}).`);
}

async function listProjects() {
  return withHelperTab(HOME, async tabId => {
    const { rows, sidebarOpened } = await projectRows(tabId);
    if (sidebarOpened) await pageCall(tabId, 'sidebar', false).catch(() => {});
    return rows;
  });
}

// Projects without chats show no link in the sidebar: open the project (in the helper tab) and
// read its address.
async function resolveProject(name) {
  return withHelperTab(HOME, async tabId => {
    const { rows, sidebarOpened } = await projectRows(tabId);
    try {
      const row = rows.find(r => r.name === name);
      if (!row) throw fail('not_found', `Project "${name}" is not in the ChatGPT sidebar.`);
      if (row.url) return row;
      const r = await pageCall(tabId, 'openProject', name);
      if (!r.ok) throw fail('not_found', `Could not open project "${name}": ${r.error}`);
      for (let i = 0; i < 20; i++) {
        await sleep(1000);
        const st = await pageCall(tabId, 'probe', null).catch(() => null);
        const m = st && st.url.match(/\/g\/(g-p-[0-9a-f]+)/i);
        if (m) return { name, id: m[1], url: `https://chatgpt.com/g/${m[1]}/project` };
      }
      throw fail('not_found', `Opened project "${name}" but could not read its link.`);
    } finally {
      if (sidebarOpened) await pageCall(tabId, 'sidebar', false).catch(() => {});
    }
  });
}

async function diagnose(p) {
  if (p.target === 'worker') {
    if (workerTabId === null) throw new Error('No ChatGPT job tab is open right now.');
    return { worker: true, ...(await pageCall(workerTabId, 'snapshot', p.selector || null, p.max || 400)) };
  }
  return withHelperTab(p.url || (project && project.url) || HOME, async tabId => {
    await sleep(p.waitMs || 7000);
    const clicks = [];
    for (const label of p.clicks || []) {
      clicks.push({ label, ...(await pageCall(tabId, 'clickLabel', label)) });
      await sleep(2500);
    }
    // Optionally attach files and/or write (never send) a text, to see the composer in that state.
    if (p.attach) {
      clicks.push({ attached: await pageCall(tabId, 'attachFiles', p.attach) });
      await sleep(p.attachWaitMs || 6000);
      clicks.push({ attachments: await pageCall(tabId, 'attachmentState') });
    }
    if (p.type) {
      await pageCall(tabId, 'clearComposer');
      await sleep(300);
      clicks.push({ typed: await pageCall(tabId, 'setPrompt', p.type, 'insertText') });
      await sleep(1500);
      clicks.push({ state: await pageCall(tabId, 'composerState') });
    }
    if (p.editCheck) clicks.push({ editCheck: await pageCall(tabId, 'editCheck', p.editCheck === true ? [] : p.editCheck) });
    const snap = await pageCall(tabId, 'snapshot', p.selector || null, p.max || 400);
    if (p.attach) {
      clicks.push({ removed: await pageCall(tabId, 'removeAttachments').catch(e => String(e)) });
      await sleep(1000);
    }
    if (p.type || p.attach) await pageCall(tabId, 'clearComposer').catch(() => {});
    return { clicks, ...snap };
  });
}

// ---------------------------------------------------------------- toolbar badge + popup

function setBadge() {
  chrome.action.setBadgeText({ text: !hostReady ? '!' : current ? '…' : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: hostReady ? '#7c3aed' : '#d93025' }).catch(() => {});
}

function remember(id, status) {
  const r = recent.find(x => x.id === id);
  if (r) r.status = status;
  else recent.unshift({ id, status, at: Date.now() });
  recent.length = Math.min(recent.length, 5);
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !msg) return;
  if (msg.type === 'popup:status') {
    reply({
      version: VERSION, connected: hostReady, lastError, project, recent,
      current: current ? { id: current.job.id, step: current.step, message: current.message } : null,
      chatgpt: { ...chatgptState, checking: !!chatgptCheck }, home: hostHome,
    });
  } else if (msg.type === 'popup:select') {
    if (!hostReady) { reply({ ok: false, error: i18n.t('errNotConnected') }); return; }
    post({ type: 'set_project', project: msg.project });
    project = msg.project;
    reply({ ok: true });
  }
});

// ---------------------------------------------------------------- setup checklist (popup)

// Whether ChatGPT is signed in, as the last look at a chatgpt.com page showed it: every probe of a
// job or a project list updates it, and the popup can ask for a fresh look. Only the page is looked
// at (login wall, verification page, message box); never cookies, tokens or the session endpoint.
// Kept in chrome.storage.local, so the popup still knows it after a browser restart.
let chatgptState = { loggedIn: null, challenge: null, checkedAt: null };
let chatgptCheck = null;
let hostHome = null; // the user's home folder (from the host): the extension's pages show it as "~"

function noteChatgpt(st) {
  if (!st || !(st.login || st.challenge || st.composer)) return; // still loading
  const next = st.challenge ? { loggedIn: chatgptState.loggedIn, challenge: st.challenge } : { loggedIn: !st.login, challenge: null };
  const changed = next.loggedIn !== chatgptState.loggedIn || next.challenge !== chatgptState.challenge;
  chatgptState = { ...next, checkedAt: Date.now() };
  if (changed) chrome.storage.local.set({ chatgptState }).catch(() => {});
}

// Opens chatgpt.com in a background tab until it shows a login wall, a verification page or the
// message box, then closes it. "Signed in" waits a moment: the "Log in" button can come after the box.
function checkChatgpt() {
  if (!chatgptCheck) {
    chatgptCheck = withHelperTab(HOME, async tabId => {
      const until = Date.now() + 45000;
      let composerSince = 0;
      await sleep(1500);
      while (Date.now() < until) {
        const st = await pageCall(tabId, 'probe', null).catch(() => null);
        if (st && (st.login || st.challenge)) return chatgptState;
        composerSince = st && st.composer ? composerSince || Date.now() : 0;
        if (composerSince && Date.now() - composerSince >= 2500) return chatgptState;
        await sleep(1000);
      }
      throw new Error(i18n.t('errChatgptCheck'));
    }).finally(() => { chatgptCheck = null; });
  }
  return chatgptCheck;
}

// The popup shows these in its own language; anything else as it is.
function setupError(e, fallbackKey) {
  if (e && e.reason === 'needs_human') return i18n.t(chatgptState.challenge ? 'chatgptChallenge' : 'chatgptOut');
  if (e && e.reason === 'not_found' && fallbackKey) return i18n.t(fallbackKey);
  return String((e && e.message) || e);
}

const setupRequests = new Map([
  ['popup:check-chatgpt', async () => ({ chatgpt: await checkChatgpt() })],
  ['popup:projects', async () => {
    try { return { projects: await listProjects() }; } catch (e) { if (e.reason === 'not_found') return { projects: [] }; throw e; }
  }],
  // A project row without a link: open it once to read the link (popup:select then saves it).
  ['popup:resolve-project', async msg => {
    try { return { project: await resolveProject(String(msg.name || '')) }; } catch (e) { throw new Error(setupError(e, 'selectFailed')); }
  }],
  // "Try again" after running install.js: connect now instead of after the back-off.
  ['popup:reconnect', async () => {
    if (!hostReady) {
      reconnectDelay = 2000;
      connect();
      for (let i = 0; i < 20 && port && !hostReady; i++) await sleep(150);
    }
    return { connected: hostReady, lastError };
  }],
]);

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const handler = msg && setupRequests.get(msg.type);
  if (!handler || sender.id !== chrome.runtime.id || !String(sender.url || '').startsWith(chrome.runtime.getURL(''))) return;
  handler(msg).then(r => reply({ ok: true, ...r }), e => reply({ ok: false, error: setupError(e) }));
  return true;
});

chrome.storage.local.get('chatgptState').then(r => {
  if (r.chatgptState && !chatgptState.checkedAt) chatgptState = { ...chatgptState, ...r.chatgptState };
}).catch(() => {});

// ---------------------------------------------------------------- gallery side panel

// What the side panel may ask the host through the worker (the host has its own allow-list too).
const PANEL_HOST_METHODS = new Set(['gallery_list', 'gallery_thumb', 'reveal_image', 'collection_add_job_image', 'list_collections']);

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || sender.id !== chrome.runtime.id || !String(sender.url || '').startsWith(chrome.runtime.getURL(''))) return;
  if (msg.type === 'panel:status') {
    reply({
      connected: hostReady, lastError,
      current: current ? { id: current.job.id, step: current.step, message: current.message, startedAt: current.startedAt } : null,
    });
  } else if (msg.type === 'panel:call') {
    if (!PANEL_HOST_METHODS.has(msg.method)) { reply({ ok: false, error: `Not allowed: ${msg.method}` }); return; }
    callHost(msg.method, msg.params || {}).then(result => reply({ ok: true, result }), e => reply({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
});

// A menu click counts as the user gesture sidePanel.open needs, so nothing is awaited before it.
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== backdrawMenus.GALLERY_ID || !tab || !(tab.windowId >= 0)) return;
  try {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(e => log('warn', 'the side panel did not open', String(e)));
  } catch (e) {
    log('warn', 'the side panel did not open', String(e));
  }
});

// ---------------------------------------------------------------- start

async function closeStaleWorker() {
  const { workerTabId: stale } = await chrome.storage.session.get('workerTabId');
  if (stale !== undefined && stale !== null && !current && workerTabId === null) {
    await chrome.storage.session.remove('workerTabId');
    closeTabQuietly(stale);
  }
}

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.create('bridge-reconnect', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'bridge-reconnect' && !port) connect(); });
setBadge();
connect();
closeStaleWorker().catch(() => {});
