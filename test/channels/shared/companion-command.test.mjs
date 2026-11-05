import test from 'node:test';
import assert from 'node:assert/strict';

import { runCompanionCommand, formatCompanionStatus } from '../../../src/channels/shared/companion-command.mjs';

const config = {
  enabled: true,
  nightStart: '22:30',
  nightEnd: '08:00',
  deepQuiet: false,
  dayIntervalMinMs: 45 * 60_000,
  dayIntervalMaxMs: 150 * 60_000,
  nightIntervalMinMs: 180 * 60_000,
  nightIntervalMaxMs: 420 * 60_000,
  dayCap: 5,
  nightCap: 2,
  quietAfterUserMinMs: 40 * 60_000,
  quietAfterUserMaxMs: 90 * 60_000,
  decay: true,
  allowImages: true,
};

function fakeController(overrides = {}) {
  const updates = [];
  const state = {
    enabled: true,
    running: true,
    night: false,
    phase: 'noon',
    remaining: { cap: 5, used: 1, remaining: 4, night: false },
    mood: { warmth: 1, consecutiveIgnored: 0 },
    moodLabel: '正常',
    lastUserAt: null,
    lastDeliveredAt: null,
    nextWakeAt: Date.now() + 30 * 60_000,
    lastDecision: null,
    conversationKey: 'direct:iMessage;-;+861',
    config,
    ...overrides,
  };
  return {
    updates,
    status: () => state,
    updateConfig: (patch) => { updates.push(patch); Object.assign(state.config, patch, { enabled: patch.enabled ?? state.enabled }); if (patch.enabled !== undefined) state.enabled = patch.enabled; return state.config; },
    triggerNow: overrides.triggerNow ?? (async () => ({ delivered: true, motive: 'bored' })),
    resetMood: () => updates.push({ reset: true }),
  };
}

test('non-companion text is ignored', async () => {
  assert.equal(await runCompanionCommand('/status', fakeController()), null);
  assert.equal(await runCompanionCommand('hello', fakeController()), null);
  assert.equal(await runCompanionCommand('/companionx', fakeController()), null);
});

test('bare /companion reports status', async () => {
  const reply = await runCompanionCommand('/companion', fakeController());
  assert.match(reply, /主动联系：已开启/);
  assert.match(reply, /白天（5 次上限，已用 1，剩 4）/);
  assert.match(reply, /夜间区间：22:30-08:00/);
});

test('on and off toggle the switch', async () => {
  const controller = fakeController();
  assert.match(await runCompanionCommand('/companion off', controller), /已关闭/);
  assert.deepEqual(controller.updates.at(-1), { enabled: false });
  assert.match(await runCompanionCommand('/cp on', controller), /已开启/);
  assert.deepEqual(controller.updates.at(-1), { enabled: true });
});

test('now reports what happened, including the skip reason', async () => {
  assert.match(await runCompanionCommand('/companion now', fakeController()), /已触发一次/);
  const skipped = fakeController({ triggerNow: async () => ({ delivered: false, reason: 'skipped' }) });
  assert.match(await runCompanionCommand('/companion now', skipped), /没什么想说的/);
  const capped = fakeController({ triggerNow: async () => ({ delivered: false, reason: 'daily-cap' }) });
  assert.match(await runCompanionCommand('/companion now', capped), /次数已用完/);
});

test('quiet accepts a clock range and rejects nonsense', async () => {
  const controller = fakeController();
  assert.match(await runCompanionCommand('/companion quiet 23:00-07:30', controller), /23:00-07:30/);
  assert.deepEqual(controller.updates.at(-1), { nightStart: '23:00', nightEnd: '07:30' });
  assert.match(await runCompanionCommand('/companion quiet 25:00-99:00', controller), /用法/);
  assert.match(await runCompanionCommand('/companion quiet', controller), /用法/);
});

test('deep toggles the hard silence window', async () => {
  const controller = fakeController();
  assert.match(await runCompanionCommand('/companion deep on', controller), /完全不会打扰/);
  assert.deepEqual(controller.updates.at(-1), { deepQuiet: true });
  assert.match(await runCompanionCommand('/companion deep off', controller), /极小概率/);
  assert.match(await runCompanionCommand('/companion deep', controller), /用法/);
});

test('rate sets both caps', async () => {
  const controller = fakeController();
  assert.match(await runCompanionCommand('/companion rate 8/1', controller), /8.*1/);
  assert.deepEqual(controller.updates.at(-1), { dayCap: 8, nightCap: 1 });
  assert.match(await runCompanionCommand('/companion rate abc', controller), /用法/);
});

test('every accepts day and night ranges in minutes', async () => {
  const controller = fakeController();
  await runCompanionCommand('/companion every 60-120 / 240-480', controller);
  assert.deepEqual(controller.updates.at(-1), {
    dayIntervalMinMs: 60 * 60_000,
    dayIntervalMaxMs: 120 * 60_000,
    nightIntervalMinMs: 240 * 60_000,
    nightIntervalMaxMs: 480 * 60_000,
  });
  await runCompanionCommand('/companion every 60-120', controller);
  assert.equal(controller.updates.at(-1).nightIntervalMinMs, undefined);
});

test('reset clears the warmth', async () => {
  const controller = fakeController();
  assert.match(await runCompanionCommand('/companion reset', controller), /已重置/);
  assert.deepEqual(controller.updates.at(-1), { reset: true });
});

test('unknown arguments list the usage instead of failing', async () => {
  const reply = await runCompanionCommand('/companion nonsense', fakeController());
  assert.match(reply, /未知参数/);
  assert.match(reply, /\/companion on\|off/);
});

test('a channel without a controller says so', async () => {
  assert.match(await runCompanionCommand('/companion', null), /不可用/);
});

test('status formatting reports an unbound chat and the skip reason', () => {
  const text = formatCompanionStatus({
    enabled: false,
    night: true,
    remaining: { cap: 2, used: 0, remaining: 2, night: true },
    mood: { warmth: 0.6, consecutiveIgnored: 1 },
    moodLabel: '略收敛',
    nextWakeAt: null,
    lastDeliveredAt: Date.now() - 10 * 60_000,
    lastDecision: { allowed: false, reason: 'deep-quiet' },
    conversationKey: null,
    config,
  }, Date.now());
  assert.match(text, /已关闭/);
  assert.match(text, /未安排/);
  assert.match(text, /略收敛（0\.60）/);
  assert.match(text, /上次主动：10 分钟前/);
  assert.match(text, /上次跳过原因：deep-quiet/);
  assert.match(text, /尚未绑定会话/);
});
