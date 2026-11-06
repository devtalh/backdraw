// The popup's setup checklist and status texts, worked out from the worker's popup:status answer.
// No chrome.* calls here, so the tests can load it too.
(() => {
  const STEP_TITLES = { bridge: 'stepBridge', chatgpt: 'stepChatgpt', project: 'stepProject', ready: 'stepReady' };
  // The steps of a running job (background.js ctx.progress) and their texts in i18n.js.
  const JOB_STEPS = {
    starting: 'jobStarting', opening: 'jobOpening', attaching: 'jobAttaching', typing: 'jobTyping', sending: 'jobSending',
    generating: 'jobGenerating', reattaching: 'jobReattaching', animating: 'jobAnimating', verifying: 'jobVerifying', downloading: 'jobDownloading',
    needs_human: 'jobNeedsHuman', resuming: 'jobResuming',
  };

  // s: the popup:status answer (null when the worker did not answer); acknowledged: the user pressed
  // Done on the last step once. A step is 'done', 'todo' (the user has something to do) or 'wait'
  // (it can't be told yet, or an earlier step comes first). The checklist is shown until it was
  // finished once, and again whenever a step needs the user.
  function setupSteps(s, acknowledged) {
    const connected = !!(s && s.connected);
    const chat = (s && s.chatgpt) || {};
    const bridge = connected ? 'done' : 'todo';
    const chatgpt = chat.challenge ? 'todo' : chat.loggedIn === true ? 'done' : chat.loggedIn === false ? 'todo' : 'wait';
    const project = s && s.project ? 'done' : connected ? 'todo' : 'wait';
    const ready = [bridge, chatgpt, project].every(x => x === 'done') ? (acknowledged ? 'done' : 'todo') : 'wait';
    const steps = [{ id: 'bridge', state: bridge }, { id: 'chatgpt', state: chatgpt }, { id: 'project', state: project }, { id: 'ready', state: ready }];
    return { steps, wizard: !acknowledged || steps.some(x => x.state === 'todo'), done: steps.filter(x => x.state === 'done').length };
  }

  // A ChatGPT project page (or a chat inside a project) in the active tab can be picked directly.
  function projectFromTab(tab) {
    const m = /^https:\/\/chatgpt\.com\/g\/(g-p-[0-9a-f]+)(-[^/?#]*)?(\/project)?/i.exec((tab && tab.url) || '');
    if (!m) return null;
    const fromTitle = m[3] ? String(tab.title || '').replace(/\s*[-|–]\s*ChatGPT\s*$/i, '').replace(/^ChatGPT\s*[-|–]\s*/i, '').trim() : '';
    return { url: `https://chatgpt.com/g/${m[1]}${m[2] || ''}/project`, name: fromTitle || (m[2] || '').slice(1) || m[1] };
  }

  // A project's link may carry its name (…/g/g-p-abc-images/project) or not (one picked from the list).
  const projectId = url => ((/\/g\/(g-p-[0-9a-f]+)/i.exec(String(url || '')) || [])[1] || '').toLowerCase();
  const sameProject = (a, b) => !!(a && b && projectId(a.url)) && projectId(a.url) === projectId(b.url);

  // The running job in the popup's language; ChatGPT's own progress (a percentage) is kept.
  function jobText(current, t) {
    if (!current) return t('idle');
    const key = JOB_STEPS[current.step];
    const text = key ? t(key) : current.message || current.step || '';
    const pct = (/(\d{1,3})%/.exec(current.message || '') || [])[1];
    return pct ? t('jobPercent', { step: text, pct }) : text;
  }

  // The ChatGPT row of the status list.
  function chatgptText(chat, t) {
    const c = chat || {};
    return c.challenge ? t('verification') : c.loggedIn === true ? t('signedIn') : c.loggedIn === false ? t('signedOut') : t('notChecked');
  }

  const api = { STEP_TITLES, JOB_STEPS, setupSteps, projectFromTab, sameProject, jobText, chatgptText };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else globalThis.backdrawSetup = api;
})();
