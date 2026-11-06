import test from 'node:test';
import assert from 'node:assert/strict';

import { IMessageRuntime } from '../../../src/channels/imessage/runtime.mjs';

const KEY = 'direct:iMessage;-;+8619829734218';

/**
 * A runtime whose companion can fire on demand: `/companion now` runs a forced
 * wake, so the ask/deliver pair a proactive turn really uses can be observed
 * without waiting on timers or probabilistic gates.
 */
function makeRuntime(t, { harnessAsk } = {}) {
  const sent = [];
  const files = [];
  const extension = {};
  const asks = [];
  let clientRef = null;
  const runtime = new IMessageRuntime({
    config: {
      botId: 'imessage_test', platformId: 'me@example.com',
      companion: { enabled: true },
    },
    token: 'token',
    harness: {
      ensureRunning: async () => true,
      ask: async (sessionId, prompt, options = {}) => {
        asks.push({ sessionId, prompt, options });
        return harnessAsk ? harnessAsk(options)
          : { message: { content: [{ type: 'text', text: '在忙吗' }] } };
      },
    },
    state: {
      cursor: () => 9999,
      setCursor: async () => {},
      sessionFor: () => 'session-bound',
      hasSeen: () => false,
      markSeen: async () => {},
      setSession: async () => {},
      snapshot: () => ({ sessions: { [KEY]: 'session-bound' } }),
      extensionState: () => extension,
      persist: () => {},
    },
    logger: { warn() {}, error() {}, info() {} },
    pollIntervalMs: 1_000_000,
    createApi: () => ({
      async getPermissions() { return { platform: 'darwin', database: 'granted', automation: 'granted' }; },
      async listMessages() { return []; },
      async getLatestMessageRowId() { return 0; },
      async sendText(payload) { sent.push(payload.text); return { sent: true }; },
      async sendFile(payload) { files.push(payload.path); return { sent: true }; },
    }),
    createClient: () => {
      clientRef = {
        sendText: async (target, text) => { sent.push(text); },
        sendFile: async (target, file) => { files.push(file); },
        sendImage: async (target, file) => { files.push(file); },
      };
      return clientRef;
    },
  });
  t.after(() => runtime.stop());
  return { runtime, sent, files, asks, extension, client: () => clientRef };
}

test('a proactive turn opens the artifact consumer for the harness ask', async (t) => {
  const { runtime, asks, client } = makeRuntime(t);
  await runtime.start();
  await client().companion.handle('/companion now', { conversationKey: KEY });
  // The wake ran: the ask carried an onArtifact consumer registration, which is
  // exactly what the errored sticker call was missing.
  assert.equal(asks.length, 1);
  assert.equal(typeof asks[0].options.onArtifact, 'function');
});

test('a sticker queued during the wake is delivered after the text', async (t) => {
  const artifact = {
    kind: 'dsh-im-outbound-artifact', schemaVersion: 1,
    fileName: '吃(西瓜).gif', bytes: Buffer.from('GIF89a'),
  };
  const { runtime, sent, files, client } = makeRuntime(t, {
    harnessAsk: (options) => {
      options.onArtifact?.(artifact);
      return { message: { content: [{ type: 'text', text: '给你看' }] } };
    },
  });
  await runtime.start();
  await client().companion.handle('/companion now', { conversationKey: KEY });
  // The artifact is not registry-backed, so delivery reports the failure
  // instead of silently dropping the file the model believed it sent.
  assert.ok(sent.includes('给你看'));
  assert.equal(files.length, 0);
  assert.ok(sent.length >= 2, 'a failure notice follows the text');
});

test('a plain wake without artifacts still sends only text', async (t) => {
  const { runtime, sent, files, client } = makeRuntime(t);
  await runtime.start();
  await client().companion.handle('/companion now', { conversationKey: KEY });
  assert.deepEqual(sent, ['在忙吗']);
  assert.deepEqual(files, []);
});
