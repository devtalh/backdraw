// Gallery side panel: the job in progress (asked from the service worker every 2 s while the panel is
// visible) and the images Backdraw saved, newest first. An image is named by its job id and number
// only; the host finds the file in its own records, so no path ever goes from here to the host.
const $ = id => document.getElementById(id);
const PAGE = 12;
const MAX_LIST = 100; // lib/gallery.js PAGE_MAX
const POLL_MS = 2000;
const THUMB_PX = 256; // like the thumbnail of a right-click add (collections.js)
const CHAT = /^https:\/\/chatgpt\.com\//i;
const STEPS = {
  queued: 'stepQueued', starting: 'stepStarting', opening: 'stepOpening', attaching: 'stepAttaching', typing: 'stepTyping',
  sending: 'stepSending', generating: 'stepGenerating', verifying: 'stepVerifying', downloading: 'stepDownloading',
  reattaching: 'stepReattaching', animating: 'stepAnimating', needs_human: 'stepNeedsHuman', resuming: 'stepResuming',
};
const ICONS = {
  chat: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  add: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
};

let language = i18n.lang();
const t = (key, vars) => i18n.translate(language, key, vars);
const imageCount = n => t(n === 1 ? 'imageCountOne' : 'imageCount', { count: n });
const keyOf = it => `${it.jobId}:${it.n}`;

let status; // the worker's last answer to panel:status; undefined before the first one
let polling = false;
let lastJobId = null;
let loaded = false;
let items = []; // the gallery entries shown, as the host listed them
let total = 0;
let nextOffset = null;
let generation = 0; // a newer listing makes the answers to older ones stale
const thumbs = new Map(); // key -> promise of a blob: URL (null: no preview)
const animations = new Map(); // key -> promise of a GIF blob: URL (null: unavailable or too large)
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

async function hostCall(method, params = {}) {
  const r = await chrome.runtime.sendMessage({ type: 'panel:call', method, params }).catch(e => ({ ok: false, error: e.message }));
  if (!r || !r.ok) throw new Error((r && r.error) || t('errNotConnected'));
  return r.result;
}

function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

function icon(name) {
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`; // constant markup only
  return tpl.content.firstChild;
}

function iconButton(name, label, onclick) {
  const b = el('button', { type: 'button', className: 'icon-btn', title: label, onclick }, icon(name));
  b.setAttribute('aria-label', label);
  return b;
}

function showMessage(text, bad) {
  $('msg').textContent = text || '';
  $('msg').className = bad ? 'msg bad' : 'msg';
}

// ---------------------------------------------------------------- settings (theme, language)

// The popup stores them when the user picks them: theme 'auto' | 'light' | 'dark', language 'auto' | 'en' | 'tr'.
function applySettings(s) {
  const root = document.documentElement;
  if (s.theme === 'light' || s.theme === 'dark') root.dataset.theme = s.theme;
  else delete root.dataset.theme;
  language = typeof s.language === 'string' && Object.hasOwn(i18n.STRINGS, s.language) ? s.language : i18n.lang();
  root.lang = language;
  for (const e of document.querySelectorAll('[data-i18n]')) e.textContent = t(e.dataset.i18n);
  for (const e of document.querySelectorAll('[data-i18n-title]')) {
    e.title = t(e.dataset.i18nTitle);
    e.setAttribute('aria-label', e.title);
  }
}

async function loadSettings() {
  let s = {};
  try { s = (await chrome.storage.local.get(['theme', 'language'])) || {}; } catch {}
  applySettings(s);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(changes.theme || changes.language)) return;
  loadSettings().then(() => {
    renderNow();
    if (loaded) renderGallery();
  });
});

// ---------------------------------------------------------------- the job in progress

function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = n => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${Math.floor(s / 60)}:${p(s % 60)}`;
}

function renderNow() {
  const job = status && status.current;
  const state = status === undefined ? 'loading' : !status || !status.connected ? 'offline'
    : !job ? 'idle' : job.step === 'needs_human' ? 'human' : 'running';
  let title = '…';
  let meta = '';
  if (state === 'offline') {
    title = t('notConnected');
    meta = t('noHost', { error: status && status.lastError ? ` (${status.lastError})` : '' });
  } else if (state === 'idle') {
    title = t('idle');
  } else if (job) {
    const pct = (String(job.message || '').match(/\((\d{1,3})%\)/) || [])[1];
    title = `${STEPS[job.step] ? t(STEPS[job.step]) : job.message || job.step}${pct ? ` · ${pct}%` : ''}`;
    meta = [job.id, job.startedAt ? t('elapsed', { time: clock(Date.now() - job.startedAt) }) : ''].filter(Boolean).join(' · ');
  }
  $('now').className = `now ${state}`;
  $('nowTitle').textContent = title;
  $('nowTitle').title = (job && job.message) || '';
  $('nowMeta').textContent = meta;
}

// Returns whether it started a new listing.
async function poll() {
  if (document.hidden || polling) return false;
  polling = true;
  let s = null;
  try { s = await chrome.runtime.sendMessage({ type: 'panel:status' }); } catch {}
  polling = false;
  const wasConnected = !!(status && status.connected);
  status = s && typeof s === 'object' ? s : null;
  renderNow();
  const id = status && status.current ? status.current.id : null;
  const ended = lastJobId !== null && id !== lastJobId;
  lastJobId = id;
  // A job that just ended may have saved images; a bridge that just connected can list them now.
  if (status && status.connected && (ended || !wasConnected)) {
    refresh();
    return true;
  }
  if (!loaded && !(status && status.connected)) showMessage(t('errNotConnected'), true);
  return false;
}

// ---------------------------------------------------------------- the gallery

function formatDate(iso) {
  const d = new Date(iso || '');
  if (Number.isNaN(d.getTime())) return '';
  const ui = chrome.i18n.getUILanguage();
  try {
    return d.toLocaleString(ui.toLowerCase().startsWith(language) ? ui : language, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return d.toLocaleString();
  }
}

const listSig = list => list.map(it => `${keyOf(it)}${it.missing ? '!' : ''}`).join();

async function refresh() {
  const gen = ++generation;
  $('refresh').disabled = true;
  try {
    // As many as are shown, which "Load more" can take past one listing's MAX_LIST: page by page.
    const want = Math.max(PAGE, items.length);
    let list = [];
    let page = { next: 0 };
    while (page.next !== null && list.length < want) {
      page = await hostCall('gallery_list', { offset: page.next, limit: Math.min(MAX_LIST, want - list.length) });
      if (gen !== generation) return;
      const seen = new Set(list.map(keyOf)); // a job that finished in between shifts the offsets
      list = list.concat(page.items.filter(it => !seen.has(keyOf(it))));
    }
    const changed = !loaded || listSig(list) !== listSig(items);
    items = list;
    total = page.total;
    nextOffset = page.next;
    loaded = true;
    // An unchanged list keeps its cards (and an open "Add to collection").
    if (changed) renderGallery(); else renderFooter();
  } catch (e) {
    if (gen === generation) showMessage(e.message, true);
  } finally {
    if (gen === generation) $('refresh').disabled = false;
  }
}

async function loadMore() {
  const gen = generation;
  $('more').disabled = true;
  try {
    const page = await hostCall('gallery_list', { offset: nextOffset, limit: PAGE });
    if (gen !== generation) return;
    const seen = new Set(items.map(keyOf)); // a job that finished meanwhile shifts the offsets
    const fresh = page.items.filter(it => !seen.has(keyOf(it)));
    items = items.concat(fresh);
    total = page.total;
    nextOffset = page.next;
    $('grid').append(...fresh.map(card));
    renderFooter();
  } catch (e) {
    showMessage(e.message, true);
  } finally {
    $('more').disabled = false;
  }
}

function renderGallery() {
  $('grid').replaceChildren(...items.map(card));
  renderFooter();
}

function renderFooter() {
  $('count').textContent = total ? imageCount(total) : '';
  $('more').hidden = nextOffset === null;
  showMessage(total ? '' : t('galleryEmpty'));
}

function card(it) {
  const box = el('article', { className: it.missing ? 'card missing' : 'card' });
  const pic = el('div', { className: 'thumb', title: String(it.path || '').split(/[\\/]/).pop() });
  if (it.width > 0 && it.height > 0) pic.style.aspectRatio = String(Math.min(2, Math.max(0.5, it.width / it.height)));
  showThumb(it, pic);
  const note = el('p', { className: 'note' });
  const say = (text, kind) => {
    note.textContent = text || '';
    note.className = kind ? `note ${kind}` : 'note';
  };
  const meta = el('div', { className: 'meta' }, el('time', { dateTime: it.createdAt || '', textContent: formatDate(it.createdAt) }));
  if (it.width && it.height) meta.append(el('span', { textContent: `${it.width}×${it.height}` }));
  if (it.format) {
    let text = it.format;
    let title = '';
    if (it.format === 'GIF' && it.frames) {
      text += ` · ${it.frames}f`;
      const seconds = it.durationMs > 0 ? (it.durationMs / 1000).toFixed(1) : '0.0';
      if (Number(seconds) > 0) {
        text += ` · ${seconds}s`;
        title = t('gifDetails', { frames: it.frames, seconds: language === 'tr' ? seconds.replace('.', ',') : seconds });
      } else {
        title = t('gifFrames', { frames: it.frames });
      }
    }
    meta.append(el('span', { className: 'pill', textContent: text, title }));
  }
  if (it.aspect) meta.append(el('span', { className: 'pill', textContent: it.aspect }));

  const hasChat = CHAT.test(it.conversationUrl || '');
  const chat = iconButton('chat', t(hasChat ? 'openChat' : 'noChatLink'), () => chrome.tabs.create({ url: it.conversationUrl }));
  chat.disabled = !hasChat;
  const reveal = iconButton('folder', t('showInFolder'), async () => {
    reveal.disabled = true;
    try {
      await hostCall('reveal_image', { jobId: it.jobId, n: it.n });
      say('');
    } catch (e) {
      say(e.message, 'bad');
    }
    reveal.disabled = false;
  });
  const copy = iconButton('copy', t('copyPath'), async () => {
    if (await copyText(it.path)) say(t('pathCopied'), 'ok');
    else say(t('copyFailed'), 'bad');
  });
  const adder = el('div', { className: 'adder', hidden: true });
  const toggle = () => {
    const open = adder.hidden;
    adder.hidden = !open;
    box.classList.toggle('open', open);
    add.classList.toggle('on', open);
    if (open) fillAdder(it, adder, say, () => pic.querySelector('img'), () => { if (!adder.hidden) toggle(); });
  };
  const add = iconButton('add', t('addToCollection'), toggle);
  if (it.missing) {
    reveal.disabled = add.disabled = true;
    say(t('fileMissing'), 'warn');
  }
  const prompt = el('p', { className: it.prompt ? 'prompt' : 'prompt none', textContent: it.prompt || t('galleryFetched'), title: it.prompt || '' });
  box.append(pic, el('div', { className: 'body' }, prompt, meta, el('div', { className: 'actions' }, chat, reveal, copy, add), adder, note));
  return box;
}

// ---------------------------------------------------------------- thumbnails

let thumbsBusy = 0;
const thumbsWaiting = [];

// At most two previews on their way at a time (each can be over half a megabyte).
function limited(fn, still) {
  return new Promise(resolve => {
    const go = () => {
      thumbsBusy++;
      const result = still && !still() ? Promise.resolve(undefined) : fn();
      result.then(resolve, () => resolve(undefined)).finally(() => {
        thumbsBusy--;
        if (thumbsWaiting.length) thumbsWaiting.shift()();
      });
    };
    if (thumbsBusy < 2) go(); else thumbsWaiting.push(go);
  });
}

function b64Blob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

// null: the image has no preview (any more). A preview that could not be asked for (undefined) is
// asked for again with the next listing.
function previewOf(it) {
  if (!it.preview) return Promise.resolve(null);
  const key = keyOf(it);
  if (!thumbs.has(key)) {
    const p = limited(async () => {
      const r = await hostCall('gallery_thumb', { jobId: it.jobId, n: it.n });
      return r && r.data ? URL.createObjectURL(b64Blob(r.data, r.mime || 'image/jpeg')) : null;
    });
    thumbs.set(key, p);
    p.then(url => { if (url === undefined) thumbs.delete(key); });
  }
  return thumbs.get(key);
}

// null: the saved file is not a small GIF. A failed host call (undefined) is retried next hover.
function animationOf(it, still) {
  const key = keyOf(it);
  if (!animations.has(key)) {
    const p = limited(async () => {
      const r = await hostCall('gallery_animation', { jobId: it.jobId, n: it.n });
      return r && r.data ? URL.createObjectURL(b64Blob(r.data, 'image/gif')) : null;
    }, still);
    animations.set(key, p);
    p.then(url => { if (url === undefined) animations.delete(key); });
  }
  return animations.get(key);
}

function showThumb(it, pic) {
  let hovering = false;
  let animationShown = false;
  let previewReady = false;
  let previewUrl = null;
  const showImage = url => pic.replaceChildren(el('img', { src: url, alt: '', decoding: 'async' }));
  const showPreview = () => pic.replaceChildren(previewUrl ? el('img', { src: previewUrl, alt: '', decoding: 'async' })
    : el('span', { className: 'ph', textContent: t('noThumb') }));
  pic.classList.add('loading');
  previewOf(it).then(url => {
    previewReady = true;
    previewUrl = url;
    pic.classList.remove('loading');
    if (!animationShown) showPreview();
  });
  if (it.format === 'GIF' && !it.missing && !reducedMotion) {
    pic.addEventListener('mouseenter', async () => {
      hovering = true;
      const url = await animationOf(it, () => hovering);
      if (!hovering) return;
      if (url) {
        animationShown = true;
        showImage(url);
      } else if (previewReady) showPreview();
    });
    pic.addEventListener('mouseleave', () => {
      hovering = false;
      animationShown = false;
      if (previewReady) showPreview();
    });
  }
}

// The card's preview as an image: the one shown, or the same preview once it has arrived (they load
// two at a time, so Add can come first).
async function previewImage(it, shown) {
  const url = await previewOf(it);
  if (!url) return null;
  if (shown && shown.naturalWidth && shown.src === url) return shown;
  const img = new Image();
  img.src = url;
  return img.decode().then(() => img, () => null);
}

// A small JPEG of the preview, as a right-click add makes one; the host checks it like those.
function smallJpeg(img) {
  if (!img || !img.naturalWidth) return undefined;
  const scale = Math.min(1, THUMB_PX / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = el('canvas', { width: Math.max(1, Math.round(img.naturalWidth * scale)), height: Math.max(1, Math.round(img.naturalHeight * scale)) });
  try {
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- actions

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  const area = el('textarea', { value: text });
  area.style.cssText = 'position:fixed;top:-200px;opacity:0';
  document.body.append(area);
  area.select();
  try { return document.execCommand('copy'); } catch { return false; } finally { area.remove(); }
}

// The collections, and "New collection…", which asks for the name in place. The host copies the image
// file itself; only the job id and number go to it.
async function fillAdder(it, box, say, picture, close) {
  box.replaceChildren(el('p', { className: 'note', textContent: t('loading') }));
  let list;
  try {
    list = await hostCall('list_collections', { summary: true });
  } catch (e) {
    box.replaceChildren();
    say(e.message, 'bad');
    return;
  }
  const controls = on => { for (const c of box.querySelectorAll('button, input')) c.disabled = !on; };
  const addTo = async (name, create) => {
    controls(false);
    say(t('saving'));
    try {
      const thumb = smallJpeg(await previewImage(it, picture()));
      const r = await hostCall('collection_add_job_image', { collection: name, create, jobId: it.jobId, n: it.n, thumb });
      say(t(r.duplicate ? 'toastDuplicate' : 'toastAdded', { name: r.name, images: imageCount(r.count) }), 'ok');
      close();
    } catch (e) {
      controls(true);
      say(e.message, 'bad');
    }
  };
  const fresh = el('button', { type: 'button', className: 'col new', textContent: t('newCollectionItem') });
  fresh.onclick = () => {
    const form = nameForm(list, say, name => addTo(name, true), close);
    fresh.replaceWith(form);
    form.querySelector('input').focus();
  };
  const rows = list.map(c => el('button', { type: 'button', className: 'col', onclick: () => addTo(c.name, false) },
    el('span', { textContent: c.name }), el('span', { textContent: imageCount(c.count) })));
  box.replaceChildren(...(rows.length ? [el('div', { className: 'list' }, ...rows)] : []), fresh);
  say('');
}

function nameForm(list, say, submit, close) {
  const input = el('input', { placeholder: t('namePlaceholder'), autocomplete: 'off', spellcheck: false });
  input.setAttribute('aria-label', t('nameLabel'));
  const form = el('form', {}, input, el('button', { type: 'submit', className: 'btn primary', textContent: t('add') }),
    el('button', { type: 'button', className: 'btn', textContent: t('cancel'), onclick: close }));
  const tidy = () => input.value.replace(/\s+/g, ' ').trim();
  input.oninput = () => {
    const wanted = tidy().toLowerCase();
    say(wanted && list.some(c => c.name.toLowerCase() === wanted) ? t('nameExists') : '');
  };
  input.onkeydown = e => { if (e.key === 'Escape') close(); };
  form.onsubmit = e => {
    e.preventDefault();
    const name = tidy();
    if (!name || Array.from(name).length > 64) say(t('nameInvalid'), 'bad');
    else submit(name);
  };
  return form;
}

// ---------------------------------------------------------------- start

$('refresh').append(icon('refresh'));
$('refresh').onclick = () => refresh();
$('more').onclick = loadMore;
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) poll().then(started => { if (!started && loaded) refresh(); });
});
setInterval(poll, POLL_MS);
setInterval(() => { if (!document.hidden && status && status.current) renderNow(); }, 1000);
showMessage(t('loading'));
loadSettings().then(() => {
  showMessage(t('loading'));
  renderNow();
  poll();
});
