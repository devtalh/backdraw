'use strict';
// Builds the GitHub Release notes for a version from its CHANGELOG.md section.
// Usage: node scripts/release-notes.js <version> [changelog path]
const fs = require('node:fs');
const path = require('node:path');

const INSTALL_INTRO = [
  '**Install with one command:**',
  '',
  '```',
  'npx backdraw@latest setup',
  '```',
  '',
  'Setup installs Backdraw into `%USERPROFILE%\\.backdraw`, registers your browsers, adds Backdraw to the MCP clients you pick, and then waits while you load the extension. Loading the extension is the only step left to you.',
].join('\n');

const UPDATE = [
  '### Update',
  '- **Quick install:** run `npx backdraw@latest setup` again (reload Backdraw at `chrome://extensions` if setup asks), then restart your MCP client.',
  '- **Manual install:** run `git pull`, then `node install.js`, and reload the extension.',
].join('\n');

const DISCLAIMER = 'Not affiliated with OpenAI or Anthropic. Automating the ChatGPT web page may conflict with OpenAI\'s terms. Use Backdraw for personal use, with your own account, at your own risk.';

const fullListLine = version => `Full list: [CHANGELOG.md](https://github.com/devtalh/backdraw/blob/v${version}/CHANGELOG.md)`;

const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The text under "## [version]" up to the next "## [" heading, without the heading and the
// blank lines around it.
function changelogSection(changelog, version) {
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const heading = new RegExp(`^## \\[${escapeRegExp(version)}\\]`);
  const start = lines.findIndex(l => heading.test(l));
  if (start === -1) throw new Error(`CHANGELOG.md has no section for ${version}`);
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## ['));
  if (end === -1) end = lines.length;
  const body = lines.slice(start + 1, end);
  while (body.length && body[0].trim() === '') body.shift();
  while (body.length && body[body.length - 1].trim() === '') body.pop();
  if (!body.length) throw new Error(`CHANGELOG.md has no section for ${version}`);
  return body.join('\n');
}

function releaseNotes(changelog, version) {
  return [INSTALL_INTRO, changelogSection(changelog, version), UPDATE, fullListLine(version), DISCLAIMER].join('\n\n') + '\n';
}

function main(argv) {
  const version = String(argv[0] || '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    process.stderr.write(`Invalid version "${argv[0] || ''}". Usage: node scripts/release-notes.js <version> [changelog path]\n`);
    return 1;
  }
  const file = argv[1] || path.join(__dirname, '..', 'CHANGELOG.md');
  try {
    process.stdout.write(releaseNotes(fs.readFileSync(file, 'utf8'), version));
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 1;
  }
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { INSTALL_INTRO, UPDATE, DISCLAIMER, fullListLine, changelogSection, releaseNotes };
