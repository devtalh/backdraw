'use strict';
// Chat ownership and cleanup eligibility come only from the bridge's job history.
const ACTIVE = new Set(['queued', 'running', 'needs_human']);
const CHAT_STATES = new Set(['archived', 'deleted', 'failed']);
const CHAT_PATH = /^\/(?:g\/g-p-[0-9a-f]+(?:-[a-z0-9-]+)?\/)?c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

function chatIdFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'chatgpt.com' || parsed.port) return null;
    return parsed.pathname.match(CHAT_PATH)?.[1].toLowerCase() || null;
  } catch { return null; }
}

function candidateUrls(job) {
  const attempts = Array.isArray(job.sprite?.attempts) ? job.sprite.attempts : [];
  return [job.conversationUrl, ...attempts.map(attempt => attempt?.conversationUrl)];
}

function ownedChatIds(job) {
  if (job.mode !== 'generate' || !Object.prototype.hasOwnProperty.call(job, 'startUrl') ||
      (job.startUrl != null && /\/c\//i.test(String(job.startUrl)))) return new Set();
  return new Set(candidateUrls(job).map(chatIdFromUrl).filter(Boolean));
}

function referencedChatIds(job) {
  return new Set([job.startUrl, ...candidateUrls(job)].map(chatIdFromUrl).filter(Boolean));
}

function cleanupPlan(jobs) {
  const chats = new Map();
  for (const job of jobs) {
    const owned = ownedChatIds(job);
    for (const id of referencedChatIds(job)) {
      if (!chats.has(id)) chats.set(id, { refs: [], owned: false, url: null });
      const chat = chats.get(id);
      chat.refs.push(job);
      if (owned.has(id)) {
        chat.owned = true;
        // Prefer the attempt's URL when the same chat also appears on the job.
        chat.url ||= candidateUrls(job).slice().reverse().find(url => chatIdFromUrl(url) === id);
      }
    }
  }
  const eligible = [], deletable = [], kept = {}, cleaned = { archived: 0, deleted: 0 };
  for (const [id, chat] of chats) {
    let latest = null;
    for (const job of jobs) {
      const entry = job.chatStates?.[id];
      if (entry && (!latest || String(entry.at || '') >= String(latest.at || ''))) latest = entry;
    }
    if (latest?.state === 'deleted') {
      cleaned.deleted++;
      continue;
    }
    // An archived chat is still deletable, so it goes through the same rules as an open one.
    const archived = latest?.state === 'archived';
    // No ownership proof left in the history: count it as archived, but never offer it for deletion.
    if (archived && !chat.owned) {
      cleaned.archived++;
      continue;
    }
    const last = chat.refs[chat.refs.length - 1];
    let reason;
    if (!chat.owned) reason = 'not_created';
    else if (chat.refs.some(job => ACTIVE.has(job.status))) reason = 'active';
    else if (last.status === 'failed' && last.reason === 'timeout') reason = 'timeout';
    else if (['failed', 'text_reply', 'needs_reference', 'cancelled'].includes(last.status)) reason = last.status;
    else if (last.status !== 'succeeded') reason = 'other';
    else if (!Array.isArray(last.images) || !last.images.length) reason = 'no_images';
    if (reason) kept[reason] = (kept[reason] || 0) + 1;
    else if (archived) {
      cleaned.archived++;
      deletable.push({ id, url: chat.url, jobIds: chat.refs.map(job => job.id), archived: true });
    } else {
      const entry = { id, url: chat.url, jobIds: chat.refs.map(job => job.id) };
      eligible.push(entry);
      deletable.push(entry);
    }
  }
  return { eligible, deletable, kept, keptTotal: Object.values(kept).reduce((sum, count) => sum + count, 0), cleaned, jobsScanned: jobs.length };
}

function eligibleForJob(jobs, job) {
  const owned = ownedChatIds(job);
  return cleanupPlan(jobs).deletable.filter(chat => owned.has(chat.id)).map(({ id, url }) => ({ id, url }));
}

module.exports = { CHAT_STATES, ACTIVE, chatIdFromUrl, ownedChatIds, referencedChatIds, cleanupPlan, eligibleForJob };
