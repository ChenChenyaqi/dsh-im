import test from 'node:test';
import assert from 'node:assert/strict';

import { IMessageBotClient, splitIMessageReplyParts, computeHumanTypingDelayMs } from '../../../src/channels/imessage/runtime.mjs';

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

const half = () => 0.5;
const zero = () => 0;
const one = () => 1;

test('typing delay grows with reply length for plain text', () => {
  assert.equal(computeHumanTypingDelayMs('好', { random: half }), 500);
  assert.equal(computeHumanTypingDelayMs('好'.repeat(100), { random: half }), 5_000);
});

test('first reply waits longer than follow-up lines', () => {
  assert.equal(computeHumanTypingDelayMs('好', { isFirst: true, random: half }), 1_450);
  assert.equal(computeHumanTypingDelayMs('好', { isFirst: false, random: half }), 500);
});

test('fenced code blocks use a short paste delay regardless of length', () => {
  assert.equal(computeHumanTypingDelayMs('```js\nconsole.log(1);', { random: half }), 550);
  assert.equal(computeHumanTypingDelayMs('```js\n' + 'x'.repeat(5_000), { isFirst: true, random: half }), 550);
});

test('typing delay is jittered and clamped to bounds', () => {
  // Same "好": non-first base 500 -> 375 with the lowest rng, 625 with the highest.
  assert.equal(computeHumanTypingDelayMs('好', { random: zero }), 375);
  assert.equal(computeHumanTypingDelayMs('好', { random: one }), 625);
  // Paste base 300 with the lowest rng (225) is clamped up to the floor.
  assert.equal(computeHumanTypingDelayMs('```', { random: zero }), 250);
});

test('client sends every part even with real typing delays', async () => {
  const api = createApiSpy();
  const slow = new IMessageBotClient(api, null, { typing: { random: zero } });
  await slow.sendText(target, 'a\nb');
  assert.deepEqual(api.calls.map((call) => call.text), ['a', 'b']);
});

test('client aborts before the first delay sends nothing', async () => {
  const api = createApiSpy();
  const controller = new AbortController();
  controller.abort();
  const aborted = new IMessageBotClient(api, controller.signal, { typing: { random: half } });
  await assert.rejects(() => aborted.sendText(target, 'x\ny'));
  assert.equal(api.calls.length, 0);
});

test('sendImage and sendFile stage bytes to a temp file and forward the path', async () => {
  const sent = [];
  const api = { sendFile: async (payload) => { sent.push(payload); return { sent: true }; } };
  const bot = new IMessageBotClient(api, null);
  await bot.sendImage(target, { bytes: Buffer.from('PNGDATA'), fileName: '../../whale.png' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatGuid, target.chatGuid);
  assert.equal(sent[0].address, target.address);
  assert.ok(sent[0].path.includes('whale.png'));
  assert.ok(!sent[0].path.includes('..'));
  const { access } = await import('node:fs/promises');
  await assert.rejects(() => access(sent[0].path));  // temp file cleaned up
  await bot.sendFile(target, { bytes: Buffer.from('XYZ'), fileName: 'doc.pdf' });
  assert.equal(sent.length, 2);
  assert.ok(sent[1].path.endsWith('doc.pdf'));
});

test('sendImage rejects empty bytes', async () => {
  const api = { sendFile: async () => ({ sent: true }) };
  const bot = new IMessageBotClient(api, null);
  await assert.rejects(() => bot.sendImage(target, {}), /bytes are required/);
});
