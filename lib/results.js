'use strict';
// The text lines of a tool result for a job. Pure (no file or bridge access) so every status can
// be tested; mcp-server.js adds the preview images.
const { intArg } = require('./args');
// pct: the warning quotes the same rounded shares as the prompt ChatGPT got.
const { TOLERANCE, aspectOption, safeBand, pct: percent } = require('./aspect');

const FINAL = new Set(['succeeded', 'failed', 'cancelled', 'needs_reference', 'text_reply']);
// Each tool call returns within this many seconds by default: some clients that reach the PC from
// the cloud give up on a tool call after 60 s, and generating takes 1-3 minutes.
const DEFAULT_WAIT = 45;
// How long a tool call may wait for its job: wait_seconds as whole seconds within 0-900.
const waitSeconds = args => intArg(args.wait_seconds, 0, 900, DEFAULT_WAIT);
const checkAgain = id => `Call job_status with job_id="${id}" and wait_seconds=${DEFAULT_WAIT} again (repeat until it finishes), or cancel_job to stop it.`;
// A prompt that asks to change an existing image rather than draw a new one.
const EDIT_INTENT = /\b(edit(s|ed|ing)?|modif(y|ies|ied|ying)|retouch(es|ed|ing)?|inpaint(s|ed|ing)?|change only|only change|change [a-z ]{1,30} only|keep (everything|it|the rest)|pixel-identical|same (pose|image|drawing|character))\b|düzenle|değiştir|aynı (kalsın|bırak|tut)|koru(yarak)?\b/i;

const SHOW_IMAGE = 'Show the image to the user in the chat: if you can display or share a local file with the user, do that with the Saved path above ' +
  '(any preview attached here is a small copy for you to check); otherwise give that path clearly.';

const neutral = (pct, against) => `Similarity to ${against}: ${pct}% (a local edit keeps ~95-100%, a redraw is usually under 60%).`;

function editCheckLines(job) {
  const check = job.editCheck;
  if (!check || !check.results || !check.results.length) return [];
  // Each result is an output image's closest match; judge by the least similar output.
  const worst = check.results.reduce((a, b) => (b.similarity < a.similarity ? b : a));
  // Judged on the shown percentage, so the verdict never contradicts the number next to it.
  const pct = Math.round(worst.similarity * 100);
  // Only collection images attached: they are style or character references, so a new picture is
  // what was asked for, not a failed edit.
  const col = job.collection;
  if (col && (job.references || []).length <= col.used.length) return [neutral(pct, worst.against)];
  if (pct >= 75) return [`Edit check: ${pct}% of the image is unchanged compared with ${worst.against} — this looks like a real edit (edited: true).`];
  if (EDIT_INTENT.test(job.prompt || '')) {
    return [`⚠ EDIT CHECK (edited: false): only ${pct}% of the image matches ${worst.against}. ChatGPT most likely drew a NEW picture instead of editing (a real local edit keeps ~95-100%). ` +
      'Tell the user; if an exact edit is needed, call generate_image again WITHOUT conversation_url and with reference_images=[the original image file].'];
  }
  return [neutral(pct, worst.against)];
}

// Collection images come after the caller's own reference images in job.references.
function referenceLines(job) {
  const refs = job.references || [];
  const col = job.collection;
  const own = col ? refs.slice(0, Math.max(0, refs.length - col.used.length)) : refs;
  const lines = own.length ? [`Reference images attached: ${own.map(r => r.name).join(', ')}`] : [];
  if (col) {
    const left = col.skipped && col.skipped.length ? `; left out: ${col.skipped.join(', ')}` : '';
    lines.push(`References: collection "${col.name}": used ${col.used.length} of ${col.total} (${col.used.join(', ')})${left}`);
  }
  return lines;
}

const MISSING = '⚠ TRANSPARENT BACKGROUND MISSING';
const RETRY = 'Tell the user; retry once in a fresh chat or remove the background with another tool.';
const KINDS = { png: 'PNG', jpg: 'JPEG', jpeg: 'JPEG', webp: 'WebP', gif: 'GIF' };
const COLOR_TYPES = { 0: 'grayscale', 2: 'RGB', 3: 'palette' };

// ChatGPT was told what the crop may cut: nothing for a ratio it draws itself, the edges outside the
// safe band beyond 1:3..3:1. When it drew another shape, the crop cut more and may have hit the subject.
function cropWarning(im) {
  const { full } = im;
  if (!im.aspect || !im.width || !im.height || !full.width || !full.height) return null;
  const p = aspectOption(im.aspect);
  const axis = im.width < full.width ? 'width' : 'height';
  const kept = axis === 'width' ? im.width / full.width : im.height / full.height;
  const band = safeBand(p);
  const allowed = band && band.axis === axis ? band.share : 1;
  if (kept >= allowed * (1 - TOLERANCE)) return null;
  const edges = axis === 'height' ? 'top and bottom' : 'left and right';
  return `⚠ ChatGPT drew ${full.width}x${full.height} instead of ${p.generate.label}, so the crop removed ${percent(1 - kept)} of the ${axis} ` +
    `(${percent((1 - kept) / 2)} at the ${edges} each${allowed < 1 ? `; it was told only ${percent((1 - allowed) / 2)} each may be cut off` : ''}). ` +
    'Check the saved image for cut-off subjects or text; the full image is kept too.';
}

function aspectLine(im) {
  const [w, h] = im.aspect.split(':').map(Number);
  if (!im.width || !im.height) return `Aspect ratio: ${im.aspect} requested; the image size is unknown, so it was not cropped.`;
  const got = `${im.width}x${im.height}`;
  if (Math.abs(im.width * h - im.height * w) <= TOLERANCE * im.height * w) return `Aspect ratio: ${im.aspect} requested, got ${got} (within ${TOLERANCE * 100}%, not cropped).`;
  return `⚠ Aspect ratio: ${im.aspect} requested, got ${got}; it could not be cropped.`;
}

// Judged on ChatGPT's own file: a cropped copy is always an RGBA PNG (canvas), whatever came in.
// The pixels were measured on the saved (cropped) image.
function transparencyLine(im) {
  const ext = (String((im.full || im).path).match(/\.([a-z0-9]+)$/i) || [])[1] || '';
  const kind = KINDS[ext.toLowerCase()] || 'image';
  const share = im.alpha ? im.alpha.transparentShare : null;
  // Only a PNG header, a JPEG or measured pixels tell whether there is an alpha channel at all.
  if (!im.png && kind !== 'JPEG' && share === null) return `Transparent background: ${kind}; whether it is transparent could not be measured.`;
  const channel = im.png ? im.png.alphaChannel || im.png.trns : kind !== 'JPEG' && share > 0;
  if (!channel) {
    const format = im.png ? `${COLOR_TYPES[im.png.colorType] || `color type ${im.png.colorType}`} PNG` : kind;
    return `${MISSING}: ChatGPT returned an image without an alpha channel (${format}), so the background is not transparent. ${RETRY}`;
  }
  if (share === null) return `Transparent background: ${kind} with an alpha channel; how much of it is transparent could not be measured.`;
  if (share > 0.02) return `Transparent background: yes — ${kind} with an alpha channel, ${Math.round(share * 100)}% of the pixels are transparent.`;
  return `${MISSING}: the ${kind} has an alpha channel but ${share > 0 ? 'almost ' : ''}every pixel is opaque. ${RETRY}`;
}

// The Saved line of one image, plus what was asked about its shape and background.
function imageLines(job, im) {
  const lines = [];
  if (im.full) {
    lines.push(`Saved: ${im.path} (${im.width ? `${im.width}x${im.height}, ` : ''}cropped from the centre to ${im.aspect})`,
      `Full image before cropping: ${im.full.path}${im.full.width ? ` (${im.full.width}x${im.full.height})` : ''}`);
    // Only a generated image was drawn to a requested shape; a fetched one is simply cropped.
    const warning = job.mode !== 'collect' && cropWarning(im);
    if (warning) lines.push(warning);
  } else {
    lines.push(`Saved: ${im.path}${im.width ? ` (${im.width}x${im.height})` : ''}`);
    if (im.aspect) lines.push(aspectLine(im));
  }
  if (job.transparent) lines.push(transparencyLine(im));
  return lines;
}

function resultLines(job) {
  const lines = [];
  switch (job.status) {
    case 'succeeded':
      lines.push(`SUCCESS — ChatGPT generated ${job.images.length} image(s). Job ${job.id}.`);
      break;
    case 'needs_reference':
      lines.push(`NEEDS REFERENCE IMAGE — ChatGPT could not access the image it should edit and asked for it to be uploaded again (job ${job.id}).${job.reattached ? ' It still asked after the bridge re-attached the image.' : ''}`,
        'Do NOT resend the same prompt. Next step: call generate_image again with reference_images=[the local file of the image to edit] — most reliable WITHOUT conversation_url (a fresh chat). ' +
        'Alternatively pass auto_reattach=true to let the bridge attach the chat\'s latest image itself.');
      break;
    case 'text_reply':
      lines.push(`CHATGPT REPLIED WITHOUT AN IMAGE (job ${job.id}). Read its reply below and act on it — do not resend the identical prompt. ` +
        'If it asked a question, answer it with generate_image(conversation_url=<the link below>, prompt=<your answer>, send_as_is=true); if it refused, rephrase the request.');
      break;
    case 'failed':
      lines.push(`FAILED — ${job.error || 'unknown error'} (job ${job.id})`);
      break;
    case 'cancelled':
      lines.push(`CANCELLED — job ${job.id}.`);
      break;
    case 'needs_human':
      lines.push(`NEEDS USER ACTION — ${job.message} (job ${job.id})`,
        'Ask the user to open the ChatGPT tab in Chrome and complete it themselves; do not try to get around it. ' +
        `The job continues automatically for up to 10 minutes; check it with job_status(job_id="${job.id}", wait_seconds=${DEFAULT_WAIT}).`);
      break;
    case 'queued':
      lines.push(`QUEUED — position ${job.queuePosition || '?'} in the queue (position 1 starts as soon as the running job, if any, is done). Job ${job.id}. ${checkAgain(job.id)}`);
      break;
    default:
      lines.push(`STILL RUNNING — ${job.message || job.step}. Job ${job.id}. ${checkAgain(job.id)}`);
  }
  if (job.conversationUrl) lines.push(`ChatGPT conversation: ${job.conversationUrl}`);
  // The ratio belongs to this job: a later fetch_images only crops when it is given the ratio again.
  if (job.status === 'failed' && job.conversationUrl && job.aspect) {
    lines.push(`If the chat finishes later, fetch_images(conversation_url=<the link above>, aspect_ratio="${job.aspect}") saves the image cropped the same way.`);
  }
  lines.push(...referenceLines(job));
  if (job.reattached && job.status === 'succeeded') lines.push('Note: ChatGPT first asked for the image again; the bridge re-attached it and asked once more.');
  for (const im of job.images || []) lines.push(...imageLines(job, im));
  for (const c of job.copies || []) lines.push(`Copied to: ${c}`);
  if (job.copyError) lines.push(`Could not copy into output_dir: ${job.copyError}`);
  // Clients differ: some show the attached preview only as a small icon, so ask for the file itself.
  if (job.status === 'succeeded' && (job.images || []).length) lines.push(SHOW_IMAGE);
  lines.push(...editCheckLines(job));
  if (job.assistantText) {
    lines.push(job.status === 'succeeded' ? `ChatGPT's text: ${job.assistantText.slice(0, 1500)}` : `ChatGPT's reply:\n${job.assistantText.slice(0, 3000)}`);
  }
  if (job.chatImages && job.chatImages.length) {
    lines.push('Images already saved from this chat (newest first) — usable as reference_images:');
    for (const im of job.chatImages) lines.push(`- ${im.path}  (${im.job}: "${im.prompt}")`);
  }
  return lines;
}

module.exports = { FINAL, DEFAULT_WAIT, EDIT_INTENT, SHOW_IMAGE, waitSeconds, editCheckLines, imageLines, referenceLines, resultLines };
