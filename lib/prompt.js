'use strict';
// The message the host sends to ChatGPT for a job.
const { promptLines } = require('./aspect');

// The wording nudges ChatGPT to call its image tool instead of asking questions first.
function withLead(job) {
  if (job.references && job.references.length) {
    const what = job.references.length > 1 ? 'The attached images are references' : 'The attached image is the reference';
    return `${what}. Follow the instructions below; when they ask for an edit, change only what is asked and keep everything else identical. Don't ask follow-up questions; generate the image directly.\n\n${job.prompt}`;
  }
  if (job.startUrl && /\/c\/[0-9a-f-]{8,}/i.test(job.startUrl)) {
    return `Update the image with the changes below and generate the new image directly, without follow-up questions.\n\n${job.prompt}`;
  }
  return `Generate an image from the description below. Don't ask follow-up questions; create the image directly.\n\n${job.prompt}`;
}

// Shape and background requests go after the prompt, so its opening (which the extension uses to
// recognise the sent message) stays the same.
function buildText(job) {
  if (job.sendAsIs) return job.prompt;
  if (job.animated) {
    const prompt = job.prompt.replace(/[\s.!]+$/u, '');
    const text = `Create an animated GIF: ${prompt}, one clear motion, still camera, seamless loop. Don't ask follow-up questions; create the GIF directly.`;
    if (job.references && job.references.length) {
      const lead = job.references.length > 1 ? 'The attached images are references.' : 'The attached image is the reference.';
      return `${lead}\n\n${text}`;
    }
    return text;
  }
  const extra = promptLines(job.aspect || null, !!job.transparent);
  return extra.length ? `${withLead(job)}\n\n${extra.join('\n')}` : withLead(job);
}

module.exports = { buildText };
