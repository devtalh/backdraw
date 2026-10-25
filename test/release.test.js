'use strict';
// Release metadata stays consistent: one version everywhere, the MCP Registry entry, the Claude Code
// plugin, the README install buttons and the release workflow.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const json = f => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const pkg = json('package.json');
const server = json('server.json');
const plugin = json('plugin/.claude-plugin/plugin.json');
const marketplace = json('.claude-plugin/marketplace.json');
const pluginMcp = json('plugin/.mcp.json');

// The command every client entry starts (Windows: clients spawn npx without a shell).
const SERVER_COMMAND = { command: 'cmd', args: ['/c', 'npx', '-y', 'backdraw@latest', 'mcp'] };

test('one version: package.json, the extension, server.json and the plugin', () => {
  const versions = {
    'package.json': pkg.version,
    'extension/manifest.json': json('extension/manifest.json').version,
    'server.json': server.version,
    'server.json packages[0]': server.packages[0].version,
    'plugin.json': plugin.version,
  };
  for (const [where, v] of Object.entries(versions)) assert.equal(v, pkg.version, where);
});

test('server.json: the MCP Registry rules for an npm package', () => {
  assert.equal(server.$schema, 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json');
  assert.equal(server.name, 'io.github.devtalh/backdraw');
  assert.equal(pkg.mcpName, server.name, 'the registry checks mcpName in the npm package');
  assert.ok(server.description.length >= 1 && server.description.length <= 100, `description is ${server.description.length} characters`);
  assert.match(server.description, /Windows/);
  assert.match(server.description, /Chrome/);
  assert.deepEqual(server.repository, { url: 'https://github.com/devtalh/backdraw', source: 'github' });
  const [p] = server.packages;
  assert.equal(server.packages.length, 1);
  assert.equal(p.registryType, 'npm');
  assert.equal(p.identifier, pkg.name);
  assert.deepEqual(p.transport, { type: 'stdio' });
  assert.deepEqual(p.packageArguments, [{ type: 'positional', value: 'mcp' }]);
  assert.equal(p.environmentVariables, undefined);
});

test('the Claude Code marketplace points at the plugin folder, and the plugin runs the npx server', () => {
  assert.equal(marketplace.name, 'backdraw');
  assert.equal(marketplace.owner.name, 'devtalh');
  const [entry] = marketplace.plugins;
  assert.equal(entry.name, plugin.name);
  assert.equal(entry.source, './plugin');
  assert.ok(fs.existsSync(path.join(ROOT, entry.source, '.claude-plugin', 'plugin.json')));
  assert.equal(plugin.name, 'backdraw');
  assert.deepEqual(pluginMcp.mcpServers.backdraw, SERVER_COMMAND);
  const skill = fs.readFileSync(path.join(ROOT, 'plugin', 'skills', 'setup', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\ndescription: .+\ndisable-model-invocation: true\n---\n/);
  assert.match(skill, /npx backdraw@latest setup --clients=none/);
  // The plugin is a folder of its own: the repository's bin/ must not end up on the user's PATH.
  assert.ok(!fs.existsSync(path.join(ROOT, 'plugin', 'bin')));
});

test('the README buttons install the same command as the plugin', () => {
  for (const readme of ['README.md', 'README.tr.md']) {
    const text = fs.readFileSync(path.join(ROOT, readme), 'utf8');
    const cursor = /https:\/\/cursor\.com\/install-mcp\?name=backdraw&config=([^)\s]+)/.exec(text);
    assert.ok(cursor, `${readme}: Cursor button`);
    assert.deepEqual(JSON.parse(Buffer.from(decodeURIComponent(cursor[1]), 'base64').toString('utf8')), SERVER_COMMAND);
    const vscode = /https:\/\/insiders\.vscode\.dev\/redirect\/mcp\/install\?name=backdraw&config=([^)\s]+)/.exec(text);
    assert.ok(vscode, `${readme}: VS Code button`);
    assert.deepEqual(JSON.parse(decodeURIComponent(vscode[1])), { type: 'stdio', ...SERVER_COMMAND });
    assert.ok(text.includes('/plugin install backdraw --marketplace devtalh/backdraw'), `${readme}: plugin command`);
    assert.ok(text.includes('codex mcp add backdraw -- cmd /c npx -y backdraw@latest mcp'), `${readme}: Codex line`);
  }
});

test('glama.json names the maintainer', () => {
  assert.deepEqual(json('glama.json'), { $schema: 'https://glama.ai/mcp/schemas/server.json', maintainers: ['devtalh'] });
});

test('the release workflow publishes with OIDC only: no stored token', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(wf, /tags: \['v\*'\]/);
  assert.equal((wf.match(/id-token: write/g) || []).length, 2, 'npm and the MCP Registry jobs');
  assert.doesNotMatch(wf, /NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./);
  assert.match(wf, /npm publish/);
  assert.match(wf, /mcp-publisher login github-oidc/);
  assert.match(wf, /MCP_PUBLISHER_VERSION: v\d+\.\d+\.\d+/);
});

test('backdraw mcp answers initialize and lists the tools on stdio', async () => {
  const bin = path.join(ROOT, pkg.bin.backdraw);
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ].map(m => JSON.stringify(m)).join('\n');
  const out = await new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [bin, 'mcp'], (e, stdout) => (e ? reject(e) : resolve(stdout)));
    child.stdin.end(`${input}\n`);
  });
  const [init, list] = out.trim().split('\n').map(l => JSON.parse(l));
  assert.equal(init.result.serverInfo.version, pkg.version);
  assert.ok(list.result.tools.some(t => t.name === 'generate_image'));
});
