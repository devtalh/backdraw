const $ = id => document.getElementById(id);
const { t } = i18n;
const { STEP_TITLES, setupSteps, projectFromTab, sameProject, jobText, chatgptText } = backdrawSetup;
const ACK_KEY = 'setupDone'; // chrome.storage.local: the user finished the checklist once
const MARKS = { done: '✓', todo: '✗', wait: '…' };

let status = null; // the worker's last popup:status answer
let acknowledged = false;
let tabProject = null; // a ChatGPT project open in the active tab
let windowId = null;
let shownSig = '';
let shownJob = null;
let collectionsLoaded = false;
// What was started from this popup: the project list, a project being resolved, a failed check.
const ui = { projects: null, projectsError: '', resolving: '', checkError: '' };

function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children.filter(c => c !== null && c !== undefined));
  return e;
}

const hideHome = text => i18n.shortPath(text, status && status.home);
const note = (text, cls = '') => el('p', { className: `note ${cls}` }, text);
const busyNote = text => el('p', { className: 'note' }, el('span', { className: 'spinner' }), text);
const button = (text, onclick, cls = 'btn') => el('button', { className: cls, textContent: text, onclick });
const primary = (text, onclick) => button(text, onclick, 'btn primary');
const actions = (...buttons) => el('div', { className: 'actions' }, ...buttons);

async function ask(type, extra = {}) {
  return chrome.runtime.sendMessage({ type, ...extra }).catch(e => ({ ok: false, error: e.message }));
}

function copyBox(text) {
  const btn = el('button', { textContent: t('copy') });
  btn.onclick = () => navigator.clipboard.writeText(text).then(() => {
    btn.textContent = t('copied');
    setTimeout(() => { btn.textContent = t('copy'); }, 1500);
  }, () => {});
  return el('div', { className: 'copy' }, el('code', { textContent: text }), btn);
}

// ---------------------------------------------------------------- setup steps

function bridgeBody(state) {
  if (state === 'done') return [note(t('bridgeOk'))];
  return [
    note(t('bridgeMissing')),
    status && status.lastError ? note(t('chromeSays', { error: hideHome(status.lastError) }), 'err') : null,
    note(t('bridgeFix')),
    copyBox('node install.js'),
    note(t('bridgeReload')),
    actions(button(t('retry'), async () => { await ask('popup:reconnect'); refresh(); })),
  ];
}

function chatgptBody(state) {
  const c = (status && status.chatgpt) || {};
  if (c.checking) return [busyNote(t('chatgptChecking'))];
  const error = ui.checkError ? note(ui.checkError, 'err') : null;
  const open = label => primary(label, () => chrome.tabs.create({ url: 'https://chatgpt.com/' }));
  if (state === 'done') return [note(t('chatgptIn'))];
  if (c.challenge) return [note(t('chatgptChallenge')), error, actions(open(t('openChatgpt')), button(t('checkAgain'), checkChatgpt))];
  if (c.loggedIn === false) return [note(t('chatgptOut')), error, actions(open(t('openChatgptSignIn')), button(t('checkAgain'), checkChatgpt))];
  return [note(t('chatgptUnknown')), error, actions(primary(t('checkNow'), checkChatgpt))];
}

function projectList() {
  if (ui.resolving) return busyNote(ui.resolving);
  if (ui.projects === 'loading') return busyNote(t('loadingProjects'));
  if (!Array.isArray(ui.projects)) return null;
  if (!ui.projects.length) return note(t('noProjects'));
  return el('div', { className: 'projects' }, ...ui.projects.map(p => button(p.name, () => useProject(p))));
}

function projectBody(state) {
  if (state === 'done') return [note(t('projectUsing', { name: status.project.name }))];
  if (state === 'wait') return [note(t('projectNeedsBridge'))];
  return [
    note(t('projectGuide')),
    actions(tabProject ? primary(t('useProject', { name: tabProject.name }), () => useProject(tabProject)) : null,
      ui.projects ? null : button(t('chooseProject'), loadProjects)),
    projectList(),
    ui.projectsError ? note(ui.projectsError, 'err') : null,
  ];
}

function readyBody(state) {
  if (state === 'wait') return [note(t('readyWaiting'))];
  return [
    note(t('readyIntro')),
    copyBox(t('examplePrompt')),
    note(t('readyCollections')),
    state === 'todo' ? actions(primary(t('gotIt'), acknowledge)) : null,
  ];
}

const BODIES = { bridge: bridgeBody, chatgpt: chatgptBody, project: projectBody, ready: readyBody };

function stepItem({ id, state }) {
  return el('li', { className: `step ${state}` },
    el('span', { className: 'mark', textContent: MARKS[state] }),
    el('div', { className: 'step-body' }, el('div', { className: 'step-title', textContent: t(STEP_TITLES[id]) }), ...BODIES[id](state)));
}

// ---------------------------------------------------------------- what the buttons do

// The worker opens chatgpt.com in a background tab, looks at the page (never at cookies) and closes it.
async function checkChatgpt() {
  ui.checkError = '';
  status = { ...status, chatgpt: { ...(status && status.chatgpt), checking: true } };
  render();
  const r = await ask('popup:check-chatgpt');
  if (!r || !r.ok) ui.checkError = hideHome((r && r.error) || t('errChatgptCheck'));
  refresh();
}

async function loadProjects() {
  Object.assign(ui, { projects: 'loading', projectsError: '' });
  render();
  const r = await ask('popup:projects');
  Object.assign(ui, r && r.ok ? { projects: r.projects } : { projects: null, projectsError: hideHome((r && r.error) || t('selectFailed')) });
  render();
}

// A project from the sidebar may come without its link: the worker opens it once to read it.
async function useProject(p) {
  let project = p.url ? { name: p.name, url: p.url } : null;
  ui.projectsError = '';
  if (!project) {
    ui.resolving = `${p.name}…`;
    render();
    const r = await ask('popup:resolve-project', { name: p.name });
    ui.resolving = '';
    if (r && r.ok) project = { name: r.project.name, url: r.project.url };
    else ui.projectsError = hideHome((r && r.error) || t('selectFailed'));
  }
  if (project) {
    const r = await ask('popup:select', { project });
    if (r && r.ok) ui.projects = null;
    else ui.projectsError = hideHome((r && r.error) || t('selectFailed'));
  }
  setTimeout(refresh, 300);
}

async function acknowledge() {
  acknowledged = true;
  await chrome.storage.local.set({ [ACK_KEY]: true }).catch(() => {});
  render();
}

// ---------------------------------------------------------------- the popup

function renderStatus(s) {
  const chat = s.chatgpt || {};
  $('conn').textContent = s.connected ? t('connected') : t('notConnected');
  $('conn').className = s.connected ? 'ok' : 'bad';
  $('chat').className = chat.challenge || chat.loggedIn === false ? 'bad' : chat.loggedIn ? 'ok' : '';
  $('chat').replaceChildren(...(chat.checking ? [el('span', { className: 'spinner' }), t('chatgptChecking')]
    : [chatgptText(chat, t), chat.loggedIn === true && !chat.challenge ? null : el('button', { className: 'link', textContent: t('checkNow'), onclick: checkChatgpt })]
      .filter(Boolean)));
  $('project').textContent = s.project ? s.project.name : t('notSelected');
  $('project').title = s.project ? s.project.url : '';
  const pick = $('pick');
  pick.hidden = !(s.connected && tabProject && !sameProject(s.project, tabProject));
  pick.textContent = tabProject ? t('useProject', { name: tabProject.name }) : '';
  pick.onclick = () => useProject(tabProject);
}

function render() {
  const s = status || {};
  const setup = setupSteps(status, acknowledged);
  const chat = s.chatgpt || {};
  $('ver').textContent = s.version || '?';
  $('wizard').hidden = !setup.wizard;
  $('overview').hidden = setup.wizard;
  // Rebuilt only when something shown changed, so a list or a "Copied" note isn't reset by the polling.
  const sig = JSON.stringify([s.connected, s.lastError, s.project, chat.loggedIn, chat.challenge, chat.checking, s.home,
    tabProject, acknowledged, ui, i18n.lang()]);
  if (sig !== shownSig) {
    shownSig = sig;
    $('setupCount').textContent = t('setupCount', { done: setup.done, total: setup.steps.length });
    $(setup.wizard ? 'steps' : 'doneSteps').replaceChildren(...setup.steps.map(stepItem));
    $(setup.wizard ? 'doneSteps' : 'steps').replaceChildren();
    renderStatus(s);
  }
  // Rebuilt only when its text changes, so the spinner keeps turning between polls.
  const jobLine = s.current ? jobText(s.current, t) : t('idle');
  if (jobLine !== shownJob) {
    shownJob = jobLine;
    $('job').replaceChildren(...(s.current ? [el('span', { className: 'spinner' })] : []), jobLine);
  }
  $('collections').hidden = !s.connected;
  if (s.connected && !collectionsLoaded) {
    collectionsLoaded = true;
    showCollections();
  }
}

async function refresh() {
  try { status = await chrome.runtime.sendMessage({ type: 'popup:status' }); } catch { status = null; }
  render();
}

function setupSettings(prefs) {
  $('language').value = i18n.PREFERENCES.includes(prefs[i18n.LANGUAGE_KEY]) ? prefs[i18n.LANGUAGE_KEY] : 'auto';
  $('theme').value = backdrawSettings.theme();
  setupCleanup(prefs);
  $('settingsBtn').onclick = () => {
    const open = $('settings').hidden;
    $('settings').hidden = !open;
    $('settingsBtn').setAttribute('aria-expanded', String(open));
  };
  $('language').onchange = () => backdrawSettings.set(i18n.LANGUAGE_KEY, $('language').value);
  $('theme').onchange = () => {
    backdrawSettings.applyTheme($('theme').value);
    backdrawSettings.set(backdrawSettings.THEME_KEY, $('theme').value);
  };
  i18n.watch(() => {
    document.documentElement.lang = i18n.lang();
    i18n.apply();
    renderCleanupSetting();
    renderCleanup();
    render();
    if (collectionsLoaded && !openCol) showCollections();
  });
}

// The side panel (gallery) only exists when the manifest declares one.
function setupGallery() {
  if (!chrome.sidePanel || !chrome.runtime.getManifest().side_panel || windowId === null) return;
  $('gallery').hidden = false;
  // Opened straight from the click: Chrome opens a side panel only for a user gesture.
  $('gallery').onclick = () => chrome.sidePanel.open({ windowId }).then(() => window.close(), () => {});
}

async function start() {
  await backdrawSettings.ready;
  const prefs = await chrome.storage.local.get([i18n.LANGUAGE_KEY, ACK_KEY, backdrawSettings.CLEANUP_KEY]).catch(() => ({}));
  acknowledged = !!prefs[ACK_KEY];
  document.documentElement.lang = i18n.lang();
  i18n.apply();
  setupSettings(prefs);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  tabProject = projectFromTab(tab);
  windowId = tab ? tab.windowId : null;
  setupGallery();
  await refresh();
  if (!popupClosed) refreshTimer = setInterval(refresh, 1500);
}

// ---------------------------------------------------------------- chat cleanup

const { keptSummary, progressText, finishText, errorText } = backdrawCleanupText;
let savedCleanupMode = 'keep';
let cleanupDeletePending = false;
let cleanupSettingSaving = false;
let cleanupSettingError = false;
let cleanupMaxJobs = 100;
let cleanupView = 'idle';
let cleanupPreview = null;
let cleanupStart = null;
let cleanupProgress = null;
let cleanupError = null;
let cleanupStopping = false;
let cleanupSignature = '';
let cleanupTimer = null;
let refreshTimer = null;
let popupClosed = false;

function renderCleanupSetting() {
  $('chatCleanup').value = cleanupDeletePending ? 'delete' : savedCleanupMode;
  $('chatCleanup').disabled = cleanupSettingSaving;
  $('cleanupHint').textContent = t('cleanupHint', { max: cleanupMaxJobs });
  const box = $('cleanupSettingConfirm');
  box.hidden = !cleanupDeletePending && !cleanupSettingError;
  box.replaceChildren();
  if (cleanupSettingError) box.append(note(t('cleanupErrUnknown'), 'err'));
  if (!cleanupDeletePending) return;
  const yes = button(t('cleanupDeleteAfterJob'), () => saveCleanupMode('delete'), 'btn danger');
  const no = button(t('cancel'), () => {
    cleanupDeletePending = false;
    cleanupSettingError = false;
    renderCleanupSetting();
  });
  yes.disabled = no.disabled = cleanupSettingSaving;
  box.append(note(t('cleanupDeleteWarning')), actions(yes, no));
}

async function saveCleanupMode(value) {
  if (cleanupSettingSaving) return;
  cleanupSettingSaving = true;
  cleanupSettingError = false;
  renderCleanupSetting();
  try {
    await backdrawSettings.set(backdrawSettings.CLEANUP_KEY, value);
    savedCleanupMode = value;
  } catch {
    cleanupSettingError = true;
  }
  cleanupDeletePending = false;
  cleanupSettingSaving = false;
  renderCleanupSetting();
}

function setupCleanup(prefs) {
  savedCleanupMode = backdrawSettings.cleanupMode(prefs[backdrawSettings.CLEANUP_KEY]);
  renderCleanupSetting();
  $('chatCleanup').onchange = () => {
    const value = backdrawSettings.cleanupMode($('chatCleanup').value);
    cleanupDeletePending = value === 'delete';
    cleanupSettingError = false;
    if (cleanupDeletePending) renderCleanupSetting();
    else saveCleanupMode(value);
  };
  $('cleanupNow').onclick = previewCleanup;
  pollCleanup(true);
}

function renderCleanup() {
  const signature = JSON.stringify([cleanupView, cleanupPreview, cleanupStart, cleanupProgress, cleanupError, cleanupStopping, i18n.lang()]);
  if (signature === cleanupSignature) return;
  cleanupSignature = signature;
  $('cleanupNow').disabled = ['loading', 'starting', 'tracking'].includes(cleanupView);
  const box = $('cleanupView');
  box.hidden = cleanupView === 'idle';
  box.replaceChildren();
  if (cleanupView === 'loading' || cleanupView === 'starting') box.append(busyNote(t('loading')));
  if (cleanupView === 'preview' || cleanupView === 'confirm') {
    const n = cleanupPreview.eligible.length;
    box.append(note(t(n ? (n === 1 ? 'cleanupEligible_one' : 'cleanupEligible') : 'cleanupEmpty', { n })));
    const kept = keptSummary(cleanupPreview.kept, cleanupPreview.keptTotal, t);
    if (kept) box.append(note(kept));
    if (n && cleanupView === 'preview') box.append(actions(
      button(t('cleanupArchiveAll'), () => startCleanup('archive')),
      button(t('cleanupDeleteAll'), () => { cleanupView = 'confirm'; renderCleanup(); }, 'btn danger')));
    if (n && cleanupView === 'confirm') box.append(el('div', { className: 'cleanup-confirm' },
      note(t(n === 1 ? 'cleanupConfirmDelete_one' : 'cleanupConfirmDelete', { n })),
      actions(button(t(n === 1 ? 'cleanupDeleteCount_one' : 'cleanupDeleteCount', { n }), () => startCleanup('delete', true), 'btn danger'),
        button(t('cancel'), () => { cleanupView = 'preview'; renderCleanup(); }))));
  }
  if (cleanupView === 'empty') box.append(note(t('cleanupEmpty')));
  if (cleanupView === 'tracking') {
    box.append(note(progressText(cleanupProgress, t)));
    const stop = button(t('cleanupStop'), stopCleanup);
    stop.disabled = cleanupStopping;
    box.append(actions(stop));
  }
  if (cleanupView === 'finished') {
    box.append(note(finishText(cleanupProgress, t)));
    const kept = keptSummary(cleanupProgress?.kept, cleanupProgress?.keptTotal, t, true);
    if (kept) box.append(note(kept));
    box.append(actions(button(t('cleanupDismiss'), dismissCleanup)));
  }
  if (cleanupError) box.append(note(errorText(cleanupError, t), 'err'));
}

async function previewCleanup() {
  if (['loading', 'starting', 'tracking'].includes(cleanupView)) return;
  cleanupView = 'loading';
  cleanupError = null;
  cleanupStart = null;
  renderCleanup();
  const r = await ask('cleanup:preview');
  if (popupClosed) return;
  if (!r?.ok) {
    cleanupView = 'error';
    cleanupError = r?.error || 'unknown';
  } else {
    cleanupPreview = r.result;
    if (Number.isInteger(r.result.maxJobs) && r.result.maxJobs > 0) cleanupMaxJobs = r.result.maxJobs;
    renderCleanupSetting();
    cleanupView = 'preview';
  }
  renderCleanup();
}

async function startCleanup(action, confirmed = false) {
  if (action === 'delete' && (cleanupView !== 'confirm' || !confirmed)) return;
  if (!['preview', 'confirm'].includes(cleanupView)) return;
  cleanupView = 'starting';
  cleanupError = null;
  renderCleanup();
  const r = await ask('cleanup:start', action === 'delete' ? { action, confirmed: true } : { action });
  if (popupClosed) return;
  if (!r?.ok) {
    cleanupView = 'error';
    cleanupError = r?.error || 'unknown';
  } else if (!r.queued) {
    cleanupView = 'empty';
  } else {
    cleanupStart = r;
    cleanupProgress = { running: true, action, done: 0, total: r.queued };
    cleanupView = 'tracking';
    await pollCleanup();
  }
  renderCleanup();
}

async function stopCleanup() {
  if (cleanupStopping) return;
  cleanupStopping = true;
  renderCleanup();
  const r = await ask('cleanup:stop');
  if (!r?.ok) {
    cleanupError = r?.error || 'unknown';
    cleanupStopping = false;
  }
  renderCleanup();
}

async function dismissCleanup() {
  const r = await ask('cleanup:dismiss');
  if (popupClosed) return;
  if (r?.ok) {
    cleanupProgress = null;
    cleanupError = null;
    cleanupView = 'idle';
  } else cleanupError = r?.error || 'unknown';
  renderCleanup();
}

async function pollCleanup(initial = false) {
  clearTimeout(cleanupTimer);
  if (popupClosed) return;
  const r = await ask('cleanup:status');
  if (popupClosed) return;
  // A delayed startup answer must not replace a preview or a confirmation already opened.
  if (initial && cleanupView !== 'idle') return;
  if (r?.ok && r.progress?.running) {
    cleanupProgress = r.progress || cleanupProgress;
    cleanupView = 'tracking';
    cleanupError = r.progress?.error || null;
    if (initial) {
      $('settings').hidden = false;
      $('settingsBtn').setAttribute('aria-expanded', 'true');
    }
  } else if (cleanupView === 'tracking' || (initial && r?.ok && r.progress?.error)) {
    if (r?.ok && r.progress) {
      cleanupProgress = r.progress;
      cleanupError = r.progress.error;
      cleanupView = 'finished';
      cleanupStopping = false;
      if (initial) {
        $('settings').hidden = false;
        $('settingsBtn').setAttribute('aria-expanded', 'true');
      }
    } else if (!r?.ok) cleanupError = r?.error || 'unknown';
  }
  renderCleanup();
  if (cleanupView === 'tracking') cleanupTimer = setTimeout(pollCleanup, 1000);
}

function closePopup() {
  popupClosed = true;
  clearTimeout(cleanupTimer);
  clearInterval(refreshTimer);
}
window.addEventListener('pagehide', closePopup);
window.addEventListener('unload', closePopup);

start();

// ---------------------------------------------------------------- reference collections

let openCol = null; // the collection shown in detail, or null for the list

async function hostCall(method, params = {}) {
  const r = await chrome.runtime.sendMessage({ type: 'host:call', method, params }).catch(e => ({ ok: false, error: e.message }));
  if (!r || !r.ok) throw new Error(hideHome((r && r.error) || t('errNotConnected')));
  return r.result;
}

function colMessage(text, bad) {
  $('colMsg').textContent = text || '';
  $('colMsg').className = bad ? 'bad' : '';
}

async function showCollections(text, bad) {
  openCol = null;
  $('colDetail').hidden = true;
  $('colList').hidden = false;
  let list;
  try {
    list = await hostCall('list_collections', { summary: true });
  } catch (e) {
    $('colList').replaceChildren();
    return colMessage(e.message, true);
  }
  $('colList').replaceChildren(...list.map(c => el('button', { className: 'btn', onclick: () => showCollection(c) },
    el('span', { textContent: c.name }), el('span', { className: 'count', textContent: i18n.images(c.count) }))));
  colMessage(text || (list.length ? '' : t('noCollections')), bad);
}

async function showCollection(c) {
  openCol = c;
  $('colList').hidden = true;
  $('colDetail').hidden = false;
  $('colEdit').hidden = true;
  $('colName').textContent = c.name;
  $('colPath').textContent = hideHome(c.path || '');
  $('colGrid').replaceChildren();
  colMessage(t('loading'));
  try {
    // Thumbnails come a page at a time (each answer from the host has to stay under 1 MB).
    for (let offset = 0; offset !== null && openCol === c;) {
      const page = await hostCall('collection_thumbs', { name: c.name, offset });
      if (openCol !== c) return;
      $('colGrid').append(...page.thumbs.map(th => thumbTile(c, th)));
      offset = Number.isInteger(page.next) ? page.next : null;
    }
    colMessage('');
  } catch (e) {
    colMessage(e.message, true);
  }
}

// The first click on × arms it; a second one within 3 s deletes the file.
function thumbTile(c, th) {
  const pic = th.data ? el('img', { src: `data:${th.mime};base64,${th.data}`, alt: th.file, title: th.file })
    : el('div', { className: 'noimg', textContent: `${th.file} (${t('noThumb')})` });
  const del = el('button', { textContent: '×', title: t('removeImage') });
  const tile = el('div', { className: 'tile' }, pic, del);
  let armed = null;
  del.onclick = async () => {
    if (!armed) {
      del.classList.add('armed');
      del.title = t('confirmRemoveImage');
      armed = setTimeout(() => { armed = null; del.classList.remove('armed'); del.title = t('removeImage'); }, 3000);
      return;
    }
    clearTimeout(armed);
    del.disabled = true;
    try {
      const r = await hostCall('delete_collection_image', { name: c.name, file: th.file });
      c.count = r.count;
      tile.remove();
      colMessage('');
    } catch (e) {
      del.disabled = false;
      colMessage(e.message, true);
    }
  };
  return tile;
}

$('colBack').onclick = () => showCollections();

$('colRename').onclick = () => {
  const c = openCol;
  const input = el('input', { value: c.name });
  const save = el('button', { className: 'btn primary', textContent: t('save') });
  const cancel = el('button', { className: 'btn', textContent: t('cancel'), onclick: () => { $('colEdit').hidden = true; } });
  save.onclick = async () => {
    try {
      const r = await hostCall('rename_collection', { name: c.name, newName: input.value });
      Object.assign(c, { name: r.name, path: r.path });
      $('colName').textContent = r.name;
      $('colPath').textContent = hideHome(r.path);
      $('colEdit').hidden = true;
      colMessage('');
    } catch (e) {
      colMessage(e.message, true);
    }
  };
  input.onkeydown = e => { if (e.key === 'Enter') save.click(); else if (e.key === 'Escape') cancel.click(); };
  $('colEdit').replaceChildren(input, save, cancel);
  $('colEdit').hidden = false;
  input.select();
};

$('colDelete').onclick = () => {
  const c = openCol;
  const yes = el('button', { className: 'btn danger', textContent: t('delete') });
  const no = el('button', { className: 'btn', textContent: t('cancel'), onclick: () => { $('colEdit').hidden = true; } });
  yes.onclick = async () => {
    yes.disabled = true;
    try {
      const r = await hostCall('delete_collection', { name: c.name });
      const left = r.failed.length ? r.failed : r.left;
      showCollections(left.length ? t('leftover', { files: left.join(', ') }) : '', left.length > 0);
    } catch (e) {
      yes.disabled = false;
      colMessage(e.message, true);
    }
  };
  $('colEdit').replaceChildren(el('p', { textContent: t('confirmDelete', { name: c.name, images: i18n.images(c.count) }) }), yes, no);
  $('colEdit').hidden = false;
};
