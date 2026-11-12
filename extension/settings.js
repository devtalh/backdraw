// The theme and language picked in the popup (chrome.storage.local "theme" and "language"), applied
// to an extension page. Loaded in <head> after i18n.js, so the colours are set before the first paint.
(() => {
  const THEMES = ['auto', 'light', 'dark'];
  const THEME_KEY = 'theme';
  const CLEANUP_KEY = 'chatCleanup';
  const CLEANUP_MODES = ['keep', 'archive', 'delete'];
  const cleanupMode = value => CLEANUP_MODES.includes(value) ? value : 'keep';
  const COPY = 'backdraw.theme'; // chrome.storage answers after the first paint; localStorage doesn't
  const root = document.documentElement;

  function applyTheme(theme) {
    root.dataset.theme = THEMES.includes(theme) ? theme : 'auto';
    try { localStorage.setItem(COPY, root.dataset.theme); } catch {}
    return root.dataset.theme;
  }

  let early = null;
  try { early = localStorage.getItem(COPY); } catch {}
  root.dataset.theme = THEMES.includes(early) ? early : 'auto';

  const ready = Promise.all([
    chrome.storage.local.get(THEME_KEY).then(r => r[THEME_KEY], () => undefined),
    i18n.load(),
  ]).then(([theme]) => {
    applyTheme(theme);
    root.lang = i18n.lang();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[THEME_KEY]) applyTheme(changes[THEME_KEY].newValue);
  });

  const set = (key, value) => chrome.storage.local.set({ [key]: value });
  const theme = () => root.dataset.theme;

  globalThis.backdrawSettings = { THEMES, THEME_KEY, CLEANUP_KEY, CLEANUP_MODES, cleanupMode, ready, set, theme, applyTheme };
})();
