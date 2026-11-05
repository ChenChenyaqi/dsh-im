import test from 'node:test';
import assert from 'node:assert/strict';

import { IMessageBotClient, splitIMessageReplyParts } from '../../../src/channels/imessage/runtime.mjs';

const target = { chatGuid: 'iMessage;-;+8613800000000', address: '+8613800000000' };

function spyApi() {
  const calls = [];
  return { calls, sendText: async (payload) => { calls.push(payload); return { sent: true }; } };
}

test('a command receipt goes out as one message with no pacing', async () => {
  const api = spyApi();
  const bot = new IMessageBotClient(api, null, { typing: { random: () => 0.5 } });
  const help = '/new  开启一个全新会话\n/compact  压缩较早上下文\n/status  检查连接状态';
  const startedAt = Date.now();
  await bot.sendCommandReply(target, help);
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].text, help);
  // No human delay: this would otherwise take seconds for three lines.
  assert.ok(Date.now() - startedAt < 1000);
});

test('a command receipt trims surrounding blank lines but keeps the body', async () => {
  const api = spyApi();
  const bot = new IMessageBotClient(api, null);
  await bot.sendCommandReply(target, '\n\n第一行\n第二行\n\n');
  assert.equal(api.calls[0].text, '第一行\n第二行');
});

test('an empty command receipt sends nothing', async () => {
  const api = spyApi();
  const bot = new IMessageBotClient(api, null);
  await bot.sendCommandReply(target, '   ');
  await bot.sendCommandReply(target, undefined);
  assert.deepEqual(api.calls, []);
});

test('ordinary replies still segment and pace', async () => {
  const api = spyApi();
  const bot = new IMessageBotClient(api, null, { lineSendIntervalMs: 0 });
  const chat = '第一句\n第二句\n```js\nconst a = 1;\n```';
  await bot.sendText(target, chat);
  assert.deepEqual(api.calls.map((call) => call.text), splitIMessageReplyParts(chat));
  assert.equal(api.calls.length, 3);
});

test('proactive reminders keep the segmented path', async () => {
  // Reminders are conversation, not receipts: they must keep the human rhythm.
  const api = spyApi();
  const bot = new IMessageBotClient(api, null, { lineSendIntervalMs: 0 });
  await bot.sendText(target, '到点了\n去睡');
  assert.equal(api.calls.length, 2);
});

test('a bot without sendCommandReply only exists when the client provides it', async () => {
  const api = spyApi();
  const bot = new IMessageBotClient(api, null);
  assert.equal(typeof bot.sendCommandReply, 'function');
  await bot.sendText(target, '单行', { instant: true });
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].text, '单行');
});
