import test from 'node:test';
import assert from 'node:assert/strict';

import { CompanionController, replyTextOf } from '../../../src/channels/imessage/companion-controller.mjs';

/** A controller wired to an in-memory state blob and a fake clock. */
function makeController(t, {
  config = {}, reply = '在想你', conversations, askError = null, deliverError = null,
} = {}) {
  let persisted = {};
  const asks = [];
  const sent = [];
  let clock = new Date(2026, 10, 5, 15, 0, 0, 0);
  const controller = new CompanionController({
    config: { enabled: true, ...config },
    readState: () => persisted,
    writeState: (next) => { persisted = next; },
    conversations: conversations ?? (() => [{ conversationKey: 'direct:iMessage;-;+861', sessionId: 'session-1' }]),
    ask: async (sessionId, prompt) => {
      asks.push({ sessionId, prompt });
      if (askError) throw askError;
      return { message: { content: [{ type: 'text', text: reply }] } };
    },
    deliver: async (target, text) => {
      if (deliverError) throw deliverError;
      sent.push({ target, text });
    },
    now: () => clock,
    random: () => 0.5,
  });
  controller.start();
  t.after(() => controller.stop());
  return {
    controller, asks, sent,
    state: () => persisted,
    advance: (minutes) => { clock = new Date(clock.getTime() + minutes * 60_000); },
  };
}

test('a forced wake asks the Harness and delivers her answer', async (t) => {
  const { controller, asks, sent } = makeController(t);
  const result = await controller.triggerNow();
  assert.equal(result.delivered, true);
  // The motive is picked per phase; assert it is one of the real motives.
  assert.ok(['unfinished-thread', 'bored', 'worry', 'share', 'want-voice'].includes(result.motive));
  assert.equal(asks.length, 1);
  assert.equal(asks[0].sessionId, 'session-1');
  assert.match(asks[0].prompt, /你想主动找他/);
  assert.deepEqual(sent.map((item) => item.text), ['在想你']);
  assert.equal(sent[0].target.conversationKey, 'direct:iMessage;-;+861');
});

test('SKIP keeps her silent and still spends one budget slot', async (t) => {
  const { controller, sent, state } = makeController(t, { reply: 'SKIP', config: { dayCap: 2 } });
  const result = await controller.triggerNow();
  assert.deepEqual(result, { delivered: false, reason: 'skipped' });
  assert.deepEqual(sent, []);
  const counters = state().conversations['direct:iMessage;-;+861'].counters;
  assert.equal(counters.day, 1);
});

test('a delivered message sets a pending marker that weakens the next reach-out', async (t) => {
  const { controller, state } = makeController(t);
  await controller.triggerNow();
  const entry = state().conversations['direct:iMessage;-;+861'];
  assert.ok(entry.pendingSince);
  assert.equal(entry.mood.consecutiveIgnored, 1);
});

test('a user reply restores warmth and clears the pending marker', async (t) => {
  const { controller, state } = makeController(t);
  await controller.triggerNow();
  controller.noteUserMessage('direct:iMessage;-;+861');
  const entry = state().conversations['direct:iMessage;-;+861'];
  assert.equal(entry.pendingSince, null);
  assert.equal(entry.mood.consecutiveIgnored, 0);
  assert.ok(entry.lastUserAt);
});

test('the daily cap blocks further reach-outs until tomorrow', async (t) => {
  const { controller, sent, advance } = makeController(t, { config: { dayCap: 1 } });
  assert.equal((await controller.triggerNow()).delivered, true);
  assert.deepEqual(await controller.triggerNow(), { delivered: false, reason: 'daily-cap' });
  assert.equal(sent.length, 1);
  advance(10);
  assert.equal((await controller.triggerNow()).reason, 'daily-cap');
});

test('a disabled companion refuses even a forced wake', async (t) => {
  const { controller, sent } = makeController(t, { config: { enabled: false } });
  assert.deepEqual(await controller.triggerNow(), { delivered: false, reason: 'disabled' });
  assert.deepEqual(sent, []);
});

test('deep quiet blocks a forced wake', async (t) => {
  let clock = new Date(2026, 10, 5, 3, 0, 0, 0);
  let persisted = {};
  const controller = new CompanionController({
    config: { enabled: true, deepQuiet: true },
    readState: () => persisted,
    writeState: (next) => { persisted = next; },
    conversations: () => [{ conversationKey: 'k', sessionId: 's' }],
    ask: async () => ({ message: { content: [{ type: 'text', text: 'hi' }] } }),
    deliver: async () => {},
    now: () => clock,
    random: () => 0.5,
  });
  controller.start();
  t.after(() => controller.stop());
  assert.deepEqual(await controller.triggerNow(), { delivered: false, reason: 'deep-quiet' });
});

test('a recent user message does not block an explicitly forced wake', async (t) => {
  const { controller } = makeController(t, {
    config: { quietAfterUserMinMs: 60 * 60_000, quietAfterUserMaxMs: 60 * 60_000 },
  });
  controller.noteUserMessage('direct:iMessage;-;+861');
  // triggerNow is the `/companion now` path: an explicit request ignores the
  // quiet window. Natural wakes still respect it (companion-logic covers that
  // at the scheduler level).
  const outcome = await controller.triggerNow();
  assert.equal(outcome.delivered, true);
});

test('a Harness failure is reported and does not spend budget', async (t) => {
  const { controller, state } = makeController(t, { askError: new Error('harness down') });
  assert.deepEqual(await controller.triggerNow(), { delivered: false, reason: 'ask-failed' });
  assert.equal(state().conversations['direct:iMessage;-;+861']?.counters ?? null, null);
});

test('a delivery failure is reported instead of throwing', async (t) => {
  const { controller } = makeController(t, { deliverError: new Error('send failed') });
  assert.deepEqual(await controller.triggerNow(), { delivered: false, reason: 'deliver-failed' });
});

test('without a bound conversation nothing is asked or sent', async (t) => {
  const { controller, asks, sent } = makeController(t, { conversations: () => [] });
  assert.deepEqual(await controller.triggerNow(), { delivered: false, reason: 'no-target' });
  assert.deepEqual(asks, []);
  assert.deepEqual(sent, []);
});

test('status reports the budget, mood and configured windows', async (t) => {
  const { controller } = makeController(t, { config: { dayCap: 4, nightCap: 2 } });
  await controller.triggerNow();
  const status = controller.status();
  assert.equal(status.enabled, true);
  assert.equal(status.running, true);
  assert.equal(status.remaining.cap, 4);
  assert.equal(status.remaining.used, 1);
  assert.equal(status.remaining.remaining, 3);
  assert.equal(status.conversationKey, 'direct:iMessage;-;+861');
  assert.equal(status.moodLabel, '略收敛');
  assert.equal(status.config.nightCap, 2);
});

test('config updates take effect and can disable the feature', async (t) => {
  const { controller } = makeController(t);
  const updated = controller.updateConfig({ dayCap: 9, nightStart: '23:00' });
  assert.equal(updated.dayCap, 9);
  assert.equal(updated.nightStart, '23:00');
  const disabled = controller.updateConfig({ enabled: false });
  assert.equal(disabled.enabled, false);
  assert.deepEqual(await controller.triggerNow(), { delivered: false, reason: 'disabled' });
});

test('reply text ignores reasoning parts and tolerates plain strings', () => {
  assert.equal(replyTextOf(' hello '), 'hello');
  assert.equal(replyTextOf({ message: { content: [
    { type: 'reasoning', text: 'inner' },
    { type: 'text', text: '到点了' },
    { type: 'text', text: '去睡' },
  ] } }), '到点了\n去睡');
  assert.equal(replyTextOf({ content: 'flat' }), 'flat');
  assert.equal(replyTextOf({}), '');
});

test('persisted garbage never breaks the controller', async (t) => {
  let persisted = { conversations: { k: { mood: 'nonsense', counters: 'bad', lastUserAt: 'x' } }, nextWakeAt: 'y' };
  const controller = new CompanionController({
    config: { enabled: true },
    readState: () => persisted,
    writeState: (next) => { persisted = next; },
    conversations: () => [{ conversationKey: 'k', sessionId: 's' }],
    ask: async () => ({ message: { content: [{ type: 'text', text: 'SKIP' }] } }),
    deliver: async () => {},
    now: () => new Date(2026, 10, 5, 15, 0, 0, 0),
    random: () => 0.5,
  });
  controller.start();
  t.after(() => controller.stop());
  assert.deepEqual(await controller.triggerNow(), { delivered: false, reason: 'skipped' });
  assert.equal(controller.status().mood.warmth, 1);
});
