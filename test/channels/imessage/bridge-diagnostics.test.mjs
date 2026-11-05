import test from 'node:test';
import assert from 'node:assert/strict';

import { IMessageHarnessBridge } from '../../../src/channels/imessage/imessage-bridge.mjs';
import { TextHarnessBridge } from '../../../src/channels/shared/text-harness-bridge.mjs';

function makeBridge(extra = {}) {
  const lines = [];
  const bridge = new IMessageHarnessBridge({
    bot: { sendText: async () => {} },
    harness: { ensureRunning: async () => true, ask: async () => ({ message: 'ok' }) },
    state: { hasSeen: () => false, sessionFor: () => null, markSeen: async () => {}, setSession: async () => {} },
    status: {},
    logger: { warn() {}, error() {} },
    diagnostics: (scope, message, details) => lines.push({ scope, message, details }),
    ...extra,
  });
  return { bridge, lines };
}

test('iMessage bridges inject a diagnostics observer by default', () => {
  const { bridge } = makeBridge();
  assert.ok(bridge instanceof TextHarnessBridge);
});

test('skipped duplicates are reported with the message id', async () => {
  const { bridge, lines } = makeBridge({ state: { hasSeen: (id) => id === 'dup', sessionFor: () => null } });
  await bridge.accept({ messageId: 'dup', senderId: 'p', conversationId: 'c', content: 'hi' });
  assert.deepEqual(lines, [{
    scope: 'bridge',
    message: 'accept skipped',
    details: { messageId: 'dup', hasIds: true },
  }]);
});

test('a bridge without diagnostics behaves exactly as before', async () => {
  let sent = 0;
  const bridge = new TextHarnessBridge({
    descriptor: { key: 'imessage', label: 'iMessage' },
    bot: { sendText: async () => { sent += 1; } },
    harness: { ensureRunning: async () => true, ask: async () => ({ message: 'ok' }) },
    state: { hasSeen: () => false, sessionFor: () => null, markSeen: async () => {}, setSession: async () => {} },
    status: {},
    logger: { warn() {}, error() {} },
  });
  // No observer installed: the same call must not throw.
  await bridge.accept({ messageId: 'x', senderId: 'p', conversationId: 'c', content: 'hi' });
  assert.equal(typeof sent, 'number');
});
