import test from 'node:test';
import assert from 'node:assert/strict';

import { IMessageRuntime, IMessageBotClient, splitIMessageReplyParts } from '../../../src/channels/imessage/runtime.mjs';

const botId = 'imessage_test';

/** Build a runtime whose api/client are stubs, so no AppleScript ever runs. */
function makeRuntime(t, { client, api = {}, config = {} } = {}) {
  const sent = [];
  const fakeApi = {
    async getPermissions() { return { platform: 'darwin', database: 'granted', automation: 'granted' }; },
    async listMessages() { return []; },
    async getLatestMessageRowId() { return 0; },
    async sendText(payload) { sent.push(payload); return { sent: true }; },
    ...api,
  };
  const state = {
    cursor: () => 0,
    setCursor: async () => {},
    sessionFor: () => null,
    hasSeen: () => false,
    markSeen: async () => {},
    setSession: async () => {},
  };
  const runtime = new IMessageRuntime({
    config: { botId, platformId: 'me@example.com', ...config },
    token: 'token',
    harness: { ensureRunning: async () => true },
    state,
    logger: { warn() {}, error() {}, info() {} },
    pollIntervalMs: 1_000_000, // never poll during a test
    createApi: () => fakeApi,
    createClient: () => client,
  });
  t.after(() => runtime.stop());
  return { runtime, fakeApi, sent, state };
}

test('proactive reminders are segmented exactly like conversational replies', async (t) => {
  const seen = [];
  const client = { sendText: async (target, text) => { seen.push({ target, text }); } };
  const { runtime, sent } = makeRuntime(t, { client });
  await runtime.start();

  const reply = '到点了，去睡\n\n别又「再五分钟」';
  assert.deepEqual(await runtime.sendProactiveText(
    { route: { chatGuid: 'iMessage;-;+8613800000000' } }, reply,
  ), { sent: true });

  // The bot client receives the whole reply once; it owns the splitting.
  assert.deepEqual(seen, [{ target: { chatGuid: 'iMessage;-;+8613800000000' }, text: reply }]);
  // Nothing bypassed the client by calling the raw AppleScript api.
  assert.deepEqual(sent, []);
});

test('a real bot client turns one reminder into multiple api sends', async (t) => {
  const apiSends = [];
  const api = {
    async sendText(payload) { apiSends.push(payload.text); return { sent: true }; },
  };
  const client = new IMessageBotClient(api, null, { lineSendIntervalMs: 0 });
  const { runtime } = makeRuntime(t, { client, api: { sendText: api.sendText } });
  await runtime.start();

  const reply = '第一段\n第二段\n```js\nconst a = 1;\n```';
  await runtime.sendProactiveText({ route: { chatGuid: 'iMessage;-;+8613800000000' } }, reply);

  assert.deepEqual(apiSends, splitIMessageReplyParts(reply));
  assert.equal(apiSends.length, 3);
  // The fenced block survives intact instead of being split per line.
  assert.equal(apiSends[2], '```js\nconst a = 1;\n```');
});

test('proactive sends fail closed when the gateway is not connected', async (t) => {
  const client = { sendText: async () => { throw new Error('must not be called'); } };
  const { runtime } = makeRuntime(t, { client });
  await assert.rejects(
    () => runtime.sendProactiveText({ route: { chatGuid: 'iMessage;-;+861' } }, 'hi'),
    (error) => error.code === 'bot-not-connected',
  );
});

test('proactive sends reject a target without a chatGuid', async (t) => {
  const client = { sendText: async () => { throw new Error('must not be called'); } };
  const { runtime } = makeRuntime(t, { client });
  await runtime.start();
  await assert.rejects(
    () => runtime.sendProactiveText({ route: {} }, 'hi'),
    (error) => error.code === 'invalid-target',
  );
  await assert.rejects(
    () => runtime.sendProactiveText(undefined, 'hi'),
    (error) => error.code === 'invalid-target',
  );
});

test('the client is dropped on stop so a stale send cannot use it', async (t) => {
  const client = { sendText: async () => { throw new Error('stale client must not be used'); } };
  const { runtime, sent } = makeRuntime(t, { client });
  await runtime.start();
  await runtime.stop();
  // Not ready anymore: the gateway guard fires before any client lookup.
  await assert.rejects(
    () => runtime.sendProactiveText({ route: { chatGuid: 'iMessage;-;+861' } }, 'hi'),
    (error) => error.code === 'bot-not-connected',
  );
  assert.deepEqual(sent, []);
});
