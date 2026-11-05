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

function lockedPolicy() {
  const scope = {
    mode: 'allowlist',
    open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] },
    allowlist: { users: [] },
  };
  return { getSettings: () => ({ direct: scope, group: scope }) };
}

test('a policy denial is logged with its reason, so silence is distinguishable', async () => {
  const { bridge, lines } = makeBridge({ accessPolicy: lockedPolicy() });
  await bridge.accept({
    messageId: 'stranger-1', senderId: '+8615229293783', conversationId: 'c', content: '嗯',
  });
  const denied = lines.find((line) => line.message === 'access denied');
  assert.ok(denied, 'a denied sender must leave a log line');
  assert.equal(denied.details.reason, 'sender-not-allowed');
  assert.equal(denied.details.kind, 'direct');
  assert.equal(denied.details.senderId, '+8615229293783');
  assert.equal(denied.details.command, false);
});

test('a denied command is flagged as a command', async () => {
  const { bridge, lines } = makeBridge({ accessPolicy: lockedPolicy() });
  await bridge.accept({
    messageId: 'stranger-2', senderId: '+8615229293783', conversationId: 'c', content: '/help',
  });
  const denied = lines.find((line) => line.message === 'access denied');
  assert.equal(denied?.details.command, true);
});

test('the allowed sender is never reported as denied', async () => {
  const scope = {
    mode: 'allowlist',
    open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] },
    allowlist: { users: [{ id: '+8619829734218', canExecuteCommands: true }] },
  };
  const { bridge, lines } = makeBridge({
    accessPolicy: { getSettings: () => ({ direct: scope, group: scope }) },
  });
  await bridge.accept({
    messageId: 'owner-1', senderId: '+8619829734218', conversationId: 'c', content: '在吗',
  });
  assert.equal(lines.filter((line) => line.message === 'access denied').length, 0);
});
