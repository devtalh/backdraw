'use strict';
// The npm package: its "files" list ships every module the commands load (and nothing private),
// and setup deploys everything the package ships.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const test = require('node:test');
const { FILES } = require('../install');

const ROOT = path.join(__dirname, '..');
const pkg = require('../package.json');
const rel = p => path.relative(ROOT, p).split(path.sep).join('/');

// npm "files": a folder entry covers what is inside it.
const shipped = file => pkg.files.some(f => (f.endsWith('/') ? file.startsWith(f) : file === f))
  || ['package.json', 'README.md', 'LICENSE'].includes(file);

// Every local file reachable through require() from these entry points.
function requiredFrom(entries) {
  const seen = new Set();
  const visit = file => {
    if (seen.has(file)) return;
    seen.add(file);
    if (!file.endsWith('.js')) return;
    for (const [, spec] of fs.readFileSync(file, 'utf8').matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      visit(require.resolve(path.resolve(path.dirname(file), spec)));
    }
  };
  entries.forEach(e => visit(path.join(ROOT, e)));
  return [...seen].map(rel);
}

test('the package ships every file the commands, the host and the MCP server load', () => {
  const files = requiredFrom([pkg.bin.backdraw, 'host.js', 'mcp-server.js', 'install.js', 'setup.js', 'doctor.js', 'cli.js']);
  for (const f of ['lib/toml.js', 'lib/mcp-clients.js', 'lib/browsers.js', 'lib/doctor.js', 'platform/win32.js', 'package.json']) assert.ok(files.includes(f), f);
  for (const f of files) assert.ok(shipped(f), `${f} is loaded but not in package.json "files"`);
});

test('the package ships the whole extension and nothing private', () => {
  assert.ok(pkg.files.includes('extension/'));
  for (const f of pkg.files) assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} does not exist`);
  for (const bad of ['data', 'logs', 'test', 'branding', '.demo', '.claude', 'CLAUDE.md', 'NIGHT_REPORT.md']) {
    assert.ok(!pkg.files.some(f => f.replace(/\/$/, '') === bad || f.startsWith(`${bad}/`)), bad);
  }
  assert.equal(pkg.private, undefined, 'a private package can\'t be published');
});

test('setup deploys every top-level file and folder the package ships', () => {
  for (const f of pkg.files.map(x => x.replace(/\/$/, '')).filter(x => !x.includes('/'))) assert.ok(FILES.includes(f), `${f} is shipped but not deployed`);
});

test('bin: the backdraw command has a node shebang and prints the package version', async () => {
  const bin = path.join(ROOT, pkg.bin.backdraw);
  assert.match(fs.readFileSync(bin, 'utf8'), /^#!\/usr\/bin\/env node\r?\n/);
  const out = await new Promise((resolve, reject) => execFile(process.execPath, [bin, '--version'], (e, stdout) => (e ? reject(e) : resolve(stdout))));
  assert.equal(out.trim(), pkg.version);
  const unknown = await new Promise(resolve => execFile(process.execPath, [bin, 'nope'], (e, stdout, stderr) => resolve({ code: e && e.code, stderr })));
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Unknown command "nope"/);
});
