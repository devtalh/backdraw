'use strict';
// Windows implementation: named pipe, native host registration for each Chromium browser
// (registry), user folders, installed browsers, and where the Claude Code CLI, the Claude desktop
// app and their configs live.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const identity = require('../identity');
const browsers = require('../lib/browsers');

const USER_TAG = (os.userInfo().username || 'user').replace(/[^A-Za-z0-9_.-]/g, '_');

function pipePath() {
  return `\\\\.\\pipe\\${identity.PIPE_PREFIX}-${USER_TAG}`;
}

// In the home folder, not under AppData: the Claude desktop app is an MSIX package, and AppData
// writes made from its processes are redirected into the package's private storage, where Chrome
// can't see them. The home folder itself is not redirected.
// home: the user's home folder; install.js passes it so its tests can use a temporary one.
function installDir(home = os.homedir()) {
  return path.join(home, identity.INSTALL_DIR_NAME);
}

function legacyInstallDir(home = os.homedir()) {
  return path.join(home, ...identity.LEGACY.INSTALL_DIR);
}

function claudeConfigFile(home = os.homedir()) {
  return path.join(home, '.claude.json');
}

// Chat MCP config of the Claude desktop app: the MSIX package's private copy and the classic one.
function desktopConfigFiles() {
  const files = [];
  const packages = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Packages');
  try {
    for (const dir of fs.readdirSync(packages)) {
      if (/^Claude_/i.test(dir)) files.push(path.join(packages, dir, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'));
    }
  } catch {}
  files.push(path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json'));
  return files.filter(f => fs.existsSync(f));
}

// Reads the output of the process query below: one executable path per line, '?' when a path
// can't be read. Claude Code's own claude.exe has the same process name but lives elsewhere and
// doesn't count; an unreadable path counts as the desktop app, to be safe.
function parseClaudeProcesses(out) {
  return String(out || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    .some(p => p === '?' || /\\WindowsApps\\|\\AnthropicClaude\\/i.test(p));
}

// True while the Claude desktop app runs (it rewrites its config on exit), false when it doesn't,
// null when that can't be told (PowerShell failed). With no claude process Get-Process reports an
// error even when silenced, so the script collects the result and exits 0 explicitly.
function desktopAppRunning() {
  let out;
  try {
    out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $p = @(Get-Process -Name claude -ErrorAction SilentlyContinue | ForEach-Object { if ($_.Path) { $_.Path } else { '?' } }); $p; exit 0"],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
  return parseClaudeProcesses(out);
}

// key: an id of browsers.HOST_KEYS (chrome, edge, chromium); Chrome's when left out.
const regSubkey = (hostName, key = 'chrome') => `${browsers.HOST_KEYS[key]}\\${hostName}`;
const regKey = (hostName, key) => `HKCU\\${regSubkey(hostName, key)}`;

// Same MSIX caveat for the registry: HKCU writes from inside the package go to a private copy.
// WMI's registry provider runs outside the package, so it writes the HKCU that Chrome reads.
function realRegistry(subkey, action, value = '') {
  const ps = `$ErrorActionPreference = 'Stop'
$hk = [uint32]2147483649
$k = '${subkey}'
function Reg($m, $a) { Invoke-CimMethod -Namespace root/default -ClassName StdRegProv -MethodName $m -Arguments $a }
if ('${action}' -eq 'delete') { [void](Reg 'DeleteKey' @{ hDefKey = $hk; sSubKeyName = $k }); exit 0 }
[void](Reg 'CreateKey' @{ hDefKey = $hk; sSubKeyName = $k })
$r = Reg 'SetStringValue' @{ hDefKey = $hk; sSubKeyName = $k; sValueName = ''; sValue = $env:BACKDRAW_VALUE }
if ($r.ReturnValue -ne 0) { throw "SetStringValue returned $($r.ReturnValue)" }
(Reg 'GetStringValue' @{ hDefKey = $hk; sSubKeyName = $k; sValueName = '' }).sValue`;
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
    { encoding: 'utf8', env: { ...process.env, BACKDRAW_VALUE: value } }).trim();
}

// Chrome starts the host through this launcher when the extension connects (native messaging).
function writeHostLauncher(dir, nodePath) {
  const bat = path.join(dir, 'host.bat');
  fs.writeFileSync(bat, `@echo off\r\n"${nodePath}" "%~dp0host.js" %*\r\n`);
  return bat;
}

// Returns where the registration lives, for display.
function registerNativeHost(hostName, manifestPath, key = 'chrome') {
  const full = regKey(hostName, key);
  try { execFileSync('reg.exe', ['delete', full, '/f'], { stdio: 'ignore' }); } catch {} // stale private copy, if any
  try {
    if (realRegistry(regSubkey(hostName, key), 'set', manifestPath) === manifestPath) return full;
  } catch {}
  execFileSync('reg.exe', ['add', full, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { stdio: 'ignore' });
  return full;
}

// Where a host's registration lives, for display (e.g. the uninstall dry run).
function nativeHostEntry(hostName, key = 'chrome') {
  return regKey(hostName, key);
}

function unregisterNativeHost(hostName, key = 'chrome') {
  try { realRegistry(regSubkey(hostName, key), 'delete'); } catch {}
  try { execFileSync('reg.exe', ['delete', regKey(hostName, key), '/f'], { stdio: 'ignore' }); } catch {}
}

// For `backdraw doctor`: in one PowerShell run, through WMI (the real registry, also from inside an
// MSIX package), the registration of `hostName` under every host key, and each browser's native
// messaging policies from HKLM and HKCU (lists are policy subkeys with numbered string values).
// Returns the raw JSON text; parseBrowserRegistry() reads it.
function readBrowserRegistry(hostName) {
  const query = {
    hosts: Object.keys(browsers.HOST_KEYS).map(id => ({ id, key: regSubkey(hostName, id) })),
    policies: browsers.BROWSERS.map(b => ({ id: b.id, policyKey: b.policyKey })),
  };
  const ps = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
function Reg($m, $a) { Invoke-CimMethod -Namespace root/default -ClassName StdRegProv -MethodName $m -Arguments $a }
$hives = @(@('hklm', [uint32]2147483650), @('hkcu', [uint32]2147483649))
$q = $env:BACKDRAW_QUERY | ConvertFrom-Json
$hosts = @{}
foreach ($h in $q.hosts) { $hosts[$h.id] = (Reg 'GetStringValue' @{ hDefKey = [uint32]2147483649; sSubKeyName = $h.key; sValueName = '' }).sValue }
$policies = @{}
foreach ($b in $q.policies) {
  $policy = @{}
  foreach ($h in $hives) {
    $d = Reg 'GetDWORDValue' @{ hDefKey = $h[1]; sSubKeyName = $b.policyKey; sValueName = 'NativeMessagingUserLevelHosts' }
    $p = @{ userLevelHosts = $(if ($d.ReturnValue -eq 0) { [int]$d.uValue } else { $null }) }
    foreach ($l in 'NativeMessagingBlocklist', 'NativeMessagingAllowlist') {
      $sub = "$($b.policyKey)\\$l"
      $e = Reg 'EnumValues' @{ hDefKey = $h[1]; sSubKeyName = $sub }
      $vals = @()
      if ($e.ReturnValue -eq 0 -and $e.sNames) { foreach ($n in $e.sNames) { $vals += [string](Reg 'GetStringValue' @{ hDefKey = $h[1]; sSubKeyName = $sub; sValueName = $n }).sValue } }
      $p[$l] = $vals
    }
    $policy[$h[0]] = $p
  }
  $policies[$b.id] = $policy
}
ConvertTo-Json -InputObject @{ hosts = $hosts; policies = $policies } -Depth 6 -Compress`;
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
    { encoding: 'utf8', env: { ...process.env, BACKDRAW_QUERY: JSON.stringify(query) }, stdio: ['ignore', 'pipe', 'ignore'] });
}

// { hosts: { chrome: manifest path or null, edge, chromium },
//   policies: { <browser id>: { userLevelHosts, blocklist, allowlist } } }.
// A machine (HKLM) policy wins over the same user (HKCU) policy.
function parseBrowserRegistry(text) {
  const raw = JSON.parse(String(text).replace(/^\uFEFF/, '').trim() || '{}');
  const list = v => [].concat(v === null || v === undefined ? [] : v).map(String);
  const hosts = {};
  for (const id of Object.keys(browsers.HOST_KEYS)) hosts[id] = (raw.hosts || {})[id] || null;
  const policies = {};
  for (const [id, policy] of Object.entries(raw.policies || {})) {
    const pick = (name, read) => {
      for (const hive of ['hklm', 'hkcu']) {
        const v = read(((policy || {})[hive] || {})[name]);
        if (v !== undefined) return v;
      }
      return undefined;
    };
    policies[id] = {
      userLevelHosts: pick('userLevelHosts', v => (v === null || v === undefined ? undefined : Number(v) !== 0)),
      blocklist: pick('NativeMessagingBlocklist', v => (list(v).length ? list(v) : undefined)) || [],
      allowlist: pick('NativeMessagingAllowlist', v => (list(v).length ? list(v) : undefined)) || [],
    };
  }
  return { hosts, policies };
}

// Program Files, Program Files (x86) and LocalAppData: where browsers install themselves.
function programRoots() {
  const env = process.env;
  return [env.ProgramFiles || 'C:\\Program Files', env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')];
}

// The executable of a browser, or null when it isn't installed.
function browserExe(browser) {
  const b = browsers.byId(browser);
  for (const root of programRoots()) {
    const exe = path.join(root, b.exe);
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

function detectBrowsers() {
  return browsers.BROWSERS.filter(b => browserExe(b.id)).map(b => b.id);
}

// Opens a browser page (e.g. its extensions page) in that browser, if it is installed.
function openInBrowser(browser, url) {
  const exe = browserExe(browser);
  if (!exe) return false;
  const child = spawn(exe, [url], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return true;
}

function openFolder(dir) {
  const child = spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

// Through PowerShell (clip.exe mangles non-ASCII paths). Returns whether it worked.
function copyToClipboard(text) {
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -Value $env:BACKDRAW_CLIP'],
      { stdio: 'ignore', env: { ...process.env, BACKDRAW_CLIP: text } });
    return true;
  } catch { return false; }
}

// The first match of a command on PATH, or null.
function which(cmd) {
  try { return execFileSync('where.exe', [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/)[0].trim() || null; } catch { return null; }
}

function appDataDir() {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

function picturesDir() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Environment]::GetFolderPath('MyPictures')"], { encoding: 'utf8' }).trim();
    if (out && fs.existsSync(out)) return out;
  } catch {}
  return path.join(os.homedir(), 'Pictures');
}

function claudeCli() {
  const local = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
  if (fs.existsSync(local)) return local;
  return which('claude');
}

// Opens Explorer with the file selected. No shell: explorer.exe is started directly. Its own parser
// splits "/select," arguments at commas, so the path is always quoted (a Windows path never holds ").
function revealInFolder(file, run = spawn) {
  if (typeof file !== 'string' || !path.win32.isAbsolute(file) || file.includes('"')) throw new Error('Not an absolute file path.');
  const child = run('explorer.exe', ['/select,', `"${file}"`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true });
  child.on('error', () => {});
  child.unref();
}

module.exports = {
  pipePath, installDir, legacyInstallDir, claudeConfigFile, desktopConfigFiles, desktopAppRunning, parseClaudeProcesses,
  writeHostLauncher, registerNativeHost, unregisterNativeHost, nativeHostEntry, readBrowserRegistry, parseBrowserRegistry,
  detectBrowsers, browserExe, openInBrowser, openFolder, copyToClipboard, which, appDataDir,
  picturesDir, claudeCli,
  revealInFolder,
};
