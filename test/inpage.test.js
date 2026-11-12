'use strict';
// Exercise the page helpers without a browser or DOM implementation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { rgbaPng, decodePng } = require('./png-fixture');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'inpage.js'), 'utf8');

function loadPage() {
  const sandbox = {};
  for (const name of ['document', 'location']) {
    Object.defineProperty(sandbox, name, { get() { assert.fail(`inpage.js accessed ${name}`); } });
  }
  vm.runInNewContext(source, sandbox, { filename: 'inpage.js' });
  return sandbox.__cgb;
}

function signatureCanvasClass() {
  const parseColor = value => {
    const match = /^#([0-9a-f]{6})$/i.exec(value);
    if (!match) throw new Error(`Unsupported fill color ${value}`);
    const n = Number.parseInt(match[1], 16);
    return [n >> 16, (n >> 8) & 0xff, n & 0xff, 255];
  };
  return class SignatureCanvas {
    constructor() {
      this._width = 300;
      this._height = 150;
      this.data = new Uint8ClampedArray(this._width * this._height * 4);
    }
    get width() { return this._width; }
    set width(value) { this._width = value; this.data = new Uint8ClampedArray(this._width * this._height * 4); }
    get height() { return this._height; }
    set height(value) { this._height = value; this.data = new Uint8ClampedArray(this._width * this._height * 4); }
    getContext() {
      const canvas = this;
      const composite = (x, y, rgba) => {
        if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
        const i = (y * canvas.width + x) * 4;
        const sa = rgba[3] / 255;
        const da = canvas.data[i + 3] / 255;
        const outA = sa + da * (1 - sa);
        for (let channel = 0; channel < 3; channel++) {
          canvas.data[i + channel] = outA
            ? Math.round((rgba[channel] * sa + canvas.data[i + channel] * da * (1 - sa)) / outA)
            : 0;
        }
        canvas.data[i + 3] = Math.round(outA * 255);
        if (canvas.data[i + 3] === 0) canvas.data.fill(0, i, i + 4);
      };
      const sampleBox = (source, x0, y0, x1, y1) => {
        let alpha = 0;
        const premultiplied = [0, 0, 0];
        let area = 0;
        for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
          const yWeight = Math.max(0, Math.min(y1, y + 1) - Math.max(y0, y));
          for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
            const weight = yWeight * Math.max(0, Math.min(x1, x + 1) - Math.max(x0, x));
            if (!weight || x < 0 || y < 0 || x >= source.width || y >= source.height) continue;
            const i = (y * source.width + x) * 4;
            const a = source.data[i + 3] / 255;
            alpha += a * weight;
            for (let channel = 0; channel < 3; channel++) premultiplied[channel] += source.data[i + channel] * a * weight;
            area += weight;
          }
        }
        return [
          alpha ? premultiplied[0] / alpha : 0,
          alpha ? premultiplied[1] / alpha : 0,
          alpha ? premultiplied[2] / alpha : 0,
          area ? (alpha / area) * 255 : 0,
        ];
      };
      return {
        fillStyle: '#000000',
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'low',
        fillRect(x, y, width, height) {
          const rgba = parseColor(this.fillStyle);
          for (let py = y; py < y + height; py++) for (let px = x; px < x + width; px++) composite(px, py, rgba);
        },
        drawImage(source, ...args) {
          let sx = 0;
          let sy = 0;
          let sw = source.width;
          let sh = source.height;
          let dx;
          let dy;
          let dw;
          let dh;
          if (args.length === 2) [dx, dy, dw, dh] = [args[0], args[1], sw, sh];
          else if (args.length === 4) [dx, dy, dw, dh] = args;
          else if (args.length === 8) [sx, sy, sw, sh, dx, dy, dw, dh] = args;
          else throw new Error(`Unsupported drawImage argument count ${args.length + 1}`);
          for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
            const x0 = sx + (x * sw) / dw;
            const y0 = sy + (y * sh) / dh;
            composite(dx + x, dy + y, sampleBox(source, x0, y0, sx + ((x + 1) * sw) / dw, sy + ((y + 1) * sh) / dh));
          }
        },
        getImageData(x, y, width, height) {
          const data = new Uint8ClampedArray(width * height * 4);
          for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
            const src = ((y + py) * canvas.width + x + px) * 4;
            data.set(canvas.data.subarray(src, src + 4), (py * width + px) * 4);
          }
          return { width, height, data };
        },
      };
    }
  };
}

function loadSignaturePage(Canvas = signatureCanvasClass()) {
  const sandbox = {
    atob, Blob, Uint8Array,
    HTMLImageElement: class HTMLImageElement {},
    document: { createElement(name) { if (name !== 'canvas') throw new Error(`Unexpected element ${name}`); return new Canvas(); } },
    createImageBitmap: async blob => {
      const decoded = decodePng(Buffer.from(await blob.arrayBuffer()));
      return { ...decoded, close() {} };
    },
  };
  vm.runInNewContext(source, sandbox, { filename: 'inpage.js' });
  return sandbox.__cgb;
}

function recordingSignatureCanvasClass(calls) {
  const Canvas = signatureCanvasClass();
  return class RecordingSignatureCanvas extends Canvas {
    getContext(...args) {
      const context = super.getContext(...args);
      const fillRect = context.fillRect;
      const drawImage = context.drawImage;
      context.fillRect = function (...rect) {
        calls.push(['fillRect', this.fillStyle, ...rect]);
        return fillRect.apply(this, rect);
      };
      context.drawImage = function (bitmap, ...rect) {
        calls.push(['drawImage', ...rect]);
        return drawImage.call(this, bitmap, ...rect);
      };
      return context;
    }
  };
}

function legacySquareSignature(bitmap) {
  const Canvas = signatureCanvasClass();
  const canvas = new Canvas();
  canvas.width = 32;
  canvas.height = 32;
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, 0, 0, 32, 32);
  const data = context.getImageData(0, 0, 32, 32).data;
  const gray = new Array(1024);
  for (let i = 0; i < 1024; i++) gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  return gray;
}

function imageSource(width, height, pixels) {
  return { data: rgbaPng(width, height, pixels).toString('base64'), mime: 'image/png' };
}

function element(text, options = {}) {
  return { className: '', childElementCount: 0, closest() { return null; }, matches() { return false; }, textContent: text, innerText: text, ...options };
}

const CHAT_ID = '12345678-abcd-1234-abcd-123456789abc';

// A small tree for cleanup selectors. Unknown selectors match nothing, like an absent composer.
function cleanupElement(tag, text = '', attrs = {}, children = []) {
  const node = element(text, {
    tagName: tag.toUpperCase(), attrs, children, clicks: 0, events: [],
    getAttribute(name) { return this.attrs[name] ?? null; },
    getBoundingClientRect() { return { width: this.hidden ? 0 : 100, height: 30 }; },
    dispatchEvent(event) { this.events.push(event); },
    click() { this.clicks++; },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) {
      const all = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
      if (selector === '*') return all;
      return all.filter(child => selector.split(',').some(part => {
        const sel = part.trim();
        if (sel === 'header button[aria-haspopup="menu"]') {
          return child.tagName === 'BUTTON' && child.attrs['aria-haspopup'] === 'menu' && child.inHeader;
        }
        const contains = sel.match(/^\[([\w-]+)\*="([^"]*)" i\]$/);
        if (contains) return (child.attrs[contains[1]] || '').toLowerCase().includes(contains[2].toLowerCase());
        const present = sel.match(/^\[([\w-]+)\]$/);
        if (present) return child.attrs[present[1]] !== undefined;
        const match = sel.match(/^([a-z][a-z0-9]*)?(?:\[([\w-]+)="([^"]*)"\])?$/i);
        return !!match && (!match[1] || child.tagName === match[1].toUpperCase()) &&
          (!match[2] || child.attrs[match[2]] === match[3]);
      }));
    },
  });
  if (tag === 'header') {
    const mark = el => { el.inHeader = true; el.children.forEach(mark); };
    children.forEach(mark);
  }
  return node;
}

function loadCleanupPage({ path = `/c/${CHAT_ID}`, hostname = 'chatgpt.com', lang = 'en-US', title = 'Example chat', children = [] } = {}) {
  const document = cleanupElement('document', '', {}, children);
  Object.assign(document, { title, documentElement: { lang }, body: cleanupElement('body'),
    getElementById(id) { return this.querySelectorAll('*').find(el => el.attrs.id === id) || null; } });
  const sandbox = { document, location: { hostname, pathname: path },
    PointerEvent: class { constructor(type, init) { Object.assign(this, { type }, init); } },
    KeyboardEvent: class { constructor(type, init) { Object.assign(this, { type }, init); } } };
  vm.runInNewContext(source, sandbox, { filename: 'inpage.js' });
  return { page: sandbox.__cgb, document };
}

test('chatPageState accepts only exact conversation UUID paths and reports language', () => {
  for (const path of [`/c/${CHAT_ID}`, `/g/g-p-abc123/c/${CHAT_ID}/`, `/g/g-p-abc123-my-project/c/${CHAT_ID.toUpperCase()}`]) {
    const { page } = loadCleanupPage({ path, lang: 'en-GB' });
    assert.equal(page.chatPageState(CHAT_ID).onChat, true, path);
    assert.equal(page.chatPageState(CHAT_ID).lang, 'en-GB');
  }
  for (const path of [`/c/${CHAT_ID.replace(/^1/, '2')}`, `/c/0${CHAT_ID}`, `/c/${CHAT_ID}0`, `/share/${CHAT_ID}`]) {
    assert.equal(loadCleanupPage({ path }).page.chatPageState(CHAT_ID).onChat, false, path);
  }
  assert.equal(loadCleanupPage({ hostname: 'example.com' }).page.chatPageState(CHAT_ID).onChat, false);
});

const GONE_NOTICE = "You don't have access to this conversation. Make sure you're logged in to the right account, or ask the conversation owner to send you a share link.";

test('chatPageState reports a chat ChatGPT already lost: home page redirect plus the visible access notice', () => {
  const alert = (text = GONE_NOTICE, attrs = { role: 'alert' }) => cleanupElement('div', text, attrs);
  const gone = (children, options = {}) => loadCleanupPage({ path: '/', children, ...options }).page.chatPageState(CHAT_ID);
  assert.equal(gone([alert()]).gone, true);
  assert.equal(gone([alert()]).onChat, false);
  assert.equal(gone([alert(GONE_NOTICE.replace("don't", 'don\u2019t'))]).gone, true);
  assert.equal(gone([alert(GONE_NOTICE.toUpperCase())]).gone, true);
  assert.equal(gone([alert(' You  don\'t have\naccess to this conversation. ')]).gone, true);
  assert.equal(gone([alert(GONE_NOTICE, { 'data-testid': 'Toast-Item' })]).gone, true);
  assert.equal(gone([alert(GONE_NOTICE, { role: 'status' })]).gone, true);
  assert.equal(gone([alert(GONE_NOTICE, { role: 'dialog' })]).gone, true);
  assert.equal(gone([alert(GONE_NOTICE, { 'aria-live': 'polite' })]).gone, true);
  assert.equal(gone([cleanupElement('div', GONE_NOTICE, { 'data-testid': 'toast' }, [cleanupElement('span', 'x')])]).gone, true);
});

test('chatPageState does not report gone without both the home page and a visible access notice', () => {
  const alert = (text = GONE_NOTICE, attrs = { role: 'alert' }) => cleanupElement('div', text, attrs);
  const state = (children, options = {}) => loadCleanupPage({ children, ...options }).page.chatPageState(CHAT_ID);
  // The same notice on a conversation page is not a redirect.
  const onChat = state([alert()]);
  assert.equal(onChat.onChat, true);
  assert.equal(onChat.gone, false);
  assert.equal(state([alert()], { path: `/c/${CHAT_ID.replace(/^1/, '2')}` }).gone, false);
  assert.equal(state([alert()], { path: '/c' }).gone, false);
  assert.equal(state([alert()], { path: '/share/abc' }).gone, false);
  assert.equal(state([alert()], { path: '/', hostname: 'example.com' }).gone, false);
  // The home page without the notice, or with another notice, is an ordinary unexpected page.
  assert.equal(state([], { path: '/' }).gone, false);
  assert.equal(state([alert('Something went wrong. Please try again.')], { path: '/' }).gone, false);
  assert.equal(state([alert('Error: ' + GONE_NOTICE)], { path: '/' }).gone, false);
  assert.equal(state([alert('You do not have access to this conversation.')], { path: '/' }).gone, false);
  // A hidden notice is stale markup, not something the page is showing.
  const hidden = alert();
  hidden.hidden = true;
  assert.equal(state([hidden], { path: '/' }).gone, false);
  // Elements that are not alert-like regions never match, and a huge region does not match by its start alone.
  assert.equal(state([alert(GONE_NOTICE, {})], { path: '/' }).gone, false);
  assert.equal(state([alert(GONE_NOTICE + ' ' + 'x'.repeat(400))], { path: '/' }).gone, false);
  assert.equal(state([alert((GONE_NOTICE + ' ').padEnd(400, 'x'))], { path: '/' }).gone, true);
  assert.equal(state([alert((GONE_NOTICE + ' ').padEnd(401, 'x'))], { path: '/' }).gone, false);
});

test('openChatMenu selects the header title, excludes the model switcher and rejects ambiguity', () => {
  const model = cleanupElement('button', 'Example chat', { 'aria-haspopup': 'menu', 'data-testid': 'model-switcher-dropdown-button' });
  const title = cleanupElement('button', ' Example  chat ', { 'aria-haspopup': 'menu' });
  const other = cleanupElement('button', 'Other menu', { 'aria-haspopup': 'menu' });
  const header = cleanupElement('header', '', {}, [model, title, other]);
  const { page } = loadCleanupPage({ children: [header] });
  assert.equal(page.openChatMenu(CHAT_ID).ok, true);
  assert.equal(title.clicks, 1);
  assert.equal(model.clicks + other.clicks, 0);
  assert.equal(page.chatPageState(CHAT_ID).title, 'Example chat');
  assert.equal(page.openChatMenu('other').error, 'wrong_page');
  const ambiguous = loadCleanupPage({ title: 'Unknown', children: [header] });
  assert.equal(ambiguous.page.openChatMenu(CHAT_ID).error, 'menu_trigger_not_found');
  assert.equal(title.clicks, 1);
  assert.equal(other.clicks, 0);
});

test('chat menu clicks use exact labels inside visible menus only', () => {
  const outside = cleanupElement('div', 'Archive', { role: 'menuitem' });
  const unarchive = cleanupElement('div', 'Unarchive', { role: 'menuitem' });
  const menu = cleanupElement('div', '', { role: 'menu' }, [unarchive]);
  const trigger = cleanupElement('button', 'Example chat', { 'aria-haspopup': 'menu', 'aria-expanded': 'true' });
  const { page, document } = loadCleanupPage({ children: [cleanupElement('header', '', {}, [trigger]), outside, menu] });
  assert.equal(page.clickChatMenuItem('Archive').error, 'item_not_found');
  assert.equal(outside.clicks + unarchive.clicks, 0);
  const archive = cleanupElement('div', '  ARCHIVE  ', { role: 'menuitem' });
  menu.children.push(archive);
  assert.equal(page.clickChatMenuItem('Archive').clicked, true);
  assert.equal(archive.clicks, 1);
  menu.children.push(cleanupElement('div', 'Archive', { role: 'menuitem' }));
  assert.equal(page.clickChatMenuItem('Archive').error, 'item_ambiguous');
  menu.hidden = true;
  assert.equal(page.chatMenuItems().length, 0);
  page.closeChatMenu();
  assert.equal(document.body.events[0].key, 'Escape');
});

test('chat menu stays bound to the open title trigger and validates the expected title', () => {
  const archiveA = cleanupElement('div', 'Archive', { role: 'menuitem' });
  const archiveB = cleanupElement('div', 'Archive', { role: 'menuitem' });
  const menuA = cleanupElement('div', '', { role: 'menu', id: 'menu-a' }, [archiveA]);
  const menuB = cleanupElement('div', '', { role: 'menu', id: 'menu-b' }, [archiveB]);
  const trigger = cleanupElement('button', 'Example chat', {
    'aria-haspopup': 'menu', 'aria-expanded': 'true', 'aria-controls': 'menu-a',
  });
  const { page } = loadCleanupPage({ children: [cleanupElement('header', '', {}, [trigger]), menuA, menuB] });
  assert.deepEqual(Array.from(page.chatMenuItems()), ['Archive']);
  assert.equal(page.clickChatMenuItem('Archive', ' example   CHAT ').clicked, true);
  assert.equal(archiveA.clicks, 1);
  assert.equal(archiveB.clicks, 0);
  assert.equal(page.clickChatMenuItem('Archive', 'Other chat').error, 'title_mismatch');
  assert.equal(archiveA.clicks, 1);
  delete trigger.attrs['aria-controls'];
  assert.equal(page.chatMenuItems().length, 0);
  assert.equal(page.clickChatMenuItem('Archive').error, 'menu_unexpected');
  trigger.attrs['aria-controls'] = 'menu-a';
  trigger.attrs['aria-expanded'] = 'false';
  assert.equal(page.chatMenuItems().length, 0);
  assert.equal(page.clickChatMenuItem('Archive').error, 'menu_unexpected');
  trigger.attrs['data-state'] = 'open';
  menuA.hidden = true;
  assert.equal(page.clickChatMenuItem('Archive').error, 'menu_unexpected');
  menuA.hidden = false;
  menuA.attrs.role = 'dialog';
  assert.equal(page.clickChatMenuItem('Archive').error, 'menu_unexpected');
  assert.equal(archiveA.clicks, 1);
  assert.equal(archiveB.clicks, 0);
});

test('delete confirmation validates the exact title and cancels missing or ambiguous confirmations', () => {
  for (const apostrophe of ["'", '’']) {
    const cancel = cleanupElement('button', 'Cancel');
    const confirm = cleanupElement('button', 'Delete chat');
    const heading = cleanupElement('h2', 'Delete chat?');
    const dialog = cleanupElement('div', `Delete chat?\nThis will permanently delete Example chat. This can${apostrophe}t be undone.`,
      { role: 'dialog' }, [heading, cancel, confirm]);
    const { page } = loadCleanupPage({ children: [dialog] });
    assert.equal(page.deleteDialogState().title, 'Example chat');
    assert.equal(page.confirmDeleteChat('Other chat').error, 'title_mismatch');
    assert.equal(cancel.clicks, 1);
    assert.equal(confirm.clicks, 0);
    assert.equal(page.confirmDeleteChat(' example   CHAT ').ok, true);
    assert.equal(confirm.clicks, 1);
    dialog.children.push(cleanupElement('button', 'Delete chat'));
    assert.equal(page.confirmDeleteChat('Example chat').error, 'confirm_button_not_found');
    assert.equal(cancel.clicks, 2);
    dialog.innerText = 'Delete chat?';
    assert.equal(page.confirmDeleteChat('Example chat').error, 'title_mismatch');
    assert.equal(confirm.clicks, 1);
  }
});

test('delete dialog requires one exact heading, including aria-labelledby or the first line', () => {
  for (const kind of ['labelled', 'first-line']) {
    const label = cleanupElement('span', 'Delete chat?', { id: 'dialog-title' });
    const dialog = cleanupElement('div', kind === 'first-line' ? 'Delete chat?\nBody' : 'Body',
      { role: 'dialog', ...(kind === 'labelled' ? { 'aria-labelledby': 'dialog-title' } : {}) });
    const { page, document } = loadCleanupPage({ children: [label, dialog] });
    assert.equal(page.deleteDialogState().found, true);
    document.children.push(cleanupElement('div', 'Delete chat?\nBody', { role: 'dialog' }));
    assert.equal(page.confirmDeleteChat('Example chat').error, 'dialog_not_found');
  }
});

test('inpage loads without accessing the DOM or location', () => {
  const page = loadPage();
  assert.equal(page.version, '2.0.0');
  assert.equal(typeof page.replyText, 'function');
  assert.equal(typeof page.busyIn, 'function');
});

test('busyIn: file names and non-status text are not busy', () => {
  const { busyIn } = loadPage();
  assert.equal(busyIn([
    element('koi_flat_logo_preview.png'),
    element('Open preview of koi_flat_logo.svg'),
    element('Download file'),
  ]), false);
  for (const text of [
    'thinking_notes.txt',
    'sketch.svg',
    'eskiz_taslak.png',
    'önizleme.gif',
    'My sketchbook',
    'Previewing options',
    'görsel_önizleme.png',
    'image_preview.svg',
    'Preview.png',
    'Creating imagery',
  ]) assert.equal(busyIn([element(text)]), false, text);
});

test('busyIn: English and Turkish progress labels remain busy', () => {
  const { busyIn } = loadPage();
  for (const text of [
    'Creating image',
    'Generating image…',
    'Image is being generated',
    'Thinking',
    'Thinking…',
    'Sketching it out',
    'Setting the scene',
    'Finishing up',
    'Preview',
    'Düşünüyor',
    'Eskiz çiziliyor',
    'Eskiz çiziliyor %41',
    'Son rötuşlar yapılıyor',
    'Görsel oluşturuluyor',
    'Önizleme',
    'önizleme',
    'Creating images',
    'Generating images…',
    'Görsel önizleme',
    'Görsel önizleme %47',
    'Image preview',
    '✨ Thinking',
    '⏳ Düşünüyor',
    '  Thinking',
    'THINKING',
    'Thinking '.padEnd(79, 'x'),
  ]) assert.equal(busyIn([element(text)]), true, text);
});

test('busyIn: markdown, child and length guards remain while busy selectors win', () => {
  const { busyIn } = loadPage();
  assert.equal(busyIn([element('Thinking', { closest: selector => selector.includes('markdown') ? {} : null })]), false);
  assert.equal(busyIn([element('Thinking', { childElementCount: 1 })]), false);
  assert.equal(busyIn([element('Thinking '.padEnd(80, 'x'))]), false);
  assert.equal(busyIn([element('Not a text status', { matches: selector => selector.includes('[aria-busy="true"]') })]), true);
});

test('replyText: a feedback survey alone leaves no assistant text', () => {
  const { replyText } = loadPage();
  for (const text of [
    'Is this conversation helpful so far?',
    'IS THIS CONVERSATION HELPFUL SO FAR',
    '  Is this conversation\n helpful so far?  Yes No  ',
  ]) assert.equal(replyText([element(text)]), '', text);
});

test('replyText: a survey alongside a real leaf keeps only the real text', () => {
  const { replyText } = loadPage();
  assert.equal(replyText([
    element('Is this conversation helpful so far?'),
    element('Here is your animation.'),
  ]), 'Here is your animation.');
});

test('replyText: markdown takes precedence and survey text inside markdown is preserved', () => {
  const { replyText } = loadPage();
  for (const className of ['MarkdownRoot', 'markdown']) {
    for (const text of ['Here is your animation.\nIs this conversation helpful so far?', 'Is this conversation helpful so far?']) {
      assert.equal(replyText([
        element(text, { className, childElementCount: 1 }),
        element('Is this conversation helpful so far?'),
        element('Other leaf text'),
      ]), text);
    }
  }
});

test('replyText: normal helpfulness statements and survey mentions remain assistant text', () => {
  const { replyText } = loadPage();
  for (const text of [
    'This sketch is helpful for planning.',
    'This image is helpful for choosing colors.',
    'The survey asks: Is this conversation helpful so far?',
    'Is this conversation helpful so farther along?',
    'Bu sohbet yararlıdır.',
  ]) assert.equal(replyText([element(text)]), text);
});

test('replyText: a survey prefix is filtered only below 80 squashed characters', () => {
  const { replyText } = loadPage();
  const prefix = 'Is this conversation helpful so far? ';
  assert.equal(replyText([element(prefix.padEnd(79, 'x'))]), '');
  const longText = prefix.padEnd(80, 'x');
  assert.equal(replyText([element(longText)]), longText);
});

test('replyText: plausible Turkish survey labels are excluded', () => {
  const { replyText } = loadPage();
  for (const text of [
    'Bu sohbet şu ana kadar faydalı mı?',
    'Bu konuşma şimdiye kadar yararlı mı?',
    'Bu sohbet işe yarar mı?',
    'Bu konuşma faydalı',
  ]) assert.equal(replyText([element(text)]), '', text);
});

test('replyText: existing leaf exclusions and failure reporting are preserved', () => {
  const { replyText } = loadPage();
  assert.equal(replyText([
    element('Container text', { childElementCount: 1 }),
    element('Button text', { closest: selector => selector.includes('button') ? {} : null }),
    element('Image generation failed Try again', {
      closest: selector => selector.includes('[role="status"]') ? {} : null,
    }),
  ]), 'Image generation failed');
});

function squareReferencePixels(flattened = false) {
  const pixels = new Uint8ClampedArray(64 * 64 * 4);
  if (flattened) {
    for (let i = 0; i < pixels.length; i += 4) pixels.set([255, 255, 255, 255], i);
  }
  for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) pixels.set([200, 40, 40, 255], (y * 64 + x) * 4);
  return pixels;
}

test('signature: a transparent reference stays similar to the same image flattened on white', async () => {
  const { signature, similarity } = loadSignaturePage();
  const reference = imageSource(64, 64, squareReferencePixels());
  const flattened = imageSource(64, 64, squareReferencePixels(true));
  const score = similarity(await signature(reference), await signature(flattened));
  assert.ok(score >= 0.9, `expected similarity >= 0.9, got ${score}`);
});

test('signature: a square transparent reference has nonzero similarity to the wider 478x356 output from the bug report', async () => {
  const { signature, similarity } = loadSignaturePage();
  const wide = new Uint8ClampedArray(478 * 356 * 4);
  for (let i = 0; i < wide.length; i += 4) wide.set([255, 255, 255, 255], i);
  const startX = Math.floor((478 - 178) / 2);
  const startY = Math.floor((356 - 178) / 2);
  for (let y = startY; y < startY + 178; y++) for (let x = startX; x < startX + 178; x++) {
    wide.set([200, 40, 40, 255], (y * 478 + x) * 4);
  }
  const score = similarity(
    await signature(imageSource(64, 64, squareReferencePixels())),
    await signature(imageSource(478, 356, wide)),
  );
  assert.ok(score > 0, `expected similarity > 0, got ${score}`);
  assert.ok(score >= 0.5, `expected similarity >= 0.5, got ${score}`);
});

test('signature: opaque self similarity is one and inverted colors stay dissimilar', async () => {
  const { signature, similarity } = loadSignaturePage();
  const pixels = new Uint8ClampedArray(64 * 64 * 4);
  const inverted = new Uint8ClampedArray(pixels.length);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const i = (y * 64 + x) * 4;
    const rgb = [(x * 3 + y) & 0xff, (x + y * 2) & 0xff, (x * 2 + y * 3) & 0xff];
    pixels.set([...rgb, 255], i);
    inverted.set(rgb.map(value => 255 - value).concat(255), i);
  }
  const original = await signature(imageSource(64, 64, pixels));
  assert.equal(similarity(original, original), 1);
  assert.ok(similarity(original, await signature(imageSource(64, 64, inverted))) < 0.2);
});

test('signature: paints white before drawing centered aspect-preserving thumbnails', async () => {
  for (const [width, height, expected] of [
    [64, 64, ['drawImage', 0, 0, 32, 32]],
    [128, 64, ['drawImage', 0, 8, 32, 16]],
    [64, 128, ['drawImage', 8, 0, 16, 32]],
  ]) {
    const calls = [];
    const { signature } = loadSignaturePage(recordingSignatureCanvasClass(calls));
    await signature(imageSource(width, height, new Uint8ClampedArray(width * height * 4)));
    assert.deepEqual(calls, [
      ['fillRect', '#ffffff', 0, 0, 32, 32],
      expected,
      ['fillRect', '#ffffff', 0, 0, 128, 128],
      ['drawImage', ...expected.slice(1).map(n => n * 4)],
    ]);
  }
});

test('signature: an opaque square keeps the legacy stretched signature exactly', async () => {
  const pixels = new Uint8ClampedArray(64 * 64 * 4);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const i = (y * 64 + x) * 4;
    pixels.set([(x * 5) & 0xff, (y * 3) & 0xff, (x + y * 2) & 0xff, 255], i);
  }
  const actual = await loadSignaturePage().signature(imageSource(64, 64, pixels));
  assert.deepEqual(Array.from(actual.gray), legacySquareSignature({ width: 64, height: 64, data: pixels }));
});

test('edit check: real color, spark and added-character changes are detected', async () => {
  const { signature, compareSignatures } = loadSignaturePage();
  const read = async name => {
    const bytes = fs.readFileSync(path.join(__dirname, 'fixtures', `edit-${name}.png`));
    const decoded = decodePng(bytes);
    assert.ok(bytes.length <= 60 * 1024, name);
    assert.ok(Math.max(decoded.width, decoded.height) <= 256, name);
    return signature({ mime: 'image/png', data: bytes.toString('base64') });
  };
  for (const [a, b] of [['spreader-gray', 'spreader-red'], ['weld-1', 'weld-2'], ['spreader-red', 'proud-welder']]) {
    const comparison = compareSignatures(await read(a), await read(b));
    assert.equal(comparison.changed, true, `${a} -> ${b}: ${JSON.stringify(comparison)}`);
    assert.ok(comparison.changedFraction > 0.01);
  }
});

test('edit check: lossless PNG re-encoding stays unchanged for every real fixture', async () => {
  const { encodePng } = require('../lib/png-codec');
  const { signature, compareSignatures } = loadSignaturePage();
  for (const name of ['spreader-gray', 'spreader-red', 'weld-1', 'weld-2', 'proud-welder']) {
    const original = fs.readFileSync(path.join(__dirname, 'fixtures', `edit-${name}.png`));
    const { width, height, data } = decodePng(original);
    const reencoded = encodePng(width, height, new Uint8Array(data));
    assert.notDeepEqual(reencoded, original, 'different encoding, same pixels');
    const compare = compareSignatures(
      await signature({ mime: 'image/png', data: original.toString('base64') }),
      await signature({ mime: 'image/png', data: reencoded.toString('base64') }));
    assert.equal(compare.changed, false, name);
    assert.equal(compare.changedFraction, 0, name);
  }
});

test('edit check: small equal-luminance recolor and small added object survive global averaging', async () => {
  const { signature, compareSignatures } = loadSignaturePage();
  const base = new Uint8ClampedArray(128 * 128 * 4);
  for (let i = 0; i < base.length; i += 4) base.set([100, 100, 100, 255], i);
  const reference = await signature(imageSource(128, 128, base));
  for (const [label, rgb] of [['recolor', [200, 49, 100, 255]], ['new object', [240, 220, 20, 255]]]) {
    const changed = base.slice();
    for (let y = 44; y < 50; y++) for (let x = 63; x < 69; x++) changed.set(rgb, (y * 128 + x) * 4);
    const result = compareSignatures(reference, await signature(imageSource(128, 128, changed)));
    assert.equal(result.changed, true, label);
    assert.ok(result.changedFraction < 0.005, 'less than 0.5% of the picture changed');
  }
});

test('edit check: JPEG quality 90 re-encoding is unchanged despite codec noise', async () => {
  const { signature, compareSignatures } = loadSignaturePage();
  const read = name => signature({ mime: 'image/png', data: fs.readFileSync(path.join(__dirname, 'fixtures', name)).toString('base64') });
  const result = compareSignatures(await read('edit-weld-1.png'), await read('edit-weld-1-jpeg90.png'));
  assert.equal(result.changed, false, JSON.stringify(result));
  assert.ok(result.similarity >= 0.95);
});

test('edit check: small encoding noise and white-matted transparency are not edits', async () => {
  const { signature, compareSignatures } = loadSignaturePage();
  const original = squareReferencePixels(true), noisy = original.slice();
  for (let i = 0; i < noisy.length; i += 4) for (let c = 0; c < 3; c++) noisy[i + c] = Math.max(0, noisy[i + c] - i % 7);
  const a = await signature(imageSource(64, 64, original));
  assert.equal(compareSignatures(a, await signature(imageSource(64, 64, noisy))).changed, false);
  assert.equal(compareSignatures(a, await signature(imageSource(64, 64, squareReferencePixels()))).changed, false);
});
