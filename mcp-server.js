'use strict';
// MCP server (stdio, newline-delimited JSON-RPC) that Claude Code starts. It is a thin client:
// every tool call is forwarded to the native host that Chrome runs for the extension.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const identity = require('./identity');
const bridge = require('./shared');
const protocol = require('./lib/protocol');
const { FINAL, DEFAULT_WAIT, waitSeconds, resultLines } = require('./lib/results');
const { MAX_REFS } = require('./lib/limits');
const { describeCollections } = require('./lib/collections');

const SERVER_INFO = { name: identity.MCP_NAME, title: identity.PRODUCT, version: bridge.VERSION };

const INSTRUCTIONS = `Generates images with the user's own ChatGPT account (already logged in in Google Chrome), with no OpenAI API key and no extra cost.
- When the user asks for an image "with ChatGPT" (in any language), call generate_image with a detailed, self-contained prompt.
- generate_image and fetch_images return within about ${DEFAULT_WAIT} seconds. Generating usually takes 1-3 minutes, so the first result is often STILL RUNNING or QUEUED with a job id: keep calling job_status(job_id, wait_seconds=${DEFAULT_WAIT}) until it reports a final status. Do not call generate_image again for the same request while its job is still running.
- To EDIT an image or keep a character consistent, pass the image file(s) in reference_images (e.g. a file saved by an earlier call). A fresh chat with reference_images is the most reliable way to edit; long revision chains via conversation_url make ChatGPT lose track of earlier images.
- For a specific shape (banner, avatar, phone wallpaper) pass aspect_ratio instead of describing the size in the prompt; for stickers/logos/icons that need a see-through background pass transparent_background=true and read the transparency line in the result.
- When the user mentions one of their Backdraw collections (reference images they saved from the web in Chrome), call list_collections if needed and pass reference_collection to generate_image.
- Read every result line: NEEDS REFERENCE IMAGE means ChatGPT could not reach the image to edit; CHATGPT REPLIED WITHOUT AN IMAGE shows ChatGPT's own text. Never resend the identical prompt in a loop; follow the next step given in the result.
- An EDIT CHECK warning means ChatGPT drew a new picture instead of editing; tell the user and retry with reference_images in a fresh chat if an exact edit is needed.
- The work happens in a background Chrome tab; never tell the user to switch tabs unless a result says NEEDS USER ACTION.
- NEEDS USER ACTION means ChatGPT shows a login or human-verification (CAPTCHA) page: ask the user to open the ChatGPT tab in Chrome and finish it themselves. Never try to get around it. The job continues automatically afterwards (check with job_status).
- If no project is selected, call list_projects, then select_project with the user's images project.
- If a job timed out but has a conversation link, fetch_images can still download the result later; pass the job's aspect_ratio again so it is cropped the same way.
- Report the saved file path(s) and the ChatGPT conversation link to the user.`;

// Shared by the tools that wait for a job.
const WAIT_SECONDS = {
  type: 'integer', minimum: 0, maximum: 900, default: DEFAULT_WAIT,
  description: `Return within this many seconds. The default ${DEFAULT_WAIT} keeps each call under the 60-second tool limit some clients have. ` +
    'If the job has not finished by then, the result says STILL RUNNING or QUEUED: call job_status with its job_id again.',
};

const TOOLS = [
  {
    name: 'generate_image',
    title: 'Generate or edit an image with ChatGPT',
    description:
      "Generate or edit an image with ChatGPT through the user's own logged-in ChatGPT account in Google Chrome (no OpenAI API key, no extra cost). " +
      "A new chat is started inside the user's selected ChatGPT Project, in a background tab: the user's active tab, window focus, mouse and keyboard are never touched. " +
      `Waits up to wait_seconds (default ${DEFAULT_WAIT}) and returns: SUCCESS with the saved file path(s) (always kept in the images folder), a preview and the conversation link; ` +
      "NEEDS REFERENCE IMAGE / CHATGPT REPLIED WITHOUT AN IMAGE together with ChatGPT's own reply text; " +
      'or, while ChatGPT is still working, STILL RUNNING / QUEUED with a job id: then keep calling job_status with that job_id. ' +
      "Use it whenever the user asks for an image, visual, illustration or concept art with ChatGPT, in any language. " +
      'Write a detailed, self-contained prompt (subject, style, composition, colors, mood); give the shape in aspect_ratio rather than in the prompt. ' +
      'To edit an image or keep a character consistent, pass the image file(s) in reference_images: a fresh chat with reference_images is the most reliable way to edit. ' +
      "To use one of the user's saved reference collections (see list_collections), pass reference_collection.",
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Full image description or edit instructions, in any language.' },
        aspect_ratio: {
          type: 'string',
          description: 'Optional shape as W:H, e.g. 1:1, 3:2, 2:3, 4:3, 3:4, 16:9, 9:16, 4:5, 5:2 (Discord banner) or 3:1 (header). ' +
            'Any W:H with whole numbers between 1:4 and 4:1 works (not 1.5:1: use 3:2). ChatGPT draws 1:3 to 3:1 itself; wider or taller shapes ' +
            'are drawn at 3:1 / 1:3 and cropped. An image more than 1% off is cropped from the centre to this ratio (to the nearest pixel), and the full image is kept too.',
        },
        transparent_background: {
          type: 'boolean', default: false,
          description: 'Ask for a PNG with a transparent background (stickers, logos, icons, sprites). The result says whether the saved image really has transparent pixels.',
        },
        reference_images: {
          type: 'array', items: { type: 'string' }, maxItems: MAX_REFS,
          description: `Optional local image files (png/jpg/webp/gif, up to ${MAX_REFS}) attached to the message, e.g. the image to edit or a character sheet. Paths saved by earlier calls work directly.`,
        },
        conversation_url: {
          type: 'string',
          description: 'Optional ChatGPT conversation link from an earlier result: the prompt is sent in that chat instead of a new one. Fine for quick follow-ups; for exact edits prefer reference_images in a fresh chat.',
        },
        auto_reattach: {
          type: 'boolean', default: false,
          description: "If ChatGPT answers that it can't access the image and asks for it to be uploaded, attach the chat's latest image (or reference_images) automatically and ask once more.",
        },
        output_dir: {
          type: 'string',
          description: "Optional folder to also copy the image(s) into, e.g. the current project's assets folder (absolute path preferred). The central images folder always keeps a copy.",
        },
        wait_seconds: WAIT_SECONDS,
        include_preview: { type: 'boolean', default: true, description: 'Attach a downscaled preview of the result so you can check it.' },
        send_as_is: { type: 'boolean', default: false, description: 'Send the prompt verbatim, without the short instruction the bridge adds (useful to answer a question ChatGPT asked).' },
        reference_collection: {
          type: 'string',
          description: "Optional name of one of the user's Backdraw reference collections (see list_collections; matched loosely). " +
            `Its images are attached after any reference_images, up to ${MAX_REFS} references in total: over the limit the newest are used, unless reference_files picks others.`,
        },
        reference_files: {
          type: 'array', items: { type: 'string' }, maxItems: MAX_REFS,
          description: 'Optional file names from list_collections to attach only those images of reference_collection, instead of the newest.',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'job_status',
    title: 'ChatGPT image job status',
    description:
      `Check a ChatGPT image job by job_id, waiting up to wait_seconds (default ${DEFAULT_WAIT}) for it to finish; call it again while the result says STILL RUNNING or QUEUED. ` +
      'Without job_id it reports the bridge itself: whether Chrome and the extension are connected, the selected ChatGPT project, the images folder, the queue and recent jobs.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job id returned by generate_image (e.g. img_1a2b3c4d).' },
        wait_seconds: WAIT_SECONDS,
        include_preview: { type: 'boolean', default: true, description: 'Attach the image preview when the job succeeded.' },
      },
      additionalProperties: false,
    },
    // Not read-only: a finished job's images are copied into the output_dir generate_image asked for
    // here, and with the short default wait that is where it usually happens. It only adds files, once.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'cancel_job',
    title: 'Cancel a ChatGPT image job',
    description: 'Cancel a queued or running ChatGPT image job. If ChatGPT is already generating, it presses Stop in the background tab and closes that tab.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string', description: 'Job id to cancel.' } },
      required: ['job_id'],
      additionalProperties: false,
    },
    // Stopping ChatGPT mid-generation can't be undone; cancelling twice changes nothing more.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'fetch_images',
    title: 'Fetch images from a ChatGPT conversation',
    description:
      'Download the generated images of the latest answer in an existing ChatGPT conversation (by its link) without sending anything. ' +
      'Use it when a job timed out or failed after ChatGPT had started, but the chat finished later, or to save images from an earlier chat. ' +
      `Like generate_image it returns within wait_seconds (default ${DEFAULT_WAIT}); if it says STILL RUNNING or QUEUED, keep calling job_status with its job_id.`,
    inputSchema: {
      type: 'object',
      properties: {
        conversation_url: { type: 'string', description: 'ChatGPT conversation link (https://chatgpt.com/…/c/…).' },
        aspect_ratio: { type: 'string', description: 'Optional W:H (between 1:4 and 4:1, e.g. 16:9) to crop the downloaded images to, from the centre; the full images are kept too. For the result of a generate_image job, pass its aspect_ratio again.' },
        output_dir: { type: 'string', description: 'Optional folder to also copy the image(s) into (absolute path preferred).' },
        wait_seconds: WAIT_SECONDS,
        include_preview: { type: 'boolean', default: true, description: 'Attach a downscaled preview.' },
      },
      required: ['conversation_url'],
      additionalProperties: false,
    },
    // Not read-only: it saves the downloaded images as new files.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'list_projects',
    title: 'List ChatGPT projects',
    description: "List the Projects in the user's ChatGPT account (read from ChatGPT's sidebar in a background tab) and show which one is selected for images. Use it during setup.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'select_project',
    title: 'Select the ChatGPT project for images',
    description: 'Select and remember the ChatGPT Project where new image chats are created. Pass the project name as shown in ChatGPT (matched loosely) or its https://chatgpt.com/g/g-p-…/project link.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name as shown in ChatGPT.' },
        url: { type: 'string', description: 'Project link (alternative to name).' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'list_collections',
    title: 'List Backdraw reference collections',
    description:
      'List the reference collections the user saved in Chrome (right-click an image, "Add to Backdraw"): each with its image count, folder and files (newest first, with the site they came from). ' +
      `Pass a collection's name as generate_image's reference_collection to attach its images (up to ${MAX_REFS} references; reference_files picks specific ones).`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

// ---------------------------------------------------------------- JSON-RPC over stdio

const frame = msg => ({ jsonrpc: '2.0', ...msg });
function send(msg) { process.stdout.write(JSON.stringify(frame(msg)) + '\n'); }
function logErr(...args) { process.stderr.write(`[${identity.MCP_NAME}] ${args.join(' ')}\n`); }

// An error answer leaves the id out when the message had none we can echo (MCP never allows a null id).
const errorReply = (id, error) => (id === undefined || id === null ? { error } : { id, error });
const INVALID_REQUEST = { code: -32600, message: 'Invalid Request' };

// Tool calls in progress, by request id. A client's notifications/cancelled marks one, and nothing
// more is sent for it (no progress, no result). The ChatGPT job keeps running: cancel_job stops that.
const inFlight = new Map();

// respond sends this message's response; a batch collects them into one array instead.
async function handle(msg, respond = send) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return respond(errorReply(null, INVALID_REQUEST));
  if (typeof msg.method !== 'string') {
    // A response (to a request this server never sends) needs no answer; anything else is malformed.
    if (!('result' in msg) && !('error' in msg)) respond(errorReply(msg.id, INVALID_REQUEST));
    return;
  }
  const isRequest = msg.id !== undefined && msg.id !== null;
  const version = protocol.requestVersion(msg.params);
  if (version !== null && !protocol.SUPPORTED_VERSIONS.includes(version)) {
    if (isRequest) respond({ id: msg.id, error: protocol.unsupportedVersion(version) });
    return;
  }
  // A notification never gets a response, whatever its method.
  if (!isRequest) {
    const call = msg.method === 'notifications/cancelled' && msg.params && inFlight.get(msg.params.requestId);
    if (call) call.cancelled = true;
    return;
  }
  // 2026-07-28 also requires _meta clientCapabilities on every request. A request without it is
  // served as if it declared none: this server never reads client capabilities, and refusing would
  // only break image generation for a client that leaves out a field nothing here uses.
  const modern = protocol.MODERN_VERSIONS.includes(version);
  const reply = result => respond({ id: msg.id, result: modern ? protocol.modernResult(msg.method, result, SERVER_INFO) : result });
  try {
    switch (msg.method) {
      case 'initialize': {
        const protocolVersion = protocol.negotiateLegacy(msg.params && msg.params.protocolVersion);
        return respond({ id: msg.id, result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS } });
      }
      case 'server/discover': return respond({ id: msg.id, result: protocol.discoverResult(SERVER_INFO, INSTRUCTIONS) });
      case 'ping': return reply({}); // legacy only, but harmless to answer
      case 'tools/list': return reply({ tools: TOOLS });
      case 'tools/call': {
        const p = msg.params || {};
        const call = { progressToken: p._meta && p._meta.progressToken, cancelled: false };
        inFlight.set(msg.id, call);
        try {
          const result = await callTool(p.name, p.arguments || {}, call);
          if (!call.cancelled) reply(result);
        } finally {
          inFlight.delete(msg.id);
        }
        return;
      }
      case 'resources/list': return reply({ resources: [] });
      case 'prompts/list': return reply({ prompts: [] });
      default:
        respond({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    }
  } catch (e) {
    logErr('request failed:', e.stack || e);
    respond({ id: msg.id, error: { code: -32603, message: String(e.message || e) } });
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return send(errorReply(null, { code: -32700, message: 'Parse error' })); }
  if (!Array.isArray(msg) || !msg.length) return handle(msg);
  // A JSON-RPC batch (2025-03-26 clients may send one): all its responses go back in one array.
  const responses = [];
  await Promise.all(msg.map(m => handle(m, r => responses.push(frame(r)))));
  if (responses.length) process.stdout.write(JSON.stringify(responses) + '\n');
});
rl.on('close', () => process.exit(0));

// ---------------------------------------------------------------- tools

const sleep = ms => new Promise(r => setTimeout(r, ms));
const textResult = (text, isError = false) => ({ content: [{ type: 'text', text }], isError });
// The wait counts from the start of the tool call: starting a job with reference images can take
// a few seconds itself, and the whole call has to fit in the client's tool-call limit.
const deadlineFrom = args => Date.now() + waitSeconds(args) * 1000;
const secondsLeft = deadline => Math.max(0, (deadline - Date.now()) / 1000);

// call: { progressToken, cancelled } of the tools/call request.
async function callTool(name, args, call) {
  try {
    switch (name) {
      case 'generate_image': return await generateImage(args, call);
      case 'job_status': return await jobStatus(args, call);
      case 'cancel_job': return await cancelJob(args, call);
      case 'fetch_images': return await fetchImages(args, call);
      case 'list_projects': return await listProjects();
      case 'select_project': return await selectProject(args);
      case 'list_collections': return await listCollections();
      default: return textResult(`Unknown tool: ${name}`, true);
    }
  } catch (e) {
    return textResult(e.code === 'NOT_RUNNING' ? `BRIDGE NOT RUNNING — ${e.message}` : `ERROR — ${e.message}`, true);
  }
}

async function generateImage(args, call) {
  const deadline = deadlineFrom(args);
  const prompt = String(args.prompt || '').trim();
  if (!prompt) return textResult('prompt is required.', true);
  const references = bridge.readReferences(args.reference_images);
  const job = await bridge.call('generate', {
    prompt, references, autoReattach: !!args.auto_reattach, sendAsIs: !!args.send_as_is,
    aspect: args.aspect_ratio, transparent: !!args.transparent_background,
    copyTo: args.output_dir ? path.resolve(String(args.output_dir)) : undefined,
    startUrl: args.conversation_url ? String(args.conversation_url) : undefined,
    referenceCollection: args.reference_collection ? String(args.reference_collection) : undefined,
    // A single file name as a string works too, like reference_images.
    referenceFiles: args.reference_files ? [].concat(args.reference_files).map(String) : undefined,
  }, 60000);
  const done = await waitForJob(job.id, secondsLeft(deadline), call);
  return jobResult(await finish(done), args.include_preview !== false);
}

async function fetchImages(args, call) {
  const deadline = deadlineFrom(args);
  const url = String(args.conversation_url || '').trim();
  if (!url) return textResult('conversation_url is required.', true);
  const copyTo = args.output_dir ? path.resolve(String(args.output_dir)) : undefined;
  const job = await bridge.call('generate', { mode: 'collect', startUrl: url, copyTo, aspect: args.aspect_ratio });
  const done = await waitForJob(job.id, secondsLeft(deadline), call);
  return jobResult(await finish(done), args.include_preview !== false);
}

async function jobStatus(args, call) {
  if (!args.job_id) return bridgeStatus();
  const id = String(args.job_id).trim();
  const job = await waitForJob(id, secondsLeft(deadlineFrom(args)), call, toldUser.has(id));
  return jobResult(await finish(job), args.include_preview !== false);
}

async function cancelJob(args, call) {
  const id = String(args.job_id || '').trim();
  if (!id) return textResult('job_id is required.', true);
  await bridge.call('cancel', { jobId: id });
  // A job being cancelled needs nothing from the user any more: wait for it to stop instead.
  return jobResult(await waitForJob(id, 25, call, true), false);
}

const finish = job => bridge.copyResults(job);

// Jobs whose current NEEDS USER ACTION the client has already been given.
const toldUser = new Set();

// A job that starts to need the user (login or CAPTCHA) returns at once so the user can be asked.
// humanKnown: the client already knows the job needs the user, so while it still does it is waited
// on like a running one (no instant answers to a polling loop); needing the user again after that
// is new and returns at once.
async function waitForJob(jobId, seconds, call, humanKnown = false) {
  const deadline = Date.now() + seconds * 1000;
  let job = await bridge.call('job', { jobId });
  let tick = 0;
  let lastNote = '';
  let lastSent = 0;
  let known = humanKnown && job.status === 'needs_human';
  while (!call.cancelled && !FINAL.has(job.status) && (known || job.status !== 'needs_human') && Date.now() < deadline) {
    await sleep(1500);
    try {
      job = await bridge.call('job', { jobId });
    } catch (e) {
      if (e.code === 'NOT_RUNNING' || e.code === 'CLOSED') {
        throw new bridge.BridgeError(`Lost the connection to Chrome while job ${jobId} was ${job.status} (${job.message || job.step}). ${bridge.NOT_RUNNING}`, e.code);
      }
      throw e;
    }
    known = known && job.status === 'needs_human';
    const note = `${job.status}: ${job.message || job.step}`;
    const { progressToken } = call;
    if (progressToken !== undefined && !call.cancelled && (note !== lastNote || Date.now() - lastSent > 10000)) {
      send({ method: 'notifications/progress', params: { progressToken, progress: ++tick, message: note } });
      lastNote = note;
      lastSent = Date.now();
    }
  }
  return job;
}

function jobResult(job, includePreview) {
  if (job.status === 'needs_human') toldUser.add(job.id); else toldUser.delete(job.id);
  const content = [{ type: 'text', text: resultLines(job).join('\n') }];
  if (includePreview && job.status === 'succeeded') {
    for (const im of job.images) {
      try {
        if (im.preview) content.push({ type: 'image', data: fs.readFileSync(im.preview).toString('base64'), mimeType: 'image/jpeg' });
      } catch {}
    }
  }
  return { content, isError: job.status === 'failed' };
}

async function bridgeStatus() {
  let s;
  try {
    s = await bridge.call('status');
  } catch (e) {
    if (e.code === 'NOT_RUNNING') return textResult(`Bridge: NOT RUNNING. ${e.message}`);
    throw e;
  }
  const lines = [
    `Bridge: connected (Chrome extension v${s.extension ? s.extension.version : '?'}, host v${s.hostVersion}).`,
    s.project
      ? `ChatGPT project: ${s.project.name} — ${s.project.url}`
      : 'ChatGPT project: NOT SELECTED — call list_projects, then select_project.',
    `Images folder: ${s.outputDir}`,
    s.running ? `Running: ${s.running.id} — ${s.running.status}: ${s.running.message || s.running.step}` : 'Running: nothing',
    `Queued: ${s.queued.length ? s.queued.join(', ') : 'none'}`,
  ];
  if (s.recent.length) {
    lines.push('Recent jobs:');
    for (const j of s.recent) lines.push(`- ${j.id} ${j.status} (${j.createdAt}) "${j.prompt}"${j.conversationUrl ? ` ${j.conversationUrl}` : ''}`);
  }
  return textResult(lines.join('\n'));
}

async function listProjects() {
  const r = await bridge.call('list_projects', {}, 130000);
  if (!r.projects.length) return textResult('No projects were found in the ChatGPT sidebar.');
  const lines = ['ChatGPT projects:'];
  for (const p of r.projects) {
    const selected = r.selected && (r.selected.id === p.id || r.selected.name === p.name);
    lines.push(`- ${p.name}${p.url ? ` — ${p.url}` : ''}${selected ? '  (selected for images)' : ''}`);
  }
  if (!r.selected) lines.push('No project is selected yet; call select_project.');
  return textResult(lines.join('\n'));
}

async function selectProject(args) {
  if (!args.name && !args.url) return textResult('Give name or url.', true);
  const r = await bridge.call('select_project', { name: args.name, url: args.url }, 130000);
  return textResult(`Selected ChatGPT project "${r.project.name}" (${r.project.url}). New images will be created there and the choice is remembered.`);
}

async function listCollections() {
  return textResult(describeCollections(await bridge.call('list_collections'), MAX_REFS));
}

process.on('uncaughtException', e => logErr('uncaught:', e.stack || e));
process.on('unhandledRejection', e => logErr('unhandled:', (e && e.stack) || e));
