import test from 'node:test';
import assert from 'node:assert/strict';

import { installProactiveRelay } from '../plugin-src/host/proactive-relay.mjs';
import { createDeliveryService } from '../plugin-src/host/delivery-service.mjs';

function createEventHarness(deliveryService) {
  const handlers = [];
  const ctx = {
    on: (type, handler) => { if (type === 'session/event') handlers.push(handler); },
  };
  const warnings = [];
  const installed = installProactiveRelay(ctx, deliveryService, {
    logger: { warn: (...args) => warnings.push(args) },
  });
  const emit = (type, data) => {
    for (const handler of handlers) handler('session-one', { type, data });
  };
  return { installed, emit, warnings };
}

test('proactive relay installs only with a full delivery service', () => {
  const ctx = { on: () => {} };
  assert.equal(installProactiveRelay(ctx, null), false);
  assert.equal(installProactiveRelay(null, { relaySessionText() {} }), false);
  assert.equal(installProactiveRelay(ctx, { relaySessionText() {} }), true);
});

test('relays schedule-driven turns to the owning conversation', async () => {
  const relays = [];
  const { installed, emit } = createEventHarness({
    relaySessionText: async (sessionId, text) => { relays.push({ sessionId, text }); return { sent: true }; },
  });
  assert.equal(installed, true);
  emit('turn/start', { turn: 25 });
  emit('user/message', { source: { kind: 'schedule' }, content: [{ type: 'text', text: '[SCHEDULE REMINDER BATCH]' }] });
  emit('assistant/message', { turn: 25, message: { role: 'assistant', content: [
    { type: 'reasoning', text: 'inner' },
    { type: 'text', text: '到点了，去睡' },
    { type: 'text', text: '别又「再五分钟」' },
  ] } });
  emit('turn/end', { turn: 25, reason: { kind: 'completed' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(relays, [{ sessionId: 'session-one', text: '到点了，去睡\n别又「再五分钟」' }]);
});

test('channel-initiated turns with an rpcId are never relayed', async () => {
  const relays = [];
  const { emit } = createEventHarness({
    relaySessionText: async (sessionId, text) => { relays.push({ sessionId, text }); return null; },
  });
  emit('turn/start', { turn: 3 });
  emit('user/message', { source: { kind: 'harness', rpcId: 'rpc-1' }, content: [{ type: 'text', text: 'hi' }] });
  emit('assistant/message', { turn: 3, message: { content: [{ type: 'text', text: 'hello' }] } });
  emit('turn/end', { turn: 3, reason: { kind: 'completed' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(relays, []);
});

test('empty replies and SKIP stay silent, relay failures are logged once', async () => {
  const relays = [];
  const { emit, warnings } = createEventHarness({
    relaySessionText: async () => { relays.push('called'); throw new Error('boom'); },
  });
  // Empty text: no relay call at all.
  emit('turn/start', { turn: 1 });
  emit('user/message', { source: { kind: 'schedule' } });
  emit('turn/end', { turn: 1, reason: { kind: 'completed' } });
  // Explicit SKIP marker: silent as well.
  emit('turn/start', { turn: 2 });
  emit('user/message', { source: { kind: 'schedule' } });
  emit('assistant/message', { message: { content: [{ type: 'text', text: ' SKIP ' }] } });
  emit('turn/end', { turn: 2, reason: { kind: 'completed' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(relays, []);
  // A failing relay is reported but never thrown into the event stream.
  emit('turn/start', { turn: 3 });
  emit('user/message', { source: { kind: 'schedule' } });
  emit('assistant/message', { message: { content: [{ type: 'text', text: '提醒' }] } });
  emit('turn/end', { turn: 3, reason: { kind: 'completed' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(relays, ['called']);
  assert.equal(warnings.length, 1);
});

test('stale turn/end events from another turn do not relay', async () => {
  const relays = [];
  const { emit } = createEventHarness({
    relaySessionText: async (sessionId, text) => { relays.push({ sessionId, text }); return null; },
  });
  emit('turn/start', { turn: 7 });
  emit('user/message', { source: { kind: 'schedule' } });
  emit('assistant/message', { message: { content: [{ type: 'text', text: '到点了' }] } });
  emit('turn/end', { turn: 6, reason: { kind: 'aborted' } }); // mismatched turn
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(relays, []);
});

test('delivery service resolves the owning adapter and sends through it', async () => {
  const service = createDeliveryService();
  const sends = [];
  const baseAdapter = {
    listBots: () => ['bot-1'],
    ownsBot: (id) => id === 'bot-1',
    listTargets: () => [],
    listSuggestions: () => [],
    createTarget: () => {},
    updateTarget: () => {},
    deleteTarget: () => {},
  };
  service.registerAdapter({
    ...baseAdapter,
    channel: 'imessage',
    describeConversationBySession: async (sessionId) => (
      sessionId === 'session-one'
        ? { channel: 'imessage', botId: 'bot-1', conversationKey: 'direct:iMessage;-;+8613800000000' }
        : null
    ),
    sendText: async (botId, target, text) => { sends.push({ botId, target, text }); return { sent: true }; },
  });
  service.registerAdapter({
    ...baseAdapter,
    channel: 'telegram',
    describeConversationBySession: async () => null,
    sendText: async () => { throw new Error('telegram must not be used'); },
  });
  const result = await service.relaySessionText('session-one', '到点了，去睡');
  assert.deepEqual(result, { sent: true });
  assert.deepEqual(sends, [{
    botId: 'bot-1',
    target: { kind: 'user', route: { chatGuid: 'iMessage;-;+8613800000000' } },
    text: '到点了，去睡',
  }]);
  assert.equal(await service.relaySessionText('session-unknown', 'text'), null);
});
