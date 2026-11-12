'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CHAT_STATES, ACTIVE, chatIdFromUrl, ownedChatIds, referencedChatIds, cleanupPlan, eligibleForJob } = require('../lib/chat-cleanup');

const A = '6812a3b4-1c2d-8000-9e8f-0123456789ab';
const B = '7812a3b4-1c2d-8000-9e8f-0123456789ab';
const C = '8812a3b4-1c2d-8000-9e8f-0123456789ab';
const url = id => `https://chatgpt.com/c/${id}`;
const PROJECT = 'https://chatgpt.com/g/g-p-67a1b2c3-images/project';
const make = (id = 'first', fields = {}) => ({ id, mode: 'generate', status: 'succeeded', startUrl: PROJECT,
  conversationUrl: url(A), images: [{ path: 'image.png' }], ...fields });

test('chat URLs require the exact origin, path and full UUID', () => {
  for (const value of [url(A), url(A.toUpperCase()) + '/', url(A) + '?view=1#reply',
    `https://chatgpt.com/g/g-p-67a1b2c3-images/c/${A}`, `https://chatgpt.com/g/g-p-67a1b2c3/c/${A}/`]) {
    assert.equal(chatIdFromUrl(value), A, value);
  }
  for (const value of [url(A).replace('https:', 'http:'), url(A).replace('chatgpt.com', 'www.chatgpt.com'),
    url(A).replace('chatgpt.com', 'evil.com'), url(A).replace('chatgpt.com', 'chatgpt.com.evil.com'),
    url(A).replace('chatgpt.com', 'chatgpt.com:8443'), 'https://chatgpt.com/c/abcdef12', url(A) + '/extra',
    url(A) + '//', `https://chatgpt.com/share/${A}`, '', null, undefined, 'https://chatgpt.com/g/g-p-xyz/c/' + A]) {
    assert.equal(chatIdFromUrl(value), null, String(value));
  }
});

test('state sets contain only the specified states', () => {
  assert.deepEqual([...ACTIVE], ['queued', 'running', 'needs_human']);
  assert.deepEqual([...CHAT_STATES], ['archived', 'deleted', 'gone', 'failed']);
});

test('only recorded generate chats opened by the bridge are owned', () => {
  const userChat = make('user', { startUrl: url(A) });
  const collect = make('collect', { mode: 'collect', conversationUrl: url(B) });
  const local = make('local', { mode: 'animate', startUrl: null, conversationUrl: null });
  for (const job of [userChat, collect, local]) assert.deepEqual([...ownedChatIds(job)], []);
  const plan = cleanupPlan([userChat, collect, local]);
  assert.deepEqual(plan, { eligible: [], kept: { not_created: 2 }, keptTotal: 2,
    cleaned: { archived: 0, deleted: 0, gone: 0 }, jobsScanned: 3 });
  assert.ok(!JSON.stringify(plan).includes(C));
  assert.deepEqual([...referencedChatIds(userChat)], [A]);
  assert.deepEqual([...referencedChatIds(collect)], [B]);
});

test('a project or empty start owns the resulting successful chat', () => {
  for (const startUrl of [PROJECT, null, undefined]) {
    const job = make('project', { startUrl });
    assert.deepEqual(cleanupPlan([job]).eligible, [{ id: A, url: url(A), jobIds: ['project'] }]);
  }
});

test('ownership rejects redirected existing chats, missing starts and malformed conversation starts', () => {
  const missing = make('missing', { conversationUrl: url(B) });
  delete missing.startUrl;
  for (const job of [missing, make('redirect', { startUrl: url(A), conversationUrl: url(B) }),
    make('invalid', { startUrl: 'https://chatgpt.com/C/abc', conversationUrl: url(B) })]) {
    assert.deepEqual([...ownedChatIds(job)], []);
    assert.deepEqual(cleanupPlan([job]).eligible, []);
    assert.equal(cleanupPlan([job]).kept.not_created, job.id === 'redirect' ? 2 : 1);
  }
});

test('any active reference keeps a chat, including a queued start URL alone', () => {
  for (const status of ACTIVE) {
    const jobs = [make(), make('next', { status, startUrl: url(A), conversationUrl: null })];
    assert.deepEqual(cleanupPlan(jobs).kept, { active: 1 }, status);
    assert.deepEqual(cleanupPlan(jobs).eligible, []);
  }
  assert.deepEqual(cleanupPlan([make('old', { status: 'running' }), make('last')]).kept, { active: 1 });
});

test('the last reference must succeed with images', () => {
  const cases = [
    [{ status: 'failed' }, 'failed'], [{ status: 'failed', reason: 'timeout' }, 'timeout'],
    [{ status: 'text_reply' }, 'text_reply'], [{ status: 'needs_reference' }, 'needs_reference'],
    [{ status: 'cancelled' }, 'cancelled'], [{ status: 'unknown' }, 'other'],
    [{ images: [] }, 'no_images'], [{ images: null }, 'no_images'], [{ images: undefined }, 'no_images'],
  ];
  for (const [fields, reason] of cases) {
    const plan = cleanupPlan([make('first', fields)]);
    assert.deepEqual(plan.kept, { [reason]: 1 });
    assert.deepEqual(plan.eligible, []);
  }
});

test('later references determine a shared owned chat outcome', () => {
  const jobs = [make(), make('second', { startUrl: url(A), status: 'failed' })];
  assert.deepEqual(cleanupPlan(jobs).kept, { failed: 1 });
  jobs.push(make('third', { startUrl: url(A) }));
  assert.deepEqual(cleanupPlan(jobs).eligible, [{ id: A, url: url(A), jobIds: ['first', 'second', 'third'] }]);
});

test('sprite attempts own each chat once and retain the attempt URL', () => {
  const attemptA = url(A) + '?attempt=1';
  const job = make('sprite', { conversationUrl: url(B), sprite: { attempts: [
    { conversationUrl: attemptA }, { conversationUrl: url(B) }, { conversationUrl: url(B) },
  ] } });
  assert.deepEqual(new Set(ownedChatIds(job)), new Set([A, B]));
  assert.deepEqual(new Set(referencedChatIds(job)), new Set([A, B]));
  assert.deepEqual(cleanupPlan([job]).eligible, [
    { id: B, url: url(B), jobIds: ['sprite'] }, { id: A, url: attemptA, jobIds: ['sprite'] },
  ]);
  // Existing history establishes chat order before this sprite's chosen conversation.
  const jobs = [make('earlier'), job];
  const expected = [
    { id: A, url: url(A), jobIds: ['earlier', 'sprite'] }, { id: B, url: url(B), jobIds: ['sprite'] },
  ];
  assert.deepEqual(cleanupPlan(jobs).eligible, expected);
  assert.deepEqual(cleanupPlan(jobs).eligible, expected);
  assert.deepEqual(eligibleForJob(jobs, job), [{ id: A, url: url(A) }, { id: B, url: url(B) }]);
  const duplicate = make('duplicate', { sprite: { attempts: [{ conversationUrl: attemptA }] } });
  assert.deepEqual(cleanupPlan([duplicate]).eligible, [{ id: A, url: attemptA, jobIds: ['duplicate'] }]);
});

test('cleaned chats are counted before ownership or activity, and failures can retry', () => {
  for (const state of CHAT_STATES) {
    const job = make('marked', { chatStates: { [A]: { state, at: '2026-11-12T10:00:00.000Z' } } });
    const plan = cleanupPlan([job]);
    assert.equal(plan.eligible.length, state === 'failed' ? 1 : 0);
    assert.deepEqual(plan.cleaned, { archived: state === 'archived' ? 1 : 0, deleted: state === 'deleted' ? 1 : 0, gone: state === 'gone' ? 1 : 0 });
    assert.equal(plan.keptTotal, 0);
  }
  const prunedOwner = make('remaining', { startUrl: url(A), status: 'running', chatStates: { [A]: { state: 'deleted' } } });
  assert.deepEqual(cleanupPlan([prunedOwner]).cleaned, { archived: 0, deleted: 1, gone: 0 });
});

test('the newest cleanup timestamp wins regardless of job creation order', () => {
  const jobs = [make('first', { chatStates: { [A]: { state: 'deleted', at: '2026-11-12T12:00:00.000Z' } } }),
    make('second', { startUrl: url(A), chatStates: { [A]: { state: 'archived', at: '2026-11-12T11:00:00.000Z' } } })];
  assert.deepEqual(cleanupPlan(jobs).cleaned, { archived: 0, deleted: 1, gone: 0 });
  jobs[1].chatStates[A] = { state: 'failed', at: '2026-11-12T13:00:00.000Z' };
  assert.equal(cleanupPlan(jobs).eligible.length, 1);
});

test('kept counts and totals count distinct chats', () => {
  const jobs = [make('one', { status: 'failed' }), make('two', { status: 'failed', conversationUrl: url(B) }),
    make('three', { status: 'text_reply', conversationUrl: url(C) })];
  const plan = cleanupPlan(jobs);
  assert.deepEqual(plan.kept, { failed: 2, text_reply: 1 });
  assert.equal(plan.keptTotal, 3);
  assert.equal(plan.jobsScanned, 3);
});

test('eligibleForJob returns only the chats owned by that job', () => {
  const first = make(), second = make('second', { conversationUrl: url(B) });
  const userChat = make('user', { startUrl: url(A) });
  const jobs = [first, second, userChat];
  assert.deepEqual(eligibleForJob(jobs, first), [{ id: A, url: url(A) }]);
  assert.deepEqual(eligibleForJob(jobs, second), [{ id: B, url: url(B) }]);
  assert.deepEqual(eligibleForJob(jobs, userChat), []);
});

test('old history and invalid origins add no chats or errors', () => {
  const jobs = [{ id: 'old' }, make('foreign', { conversationUrl: url(A).replace('chatgpt.com', 'evil.com') }),
    make('bad', { conversationUrl: 'invalid', sprite: { attempts: [null, {}, { conversationUrl: url(B).replace('https:', 'http:') }] } })];
  assert.deepEqual(cleanupPlan(jobs), { eligible: [], kept: {}, keptTotal: 0, cleaned: { archived: 0, deleted: 0, gone: 0 }, jobsScanned: 3 });
  assert.deepEqual(cleanupPlan([]), { eligible: [], kept: {}, keptTotal: 0, cleaned: { archived: 0, deleted: 0, gone: 0 }, jobsScanned: 0 });
});

test('archived and deleted chats are in no list; only open chats are eligible', () => {
  const archived = { state: 'archived', at: '2026-11-12T10:00:00.000Z' };
  const jobs = [make('open'), make('closed', { conversationUrl: url(B), chatStates: { [B]: archived } }),
    make('gone', { conversationUrl: url(C), chatStates: { [C]: { state: 'deleted', at: '2026-11-12T10:00:00.000Z' } } })];
  const plan = cleanupPlan(jobs);
  assert.deepEqual(plan.eligible, [{ id: A, url: url(A), jobIds: ['open'] }]);
  assert.equal(Object.hasOwn(plan, 'deletable'), false);
  assert.deepEqual(plan.kept, {});
  assert.deepEqual(plan.cleaned, { archived: 1, deleted: 1, gone: 0 });
  assert.deepEqual(eligibleForJob(jobs, jobs[1]), []);
  assert.deepEqual(eligibleForJob(jobs, jobs[2]), []);
});

test('an archived chat is counted before later eligibility rules', () => {
  const archived = { state: 'archived', at: '2026-11-12T10:00:00.000Z' };
  const jobs = [make('first', { chatStates: { [A]: archived } }), make('return', { startUrl: url(A), status: 'failed' })];
  const plan = cleanupPlan(jobs);
  assert.deepEqual(plan.kept, {});
  assert.deepEqual(plan.eligible, []);
  assert.equal(Object.hasOwn(plan, 'deletable'), false);
  assert.deepEqual(plan.cleaned, { archived: 1, deleted: 0, gone: 0 });
});

test('an archived chat whose owner left the history is counted as archived, not kept or eligible', () => {
  const returning = make('return', { startUrl: url(A), conversationUrl: url(A),
    chatStates: { [A]: { state: 'archived', at: '2026-11-12T10:00:00.000Z' } } });
  const plan = cleanupPlan([returning]);
  assert.deepEqual(plan.cleaned, { archived: 1, deleted: 0, gone: 0 });
  assert.deepEqual(plan.kept, {});
  assert.equal(plan.keptTotal, 0);
  assert.deepEqual(plan.eligible, []);
  assert.equal(Object.hasOwn(plan, 'deletable'), false);
});

test('a gone chat is in no list and is counted as gone, like a deleted one', () => {
  const gone = { state: 'gone', at: '2026-11-12T10:00:00.000Z' };
  const jobs = [make('open'), make('lost', { conversationUrl: url(B), chatStates: { [B]: gone } }),
    make('deleted', { conversationUrl: url(C), chatStates: { [C]: { state: 'deleted', at: '2026-11-12T10:00:00.000Z' } } })];
  const plan = cleanupPlan(jobs);
  assert.deepEqual(plan.eligible, [{ id: A, url: url(A), jobIds: ['open'] }]);
  assert.equal(Object.hasOwn(plan, 'deletable'), false);
  assert.deepEqual(plan.kept, {});
  assert.deepEqual(plan.cleaned, { archived: 0, deleted: 1, gone: 1 });
  assert.deepEqual(eligibleForJob(jobs, jobs[1]), []);
});

test('a gone chat is counted even when its owning job left the history or is no longer eligible', () => {
  const gone = { state: 'gone', at: '2026-11-12T10:00:00.000Z' };
  const returning = make('return', { startUrl: url(A), conversationUrl: url(A), chatStates: { [A]: gone } });
  assert.deepEqual(cleanupPlan([returning]).cleaned, { archived: 0, deleted: 0, gone: 1 });
  const failed = make('failed', { status: 'failed', chatStates: { [A]: gone } });
  const plan = cleanupPlan([failed]);
  assert.deepEqual(plan.cleaned, { archived: 0, deleted: 0, gone: 1 });
  assert.deepEqual(plan.kept, {});
  assert.deepEqual(plan.eligible, []);
});

test('a chat found gone after it was archived is counted as gone only', () => {
  const jobs = [make('first', { chatStates: { [A]: { state: 'archived', at: '2026-11-12T10:00:00.000Z' } } }),
    make('second', { startUrl: url(A), chatStates: { [A]: { state: 'gone', at: '2026-11-12T11:00:00.000Z' } } })];
  const plan = cleanupPlan(jobs);
  assert.deepEqual(plan.cleaned, { archived: 0, deleted: 0, gone: 1 });
  assert.equal(Object.hasOwn(plan, 'deletable'), false);
});
