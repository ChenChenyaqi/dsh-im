import test from 'node:test';
import assert from 'node:assert/strict';

import { createCompanionRpcHandler, COMPANION_ENDPOINTS } from '../plugin-src/host/companion-rpc.mjs';
import { normalizeCompanionConfig } from '../src/channels/imessage/companion-scheduler.mjs';

function fakeStore(bot) {
  let live = bot;
  return {
    get: () => live,
    save: async (next) => { live = next; },
    live: () => live,
  };
}

test('saving pushes the new rhythm into the running scheduler', async () => {
  const applied = [];
  const store = fakeStore({
    botId: 'imessage_abc', platformId: 'x',
    companion: normalizeCompanionConfig({ enabled: false }),
  });
  const handler = createCompanionRpcHandler({
    configStore: store,
    onSaved: (botId, settings) => applied.push({ botId, settings }),
  });
  await handler(COMPANION_ENDPOINTS.set, { botId: 'imessage_abc', enabled: true, dayCap: 7 }, undefined);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].botId, 'imessage_abc');
  // The runtime receives the already-normalized block, not the raw payload.
  assert.equal(applied[0].settings.companion.enabled, true);
  assert.equal(applied[0].settings.companion.dayCap, 7);
  assert.equal(applied[0].settings.companion.nightCap, 2);
});

test('a failing apply callback never breaks the save', async () => {
  const store = fakeStore({
    botId: 'imessage_abc', platformId: 'x', companion: normalizeCompanionConfig({}),
  });
  const handler = createCompanionRpcHandler({
    configStore: store,
    onSaved: () => { throw new Error('runtime gone'); },
  });
  const answer = await handler(COMPANION_ENDPOINTS.set, { botId: 'imessage_abc', enabled: true }, undefined);
  assert.equal(answer.ok, true);
  assert.equal(store.live().companion.enabled, true);
});

test('a read never triggers the apply callback', async () => {
  const applied = [];
  const store = fakeStore({
    botId: 'imessage_abc', platformId: 'x', companion: normalizeCompanionConfig({}),
  });
  const handler = createCompanionRpcHandler({ configStore: store, onSaved: (...args) => applied.push(args) });
  await handler(COMPANION_ENDPOINTS.get, { botId: 'imessage_abc' }, undefined);
  assert.deepEqual(applied, []);
});
