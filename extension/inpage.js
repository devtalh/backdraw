// Injected (isolated world) into the ChatGPT tab that the extension opened in the background.
// It only reads that page and dispatches synthetic DOM events inside it: it never moves the real
// mouse or keyboard, never focuses a window and never reads cookies or tokens.
// Re-injected before every call, so it always redefines itself (no stale copies after updates).
(() => {
  const VERSION = '2.0.0';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const squash = s => String(s || '').replace(/\s+/g, ' ').trim();
  const tidy = s => String(s || '').replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const shown = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const classOf = el => (typeof el.className === 'string' ? el.className : '');
  const firstOf = sels => {
    for (const s of sels) { try { const el = $(s); if (el) return el; } catch {} }
    return null;
  };

  const EDITOR = [
    '#prompt-textarea[contenteditable="true"]', 'div.ProseMirror[contenteditable="true"]',
    'form [contenteditable="true"]', 'textarea#prompt-textarea', 'form textarea',
  ];
  const SEND = ['button[data-testid="send-button"]', 'button#composer-submit-button', 'button[data-testid="composer-submit-button"]'];
  const STOP = ['button[data-testid="stop-button"]'];

  const editor = () => firstOf(EDITOR);

  // The send/stop buttons live next to the editor; look there by label when no test id matches.
  function composerRoot(ed) {
    if (!ed) return null;
    return ed.closest('form') || ed.closest('[class*="ComposerLayoutRoot"]') || ed.closest('[class*="Composer"]') ||
      (ed.parentElement && ed.parentElement.parentElement && ed.parentElement.parentElement.parentElement);
  }
  function composerButton(testIds, label) {
    const byId = firstOf(testIds);
    if (byId) return byId;
    const root = composerRoot(editor());
    return root ? $$('button', root).find(b => label.test(b.getAttribute('aria-label') || '')) || null : null;
  }
  const sendButton = () => composerButton(SEND, /send|gönder/i);
  const stopButton = () => composerButton(STOP, /stop|durdur/i);
  const textOf = el => (!el ? '' : el.tagName === 'TEXTAREA' ? el.value : el.innerText || el.textContent || '');
  const isDisabled = b => !!b && (b.disabled || b.getAttribute('aria-disabled') === 'true');

  // ------------------------------------------------------------ page state

  function challenge(hasComposer) {
    if (/just a moment|attention required|bir dakika|verify you are human|insan olduğunuzu/i.test(document.title || '')) return 'verification';
    const frames = $$('iframe[src*="challenges.cloudflare.com"], iframe[src*="arkoselabs"], iframe[src*="funcaptcha"], iframe[src*="hcaptcha"], iframe[src*="recaptcha"], iframe[title*="captcha" i]');
    if (frames.some(f => { const r = f.getBoundingClientRect(); return r.width >= 120 && r.height >= 60; })) return 'captcha';
    if (!hasComposer && $('#challenge-form, #cf-challenge-running, #challenge-stage, .cf-turnstile')) return 'verification';
    return null;
  }

  function loginWall() {
    if (/^auth\d*\./i.test(location.hostname) || /^\/(auth|log-?in)\b/i.test(location.pathname)) return true;
    return !!$('[data-testid="login-button"], [data-testid="signup-button"]');
  }

  // The conversation (2026 UI): user messages are "group/user-message" blocks, generated images sit
  // in "generated-image-preview" buttons, replies are "MarkdownRoot" blocks, and a role=status
  // aria-busy element shows while ChatGPT is answering. Long chats only render their latest turns,
  // so the reply is always located relative to the LAST user message, never counted from the top.
  const transcriptRoot = () => $('[class*="transcriptContent"]') || $('.thread-scroll-container') || $('main') || document.body;

  function outermost(list) { return list.filter(el => !list.some(o => o !== el && o.contains(el))); }

  function userMessages(root) {
    const modern = outermost($$('[class*="group/user-message"]', root));
    return modern.length ? modern : $$('[data-message-author-role="user"]', root);
  }

  const generatedImages = root => {
    const seen = new Set();
    return $$('[data-testid="generated-image-preview"] img, [data-testid="generated-image-gallery"] img', root)
      .filter(img => !seen.has(img) && seen.add(img));
  };

  function counts() {
    const root = transcriptRoot();
    return { users: userMessages(root).length, images: generatedImages(root).length };
  }

  const isAfter = (last, n) => !last || (n !== last && !last.contains(n) && !!(last.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING));

  // Elements that come after the last user message, i.e. the reply being written.
  function nodesAfter(after, root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    const out = [];
    let passed = !after;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!passed) {
        if (!isAfter(after, n)) continue;
        passed = true;
      }
      out.push(n);
    }
    return out;
  }

  function lastUser(root) {
    const users = userMessages(root);
    const last = users[users.length - 1] || null;
    const textEl = last && (last.querySelector('.whitespace-pre-wrap') || last);
    return { users, last, text: textEl ? squash(textEl.innerText || textEl.textContent).slice(0, 400) : '' };
  }

  const inMarkdown = el => !!el.closest('[class*="MarkdownRoot"], .markdown');

  // "Görsel oluşturma başarısız oldu  [Tekrar dene]" status line under a reply.
  const FAILED_TEXT = /görsel oluşturma başarısız|görüntü oluşturma başarısız|image (generation|creation) failed|couldn.?t (generate|create) (the |this )?image|failed to (generate|create) (the |this )?image/i;
  function failedText(replyEls) {
    for (const el of replyEls) {
      if (inMarkdown(el)) continue;
      const t = squash(el.textContent);
      if (t && t.length < 120 && FAILED_TEXT.test(t)) return t.replace(/\s*(tekrar dene|try again|retry)$/i, '');
    }
    return null;
  }

  // Match only a short survey label at the start of the squashed text, not general helpfulness.
  const FEEDBACK_TEXT = /^(?=.{1,79}$)(?:is this conversation helpful so far|bu (?:sohbet|konuşma) (?:(?:şu ana kadar|şimdiye kadar) )?(?:faydalı|yararlı|işe yarar)(?: mı)?)(?:\?|(?= |$))/i;

  // The reply as ChatGPT wrote it (its markdown blocks), plus a failure line if there is one.
  // Other text after the reply (feedback surveys, buttons, screen-reader labels) is left out.
  function replyText(replyEls) {
    const md = outermost(replyEls.filter(el => /MarkdownRoot|(^|\s)markdown(\s|$)/.test(classOf(el))));
    const parts = md.length
      ? md.map(el => el.innerText || el.textContent)
      : replyEls.filter(el => !el.childElementCount && !el.closest('.sr-only, button, [role="status"], form') &&
        !FEEDBACK_TEXT.test(squash(el.textContent))).map(el => el.textContent);
    const failed = failedText(replyEls);
    if (failed) parts.push(failed);
    return tidy(parts.join('\n'));
  }

  const PERCENT = /%\s?\d{1,3}\b|\b\d{1,3}\s?%/;

  // Progress such as "Eskiz çiziliyor %41" in the reply, or a small "Görsel önizleme %47" popup.
  function progressText(replyEls) {
    for (const el of replyEls) {
      if (el.childElementCount || inMarkdown(el)) continue;
      const t = squash(el.textContent);
      if (t && t.length < 80 && PERCENT.test(t)) return t;
    }
    for (const el of $$('[role="dialog"], [role="status"], [aria-live]')) {
      const t = squash(el.innerText || el.textContent);
      if (t && t.length < 80 && PERCENT.test(t)) return t;
    }
    return null;
  }

  const IMG_HINT = /estuary\/content|oaiusercontent\.com|\/backend-api\/files|\/file-service|sdmntpr/i;

  function imageKey(src) {
    if (src.startsWith('blob:')) return src;
    try { const u = new URL(src, location.href); return u.searchParams.get('id') || u.origin + u.pathname; } catch { return src; }
  }

  function blurred(el) {
    for (let i = 0; el && i < 4; i++, el = el.parentElement) {
      const f = getComputedStyle(el).filter;
      if (f && f.includes('blur')) return true;
    }
    return false;
  }

  function describeImages(imgs) {
    const map = new Map();
    for (const img of imgs) {
      const src = img.currentSrc || img.src || '';
      if (!src || src.startsWith('data:image/svg') || /favicon|\/s2\/favicons|gravatar|avatar/i.test(src)) continue;
      const r = img.getBoundingClientRect();
      const info = {
        src, key: imageKey(src), alt: squash(img.alt).slice(0, 120), w: img.naturalWidth, h: img.naturalHeight,
        rw: Math.round(r.width), rh: Math.round(r.height), complete: img.complete, blurred: blurred(img),
      };
      const prev = map.get(info.key);
      if (!prev || (prev.blurred && !info.blurred)) map.set(info.key, info);
    }
    return [...map.values()];
  }

  // Fallback for layouts without the generated-image markers: large or known-host images.
  function looseImages(imgs) {
    return describeImages(imgs.filter(img => {
      const src = img.currentSrc || img.src || '';
      const r = img.getBoundingClientRect();
      return IMG_HINT.test(src) || src.startsWith('blob:') || Math.max(img.naturalWidth, img.naturalHeight, r.width, r.height) >= 200;
    }));
  }

  // Short status labels must start the text; file names and later mentions are not busy states.
  const BUSY_TEXT = /^[\s\p{P}\p{S}]*(?:creating images?|generating images?|image is being|thinking|sketch(?:ing)?|setting the scene|finishing up|preview|görsel önizleme|image preview|görsel oluşturuluyor|görüntü oluşturuluyor|resim oluşturuluyor|görsel hazırlanıyor|düşünüyor|eskiz|son rötuşlar|önizleme)(?![\p{L}\p{N}_])/iu;
  const FILE_NAME_TEXT = /[^\s/\\]+\.(?:png|jpe?g|webp|gif|svg|avif|bmp|tiff?|ico|zip|pdf|txt|json|csv|md|xml|ya?ml|docx?|xlsx?|pptx?)(?![\p{L}\p{N}_])[\s\p{P}]*$/iu;
  const BUSY_SEL = '[aria-busy="true"], .pulsing-dot, .loading-shimmer, [class*="shimmer"], [role="progressbar"], .result-streaming';

  function busyIn(els) {
    return els.some(el => {
      if (inMarkdown(el)) return false;
      if (el.matches(BUSY_SEL)) return true;
      const t = squash(el.textContent);
      return !el.childElementCount && t.length < 80 && !FILE_NAME_TEXT.test(t) && BUSY_TEXT.test(t);
    });
  }

  const ERROR_TEXT = /something went wrong|an error occurred|error in message stream|network error|bir şeyler ters gitti|bir hata oluştu|hata oluştu|ağ hatası/i;

  function errorIn(els) {
    for (const el of els) {
      if (inMarkdown(el)) continue;
      const t = squash(el.textContent);
      if (!t) continue;
      if (el.matches('.text-red-500, [class*="text-token-text-error"], [data-testid*="error" i]')) return t.slice(0, 300);
      if (!el.childElementCount && t.length < 300 && ERROR_TEXT.test(t)) return t;
    }
    return null;
  }

  // baseline: {users, images} counted before our message was sent (null = page state only).
  function probe(baseline) {
    const ed = editor();
    const send = sendButton();
    const root = transcriptRoot();
    const { users, last, text: lastUserText } = lastUser(root);
    const gen = generatedImages(root);
    const replyEls = nodesAfter(last, root);
    const out = {
      url: location.href, title: document.title, ready: document.readyState, hidden: document.hidden,
      viewport: [innerWidth, innerHeight],
      challenge: challenge(!!ed), login: loginWall(),
      composer: !!ed,
      editorKind: !ed ? null : ed.tagName === 'TEXTAREA' ? 'textarea' : ed.classList.contains('ProseMirror') ? 'prosemirror' : 'contenteditable',
      composerText: squash(textOf(ed)).slice(0, 200),
      send: send ? { disabled: isDisabled(send), testid: send.getAttribute('data-testid'), label: send.getAttribute('aria-label') } : null,
      stop: !!stopButton(),
      counts: { users: users.length, images: gen.length },
      lastUserText,
      progress: progressText(replyEls),
      sidebarOpen: (() => { const sb = $('#app-shell-sidebar'); return sb ? sb.getBoundingClientRect().width > 120 : null; })(),
      dialogs: $$('[role="dialog"]').filter(shown).map(d => squash(d.innerText).slice(0, 120)),
    };
    if (baseline && typeof baseline === 'object') {
      out.userTurns = users.length - (baseline.users || 0);
      const mine = gen.filter(img => isAfter(last, img));
      out.images = mine.length ? describeImages(mine)
        : gen.length ? []
          : looseImages(replyEls.filter(el => el.tagName === 'IMG' && !el.closest('form, .composer-attachment-surface')));
      out.text = replyText(replyEls).slice(0, 4000);
      out.failed = failedText(replyEls);
      out.done = replyEls.some(el => classOf(el).includes('turn-action-controls'));
      out.replyCount = out.text || out.images.length ? 1 : 0;
      out.busy = busyIn(replyEls) || !!out.progress;
      out.error = errorIn(replyEls);
      out.sig = `${out.images.map(i => i.key + (i.blurred ? '~b' : '')).join('|')}#${out.text.length}#${out.busy}#${out.stop}#${out.progress}`;
    }
    return out;
  }

  function composerState() {
    const ed = editor();
    const send = sendButton();
    return {
      composer: !!ed, text: textOf(ed), send: send ? { disabled: isDisabled(send) } : null, stop: !!stopButton(),
      dialogs: $$('[role="dialog"]').filter(shown).length,
    };
  }

  // ------------------------------------------------------------ actions (synthetic DOM events only)

  function selectAll(el) {
    const sel = getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function setNativeValue(el, value) {
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value') ||
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    desc.set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function clearComposer() {
    const ed = editor();
    if (!ed) return { ok: false, error: 'composer not found' };
    if (ed.tagName === 'TEXTAREA') { setNativeValue(ed, ''); return { ok: true }; }
    ed.focus();
    selectAll(ed);
    document.execCommand('delete', false);
    return { ok: true, left: textOf(ed).length };
  }

  function setPrompt(text, method) {
    const ed = editor();
    if (!ed) return { ok: false, error: 'composer not found' };
    if (ed.tagName === 'TEXTAREA') { setNativeValue(ed, text); return { ok: true, method: 'textarea' }; }
    ed.focus();
    selectAll(ed);
    if (method === 'insertText') return { ok: document.execCommand('insertText', false, text), method };
    if (method === 'paste') {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      const ev = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      ed.dispatchEvent(ev);
      return { ok: true, method, handled: ev.defaultPrevented };
    }
    const paragraphs = text.split('\n').map(line => {
      const p = document.createElement('p');
      if (line) p.textContent = line; else p.appendChild(document.createElement('br'));
      return p;
    });
    ed.replaceChildren(...paragraphs);
    ed.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    return { ok: true, method: 'dom' };
  }

  function clickSend() {
    const b = sendButton();
    if (!b) return { ok: false, error: 'send button not found' };
    if (isDisabled(b)) return { ok: false, error: 'send button disabled' };
    b.click();
    return { ok: true };
  }

  function pressEnter() {
    const ed = editor();
    if (!ed) return { ok: false, error: 'composer not found' };
    ed.focus();
    const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    ed.dispatchEvent(new KeyboardEvent('keydown', init));
    ed.dispatchEvent(new KeyboardEvent('keyup', init));
    return { ok: true };
  }

  function clickStop() {
    const b = stopButton();
    if (!b) return { ok: false };
    b.click();
    return { ok: true };
  }

  // Closes pop-ups that can sit over the composer. It only uses their close (X) buttons / Escape,
  // never "accept"-style buttons.
  function dismissDialogs() {
    let closed = 0;
    for (const d of $$('[role="dialog"]')) {
      const btn = d.querySelector('button[aria-label*="close" i], button[aria-label*="kapat" i], [data-testid="close-button"]');
      if (btn) { btn.click(); closed++; }
    }
    const esc = { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true };
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', esc));
    return { closed };
  }

  // ------------------------------------------------------------ attachments (reference images)

  function b64ToBlob(data, mime) {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime || 'image/png' });
  }

  function fileInputs() {
    const ed = editor();
    const scope = (ed && (ed.closest('form') || composerRoot(ed))) || document;
    return $$('input[type="file"]', scope);
  }

  // Puts files on the composer's own photo input, exactly like picking them in the file dialog.
  function attachFiles(files) {
    const inputs = fileInputs();
    const input = inputs.find(i => /image/.test(i.accept || '') && !/video/.test(i.accept || '')) ||
      inputs.find(i => /image/.test(i.accept || '')) || inputs.find(i => !i.accept) || inputs[0];
    if (!input) return { ok: false, error: 'file input not found' };
    const data = new DataTransfer();
    for (const f of files) data.items.add(new File([b64ToBlob(f.data, f.mime)], f.name, { type: f.mime }));
    input.files = data.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, input: input.getAttribute('aria-label'), count: input.files ? input.files.length : null };
  }

  // Attachment chips in the composer ("reference.png" + its remove button) and whether any still uploads.
  function attachmentState() {
    const root = composerRoot(editor());
    const area = root && $('[class*="ComposerLayoutAttachments"]', root);
    const items = area ? outermost($$('[role="button"][aria-label]', area)) : [];
    const uploading = items.some(el => el.matches('[aria-busy="true"]') ||
      !!el.querySelector('[role="progressbar"], [aria-busy="true"], .animate-spin, [class*="spinner"], [class*="loading"]'));
    const failed = items.filter(el => /başarısız|failed|hata|error/i.test(el.textContent || '')).map(el => el.getAttribute('aria-label'));
    return { count: items.length, uploading, failed, names: items.map(el => el.getAttribute('aria-label')) };
  }

  function removeAttachments() {
    const root = composerRoot(editor());
    if (!root) return { removed: 0 };
    const buttons = $$('button', root).filter(b => /kaldır|remove|delete|sil\b/i.test(b.getAttribute('aria-label') || ''));
    buttons.forEach(b => b.click());
    return { removed: buttons.length, labels: buttons.map(b => b.getAttribute('aria-label')) };
  }

  // The newest generated image above the last user message (to re-attach it when ChatGPT asks).
  function latestEarlierImage() {
    const root = transcriptRoot();
    const { last } = lastUser(root);
    const earlier = generatedImages(root).filter(img => !isAfter(last, img));
    const img = earlier[earlier.length - 1];
    return img ? { src: img.currentSrc || img.src } : null;
  }

  // ------------------------------------------------------------ edit check

  // Keep the 32px structural signature and a 128px color thumbnail for local changes. Decode bytes:
  // img.decode() can stall for minutes in a background tab that is never painted.
  async function signature(source) {
    const blob = source instanceof HTMLImageElement
      ? await (await fetch(source.currentSrc || source.src)).blob()
      : b64ToBlob(source.data, source.mime);
    const bitmap = await createImageBitmap(blob);
    const thumbnail = size => {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const g = canvas.getContext('2d', { willReadFrequently: true });
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, size, size);
      const scale = size / Math.max(bitmap.width, bitmap.height);
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const x = Math.floor((size - width) / 2), y = Math.floor((size - height) / 2);
      g.drawImage(bitmap, x, y, width, height);
      return { data: g.getImageData(0, 0, size, size).data, x, y, width, height };
    };
    try {
      const d = thumbnail(32).data, gray = new Array(1024);
      for (let i = 0; i < 1024; i++) gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
      return { gray, color: thumbnail(128) };
    } finally { if (bitmap.close) bitmap.close(); }
  }

  // Share of the 64 blocks (4x4 px of the contrast-normalised thumbnail) that stayed the same.
  // Calibrated on real pairs: local edits (mouth, eyes) ~1.00, a redraw of the same character ~0.47,
  // unrelated images ~0.
  function similarity(a, b) {
    const norm = v => {
      const m = v.reduce((s, x) => s + x, 0) / v.length;
      const sd = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length) || 1;
      return v.map(x => (x - m) / sd);
    };
    const za = norm(a.gray);
    const zb = norm(b.gray);
    let same = 0;
    for (let by = 0; by < 8; by++) {
      for (let bx = 0; bx < 8; bx++) {
        let diff = 0;
        for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { const i = (by * 4 + y) * 32 + bx * 4 + x; diff += Math.abs(za[i] - zb[i]); }
        if (diff / 16 < 0.3) same++;
      }
    }
    return same / 64;
  }

  function compareSignatures(a, b) {
    let pixels = 0, different = 0, peak = 0;
    const inside = (c, x, y) => x >= c.x && x < c.x + c.width && y >= c.y && y < c.y + c.height;
    for (let by = 0; by < 128; by += 8) for (let bx = 0; bx < 128; bx += 8) {
      let local = 0, count = 0;
      for (let y = by; y < by + 8; y++) for (let x = bx; x < bx + 8; x++) {
        // Padding is not part of the picture and must not inflate its unchanged share.
        if (!inside(a.color, x, y) && !inside(b.color, x, y)) continue;
        count++;
        const i = (y * 128 + x) * 4;
        // Ignore small encoding/resampling noise, but retain hue changes at equal luminance.
        if (Math.max(...[0, 1, 2].map(c => Math.abs(a.color.data[i + c] - b.color.data[i + c]))) > 24) local++;
      }
      pixels += count;
      different += local;
      if (count) peak = Math.max(peak, local / count);
    }
    const changedFraction = different / Math.max(1, pixels);
    // A small coherent region counts, while isolated codec noise does not.
    const changed = different >= 8 && changedFraction >= 0.001 && (peak >= 0.08 || changedFraction >= 0.01);
    return { similarity: similarity(a, b), changedFraction, changed };
  }

  // Compares each new image with the reference images and with the images earlier in the chat.
  async function editCheck(refs) {
    const root = transcriptRoot();
    const { last } = lastUser(root);
    const all = generatedImages(root);
    const outputs = describeImages(all.filter(img => isAfter(last, img))).map(i => all.find(img => (img.currentSrc || img.src) === i.src));
    const earlier = all.filter(img => !isAfter(last, img)).slice(-12).reverse();
    const candidates = [
      ...(refs || []).map((r, i) => ({ label: `reference image ${i + 1}${r.name ? ` (${r.name})` : ''}`, source: r })),
      ...earlier.map((img, i) => ({ label: i === 0 ? 'the previous image in the chat' : `an earlier image in the chat (${i + 1} back)`, source: img })),
    ];
    if (!outputs.length || !candidates.length) return null;
    const sigs = [];
    for (const c of candidates) {
      try { sigs.push({ label: c.label, sig: await signature(c.source) }); } catch {}
    }
    const results = [];
    for (const img of outputs) {
      let out;
      try { out = await signature(img); } catch { continue; }
      let best = null;
      for (const c of sigs) {
        const comparison = compareSignatures(out, c.sig);
        if (!best || comparison.similarity > best.similarity ||
            comparison.similarity === best.similarity && comparison.changedFraction < best.changedFraction) {
          best = { ...comparison, against: c.label };
        }
      }
      if (best) results.push({ ...best, similarity: Math.round(best.similarity * 100) / 100 });
    }
    return results.length ? { results, compared: sigs.length } : null;
  }

  // ------------------------------------------------------------ projects (sidebar)

  // Sidebar folder rows of the "Projects" section: a row (role=button, aria-expanded) holding the
  // name, followed by a list of the project's chats. The rows have no link of their own; the
  // project id only shows up in the links of the chats inside it.
  function projectRows() {
    const rows = [];
    for (const item of $$('[role="listitem"]')) {
      const head = item.querySelector('[role="button"][aria-expanded]');
      const chats = item.querySelector('[role="list"]');
      if (!head || !chats || !(head.compareDocumentPosition(chats) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      const nameEl = head.querySelector('[class*="content-"]') || head;
      const name = squash(nameEl.textContent).split('\n')[0];
      if (name) rows.push({ item, head, chats, name });
    }
    return rows;
  }

  function listProjects() {
    const found = new Map();
    for (const r of projectRows()) {
      const link = r.chats.querySelector('a[href*="/g/g-p-"]');
      const m = link && link.getAttribute('href').match(/\/g\/(g-p-[0-9a-f]+)/i);
      found.set(r.name, { name: r.name, id: m ? m[1] : null, url: m ? `${location.origin}/g/${m[1]}/project` : null });
    }
    // Older layouts linked the project page directly.
    for (const a of $$('a[href*="/g/g-p-"]')) {
      const m = (a.getAttribute('href') || '').match(/^\/g\/(g-p-[0-9a-f]+)(-[^/]*)?\/project\/?$/i);
      const name = squash((a.innerText || a.getAttribute('aria-label') || '').split('\n')[0]);
      if (m && name && !found.has(name)) found.set(name, { name, id: m[1], url: `${location.origin}/g/${m[1]}${m[2] || ''}/project` });
    }
    return [...found.values()];
  }

  // Presses a project's "new chat in this project" button; ChatGPT then shows the project page,
  // whose URL carries the project id. (The other row button, the actions menu, has aria-expanded.)
  function openProject(name) {
    const row = projectRows().find(r => r.name === name);
    if (!row) return { ok: false, error: 'project row not found' };
    const btn = $$('button', row.head).find(b => !b.hasAttribute('aria-expanded'));
    press(btn || row.head);
    return { ok: true, via: btn ? 'new-chat-button' : 'row' };
  }

  // Radix menus open on pointerdown, plain buttons and popovers on click: send both.
  function press(el) {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', isPrimary: true }));
    el.click();
  }

  function clickLabel(label) {
    const want = squash(label).toLowerCase();
    const els = $$('button, a, [role="button"], [role="menuitem"], [role="tab"], [role="option"]');
    const el = els.find(e => squash(e.getAttribute('aria-label')).toLowerCase() === want) ||
      els.find(e => squash(e.innerText).toLowerCase() === want);
    if (!el) return { clicked: false };
    press(el);
    return { clicked: true, tag: el.tagName, label: el.getAttribute('aria-label'), text: squash(el.innerText).slice(0, 60) };
  }

  function sidebar(open) {
    const b = firstOf(open
      ? ['[data-testid="open-sidebar-button"]', 'button[aria-label="Open sidebar"]', 'button[aria-label="Kenar çubuğunu göster"]', 'button[aria-label*="kenar çubuğunu aç" i]']
      : ['[data-testid="close-sidebar-button"]', 'button[aria-label="Close sidebar"]', 'button[aria-label="Kenar çubuğunu gizle"]', 'button[aria-label*="kenar çubuğunu kapat" i]']);
    if (!b) return { clicked: false };
    b.click();
    return { clicked: true };
  }

  // ------------------------------------------------------------ chat cleanup

  const CHAT_PATH = /^\/(?:g\/g-p-[0-9a-f]+(?:-[a-z0-9-]+)?\/)?c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;
  const sameLabel = (a, b) => squash(a).toLowerCase() === squash(b).toLowerCase();

  function chatTrigger() {
    const buttons = $$('header button[aria-haspopup="menu"]').filter(shown)
      .filter(b => !(b.getAttribute('data-testid') || '').includes('model-switcher') && squash(b.innerText));
    const matching = buttons.filter(b => sameLabel(b.innerText, document.title));
    const candidates = matching.length ? matching : buttons;
    return candidates.length === 1 ? candidates[0] : null;
  }

  // ChatGPT sends a deleted chat's link to the home page with this notice.
  const GONE_TEXT = /^you don['’]t have access to this conversation/i;

  function chatGone() {
    if (location.hostname !== 'chatgpt.com' || location.pathname !== '/') return false;
    return $$('[role="alert"], [role="dialog"], [role="status"], [aria-live], [data-testid*="toast" i]').some(el => {
      if (!shown(el)) return false;
      const text = squash(el.innerText || el.textContent);
      return text.length <= 400 && GONE_TEXT.test(text);
    });
  }

  function chatPageState(id) {
    const trigger = chatTrigger();
    return {
      onChat: location.hostname === 'chatgpt.com' && location.pathname.match(CHAT_PATH)?.[1].toLowerCase() === String(id).toLowerCase(),
      lang: document.documentElement.lang || '', title: trigger ? squash(trigger.innerText) : null,
      trigger: !!trigger, login: loginWall(), challenge: challenge(!!editor()), gone: chatGone(),
      menuOpen: $$('[role="menu"]').some(shown),
    };
  }

  function openChatMenu(id) {
    if (!chatPageState(id).onChat) return { ok: false, error: 'wrong_page' };
    const trigger = chatTrigger();
    if (!trigger) return { ok: false, error: 'menu_trigger_not_found' };
    const title = squash(trigger.innerText);
    press(trigger);
    return { ok: true, title };
  }

  function chatMenu() {
    const trigger = chatTrigger();
    if (!trigger || !(trigger.getAttribute('aria-expanded') === 'true' || trigger.getAttribute('data-state') === 'open')) return null;
    const controls = trigger.getAttribute('aria-controls');
    if (controls) {
      const menu = document.getElementById(controls);
      return menu && shown(menu) && menu.getAttribute('role') === 'menu' ? menu : null;
    }
    const menus = $$('[role="menu"]').filter(shown);
    return menus.length === 1 ? menus[0] : null;
  }

  function chatMenuItems() {
    const menu = chatMenu();
    return menu ? $$('[role="menuitem"]', menu).filter(shown).map(el => squash(el.innerText)) : [];
  }

  function clickChatMenuItem(label, expectedTitle) {
    const menu = chatMenu();
    if (!menu) return { clicked: false, error: 'menu_unexpected' };
    if (expectedTitle !== undefined && !sameLabel(chatTrigger()?.innerText, expectedTitle)) return { clicked: false, error: 'title_mismatch' };
    const items = $$('[role="menuitem"]', menu).filter(shown).filter(el => sameLabel(el.innerText, label));
    if (items.length !== 1) return { clicked: false, error: items.length ? 'item_ambiguous' : 'item_not_found' };
    press(items[0]);
    return { clicked: true };
  }

  function closeChatMenu() {
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    return { ok: true };
  }

  function deleteDialog() {
    const dialogs = $$('[role="dialog"]').filter(shown).filter(dialog => {
      const headings = $$('h1, h2, h3, h4, h5, h6, [role="heading"]', dialog);
      const labelled = (dialog.getAttribute('aria-labelledby') || '').split(/\s+/)
        .map(id => document.getElementById(id)).filter(Boolean);
      return [...headings, ...labelled].some(el => sameLabel(el.innerText, 'Delete chat?')) ||
        sameLabel((dialog.innerText || '').split('\n')[0], 'Delete chat?');
    });
    return dialogs.length === 1 ? dialogs[0] : null;
  }

  function deleteDialogState() {
    const dialog = deleteDialog();
    const match = dialog && squash(dialog.innerText).match(/This will permanently delete (.+?)\.\s*This can['’]t be undone/i);
    return { found: !!dialog, title: match ? match[1] : null };
  }

  function confirmDeleteChat(expectedTitle) {
    const state = deleteDialogState();
    const dialog = deleteDialog();
    if (!state.found || !dialog) return { ok: false, error: 'dialog_not_found' };
    const buttons = $$('button', dialog).filter(shown);
    const cancel = () => {
      const matches = buttons.filter(b => sameLabel(b.innerText, 'Cancel'));
      if (matches.length === 1) press(matches[0]);
    };
    if (state.title === null || !sameLabel(state.title, expectedTitle)) {
      cancel();
      return { ok: false, error: 'title_mismatch' };
    }
    const matches = buttons.filter(b => sameLabel(b.innerText, 'Delete chat'));
    if (matches.length !== 1) { cancel(); return { ok: false, error: 'confirm_button_not_found' }; }
    press(matches[0]);
    return { ok: true };
  }

  // ------------------------------------------------------------ image bytes

  async function blobToResult(blob, via) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return { data: btoa(bin), mime: blob.type || '', size: bytes.length, via };
  }

  // Reads the image bytes inside the page (same origin, so ChatGPT's own blob: and file URLs work).
  // If fetching fails, the already-loaded <img> is copied through a canvas (same-origin, untainted).
  async function fetchImage(src) {
    let fetchError = null;
    try {
      const res = await fetch(src, { credentials: 'include' });
      if (res.ok) return blobToResult(await res.blob(), 'fetch');
      fetchError = `HTTP ${res.status}`;
    } catch (e) {
      fetchError = String(e);
    }
    const img = $$('img').find(i => (i.currentSrc || i.src) === src);
    if (!img) return { error: `${fetchError}; image element not found` };
    if (!img.naturalWidth) return { error: `${fetchError}; image not decoded` };
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return { error: `${fetchError}; canvas export failed` };
    return blobToResult(blob, 'canvas');
  }

  // ------------------------------------------------------------ diagnostics

  const ATTRS = ['id', 'data-testid', 'role', 'aria-label', 'data-turn', 'data-message-author-role', 'href', 'src', 'alt',
    'contenteditable', 'disabled', 'aria-disabled', 'aria-busy', 'aria-expanded', 'title', 'type', 'accept', 'multiple', 'name'];

  function outline(root, max) {
    const lines = [];
    const walk = (el, depth) => {
      if (lines.length >= max || !el || el.nodeType !== 1) return;
      const tag = el.tagName.toLowerCase();
      if (['script', 'style', 'noscript', 'template', 'path', 'svg'].includes(tag)) return;
      const attrs = [];
      for (const name of ATTRS) {
        const v = el.getAttribute(name);
        if (v !== null) attrs.push(`${name}="${v.slice(0, name === 'src' || name === 'href' ? 100 : 60)}"`);
      }
      if (classOf(el)) attrs.push(`class="${classOf(el).slice(0, 100)}"`);
      let own = '';
      for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent;
      own = squash(own).slice(0, 80);
      const r = el.getBoundingClientRect();
      const size = r.width || r.height ? ` [${Math.round(r.width)}x${Math.round(r.height)}]` : ' [0]';
      const filter = getComputedStyle(el).filter;
      lines.push(`${'  '.repeat(Math.min(depth, 24))}<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}>${size}${filter && filter !== 'none' ? ` {filter:${filter}}` : ''}${own ? ` "${own}"` : ''}`);
      for (const c of el.children) walk(c, depth + 1);
    };
    walk(root, 0);
    return lines;
  }

  function snapshot(selector, max) {
    let root = document.body;
    if (selector === 'transcript') root = transcriptRoot();
    else if (selector) root = $(selector) || document.body;
    return { url: location.href, title: document.title, probe: probe({ users: 0, images: 0 }), lines: outline(root, Math.min(max || 400, 3000)) };
  }

  globalThis.__cgb = {
    version: VERSION, probe, composerState, clearComposer, setPrompt, clickSend, pressEnter, clickStop,
    dismissDialogs, listProjects, openProject, sidebar, clickLabel, fetchImage, snapshot, counts,
    attachFiles, attachmentState, removeAttachments, latestEarlierImage, signature, similarity, compareSignatures, editCheck, replyText, busyIn,
    chatPageState, openChatMenu, chatMenuItems, clickChatMenuItem, closeChatMenu, deleteDialogState, confirmDeleteChat,
  };
})();
