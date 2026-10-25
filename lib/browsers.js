'use strict';
// The Chromium browsers Backdraw registers its native host for (Windows). A browser looks a per-user
// host up under HKCU\<key>\<host name> (default value = path of the host manifest), trying its keys
// in order and using the first one that is there:
//   Chrome     Google\Chrome                       (developer.chrome.com, native messaging)
//   Edge       Microsoft\Edge, Chromium, Chrome    (learn.microsoft.com, Edge native messaging)
//   Chromium   Chromium, Chrome                    (chromium launch_context_win.cc, CHROMIUM_BRANDING)
//   Brave      Chromium, Chrome                    (a Chromium-branded build; it has no key of its own)
// Backdraw writes each target browser's first key. Policies live under HKLM and HKCU\<policyKey>.
//   exe   where its executable can be (each channel), relative to Program Files, Program Files (x86)
//         or LocalAppData
//   page  its extensions page
// Chrome's key is always written: every Chrome channel (Beta, Dev, Canary, a portable copy) reads
// it, and the others fall back to it.
const HOST_KEYS = {
  chrome: 'Software\\Google\\Chrome\\NativeMessagingHosts',
  edge: 'Software\\Microsoft\\Edge\\NativeMessagingHosts',
  chromium: 'Software\\Chromium\\NativeMessagingHosts',
};

const BROWSERS = [
  {
    id: 'chrome', name: 'Google Chrome', keys: ['chrome'],
    policyKey: 'SOFTWARE\\Policies\\Google\\Chrome',
    exe: ['Chrome', 'Chrome Beta', 'Chrome Dev', 'Chrome SxS'].map(c => `Google\\${c}\\Application\\chrome.exe`),
    page: 'chrome://extensions',
  },
  {
    id: 'edge', name: 'Microsoft Edge', keys: ['edge', 'chromium', 'chrome'],
    policyKey: 'SOFTWARE\\Policies\\Microsoft\\Edge',
    exe: ['Edge', 'Edge Beta', 'Edge Dev', 'Edge SxS'].map(c => `Microsoft\\${c}\\Application\\msedge.exe`),
    page: 'edge://extensions',
  },
  {
    id: 'brave', name: 'Brave', keys: ['chromium', 'chrome'],
    policyKey: 'SOFTWARE\\Policies\\BraveSoftware\\Brave',
    exe: ['', '-Beta', '-Dev', '-Nightly'].map(c => `BraveSoftware\\Brave-Browser${c}\\Application\\brave.exe`),
    page: 'brave://extensions',
  },
  {
    id: 'chromium', name: 'Chromium', keys: ['chromium', 'chrome'],
    policyKey: 'SOFTWARE\\Policies\\Chromium',
    exe: ['Chromium\\Application\\chrome.exe'],
    page: 'chrome://extensions',
  },
];

const byId = id => BROWSERS.find(b => b.id === id);

// The registry keys (ids of HOST_KEYS) to write for these browsers, once each.
const keysFor = browserIds => [...new Set(browserIds.map(id => byId(id).keys[0]))];

// The manifest path a browser will use: the value of the first of its keys that is set.
//   values: { chrome: path | null, edge: …, chromium: … }
function effectiveHost(browser, values) {
  for (const key of browser.keys) if (values[key]) return { key, path: values[key] };
  return null;
}

// Whether a browser's policies stop it from starting a per-user (HKCU) native host:
//   policies: { userLevelHosts: true | false | undefined, blocklist: [...], allowlist: [...] }
// The allowlist only matters for a host the blocklist names (by name or "*"). Returns null when
// nothing blocks it, or the reason.
function policyProblem(policies, hostName) {
  if (!policies) return null;
  if (policies.userLevelHosts === false) {
    return 'the NativeMessagingUserLevelHosts policy is off, so per-user hosts (like Backdraw\'s) are ignored';
  }
  const blocked = (policies.blocklist || []).some(n => n === '*' || n === hostName);
  if (blocked && !(policies.allowlist || []).includes(hostName)) return 'the NativeMessagingBlocklist policy blocks Backdraw\'s host';
  return null;
}

module.exports = { HOST_KEYS, BROWSERS, byId, keysFor, effectiveHost, policyProblem };
