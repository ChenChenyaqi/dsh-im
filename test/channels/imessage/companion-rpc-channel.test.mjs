import test from 'node:test';
import assert from 'node:assert/strict';

import { createIMessageRpcHandler, IMESSAGE_RPC_CHANNEL } from '../../../plugin-src/host/channels/imessage/rpc.mjs';
import { COMPANION_ENDPOINTS } from '../../../plugin-src/host/companion-rpc.mjs';

const botId = 'imessage_test';

/** Controller stub: the token handler only needs the shallow surface below. */
function fakeController() {
  return {
    status: async () => ({ ready: false }),
    bindCredentials: async () => ({}),
    reconnectBot: async () => ({}),
    deleteBot: async () => ({}),
    diagnostics: null,
  };
}

test('companion endpoints are answered on the iMessage RPC channel', async () => {
  const seen = [];
  const handler = createIMessageRpcHandler(fakeController(), {
    companion: async (endpoint, payload) => {
      seen.push({ endpoint, payload });
      return { ok: true, value: { enabled: true, dayCap: 5, nightCap: 2 } };
    },
  });
  const answer = await handler(COMPANION_ENDPOINTS.get, { botId }, undefined);
  assert.equal(answer.ok, true);
  assert.equal(answer.value.enabled, true);
  assert.deepEqual(seen, [{ endpoint: COMPANION_ENDPOINTS.get, payload: { botId } }]);
});

test('the companion endpoint never falls through to the shared token handler', async () => {
  const handler = createIMessageRpcHandler(fakeController(), {
    companion: async () => ({ ok: true, value: { enabled: false } }),
  });
  const answer = await handler(COMPANION_ENDPOINTS.set, { botId, enabled: true }, undefined);
  assert.equal(answer.ok, true);
  // A fall-through would have produced the shared "Unknown iMessage endpoint" error.
  assert.doesNotMatch(JSON.stringify(answer), /Unknown iMessage endpoint/);
});

test('without a store the endpoints report unavailable instead of unknown', async () => {
  const handler = createIMessageRpcHandler(fakeController());
  const answer = await handler(COMPANION_ENDPOINTS.get, { botId }, undefined);
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, 'companion-unavailable');
  assert.doesNotMatch(JSON.stringify(answer), /Unknown iMessage endpoint/);
});

test('the channel id is the one the settings card actually calls', () => {
  // Registering on a different channel was the original bug: rpcCall addresses
  // '/imessage', so a separate channel is never reached.
  assert.equal(IMESSAGE_RPC_CHANNEL, '/imessage');
});
