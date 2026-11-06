'use strict';
// Exercise the page helpers without a browser or DOM implementation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'inpage.js'), 'utf8');

function loadPage() {
  const sandbox = {};
  for (const name of ['document', 'location']) {
    Object.defineProperty(sandbox, name, { get() { assert.fail(`inpage.js accessed ${name}`); } });
  }
  vm.runInNewContext(source, sandbox, { filename: 'inpage.js' });
  return sandbox.__cgb;
}

function element(text, options = {}) {
  return { className: '', childElementCount: 0, closest() { return null; }, textContent: text, innerText: text, ...options };
}

test('inpage loads without accessing the DOM or location', () => {
  const page = loadPage();
  assert.equal(page.version, '2.0.0');
  assert.equal(typeof page.replyText, 'function');
});

test('replyText: a feedback survey alone leaves no assistant text', () => {
  const { replyText } = loadPage();
  for (const text of [
    'Is this conversation helpful so far?',
    'IS THIS CONVERSATION HELPFUL SO FAR',
    '  Is this conversation\n helpful so far?  Yes No  ',
  ]) assert.equal(replyText([element(text)]), '', text);
});

test('replyText: a survey alongside a real leaf keeps only the real text', () => {
  const { replyText } = loadPage();
  assert.equal(replyText([
    element('Is this conversation helpful so far?'),
    element('Here is your animation.'),
  ]), 'Here is your animation.');
});

test('replyText: markdown takes precedence and survey text inside markdown is preserved', () => {
  const { replyText } = loadPage();
  for (const className of ['MarkdownRoot', 'markdown']) {
    for (const text of ['Here is your animation.\nIs this conversation helpful so far?', 'Is this conversation helpful so far?']) {
      assert.equal(replyText([
        element(text, { className, childElementCount: 1 }),
        element('Is this conversation helpful so far?'),
        element('Other leaf text'),
      ]), text);
    }
  }
});

test('replyText: normal helpfulness statements and survey mentions remain assistant text', () => {
  const { replyText } = loadPage();
  for (const text of [
    'This sketch is helpful for planning.',
    'This image is helpful for choosing colors.',
    'The survey asks: Is this conversation helpful so far?',
    'Is this conversation helpful so farther along?',
    'Bu sohbet yararlıdır.',
  ]) assert.equal(replyText([element(text)]), text);
});

test('replyText: a survey prefix is filtered only below 80 squashed characters', () => {
  const { replyText } = loadPage();
  const prefix = 'Is this conversation helpful so far? ';
  assert.equal(replyText([element(prefix.padEnd(79, 'x'))]), '');
  const longText = prefix.padEnd(80, 'x');
  assert.equal(replyText([element(longText)]), longText);
});

test('replyText: plausible Turkish survey labels are excluded', () => {
  const { replyText } = loadPage();
  for (const text of [
    'Bu sohbet şu ana kadar faydalı mı?',
    'Bu konuşma şimdiye kadar yararlı mı?',
    'Bu sohbet işe yarar mı?',
    'Bu konuşma faydalı',
  ]) assert.equal(replyText([element(text)]), '', text);
});

test('replyText: existing leaf exclusions and failure reporting are preserved', () => {
  const { replyText } = loadPage();
  assert.equal(replyText([
    element('Container text', { childElementCount: 1 }),
    element('Button text', { closest: selector => selector.includes('button') ? {} : null }),
    element('Image generation failed Try again', {
      closest: selector => selector.includes('[role="status"]') ? {} : null,
    }),
  ]), 'Image generation failed');
});
