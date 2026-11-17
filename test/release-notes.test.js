'use strict';
// GitHub Release notes come from CHANGELOG.md: the right section, the fixed install text around
// it, and the same result as the hand-written v2.4.1 release (minus its "New in" paragraph).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const test = require('node:test');
const { INSTALL_INTRO, UPDATE, DISCLAIMER, changelogSection, releaseNotes } = require('../scripts/release-notes');

const ROOT = path.join(__dirname, '..');
const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'release-v2.4.1.md'), 'utf8').replace(/\r\n/g, '\n');

// Independent reference: the lines between "## [version]" and the next "## [" heading.
function expectedSection(version) {
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const start = lines.indexOf(lines.find(l => l.startsWith(`## [${version}] `)));
  assert.ok(start >= 0, `CHANGELOG.md has ## [${version}]`);
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith('## [')) end += 1;
  return lines.slice(start + 1, end).join('\n').trim();
}

const run = args => new Promise(resolve => {
  execFile(process.execPath, args, { cwd: ROOT }, (e, stdout, stderr) => resolve({ code: e ? e.code : 0, stdout, stderr }));
});

test('changelogSection returns exactly the lines of the version, without its heading', () => {
  const cases = [
    { version: '2.4.1', first: '### Fixed', next: 'Chat cleanup in the popup' },
    { version: '2.4.0', first: '### Added', next: 'Local `animate_sheet` tool' },
    { version: '2.1.2', first: '### Added', next: '`backdraw mcp` runs the MCP server on stdio' },
  ];
  for (const { version, first, next } of cases) {
    const section = changelogSection(changelog, version);
    assert.equal(section, expectedSection(version), version);
    assert.ok(section.startsWith(`${first}\n`), `${version} starts with ${first}`);
    assert.ok(!section.includes('## ['), `${version} has no version heading`);
    assert.ok(!section.includes(next), `${version} does not run into the next version`);
    assert.ok(changelog.includes(next), `the next version's text "${next}" is in CHANGELOG.md`);
  }
  assert.ok(!changelogSection(changelog, '2.4.1').includes('(#21)'), '2.4.1 has none of the 2.4.0 entries');
});

test('changelogSection throws for a missing version and does not match a longer one', () => {
  assert.throws(() => changelogSection(changelog, '9.9.9'), /CHANGELOG\.md has no section for 9\.9\.9/);
  const synthetic = '# Changelog\n\n## [2.4.10] - 2027-01-01\n\n### Fixed\n\n- Something.\n';
  assert.equal(changelogSection(synthetic, '2.4.10'), '### Fixed\n\n- Something.');
  assert.throws(() => changelogSection(synthetic, '2.4.1'), /no section for 2\.4\.1/);
  assert.throws(() => changelogSection('## [2.4.1] - 2027-01-01\n\n\n## [2.4.0]\n\n- x\n', '2.4.1'), /no section for 2\.4\.1/, 'an empty section');
  assert.throws(() => changelogSection('## [2x4x1] - 2027-01-01\n\n- x\n', '2.4.1'), /no section for 2\.4\.1/, 'dots are literal');
});

test('a CRLF changelog gives the same section', () => {
  const crlf = changelog.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  for (const v of ['2.4.1', '2.4.0', '2.1.2']) assert.equal(changelogSection(crlf, v), changelogSection(changelog, v), v);
  assert.equal(releaseNotes(crlf, '2.4.1'), releaseNotes(changelog, '2.4.1'));
  assert.ok(!releaseNotes(crlf, '2.4.1').includes('\r'));
});

test('releaseNotes: install text first, then the section, update steps, full list and the disclaimer', () => {
  const notes = releaseNotes(changelog, '2.4.1');
  assert.ok(notes.startsWith('**Install with one command:**\n\n```\nnpx backdraw@latest setup\n```\n\nSetup installs Backdraw into '));
  assert.ok(notes.startsWith(`${INSTALL_INTRO}\n\n${changelogSection(changelog, '2.4.1')}\n\n${UPDATE}\n\n`));
  assert.ok(notes.endsWith(`\n\n${DISCLAIMER}\n`));
  assert.ok(!notes.endsWith('\n\n'));
  assert.ok(notes.includes('Full list: [CHANGELOG.md](https://github.com/devtalh/backdraw/blob/v2.4.1/CHANGELOG.md)'));
  assert.ok(!notes.includes('New in'));
  assert.ok(!notes.includes('\r'));
});

test('releaseNotes matches the v2.4.1 GitHub Release without its "New in" paragraph', () => {
  const newIn = fixture.match(/^New in 2\.4\.1: .+\n\n/gm);
  assert.equal(newIn && newIn.length, 1, 'the fixture has one "New in" paragraph');
  const withoutNewIn = fixture.replace(newIn[0], '');
  assert.notEqual(withoutNewIn, fixture);
  assert.equal(releaseNotes(changelog, '2.4.1'), withoutNewIn);
});

test('CLI: prints the notes for a version (v prefix allowed) and exits 1 for an unknown one', async () => {
  const ok = await run(['scripts/release-notes.js', 'v2.4.1']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.stdout, releaseNotes(changelog, '2.4.1'));
  const missing = await run(['scripts/release-notes.js', '9.9.9']);
  assert.equal(missing.code, 1);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /no section for 9\.9\.9/);
  const invalid = await run(['scripts/release-notes.js', 'latest']);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /Invalid version/);
});

test('the release notes script is not shipped in the npm package', () => {
  const pkg = require('../package.json');
  assert.ok(!pkg.files.some(f => f === 'scripts' || f.startsWith('scripts/')));
});
