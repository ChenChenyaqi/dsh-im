import test from 'node:test';
import assert from 'node:assert/strict';

import { IMessageBotClient, splitIMessageReplyParts } from '../../../src/channels/imessage/runtime.mjs';

function createApiSpy() {
  const calls = [];
  return { calls, sendText: async (payload) => { calls.push(payload); return { sent: true }; } };
}

const target = { chatGuid: 'any;-;+8613800000000', address: '+8613800000000' };
const client = (api) => new IMessageBotClient(api, null, { lineSendIntervalMs: 0 });

test('sends each line as a separate message', async () => {
  const api = createApiSpy();
  await client(api).sendText(target, '第一句\n第二句\n第三句');
  assert.deepEqual(api.calls.map((call) => call.text), ['第一句', '第二句', '第三句']);
});

test('skips blank lines and trims surrounding spaces when splitting', async () => {
  const api = createApiSpy();
  await client(api).sendText(target, '  你好  \n\n\n在吗\n');
  assert.deepEqual(api.calls.map((call) => call.text), ['你好', '在吗']);
});

test('keeps single-line replies as one message', async () => {
  const api = createApiSpy();
  await client(api).sendText(target, '好的');
  assert.deepEqual(api.calls.map((call) => call.text), ['好的']);
});

test('still forwards empty text to the API layer for validation', async () => {
  const api = createApiSpy();
  await client(api).sendText(target, '');
  assert.deepEqual(api.calls.map((call) => call.text), ['']);
});

test('forwards chat target and abort signal on every line', async () => {
  const api = createApiSpy();
  const controller = new AbortController();
  const lined = new IMessageBotClient(api, controller.signal, { lineSendIntervalMs: 0 });
  await lined.sendText(target, 'a\nb');
  assert.equal(api.calls.length, 2);
  for (const call of api.calls) {
    assert.equal(call.chatGuid, target.chatGuid);
    assert.equal(call.address, target.address);
    assert.equal(call.signal, controller.signal);
  }
});

test('keeps fenced code blocks with inner blank lines as one message', async () => {
  const api = createApiSpy();
  await client(api).sendText(target, '看这段\n```js\nconst a = 1;\n\nconst b = 2;\n```\n完事');
  assert.deepEqual(api.calls.map((call) => call.text), [
    '看这段',
    '```js\nconst a = 1;\n\nconst b = 2;\n```',
    '完事',
  ]);
});

test('sends an unclosed fenced code block as one trailing message', async () => {
  const api = createApiSpy();
  await client(api).sendText(target, '先说一句\n```python\nprint(1)\n\nprint(2)');
  assert.deepEqual(api.calls.map((call) => call.text), [
    '先说一句',
    '```python\nprint(1)\n\nprint(2)',
  ]);
});

test('splitIMessageReplyParts treats a bare fenced block as a single part', () => {
  assert.deepEqual(
    splitIMessageReplyParts('```\nonly line\n```'),
    ['```\nonly line\n```'],
  );
});

test('splitIMessageReplyParts keeps code lines and fences untrimmed inside blocks', () => {
  assert.deepEqual(
    splitIMessageReplyParts('```` ``` \n  indented();\n\n``` '),
    ['```` ``` \n  indented();\n\n``` '],
  );
});

test('splitIMessageReplyParts still splits plain lines around blocks', () => {
  assert.deepEqual(
    splitIMessageReplyParts('第一句\n\n```js\nx();\n```\n\n  第二句  \n'),
    ['第一句', '```js\nx();\n```', '第二句'],
  );
});
