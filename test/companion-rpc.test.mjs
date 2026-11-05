import test from 'node:test';
import assert from 'node:assert/strict';

import { createCompanionRpcHandler, COMPANION_ENDPOINTS } from '../plugin-src/host/companion-rpc.mjs';
import { normalizeCompanionConfig } from '../src/channels/imessage/companion-scheduler.mjs';

function fakeStore(initial) {
  const bots = new Map(initial.map((bot) => [bot.botId, bot]));
  return {
    get: (botId) => bots.get(botId) ?? null,
    save: async (bot) => { bots.set(bot.botId, bot); },
    saved: () => [...bots.values()],
  };
}

const bot = {
  botId: 'imessage_abc',
  platformId: 'macos-messages',
  name: 'Mac Messages',
  companion: normalizeCompanionConfig({ enabled: false, dayCap: 5, nightCap: 2 }),
};

function handlerFor(store = fakeStore([bot])) {
  return { store, handler: createCompanionRpcHandler({ configStore: store }) };
}

test('get returns the rhythm view without bot identity', async () => {
  const { handler } = handlerFor();
  const answer = await handler(COMPANION_ENDPOINTS.get, { botId: 'imessage_abc' }, undefined);
  assert.equal(answer.ok, true);
  assert.equal(answer.value.enabled, false);
  assert.equal(answer.value.dayCap, 5);
  assert.equal(answer.value.nightCap, 2);
  assert.equal(answer.value.dayIntervalMinutes, 45);
  assert.equal(answer.value.nightIntervalMaxMinutes, 420);
  // Never leak storage internals.
  assert.equal(answer.value.platformId, undefined);
  assert.equal(answer.value.botId, undefined);
});

test('set persists a normalized block and answers with the saved view', async () => {
  const { handler, store } = handlerFor();
  const answer = await handler(COMPANION_ENDPOINTS.set, {
    botId: 'imessage_abc',
    enabled: true,
    dayCap: 8,
    nightCap: 1,
    nightStart: '23:00',
    nightEnd: '07:00',
    dayIntervalMinutes: 60,
    dayIntervalMaxMinutes: 120,
  }, undefined);
  assert.equal(answer.ok, true);
  assert.equal(answer.value.enabled, true);
  assert.equal(answer.value.dayCap, 8);
  assert.equal(answer.value.nightStart, '23:00');
  assert.equal(answer.value.dayIntervalMinutes, 60);
  const saved = store.saved()[0];
  assert.equal(saved.companion.enabled, true);
  assert.equal(saved.companion.dayIntervalMinMs, 60 * 60_000);
  // Identity fields survive the write.
  assert.equal(saved.platformId, 'macos-messages');
});

test('unknown fields and unknown bots are rejected', async () => {
  const { handler } = handlerFor();
  const badField = await handler(COMPANION_ENDPOINTS.set,
    { botId: 'imessage_abc', tokenRef: 'stolen' }, undefined);
  assert.equal(badField.ok, false);
  assert.equal(badField.error.code, 'bad-request');
  const unknownBot = await handler(COMPANION_ENDPOINTS.get, { botId: 'nope' }, undefined);
  assert.equal(unknownBot.ok, false);
  assert.equal(unknownBot.error.code, 'unknown-bot');
  const noBot = await handler(COMPANION_ENDPOINTS.get, {}, undefined);
  assert.equal(noBot.error.code, 'bad-request');
});

test('a missing bot has no companion block to read', async () => {
  const store = fakeStore([{ botId: 'imessage_abc', platformId: 'x' }]);
  const handler = createCompanionRpcHandler({ configStore: store });
  const answer = await handler(COMPANION_ENDPOINTS.get, { botId: 'imessage_abc' }, undefined);
  assert.equal(answer.ok, true);
  // Defaults, because the bot never configured the block.
  assert.equal(answer.value.enabled, false);
  assert.equal(answer.value.dayCap, 5);
});

test('an aborted request and a non-object payload are refused', async () => {
  const { handler } = handlerFor();
  const controller = new AbortController();
  controller.abort();
  assert.equal((await handler(COMPANION_ENDPOINTS.get, { botId: 'imessage_abc' }, controller.signal)).error.code, 'bad-request');
  assert.equal((await handler(COMPANION_ENDPOINTS.get, null, undefined)).error.code, 'bad-request');
  assert.equal((await handler('settings.companion.other', { botId: 'imessage_abc' }, undefined)).error.code, 'bad-request');
});

test('a store that cannot save reports a friendly failure', async () => {
  const store = fakeStore([bot]);
  store.save = async () => { throw new Error('disk full'); };
  const handler = createCompanionRpcHandler({ configStore: store });
  const answer = await handler(COMPANION_ENDPOINTS.set, { botId: 'imessage_abc', enabled: true }, undefined);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, 'companion-unavailable');
});
