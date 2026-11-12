'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const read = f => fs.readFileSync(path.join(__dirname, '..', 'extension', f), 'utf8');
const ctx = vm.createContext({});
for (const f of ['i18n.js', 'chat-cleanup-ui.js']) vm.runInContext(read(f), ctx, { filename: f });
const { keptSummary, progressText, finishText, errorText } = ctx.backdrawCleanupText;
const translate = lang => (key, vars) => ctx.i18n.translate(lang, key, vars);

test('kept summaries: exact preview and result examples, singulars, plurals and empty totals', () => {
  for (const [lang, preview, done] of [
    ['tr', '3 sohbet açık bırakılacak: 2 başarısız iş, 1 ChatGPT sorusu.', '3 sohbet açık bırakıldı: 2 başarısız iş, 1 ChatGPT sorusu.'],
    ['en', '3 chats will stay open: 2 failed jobs, 1 ChatGPT question.', '3 chats were left open: 2 failed jobs, 1 ChatGPT question.'],
  ]) {
    const t = translate(lang);
    assert.equal(keptSummary({ text_reply: 1, failed: 2 }, 3, t), preview);
    assert.equal(keptSummary({ text_reply: 1, failed: 2 }, 3, t, true), done);
    assert.equal(keptSummary({}, 0, t), '');
    assert.equal(keptSummary({ failed: 1 }, 1, t), t('cleanupKeptPreview_one', { n: 1, list: `1 ${t('reason_failed_one')}` }));
    assert.equal(keptSummary({ failed: 1 }, 1, t, true), t('cleanupKeptDone_one', { n: 1, list: `1 ${t('reason_failed_one')}` }));
    assert.equal(keptSummary({ failed: 2 }, 2, t), t('cleanupKeptPreview', { n: 2, list: `2 ${t('reason_failed_other')}` }));
  }
});

test('kept summaries: fixed reason order and all singular/plural labels', () => {
  const reasons = ['failed', 'timeout', 'text_reply', 'needs_reference', 'cancelled', 'no_images', 'active', 'not_created', 'other'];
  const kept = Object.fromEntries([...reasons].reverse().map(code => [code, 1]));
  for (const lang of ['en', 'tr']) {
    const t = translate(lang);
    assert.equal(keptSummary(kept, 9, t), t('cleanupKeptPreview', { n: 9,
      list: reasons.map(code => `1 ${t(`reason_${code}_one`)}`).join(', ') }));
    for (const code of reasons) for (const n of [1, 2]) {
      const key = `reason_${code}_${n === 1 ? 'one' : 'other'}`;
      assert.ok(ctx.i18n.STRINGS[lang][key]);
      assert.ok(keptSummary({ [code]: n }, n, t).includes(`${n} ${t(key)}`));
    }
  }
});

test('progress and finish texts: exact totals, zero omission and both actions in both languages', () => {
  for (const [lang, archiving, deleting, done, empty] of [
    ['en', 'Archiving 3/12', 'Deleting 3/12', 'Done: 10 archived, 1 already archived, 2 deleted, 1 skipped, 1 failed.', 'Nothing was changed.'],
    ['tr', 'Arşivleniyor 3/12', 'Siliniyor 3/12', 'Bitti: 10 arşivlendi, 1 zaten arşivliydi, 2 silindi, 1 atlandı, 1 hata.', 'Hiçbir şey değişmedi.'],
  ]) {
    const t = translate(lang);
    const p = { done: 3, total: 12, failed: 0 };
    assert.equal(progressText({ ...p, action: 'archive' }, t), archiving);
    assert.equal(progressText({ ...p, action: 'delete' }, t), deleting);
    assert.equal(progressText({ ...p, action: 'archive', failed: 1 }, t), archiving + (lang === 'en' ? ' · 1 failed' : ' · 1 hata'));
    assert.equal(finishText({ archived: 10, alreadyArchived: 1, deleted: 2, skipped: 1, failed: 1 }, t), done);
    assert.equal(finishText({ archived: 0, deleted: 0, failed: 0 }, t), empty);
    assert.equal(finishText({ archived: 1 }, t), lang === 'en' ? 'Done: 1 archived.' : 'Bitti: 1 arşivlendi.');
  }
});

test('cleanup errors: all codes and unknown values have safe texts in both languages', () => {
  for (const lang of ['en', 'tr']) {
    const t = translate(lang);
    for (const code of ['unsupported_language', 'login', 'challenge', 'too_many_failures', 'tab_closed', 'not_connected', 'unknown', 'toString']) {
      const text = errorText(code, t);
      assert.ok(text.length > 20, `${lang}: ${code}`);
      assert.doesNotMatch(text, /cleanupErr|undefined/);
    }
    assert.equal(errorText('not_connected', t), t('errNotConnected'));
    assert.equal(errorText('login', t), errorText('challenge', t));
    assert.equal(errorText('unknown', t), t('cleanupErrUnknown'));
  }
});

// Minimal DOM stand-in: execute the actual popup handlers, without Chrome or a browser.
class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.hidden = false; this.disabled = false; this.value = ''; this.dataset = {}; this.attrs = {}; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; this._text = ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return (this._text || '') + this.children.map(c => typeof c === 'object' ? c.textContent : String(c)).join(''); }
  setAttribute(key, value) { this.attrs[key] = value; }
  querySelectorAll() { return []; }
}
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)); };

async function popup({ stored = {}, reply = () => undefined } = {}) {
  const nodes = new Map([...read('popup.html').matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  nodes.get('settings').hidden = true;
  const saved = [], sent = [], listeners = [], timers = new Map(), lifecycle = {};
  let timerId = 0;
  const schedule = (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; };
  const doc = { documentElement: new Element(), getElementById: id => nodes.get(id), createElement: tag => new Element(tag), querySelectorAll: () => [] };
  const sandbox = vm.createContext({ document: doc, localStorage: { getItem() {}, setItem() {} },
    setTimeout: schedule, clearTimeout: id => timers.delete(id), setInterval: schedule, clearInterval: id => timers.delete(id),
    window: { addEventListener: (type, fn) => { lifecycle[type] = fn; } },
    chrome: {
      i18n: { getUILanguage: () => 'en' },
      storage: { local: { get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in stored).map(k => [k, stored[k]])),
        set: async values => { saved.push({ ...values }); Object.assign(stored, values); for (const fn of listeners) fn(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { newValue: v }])), 'local'); } },
        onChanged: { addListener: fn => listeners.push(fn) } },
      tabs: { query: async () => [] }, runtime: { getManifest: () => ({}), sendMessage: async msg => {
        sent.push(JSON.parse(JSON.stringify(msg)));
        return reply(msg) ?? (msg.type === 'popup:status' ? { connected: false } : { ok: true, progress: null, queued: 0 });
      } },
    },
  });
  for (const f of ['i18n.js', 'settings.js', 'setup.js', 'chat-cleanup-ui.js', 'popup.js']) vm.runInContext(read(f), sandbox, { filename: f });
  await settle();
  const findButton = (id, text) => {
    const visit = node => node instanceof Element && node.tagName === 'button' && node.textContent === text ? node
      : node?.children?.map(visit).find(Boolean);
    const found = visit(nodes.get(id));
    assert.ok(found, `${id}: button ${text}`);
    return found;
  };
  const click = async (id, text) => { const b = text ? findButton(id, text) : nodes.get(id); assert.ok(!b.disabled); await b.onclick(); await settle(); };
  const change = async value => { nodes.get('chatCleanup').value = value; nodes.get('chatCleanup').onchange(); await settle(); };
  const poll = async () => { const entry = [...timers].find(([, t]) => t.ms === 1000); assert.ok(entry); timers.delete(entry[0]); await entry[1].fn(); await settle(); };
  return { nodes, saved, sent, sandbox, timers, lifecycle, click, change, poll };
}

test('popup setting: defaults to keep, validates stored modes, saves archive/keep, confirms delete and restores on cancel', async () => {
  const p = await popup();
  assert.equal(p.nodes.get('chatCleanup').value, 'keep');
  assert.equal(p.saved.length, 0);
  for (const value of [undefined, null, 'bad', 1]) assert.equal(p.sandbox.backdrawSettings.cleanupMode(value), 'keep');
  await p.change('archive');
  assert.deepEqual(p.saved, [{ chatCleanup: 'archive' }]);
  await p.change('delete');
  assert.equal(p.saved.length, 1);
  assert.equal(p.nodes.get('cleanupSettingConfirm').hidden, false);
  await p.click('cleanupSettingConfirm', 'Cancel');
  assert.equal(p.nodes.get('chatCleanup').value, 'archive');
  assert.equal(p.saved.length, 1);
  await p.change('delete');
  await p.click('cleanupSettingConfirm', 'Delete after each job');
  assert.deepEqual(p.saved[1], { chatCleanup: 'delete' });
  await p.change('keep');
  assert.deepEqual(p.saved[2], { chatCleanup: 'keep' });
  assert.match(p.nodes.get('cleanupHint').textContent, /last 100 jobs; older chats are not known/);
});

test('popup delete all: first click sends nothing, cancel keeps preview, second confirmation sends confirmed true', async () => {
  const p = await popup({ reply: m => m.type === 'cleanup:preview' ? { ok: true, result: { eligible: [{ id: 'a' }, { id: 'b' }], kept: {}, keptTotal: 0, maxJobs: 87 } }
    : m.type === 'cleanup:start' ? { ok: true, queued: 0 } : undefined });
  await p.click('cleanupNow');
  assert.match(p.nodes.get('cleanupHint').textContent, /last 87 jobs/);
  const before = p.sent.length;
  await p.click('cleanupView', 'Delete all');
  assert.equal(p.sent.length, before);
  assert.match(p.nodes.get('cleanupView').textContent, /Delete 2 chats\? This can't be undone/);
  await p.click('cleanupView', 'Cancel');
  assert.equal(p.sent.length, before);
  await p.click('cleanupView', 'Delete all');
  await p.click('cleanupView', 'Delete 2 chats');
  assert.deepEqual(p.sent.filter(m => m.type === 'cleanup:start'), [{ type: 'cleanup:start', action: 'delete', confirmed: true }]);
  assert.equal(p.nodes.get('cleanupView').textContent, 'No Backdraw chats to clean up.');
});

test('popup archive: progress, stop, finished totals and kept reasons use the start response', async () => {
  let progress = null;
  const p = await popup({ reply: m => {
    if (m.type === 'cleanup:preview') return { ok: true, result: { eligible: [{}], kept: {}, keptTotal: 0 } };
    if (m.type === 'cleanup:start') {
      progress = { running: true, action: 'archive', done: 0, total: 2, failed: 0 };
      return { ok: true, queued: 2, kept: { failed: 2, text_reply: 1 }, keptTotal: 3 };
    }
    if (m.type === 'cleanup:status') return { ok: true, progress };
  } });
  await p.click('cleanupNow'); await p.click('cleanupView', 'Archive all');
  assert.deepEqual(p.sent.find(m => m.type === 'cleanup:start'), { type: 'cleanup:start', action: 'archive' });
  assert.match(p.nodes.get('cleanupView').textContent, /Archiving 0\/2/);
  progress = { ...progress, done: 1, archived: 1 };
  await p.poll();
  assert.match(p.nodes.get('cleanupView').textContent, /Archiving 1\/2/);
  await p.click('cleanupView', 'Stop');
  assert.ok(p.sent.some(m => m.type === 'cleanup:stop'));
  progress = { ...progress, running: false, error: 'tab_closed' };
  await p.poll();
  assert.match(p.nodes.get('cleanupView').textContent, /Done: 1 archived\.3 chats were left open: 2 failed jobs, 1 ChatGPT question\./);
  assert.match(p.nodes.get('cleanupView').textContent, /background ChatGPT tab was closed/);
  assert.equal([...p.timers.values()].some(t => t.ms === 1000), false);
});

test('popup reopen resumes running progress, clears timers on close and does not stop the worker', async () => {
  const p = await popup({ reply: m => m.type === 'cleanup:status'
    ? { ok: true, progress: { running: true, action: 'delete', done: 3, total: 12, failed: 1 } } : undefined });
  assert.equal(p.nodes.get('settings').hidden, false);
  assert.match(p.nodes.get('cleanupView').textContent, /Deleting 3\/12 · 1 failed/);
  p.lifecycle.pagehide(); p.lifecycle.unload();
  assert.equal(p.timers.size, 0);
  assert.equal(p.sent.some(m => m.type === 'cleanup:stop'), false);
});

test('popup preview: disconnected errors and no eligible chats show no archive/delete actions', async () => {
  for (const response of [{ ok: false, error: 'not_connected' }, { ok: true, result: { eligible: [], kept: { failed: 1 }, keptTotal: 1 } }]) {
    const p = await popup({ reply: m => m.type === 'cleanup:preview' ? response : undefined });
    await p.click('cleanupNow');
    const text = p.nodes.get('cleanupView').textContent;
    assert.doesNotMatch(text, /Archive all|Delete all/);
    if (response.ok) assert.equal(text, 'No Backdraw chats to clean up.1 chat will stay open: 1 failed job.');
    else assert.equal(text, translate('en')('errNotConnected'));
  }
});
