'use strict';
// Runs the real MCP server as a child process on a private test pipe (the PIPE_ENV override), first
// with nothing listening, then against a fake host. Chrome and the installed bridge are never involved.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const identity = require('../identity');
const { aspectOption } = require('../lib/aspect');
const { MAX_REFS } = require('../lib/limits');
const { LEGACY_VERSIONS } = require('../lib/protocol');
const { MOTION_NAMES } = require('../lib/motion');
const { LIGHT_MOTIONS } = require('../lib/light-motion');
const { SHEET_MOTIONS } = require('../lib/sprite-sheet');
const { SPRITE_MOTIONS } = require('../lib/sprite-prompt');
const { grid } = require('./sprite-fixture');
const { encodePng, decodePng } = require('../lib/png-codec');
const { gifInfo } = require('../lib/gif');

const SERVER = path.join(__dirname, '..', 'mcp-server.js');
const TAG = `backdraw-test-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
const PIPE = process.platform === 'win32' ? `\\\\.\\pipe\\${TAG}` : path.join(os.tmpdir(), `${TAG}.sock`);
const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo';
const MODERN = { [VERSION_KEY]: '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
const TOOL_NAMES = ['generate_image', 'generate_sprite', 'job_status', 'cancel_job', 'fetch_images', 'list_projects', 'select_project', 'list_collections', 'animate_sheet', 'animate_image'];

function animationFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backdraw-mcp-animate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const imagePath = path.join(dir, 'starfish.png');
  const rgba = new Uint8Array(16 * 16 * 4);
  for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) rgba.set([240, 40, 80, 255], (y * 16 + x) * 4);
  fs.writeFileSync(imagePath, encodePng(16, 16, rgba));
  return imagePath;
}

// ---------------------------------------------------------------- MCP server child process

const child = spawn(process.execPath, [SERVER], { env: { ...process.env, [identity.PIPE_ENV]: PIPE }, stdio: ['pipe', 'pipe', 'pipe'] });
const waiting = new Map();
const unsolicited = []; // notifications, batches, and anything answering an id we did not wait for
let seq = 0;
let out = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  out += chunk;
  let nl;
  while ((nl = out.indexOf('\n')) >= 0) {
    const msg = JSON.parse(out.slice(0, nl));
    out = out.slice(nl + 1);
    const w = waiting.get(msg.id);
    if (!w) { unsolicited.push(msg); continue; }
    waiting.delete(msg.id);
    clearTimeout(w.timer);
    w.resolve(msg);
  }
});
child.stderr.resume();
test.after(() => { child.stdin.end(); child.kill(); });

function request(method, params, timeoutMs = 5000) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`no answer to ${method} within ${timeoutMs} ms`)); }, timeoutMs);
    waiting.set(id, { resolve, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

const raw = line => child.stdin.write(`${line}\n`);
const notify = (method, params) => raw(JSON.stringify({ jsonrpc: '2.0', method, params }));
const callTool = (name, args, meta) => request('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
const textOf = res => res.result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
const sleep = ms => new Promise(r => setTimeout(r, ms));
// A ping round trip: every line written before it has been read (not necessarily answered).
const settle = () => request('ping');
async function until(check, timeoutMs = 3000) {
  for (const start = Date.now(); !check(); await sleep(20)) if (Date.now() - start > timeoutMs) throw new Error('timed out');
}

// ---------------------------------------------------------------- fake host on the test pipe

// The bridge line protocol: one JSON request line per connection, one JSON reply line back.
let handlers = {};
const hostCalls = [];
const host = net.createServer(sock => {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('error', () => {});
  sock.on('data', async chunk => {
    buf += chunk;
    const nl = buf.indexOf('\n');
    if (nl < 0) return;
    const req = JSON.parse(buf.slice(0, nl));
    hostCalls.push(req.method);
    const fn = handlers[req.method];
    let reply;
    try {
      reply = fn ? { id: req.id, result: await fn(req.params) } : { id: req.id, error: { message: `no ${req.method}`, code: 'BAD_REQUEST' } };
    } catch (e) {
      reply = { id: req.id, error: { message: e.message, code: 'BAD_REQUEST' } }; // as the host answers a rejected request
    }
    if (!sock.destroyed) sock.write(JSON.stringify(reply) + '\n');
  });
});
test.after(() => new Promise(resolve => host.close(() => resolve())));
const startHost = () => new Promise((resolve, reject) => { host.once('error', reject); host.listen(PIPE, resolve); });

const JOB_ID = 'img_0badc0de';
const fakeJob = fields => ({
  id: JOB_ID, mode: 'generate', status: 'queued', step: 'queued', message: 'Waiting for its turn', prompt: 'x',
  images: [], copies: [], references: [], conversationUrl: null, ...fields,
});

// ---------------------------------------------------------------- legacy (initialize) clients

test('legacy initialize: a known version is echoed, with capabilities, serverInfo and instructions', async () => {
  const res = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(res.result.protocolVersion, '2025-06-18');
  assert.deepEqual(res.result.capabilities, { tools: { listChanged: false } });
  assert.equal(res.result.serverInfo.name, 'backdraw');
  assert.match(res.result.instructions, /keep calling job_status\(job_id, wait_seconds=45\)/);
  assert.equal(res.result.resultType, undefined);
});

test('legacy initialize: an unknown version gets the newest legacy version', async () => {
  assert.equal((await request('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, '2025-11-25');
  assert.equal((await request('initialize', {})).result.protocolVersion, '2025-11-25');
});

test('notifications get no reply, even with a request method; ping still answers', async () => {
  notify('notifications/initialized');
  for (const method of ['initialize', 'server/discover', 'tools/list', 'ping']) notify(method, {});
  notify('tools/call', { name: 'generate_image', arguments: { prompt: 'x', wait_seconds: 0 } });
  const res = await request('ping');
  assert.deepEqual(res.result, {});
  await sleep(200); // a tools/call that ran would answer after its failed bridge call
  assert.deepEqual(unsolicited, []);
});

test('parse errors and invalid requests are answered without a null id', async () => {
  unsolicited.length = 0;
  raw('not json {');
  raw('null');
  raw('[]');
  raw(JSON.stringify({ jsonrpc: '2.0', id: 16 }));
  raw(JSON.stringify({ jsonrpc: '2.0', id: 17, result: {} })); // a response: nothing to answer
  await settle();
  assert.deepEqual(unsolicited, [
    { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } },
    { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' } },
    { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' } },
    { jsonrpc: '2.0', id: 16, error: { code: -32600, message: 'Invalid Request' } },
  ]);
});

test('a batch is answered with one array of its responses (2025-03-26)', async () => {
  unsolicited.length = 0;
  raw(JSON.stringify([{ jsonrpc: '2.0', id: 'b1', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 'b2', method: 'tools/list' }, { jsonrpc: '2.0', id: 'b3', method: 'nope' }]));
  raw(JSON.stringify([{ jsonrpc: '2.0', method: 'notifications/initialized' }]));
  await until(() => unsolicited.length);
  await settle();
  assert.equal(unsolicited.length, 1);
  const [batch] = unsolicited;
  assert.ok(Array.isArray(batch));
  assert.deepEqual(batch.map(r => r.id).sort(), ['b1', 'b2', 'b3']);
  assert.ok(batch.every(r => r.jsonrpc === '2.0'));
  assert.deepEqual(batch.find(r => r.id === 'b1').result, {});
  assert.equal(batch.find(r => r.id === 'b2').result.tools.length, TOOL_NAMES.length);
  assert.equal(batch.find(r => r.id === 'b3').error.code, -32601);
});

test('legacy tools/list: fixed order, annotations, 45-second default waits, no modern fields', async () => {
  const { result } = await request('tools/list', {});
  assert.deepEqual(result.tools.map(t => t.name), TOOL_NAMES);
  assert.equal(result.resultType, undefined);
  assert.equal(result.ttlMs, undefined);
  const tool = name => result.tools.find(t => t.name === name);
  for (const name of ['generate_image', 'fetch_images', 'job_status']) {
    const { type, minimum, maximum, default: dflt, description } = tool(name).inputSchema.properties.wait_seconds;
    assert.deepEqual({ type, minimum, maximum, dflt }, { type: 'integer', minimum: 0, maximum: 900, dflt: 45 }, name);
    assert.match(description, /60-second tool limit/);
  }
  assert.deepEqual(tool('fetch_images').annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
  assert.deepEqual(tool('generate_image').annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
  // job_status copies a finished job's images into output_dir, so it is not read-only.
  assert.deepEqual(tool('job_status').annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.deepEqual(tool('cancel_job').annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
  assert.deepEqual(tool('list_projects').annotations, { readOnlyHint: true, openWorldHint: true });
  assert.deepEqual(tool('select_project').annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  assert.deepEqual(tool('list_collections').annotations, { readOnlyHint: true, openWorldHint: false });
  assert.deepEqual(tool('list_collections').inputSchema, { type: 'object', properties: {}, additionalProperties: false });
});

test('generate_image schema: one reference limit, collection options after the older ones', async () => {
  const { result } = await request('tools/list', {});
  const { properties, required } = result.tools.find(t => t.name === 'generate_image').inputSchema;
  assert.equal(MAX_REFS, 16);
  assert.equal(properties.reference_images.maxItems, MAX_REFS);
  assert.ok(properties.reference_images.description.includes(`up to ${MAX_REFS})`));
  assert.deepEqual(Object.keys(properties).slice(-2), ['reference_collection', 'reference_files']);
  assert.equal(properties.reference_collection.type, 'string');
  assert.match(properties.reference_collection.description, /list_collections/);
  assert.match(properties.reference_collection.description, /newest are used, unless reference_files picks others/);
  assert.deepEqual({ ...properties.reference_files, description: undefined }, { type: 'array', items: { type: 'string' }, maxItems: MAX_REFS, description: undefined });
  assert.deepEqual(required, ['prompt']);
});

test('instructions mention collections', async () => {
  const res = await request('initialize', { protocolVersion: '2025-06-18' });
  assert.match(res.result.instructions, /call list_collections if needed and pass reference_collection/);
  assert.match(res.result.instructions, /pass filename_hint with a few words naming what the user asked for/);
});

// Some clients show the preview only as a small icon; the image itself should reach the user.
test('instructions ask to show the saved image in the chat without naming a client tool', async () => {
  const res = await request('initialize', { protocolVersion: '2025-06-18' });
  assert.match(res.result.instructions, /After SUCCESS, show the saved image to the user in the chat: if you can display or share a local file with the user, do that with the saved path/);
  assert.match(res.result.instructions, /otherwise give the saved path clearly/);
});

// Directories such as Glama read the instructions through mcp-proxy with a 2025-11-25 initialize.
test('instructions: the same text for every legacy initialize version and for modern server/discover', async () => {
  const { result: discover } = await request('server/discover', { _meta: MODERN });
  assert.match(discover.instructions, /^Generates images with the user's own ChatGPT account/);
  assert.match(discover.instructions, /Report the saved file path\(s\) and the ChatGPT conversation link to the user\.$/);
  for (const protocolVersion of LEGACY_VERSIONS) {
    const res = await request('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'mcp-proxy', version: '1' } });
    assert.equal(res.result.protocolVersion, protocolVersion);
    assert.equal(res.result.instructions, discover.instructions, protocolVersion);
  }
});

test('generate_image refuses more reference images than the limit before calling the bridge', async () => {
  const res = await callTool('generate_image', { prompt: 'x', reference_images: Array.from({ length: MAX_REFS + 1 }, (_, i) => `r${i}.png`), wait_seconds: 0 });
  assert.equal(res.result.isError, true);
  assert.match(textOf(res), new RegExp(`At most ${MAX_REFS} reference images`));
});

test('tools/list: aspect_ratio and transparent_background', async () => {
  const { result } = await request('tools/list', {});
  const props = name => result.tools.find(t => t.name === name).inputSchema.properties;
  const generate = props('generate_image');
  assert.equal(generate.aspect_ratio.type, 'string');
  for (const s of ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '4:5', '5:2 (Discord banner)', '3:1 (header)', 'between 1:4 and 4:1', 'not 1.5:1']) {
    assert.ok(generate.aspect_ratio.description.includes(s), s);
  }
  assert.deepEqual({ type: generate.transparent_background.type, dflt: generate.transparent_background.default }, { type: 'boolean', dflt: false });
  assert.equal(props('fetch_images').aspect_ratio.type, 'string');
  assert.equal(props('fetch_images').transparent_background, undefined);
  const init = await request('initialize', { protocolVersion: '2025-06-18' });
  assert.match(init.result.instructions, /pass aspect_ratio instead of describing the size in the prompt; .* pass transparent_background=true and read the transparency line/);
  // The crop target stays with the generate_image job, so fetching its result later needs it again.
  assert.match(init.result.instructions, /fetch_images can still download the result later; pass the job's aspect_ratio again so it is cropped the same way\./);
  assert.match(props('fetch_images').aspect_ratio.description, /For the result of a generate_image job, pass its aspect_ratio again\.$/);
});

test('unknown methods are "method not found"', async () => {
  const res = await request('resources/templates/list', {});
  assert.equal(res.error.code, -32601);
});

test('animated schema and instructions describe GIF prompts without assuming PNG transparency', async () => {
  const { result } = await request('tools/list', {});
  const props = result.tools.find(t => t.name === 'generate_image').inputSchema.properties;
  assert.deepEqual({ type: props.animated.type, default: props.animated.default }, { type: 'boolean', default: false });
  for (const part of ['animated GIF', 'one subject', 'one clear motion', 'still camera', 'no small text', 'aspect_ratio is not applied', 'frame count and duration']) {
    assert.ok(props.animated.description.includes(part), part);
  }
  assert.doesNotMatch(props.transparent_background.description, /Ask for a PNG/);
  assert.match(props.transparent_background.description, /A PNG is checked for transparent pixels; a GIF's first frame too \(GIF requests do not ask ChatGPT for transparency\)\./);
  const { result: init } = await request('initialize', { protocolVersion: '2025-06-18' });
  assert.match(init.instructions, /animation, GIF or moving image, pass animated=true/);
  assert.match(init.instructions, /one subject, one clear motion, a still camera and no small text.*aspect_ratio is not applied to the GIF/);
});

// ---------------------------------------------------------------- modern (2026-07-28) clients

test('motion schema shares the preset enum and describes automatic animation and frame hints', async () => {
  const { result } = await request('tools/list', {});
  const props = result.tools.find(t => t.name === 'generate_image').inputSchema.properties;
  assert.equal(props.motion.type, 'string');
  assert.deepEqual(props.motion.enum, MOTION_NAMES);
  for (const name of MOTION_NAMES) assert.ok(props.motion.description.includes(name));
  assert.match(props.motion.description, /enables animated when omitted or false/);
  assert.match(props.motion.description, /frame count is only a hint/);
  assert.match(props.animated.description, /Pass motion for a preset movement/);
  const { result: init } = await request('initialize', { protocolVersion: '2025-06-18' });
  assert.ok(init.instructions.includes(`For a common motion (${MOTION_NAMES.join(', ')}) pass motion; describe the subject and style in the prompt.`));
});

test('modern server/discover: versions, capabilities, serverInfo and caching', async () => {
  const { result } = await request('server/discover', { _meta: MODERN });
  assert.equal(result.resultType, 'complete');
  assert.ok(result.supportedVersions.includes('2026-07-28'));
  assert.ok(result.supportedVersions.includes('2025-11-25'));
  assert.deepEqual(result.capabilities, { tools: {} });
  assert.equal(result._meta[SERVER_INFO_KEY].name, 'backdraw');
  assert.match(result.instructions, /STILL RUNNING or QUEUED/);
  assert.equal(result.ttlMs, 3600000);
  assert.equal(result.cacheScope, 'public');
});

test('modern tools/list: the same tools, marked complete and cacheable', async () => {
  const { result } = await request('tools/list', { _meta: MODERN });
  assert.equal(result.resultType, 'complete');
  assert.equal(typeof result.ttlMs, 'number');
  assert.equal(result.cacheScope, 'public');
  assert.equal(result._meta[SERVER_INFO_KEY].name, 'backdraw');
  assert.deepEqual(result.tools.map(t => t.name), TOOL_NAMES);
});

test('modern ping is marked complete', async () => {
  const { result } = await request('ping', { _meta: MODERN });
  assert.equal(result.resultType, 'complete');
  assert.equal(result._meta[SERVER_INFO_KEY].name, 'backdraw');
});

test('a request naming a legacy version in _meta is served the legacy way', async () => {
  const { result } = await request('tools/list', { _meta: { [VERSION_KEY]: '2025-06-18' } });
  assert.deepEqual(result.tools.map(t => t.name), TOOL_NAMES);
  assert.equal(result.resultType, undefined);
  assert.equal(result.ttlMs, undefined);
});

test('a modern request without clientCapabilities is still served (on purpose)', async () => {
  const { result, error } = await request('tools/list', { _meta: { [VERSION_KEY]: '2026-07-28' } });
  assert.equal(error, undefined);
  assert.equal(result.resultType, 'complete');
});

test('a notification with an unsupported version gets no reply', async () => {
  unsolicited.length = 0;
  notify('notifications/initialized', { _meta: { [VERSION_KEY]: '2099-01-01' } });
  await settle();
  assert.deepEqual(unsolicited, []);
});

test('modern request with an unsupported version: error -32022 listing what is supported', async () => {
  const res = await request('tools/list', { _meta: { ...MODERN, [VERSION_KEY]: '2099-01-01' } });
  assert.equal(res.result, undefined);
  assert.equal(res.error.code, -32022);
  assert.equal(res.error.message, 'Unsupported protocol version');
  assert.equal(res.error.data.requested, '2099-01-01');
  assert.ok(res.error.data.supported.includes('2026-07-28'));
  assert.ok(res.error.data.supported.includes('2025-11-25'));
});

// ---------------------------------------------------------------- tools

test('job_status without job_id while nothing listens: NOT RUNNING', async () => {
  const res = await callTool('job_status', {});
  assert.match(textOf(res), /NOT RUNNING/);
});

test('generate_image with nothing listening: BRIDGE NOT RUNNING error result', async () => {
  const res = await callTool('generate_image', { prompt: 'x', wait_seconds: 0 });
  assert.equal(res.result.isError, true);
  assert.match(textOf(res), /^BRIDGE NOT RUNNING/);
});

test('animate_image schema and instructions expose local motion separately from ChatGPT motion', async () => {
  const { result } = await request('tools/list');
  const tool = result.tools.at(-1), { properties: p, required, additionalProperties } = tool.inputSchema;
  assert.equal(tool.name, 'animate_image');
  assert.equal(tool.title, 'Animate a PNG locally (no ChatGPT)');
  assert.deepEqual(required, ['image_path', 'motion']);
  assert.equal(additionalProperties, false);
  assert.equal(p.image_path.type, 'string');
  assert.equal(p.image_path.description, "Absolute path preferred (e.g. a path saved by generate_image); a relative path is resolved from the server's current folder.");
  assert.deepEqual(p.motion.enum, LIGHT_MOTIONS);
  assert.equal(p.motion.type, 'string');
  assert.deepEqual({ ...p.size, description: undefined }, { type: 'integer', minimum: 64, maximum: 1024, default: 384, description: undefined });
  assert.equal(p.size.description, 'Output long-edge limit in pixels; enlargement uses the nearest whole multiple of the source pixel grid, so the result may be smaller.');
  assert.deepEqual(p.background, { type: 'string', enum: ['transparent', 'white'], default: 'transparent' });
  assert.deepEqual(p.include_preview, { type: 'boolean', default: true });
  assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  const init = await request('initialize', {});
  assert.match(init.result.instructions, /use animate_image on a transparent PNG; for changing poses \(walking, jumping, waving\), use generate_sprite; for a ready sprite sheet, use animate_sheet/);
});

test('animate_image saves a sibling GIF and PNG sheet even without a bridge; relative paths use the caller cwd', async t => {
  const imagePath = animationFixture(t), original = fs.readFileSync(imagePath);
  const res = await callTool('animate_image', { image_path: path.relative(process.cwd(), imagePath), motion: 'bounce' });
  assert.equal(res.result.isError, false, textOf(res));
  assert.match(textOf(res), /^SUCCESS/);
  const saved = path.join(path.dirname(imagePath), 'starfish_bounce.gif');
  assert.ok(textOf(res).includes(`Saved: ${saved}`));
  assert.match(textOf(res), /16 frames, 800 ms per loop \(50 ms per frame\)/);
  assert.match(textOf(res), /Sampling: nearest neighbor \(enlarged 27x from 16 x 16 source pixels\)/);
  assert.match(textOf(res), /Gallery: not added.*the bridge is not running \(Chrome is closed or the extension is off\), so it is not in the gallery/);
  assert.doesNotMatch(textOf(res), /run animate_image again/);
  assert.match(textOf(res), /The GIF is saved/);
  const info = gifInfo(fs.readFileSync(saved));
  assert.equal(info.frames, 16);
  assert.equal(Math.max(info.width, info.height), 378);
  assert.ok(Math.max(info.width, info.height) <= 384);
  const preview = res.result.content.find(c => c.type === 'image');
  assert.equal(preview.mimeType, 'image/png');
  assert.ok(decodePng(Buffer.from(preview.data, 'base64')).width > 0);
  const noPreview = await callTool('animate_image', { image_path: imagePath, motion: 'bounce', size: 64, include_preview: false });
  assert.equal(noPreview.result.isError, false);
  assert.equal(noPreview.result.content.length, 1);
  assert.ok(fs.existsSync(saved.replace('.gif', '_2.gif')));
  assert.deepEqual(fs.readFileSync(imagePath), original);
});

test('animate_image rejects missing paths, non-PNG bytes, unknown motion and invalid sizes', async t => {
  const imagePath = animationFixture(t);
  const badPath = path.join(path.dirname(imagePath), 'wrong.jpg'); fs.writeFileSync(badPath, 'not PNG');
  for (const [args, error] of [
    [{}, /image_path is required\./], [{ image_path: ' ' }, /image_path is required\./],
    [{ image_path: badPath, motion: 'idle' }, /ERROR.*not a PNG/],
    [{ image_path: imagePath, motion: 'walk' }, /ERROR.*Unknown motion/],
    ...['384', null, 63, 1025].map(size => [{ image_path: imagePath, motion: 'idle', size }, /ERROR.*size must/]),
  ]) {
    const res = await callTool('animate_image', args);
    assert.equal(res.result.isError, true); assert.match(textOf(res), error);
  }
});

function sheetFixture(t, columns = 3, rows = 2) {
  const imagePath = animationFixture(t), source = grid(columns, rows);
  fs.writeFileSync(imagePath, encodePng(source.width, source.height, source.rgba));
  return imagePath;
}

test('animate_sheet exposes the full local sprite schema and quality instructions', async () => {
  const { result } = await request('tools/list'), tool = result.tools.find(t => t.name === 'animate_sheet');
  const { properties: p, required, additionalProperties } = tool.inputSchema;
  assert.deepEqual(required, ['image_path', 'motion']); assert.equal(additionalProperties, false);
  assert.deepEqual(p.motion.enum, SHEET_MOTIONS);
  for (const key of ['columns', 'rows']) assert.deepEqual([p[key].type, p[key].minimum, p[key].maximum], ['integer', 1, 16]);
  assert.deepEqual([p.frames.minimum, p.frames.maximum], [2, 64]);
  assert.deepEqual([p.fps.type, p.fps.minimum, p.fps.maximum], ['number', 1, 50]);
  assert.deepEqual(p.durations_ms.items, { type: 'integer', minimum: 20, maximum: 5000 });
  assert.deepEqual([p.air_frames.minItems, p.air_frames.maxItems], [2, 2]);
  assert.deepEqual([p.jump_height.minimum, p.jump_height.maximum], [0, 2048]);
  assert.deepEqual([p.size.minimum, p.size.maximum, p.size.default], [64, 1024, undefined]);
  assert.equal(p.background.default, 'transparent'); assert.equal(p.include_preview.default, true);
  assert.deepEqual(tool.annotations, result.tools.find(t => t.name === 'animate_image').annotations);
  assert.match(tool.description, /source PNG is never changed/);
  assert.match((await request('initialize', {})).result.instructions, /sprite sheet PNG.*animate_sheet.*quality warnings/);
});

test('animate_sheet saves a folder and transparent GIF without a bridge, resolving relative paths', async t => {
  const imagePath = sheetFixture(t), hash = crypto.createHash('sha256').update(fs.readFileSync(imagePath)).digest('hex');
  const res = await callTool('animate_sheet', { image_path: path.relative(process.cwd(), imagePath), motion: 'walk', columns: 3, rows: 2 });
  assert.equal(res.result.isError, false, textOf(res)); assert.match(textOf(res), /^SUCCESS/);
  const folder = path.join(path.dirname(imagePath), 'starfish_walk_sheet');
  assert.ok(textOf(res).includes(`Saved folder: ${folder}`));
  assert.equal(gifInfo(fs.readFileSync(path.join(folder, 'starfish_walk.gif'))).frames, 6);
  for (const file of ['atlas.png', 'manifest.json', 'contact.png', 'frames/frame_01.png']) assert.ok(fs.existsSync(path.join(folder, file)));
  assert.match(textOf(res), /Gallery: not added.*the bridge is not running/);
  assert.ok(decodePng(Buffer.from(res.result.content[1].data, 'base64')).width > 0);
  const second = await callTool('animate_sheet', { image_path: imagePath, motion: 'walk', include_preview: false });
  assert.equal(second.result.content.length, 1); assert.ok(fs.existsSync(`${folder}_2`));
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(imagePath)).digest('hex'), hash);
});

test('animate_sheet rejects missing paths, non-PNGs, unknown motions and partial grid options', async t => {
  const imagePath = sheetFixture(t), badPath = path.join(path.dirname(imagePath), 'bad.jpg');
  fs.writeFileSync(badPath, 'not PNG');
  for (const [args, pattern] of [[{}, /image_path is required/], [{ image_path: ' ' }, /image_path is required/],
    [{ image_path: badPath, motion: 'walk' }, /not a PNG/], [{ image_path: imagePath, motion: 'bounce' }, /Unknown motion/],
    [{ image_path: imagePath, motion: 'walk', columns: 3 }, /columns and rows must be provided together/]]) {
    const res = await callTool('animate_sheet', args);
    assert.equal(res.result.isError, true); assert.match(textOf(res), /^ERROR/); assert.match(textOf(res), pattern);
  }
});

test('with a fake host', async t => {
  await startHost();

  await t.test('generate_sprite schema and old-host guard prevent unsupported jobs', async () => {
    const { result } = await request('tools/list');
    const schema = result.tools.find(t => t.name === 'generate_sprite').inputSchema;
    assert.deepEqual(schema.required, ['prompt', 'motion']); assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.properties.motion.enum, SPRITE_MOTIONS);
    assert.deepEqual(schema.properties.frames.enum, [8, 16]); assert.equal(schema.properties.frames.default, 8);
    assert.deepEqual(schema.properties.view.enum, ['side', 'front']);
    assert.deepEqual(schema.properties.background.enum, ['transparent', 'white']);
    assert.equal(schema.properties.size.minimum, 64); assert.equal(schema.properties.size.maximum, 1024);
    assert.match((await request('initialize', {})).result.instructions, /for changing poses \(walking, jumping, waving\), use generate_sprite; for a ready sprite sheet, use animate_sheet/);
    handlers = { status: () => ({ hostVersion: 'old' }) }; hostCalls.length = 0;
    const res = await callTool('generate_sprite', { prompt: 'frog', motion: 'walk', wait_seconds: 0 });
    assert.equal(res.result.isError, true);
    assert.equal(textOf(res), 'ERROR \u2014 the installed bridge is older than this server; update Backdraw (node install.js), reload the extension and restart the client.');
    assert.deepEqual(hostCalls, ['status']);
  });

  await t.test('generate_sprite passes defaults, references and options; attaches only the contact preview with its signature MIME', async t => {
    const imagePath = animationFixture(t), sent = [];
    handlers = { status: () => ({ features: ['sprite'] }),
      generate: p => { sent.push(p); return fakeJob(); }, job: () => fakeJob() };
    hostCalls.length = 0;
    const args = { prompt: 'frog', motion: 'walk', wait_seconds: 0 };
    assert.equal((await callTool('generate_sprite', args)).result.isError, false);
    assert.deepEqual(hostCalls, ['status', 'generate', 'job']);
    assert.deepEqual(sent[0].sprite, { motion: 'walk', frames: 8, view: 'side', background: 'transparent' });
    await callTool('generate_sprite', { ...args, frames: 16, view: 'front', size: 256, background: 'white',
      filename_hint: 'frog walk', output_dir: path.dirname(imagePath), reference_images: [imagePath] });
    assert.deepEqual(sent[1].sprite, { motion: 'walk', frames: 16, view: 'front', size: 256, background: 'white' });
    assert.equal(sent[1].filenameHint, 'frog walk'); assert.equal(sent[1].copyTo, path.dirname(imagePath));
    assert.equal(sent[1].references[0].data, fs.readFileSync(imagePath).toString('base64'));
    const attempt = { sheetPath: imagePath, gif: 'walk.gif', folder: 'walk_sheet', frames: 8, durationMs: 640,
      width: 16, height: 16, bytes: 1024, gates: ['count', 'empty', 'identity', 'size', 'seam', 'edges'].map(id => ({ id, passed: true })) };
    for (const [bytes, mime] of [[fs.readFileSync(imagePath), 'image/png'], [Buffer.from([255, 216, 255, 224]), 'image/jpeg']]) {
      const preview = path.join(path.dirname(imagePath), 'contact.bin'); fs.writeFileSync(preview, bytes);
      handlers.job = () => fakeJob({ status: 'succeeded', images: [{ path: 'walk.gif', preview }, { path: imagePath, preview: imagePath }],
        sprite: { motion: 'walk', background: 'transparent', chosen: 0, attempts: [attempt] } });
      const res = await callTool('generate_sprite', args);
      assert.equal(res.result.content.length, 2); assert.equal(res.result.content[1].mimeType, mime);
      assert.equal(res.result.content[1].data, bytes.toString('base64'));
      const noPreview = await callTool('job_status', { job_id: JOB_ID, wait_seconds: 0, include_preview: false });
      assert.equal(noPreview.result.content.length, 1);
    }
  });

  await t.test('job_status uses preview signatures for non-sprite PNG and JPEG jobs', async t => {
    const png = fs.readFileSync(animationFixture(t));
    const preview = path.join(os.tmpdir(), `backdraw-mcp-preview-${process.pid}.bin`);
    t.after(() => fs.rmSync(preview, { force: true }));
    for (const [bytes, mime] of [[png, 'image/png'], [Buffer.from([255, 216, 255, 224]), 'image/jpeg']]) {
      fs.writeFileSync(preview, bytes);
      handlers = { job: () => fakeJob({ status: 'succeeded', images: [{ path: 'image.bin', preview }] }) };
      const res = await callTool('job_status', { job_id: JOB_ID, wait_seconds: 0 });
      assert.equal(res.result.content.length, 2); assert.equal(res.result.content[1].mimeType, mime);
      assert.equal(res.result.content[1].data, bytes.toString('base64'));
    }
  });

  await t.test('animate_sheet registers kind, absolute white GIF path and exact preview frame counts; old hosts advise updating', async t => {
    const imagePath = sheetFixture(t, 17, 1);
    let sent;
    handlers = { add_local_animation: p => { sent = p; return { id: JOB_ID }; } }; hostCalls.length = 0;
    const res = await callTool('animate_sheet', { image_path: imagePath, motion: 'walk', background: 'white' }, MODERN);
    assert.equal(res.result.isError, false, textOf(res)); assert.equal(res.result.resultType, 'complete');
    assert.deepEqual(hostCalls, ['add_local_animation']); assert.equal(sent.kind, 'sheet');
    assert.equal(sent.sourcePath, imagePath); assert.ok(path.isAbsolute(sent.path));
    assert.match(sent.path, /starfish_walk_white.gif$/); assert.ok(fs.existsSync(sent.path));
    assert.deepEqual(sent.previewFrames, { shown: 16, total: 17 });
    assert.equal(sent.motion, 'walk'); assert.equal(sent.background, 'white');
    assert.ok(decodePng(Buffer.from(sent.preview, 'base64')).width > 0); assert.equal(sent.preview, res.result.content[1].data);
    assert.match(textOf(res), /Gallery: added/);
    for (const [message, pattern] of [['Unknown motion. Use: bounce, idle.', /the installed bridge is older than this server; update Backdraw/],
      ['Unknown method "add_local_animation".', /the installed bridge is older than this server; update Backdraw/],
      ['disk unavailable', /disk unavailable/]]) {
      handlers = { add_local_animation: () => { throw new Error(message); } };
      const failed = await callTool('animate_sheet', { image_path: imagePath, motion: 'walk' });
      assert.equal(failed.result.isError, false); assert.match(textOf(failed), pattern); assert.match(textOf(failed), /The GIF is saved/);
      const folder = textOf(failed).split('\n').find(l => l.startsWith('Saved folder: ')).slice(14);
      assert.ok(fs.existsSync(path.join(folder, 'starfish_walk.gif')));
    }
  });

  await t.test('animate_image registers absolute paths and a PNG sheet; gallery errors never lose the GIF', async t => {
    const imagePath = animationFixture(t);
    let sent;
    handlers = { add_local_animation: p => { sent = p; return { id: JOB_ID }; } };
    hostCalls.length = 0;
    const res = await callTool('animate_image', { image_path: imagePath, motion: 'wiggle', size: 64, background: 'white' }, MODERN);
    assert.equal(res.result.isError, false); assert.equal(res.result.resultType, 'complete');
    assert.match(textOf(res), new RegExp(`Gallery: added \\(${JOB_ID}\\)`));
    assert.deepEqual(hostCalls, ['add_local_animation']);
    assert.equal(sent.path, path.join(path.dirname(imagePath), 'starfish_wiggle.gif'));
    assert.equal(sent.sourcePath, imagePath); assert.ok(path.isAbsolute(sent.path));
    assert.equal(sent.motion, 'wiggle'); assert.equal(sent.background, 'white');
    assert.deepEqual(sent.previewFrames, { shown: 10, total: 10 });
    assert.ok(decodePng(Buffer.from(sent.preview, 'base64')).width > 0);
    assert.equal(res.result.content[1].data, sent.preview);
    for (const [message, reason] of [
      ['Unknown method "add_local_animation".', /the installed bridge is older than this server; update Backdraw/],
      ['disk is unavailable', /disk is unavailable/],
    ]) {
      handlers = { add_local_animation: () => { throw new Error(message); } };
      const failedGallery = await callTool('animate_image', { image_path: imagePath, motion: 'nod', size: 64 });
      assert.equal(failedGallery.result.isError, false);
      assert.match(textOf(failedGallery), /^SUCCESS/); assert.match(textOf(failedGallery), /Gallery: not added/);
      assert.match(textOf(failedGallery), reason);
      const file = textOf(failedGallery).split('\n').find(l => l.startsWith('Saved: ')).slice(7);
      assert.ok(fs.existsSync(file));
    }
  });

  await t.test('animated is passed to the host and defaults to false', async () => {
    const sent = [];
    handlers = { generate: p => { sent.push(p); return fakeJob(); }, job: () => fakeJob() };
    for (const args of [{ animated: true }, {}, { animated: false }]) {
      const res = await callTool('generate_image', { prompt: 'A fox waves', wait_seconds: 0, ...args });
      assert.equal(res.result.isError, false);
    }
    assert.deepEqual(sent.map(p => p.animated), [true, false, false]);
  });

  await t.test('motion is passed unchanged and enables animated even when false', async () => {
    const sent = [];
    handlers = { generate: p => { sent.push(p); return fakeJob(); }, job: () => fakeJob() };
    for (const motion of MOTION_NAMES) {
      for (const animated of [undefined, false, true]) {
        const res = await callTool('generate_image', { prompt: 'A pixel fox', motion, animated, wait_seconds: 0 });
        assert.equal(res.result.isError, false);
        assert.equal(sent.at(-1).motion, motion);
        assert.equal(sent.at(-1).animated, true);
      }
    }
    await callTool('generate_image', { prompt: 'A fox', wait_seconds: 0 });
    assert.equal(sent.at(-1).motion, undefined);
    assert.equal(sent.at(-1).animated, false);
  });

  await t.test('queued job: QUEUED with its position and how to keep waiting', async () => {
    handlers = { generate: () => fakeJob({ queuePosition: 2 }), job: () => fakeJob({ queuePosition: 2 }) };
    const res = await callTool('generate_image', { prompt: 'x', wait_seconds: 0 });
    const text = textOf(res);
    assert.equal(res.result.isError, false);
    assert.match(text, /QUEUED/);
    assert.match(text, /position 2/);
    assert.ok(text.includes(JOB_ID));
    assert.match(text, /job_status/);
  });

  await t.test('running job (modern client): STILL RUNNING, result marked complete', async () => {
    handlers = { generate: () => fakeJob(), job: () => fakeJob({ status: 'running', step: 'generating', message: 'ChatGPT is generating the image' }) };
    const res = await callTool('generate_image', { prompt: 'x', wait_seconds: 0 }, MODERN);
    const text = textOf(res);
    assert.match(text, /^STILL RUNNING — ChatGPT is generating the image\./);
    assert.ok(text.includes(`job_id="${JOB_ID}"`));
    assert.match(text, /wait_seconds=45/);
    assert.equal(res.result.resultType, 'complete');
    assert.equal(res.result._meta[SERVER_INFO_KEY].name, 'backdraw');
  });

  await t.test('the wait counts from the start of the call, including a slow generate', async () => {
    handlers = {
      generate: async () => { await sleep(1200); return fakeJob(); },
      job: () => fakeJob({ status: 'running', step: 'generating' }),
    };
    hostCalls.length = 0;
    const res = await callTool('generate_image', { prompt: 'x', wait_seconds: 1 });
    assert.match(textOf(res), /STILL RUNNING/);
    // The second left after "generate" are used up, so only the first status check happens.
    assert.deepEqual(hostCalls, ['generate', 'job']);
  });

  await t.test('aspect_ratio and transparent_background are passed on to the host', async () => {
    const sent = [];
    handlers = { generate: p => { sent.push(p); return fakeJob(); }, job: () => fakeJob() };
    await callTool('generate_image', { prompt: 'x', aspect_ratio: '4:1', transparent_background: true, wait_seconds: 0 });
    await callTool('generate_image', { prompt: 'x', wait_seconds: 0 });
    await callTool('fetch_images', { conversation_url: 'https://chatgpt.com/c/6812a3b4-1c2d-8000-9e8f-0123456789ab', aspect_ratio: '16:9', wait_seconds: 0 });
    assert.deepEqual(sent.map(p => [p.aspect, p.transparent]), [['4:1', true], [undefined, false], ['16:9', undefined]]);
    assert.equal(sent[2].mode, 'collect');
  });

  await t.test('an aspect_ratio the host rejects is an ERROR result with its reason', async () => {
    // The host's createJob runs the same check (lib/aspect aspectOption) and answers BAD_REQUEST.
    handlers = { generate: p => { aspectOption(p.aspect); return fakeJob(); } };
    const res = await callTool('generate_image', { prompt: 'x', aspect_ratio: '9:1', wait_seconds: 0 });
    assert.equal(res.result.isError, true);
    assert.equal(textOf(res), 'ERROR — aspect_ratio 9:1 is outside the supported range 1:4 to 4:1 (ChatGPT itself draws 1:3 to 3:1).');
  });

  await t.test('bridge status: connection, project, folder, running job, queue and recent jobs', async () => {
    const status = fields => ({ hostVersion: '1.1.0', extension: { version: '1.1.0' }, project: null, outputDir: 'X', running: null, queued: [], recent: [], ...fields });
    handlers = { status: () => status({ queued: ['img_a', 'img_b'] }) };
    assert.equal(textOf(await callTool('job_status', {})), [
      'Bridge: connected (Chrome extension v1.1.0, host v1.1.0).',
      'ChatGPT project: NOT SELECTED — call list_projects, then select_project.',
      'Images folder: X',
      'Running: nothing',
      'Queued: img_a, img_b',
    ].join('\n'));
    handlers = {
      status: () => status({
        project: { name: 'Images', url: 'https://chatgpt.com/g/g-p-1/project' },
        running: { id: 'img_r', status: 'running', step: 'generating', message: null },
        recent: [{ id: 'img_r', status: 'running', createdAt: 'T', prompt: 'p', conversationUrl: null }],
      }),
    };
    const text = textOf(await callTool('job_status', {}));
    assert.match(text, /^ChatGPT project: Images — https:\/\/chatgpt\.com\/g\/g-p-1\/project$/m);
    assert.match(text, /^Running: img_r — running: generating$/m);
    assert.match(text, /^Queued: none$/m);
    assert.match(text, /^Recent jobs:\n- img_r running \(T\) "p"$/m);
  });

  // Each needs_human case uses its own job id: the server remembers which ones it reported.
  const human = (id, fields) => fakeJob({ id, status: 'needs_human', step: 'login', message: 'ChatGPT shows a login page', ...fields });
  const sequence = (...polls) => () => (polls.length > 1 ? polls.shift() : polls[0]);

  await t.test('job_status on a job that needs the user, not yet reported: NEEDS USER ACTION at once', async () => {
    handlers = { job: () => human('img_000000a1') };
    const started = Date.now();
    const res = await callTool('job_status', { job_id: 'img_000000a1', wait_seconds: 20 });
    assert.match(textOf(res), /^NEEDS USER ACTION — ChatGPT shows a login page \(job img_000000a1\)/);
    assert.ok(Date.now() - started < 1500);
  });

  await t.test('job_status keeps waiting on a job whose NEEDS USER ACTION was already reported, with progress', async () => {
    const id = 'img_000000b1';
    handlers = {
      generate: () => fakeJob({ id }),
      job: sequence(human(id), human(id), fakeJob({ id, status: 'succeeded', step: 'succeeded', images: [{ path: path.join(os.tmpdir(), 'x.png'), width: 2, height: 2, preview: null }] })),
    };
    assert.match(textOf(await callTool('generate_image', { prompt: 'x', wait_seconds: 20 })), /^NEEDS USER ACTION/);
    unsolicited.length = 0;
    const res = await callTool('job_status', { job_id: id, wait_seconds: 5 }, { progressToken: 'tok' });
    const text = textOf(res);
    assert.match(text, /^SUCCESS — ChatGPT generated 1 image\(s\)\./);
    assert.ok(text.includes(`Saved: ${path.join(os.tmpdir(), 'x.png')} (2x2)`));
    const progress = unsolicited.filter(m => m.method === 'notifications/progress');
    assert.ok(progress.length >= 1);
    assert.equal(progress[0].params.progressToken, 'tok');
    assert.match(progress[0].params.message, /^succeeded/);
  });

  await t.test('a reported job that needs the user again after running returns at once', async () => {
    const id = 'img_000000c1';
    handlers = { generate: () => fakeJob({ id }), job: () => human(id) };
    assert.match(textOf(await callTool('generate_image', { prompt: 'x', wait_seconds: 20 })), /^NEEDS USER ACTION/);
    handlers = { job: sequence(human(id), fakeJob({ id, status: 'running', step: 'generating' }), human(id, { message: 'ChatGPT shows a human-verification page' })) };
    const started = Date.now();
    const res = await callTool('job_status', { job_id: id, wait_seconds: 20 });
    assert.match(textOf(res), /^NEEDS USER ACTION — ChatGPT shows a human-verification page/);
    assert.ok(Date.now() - started < 4500);
  });

  await t.test('job_status on a running job that starts to need the user returns at once', async () => {
    const id = 'img_000000d1';
    handlers = { job: sequence(fakeJob({ id, status: 'running', step: 'generating' }), human(id)) };
    const started = Date.now();
    const res = await callTool('job_status', { job_id: id, wait_seconds: 20 });
    assert.match(textOf(res), /^NEEDS USER ACTION/);
    assert.ok(Date.now() - started < 3000);
  });

  await t.test('cancel_job on a job that needs the user waits until it is cancelled', async () => {
    const id = 'img_000000e1';
    const cancelling = human(id, { message: 'Cancelling…' });
    handlers = {
      cancel: () => cancelling,
      job: sequence(cancelling, cancelling, fakeJob({ id, status: 'cancelled', step: 'cancelled', message: 'Cancelled' })),
    };
    const res = await callTool('cancel_job', { job_id: id });
    assert.equal(textOf(res), `CANCELLED — job ${id}.`);
  });

  await t.test('after notifications/cancelled a call sends no more progress and no result', async () => {
    let n = 0;
    handlers = { job: () => fakeJob({ status: 'running', step: 'generating', message: `step ${++n}` }) };
    unsolicited.length = 0;
    const id = ++seq;
    raw(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'job_status', arguments: { job_id: JOB_ID, wait_seconds: 4 }, _meta: { progressToken: 'c' } } }));
    await until(() => unsolicited.some(m => m.method === 'notifications/progress'));
    notify('notifications/cancelled', { requestId: id, reason: 'The user pressed Esc.' });
    await settle();
    const seen = unsolicited.length;
    await sleep(4500); // past the 4-second wait, when the result would have been sent
    await settle();
    assert.equal(unsolicited.length, seen, JSON.stringify(unsolicited.slice(seen)));
    assert.ok(!unsolicited.some(m => m.id === id));
  });

  await t.test('list_collections: every collection with its folder and files, and how to use it', async () => {
    handlers = { list_collections: () => [] };
    assert.match(textOf(await callTool('list_collections', {})), /^No reference collections yet\./);
    handlers = {
      list_collections: () => [{
        name: 'Cats', folder: 'Cats', path: 'D:/refs/Cats', count: 1, updatedAt: 'T',
        images: [{ file: '001_cat.png', path: 'D:/refs/Cats/001_cat.png', sourceUrl: 'https://cdn.example.com/c.png', pageUrl: 'https://www.example.com/p', addedAt: '2026-10-01T00:00:00Z', width: 4, height: 3 }],
      }],
    };
    const res = await callTool('list_collections', {});
    const text = textOf(res);
    assert.equal(res.result.isError, false);
    assert.match(text, /^- "Cats": 1 image\(s\), folder D:\/refs\/Cats$/m);
    assert.match(text, /^ {2}- 001_cat\.png \(example\.com, 4x3, added 2026-10-01\)$/m);
    assert.match(text, /up to 16 references in total/);
  });

  await t.test('generate_image passes reference_collection and reference_files; the result says what was used', async () => {
    let sent = null;
    const job = fakeJob({
      status: 'succeeded', step: 'succeeded', images: [], references: [{ name: 'own.png', bytes: 1 }, { name: '003_c.png', bytes: 1 }, { name: '001_a.png', bytes: 1 }],
      collection: { name: 'Cats', used: ['003_c.png', '001_a.png'], total: 5 },
    });
    handlers = { generate: p => { sent = p; return job; }, job: () => job };
    const res = await callTool('generate_image', { prompt: 'x', reference_collection: 'cats', reference_files: ['003_c.png', '001_a.png'], wait_seconds: 0 });
    assert.equal(sent.referenceCollection, 'cats');
    assert.deepEqual(sent.referenceFiles, ['003_c.png', '001_a.png']);
    const text = textOf(res);
    assert.match(text, /^Reference images attached: own\.png$/m);
    assert.match(text, /^References: collection "Cats": used 2 of 5 \(003_c\.png, 001_a\.png\)$/m);
    // A single file name as a string is not dropped (the newest would be attached instead).
    await callTool('generate_image', { prompt: 'x', reference_collection: 'cats', reference_files: '001_a.png', wait_seconds: 0 });
    assert.deepEqual(sent.referenceFiles, ['001_a.png']);
    handlers = { generate: p => { sent = p; return job; }, job: () => job };
    await callTool('generate_image', { prompt: 'x', wait_seconds: 0 });
    assert.equal(sent.referenceCollection, undefined);
    assert.equal(sent.referenceFiles, undefined);
    assert.equal(sent.filenameHint, undefined);
    await callTool('generate_image', { prompt: 'x', filename_hint: 'red fox mascot', wait_seconds: 0 });
    assert.equal(sent.filenameHint, 'red fox mascot');
  });

  await t.test('a job that starts to need the user returns at once', async () => {
    handlers = { generate: () => fakeJob(), job: () => fakeJob({ status: 'needs_human', step: 'captcha', message: 'ChatGPT shows a human-verification page' }) };
    const started = Date.now();
    hostCalls.length = 0;
    const res = await callTool('fetch_images', { conversation_url: 'https://chatgpt.com/c/6812a3b4-1c2d-8000-9e8f-0123456789ab', wait_seconds: 30 });
    assert.match(textOf(res), /^NEEDS USER ACTION — ChatGPT shows a human-verification page/);
    assert.ok(Date.now() - started < 1500);
  });
});
