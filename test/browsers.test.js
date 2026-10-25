'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const browsers = require('../lib/browsers');
const { parseBrowserRegistry } = require('../platform/win32');

const HOST = 'io.example.host';

test('each browser reads the keys its vendor documents, in order', () => {
  assert.deepEqual(browsers.HOST_KEYS, {
    chrome: 'Software\\Google\\Chrome\\NativeMessagingHosts',
    edge: 'Software\\Microsoft\\Edge\\NativeMessagingHosts',
    chromium: 'Software\\Chromium\\NativeMessagingHosts',
  });
  assert.deepEqual(Object.fromEntries(browsers.BROWSERS.map(b => [b.id, b.keys])), {
    chrome: ['chrome'], edge: ['edge', 'chromium', 'chrome'], brave: ['chromium', 'chrome'], chromium: ['chromium', 'chrome'],
  });
  assert.deepEqual(Object.fromEntries(browsers.BROWSERS.map(b => [b.id, b.policyKey])), {
    chrome: 'SOFTWARE\\Policies\\Google\\Chrome', edge: 'SOFTWARE\\Policies\\Microsoft\\Edge',
    brave: 'SOFTWARE\\Policies\\BraveSoftware\\Brave', chromium: 'SOFTWARE\\Policies\\Chromium',
  });
});

test('keysFor: each target browser\'s first key, once', () => {
  assert.deepEqual(browsers.keysFor(['chrome']), ['chrome']);
  assert.deepEqual(browsers.keysFor(['brave', 'chromium']), ['chromium']);
  assert.deepEqual(browsers.keysFor(['chrome', 'edge', 'brave']), ['chrome', 'edge', 'chromium']);
});

test('effectiveHost: the first key that is set wins (Edge and Brave fall back to Chrome\'s)', () => {
  const only = { chrome: 'C:\\m.json', edge: null, chromium: null };
  for (const b of browsers.BROWSERS) assert.deepEqual(browsers.effectiveHost(b, only), { key: 'chrome', path: 'C:\\m.json' }, b.id);
  const shadowed = { chrome: 'C:\\m.json', edge: null, chromium: 'C:\\old.json' };
  assert.deepEqual(browsers.effectiveHost(browsers.byId('brave'), shadowed), { key: 'chromium', path: 'C:\\old.json' });
  assert.deepEqual(browsers.effectiveHost(browsers.byId('edge'), shadowed), { key: 'chromium', path: 'C:\\old.json' });
  assert.equal(browsers.effectiveHost(browsers.byId('chrome'), { chrome: null }), null);
});

test('policyProblem: user-level hosts off, or a blocklist that names the host or "*" without an allowlist entry', () => {
  assert.equal(browsers.policyProblem(undefined, HOST), null);
  assert.equal(browsers.policyProblem({ blocklist: [], allowlist: [] }, HOST), null);
  assert.match(browsers.policyProblem({ userLevelHosts: false }, HOST), /NativeMessagingUserLevelHosts/);
  assert.equal(browsers.policyProblem({ userLevelHosts: true }, HOST), null);
  assert.match(browsers.policyProblem({ blocklist: ['*'] }, HOST), /NativeMessagingBlocklist/);
  assert.match(browsers.policyProblem({ blocklist: [HOST] }, HOST), /NativeMessagingBlocklist/);
  assert.equal(browsers.policyProblem({ blocklist: ['*'], allowlist: [HOST] }, HOST), null);
  assert.equal(browsers.policyProblem({ blocklist: ['other.host'] }, HOST), null);
});

test('parseBrowserRegistry: host values, and machine policy over user policy (PowerShell\'s JSON shapes)', () => {
  const text = `\uFEFF${JSON.stringify({
    hosts: { chrome: 'C:\\m.json', edge: null },
    policies: {
      chrome: { hklm: { userLevelHosts: 0, NativeMessagingBlocklist: '*', NativeMessagingAllowlist: [] }, hkcu: { userLevelHosts: 1 } },
      edge: { hklm: { userLevelHosts: null, NativeMessagingBlocklist: [] }, hkcu: { userLevelHosts: 1, NativeMessagingBlocklist: ['a', 'b'] } },
      brave: { hklm: {}, hkcu: {} },
    },
  })}\r\n`;
  assert.deepEqual(parseBrowserRegistry(text), {
    hosts: { chrome: 'C:\\m.json', edge: null, chromium: null },
    policies: {
      chrome: { userLevelHosts: false, blocklist: ['*'], allowlist: [] },
      edge: { userLevelHosts: true, blocklist: ['a', 'b'], allowlist: [] },
      brave: { userLevelHosts: undefined, blocklist: [], allowlist: [] },
    },
  });
});
