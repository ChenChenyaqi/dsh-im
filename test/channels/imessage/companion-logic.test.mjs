import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMood, nextMood, normalizeMood, intervalMultiplier, moodLabel,
} from '../../../src/channels/imessage/companion-mood.mjs';
import {
  phaseOf, pickMotive, buildWakePrompt, isSkipReply, COMPANION_MOTIVES, DAY_PHASES,
} from '../../../src/channels/imessage/companion-motives.mjs';
import {
  COMPANION_DEFAULTS, normalizeCompanionConfig, isNight, isDeepQuiet, pickDelay,
  evaluateWake, recordWake, remainingToday, emptyDailyCounters, localDateKey,
} from '../../../src/channels/imessage/companion-scheduler.mjs';

const at = (hour, minute = 0) => new Date(2026, 10, 5, hour, minute, 0, 0);

// ---- mood ----

test('a reply restores warmth and clears the ignored streak', () => {
  const ignored = nextMood(nextMood(createMood(), 'ignored'), 'ignored');
  assert.equal(ignored.consecutiveIgnored, 2);
  assert.ok(ignored.warmth < 1);
  const replied = nextMood(ignored, 'replied');
  assert.equal(replied.consecutiveIgnored, 0);
  assert.ok(replied.warmth > ignored.warmth);
});

test('warmth never drops below the floor however long the silence lasts', () => {
  let mood = createMood();
  for (let i = 0; i < 40; i += 1) mood = nextMood(mood, 'ignored');
  assert.ok(mood.warmth >= 0.2);
  assert.equal(mood.consecutiveIgnored, 40);
});

test('the interval multiplier grows with silence and then stops', () => {
  assert.equal(intervalMultiplier(createMood()), 1);
  assert.equal(intervalMultiplier({ warmth: 1, consecutiveIgnored: 1 }), 1.6);
  assert.equal(intervalMultiplier({ warmth: 1, consecutiveIgnored: 10 }), 2.5);
  // Decay disabled keeps a flat rhythm.
  assert.equal(intervalMultiplier({ warmth: 1, consecutiveIgnored: 10 }, { decay: false }), 1);
});

test('mood normalization rejects broken persisted values', () => {
  assert.deepEqual(normalizeMood(null), { warmth: 1, consecutiveIgnored: 0 });
  assert.deepEqual(normalizeMood({ warmth: 'x', consecutiveIgnored: -3 }), { warmth: 1, consecutiveIgnored: 0 });
  assert.deepEqual(normalizeMood({ warmth: 0.5, consecutiveIgnored: 2 }), { warmth: 0.5, consecutiveIgnored: 2 });
  assert.equal(moodLabel({ warmth: 0.5, consecutiveIgnored: 0 }), '正常');
  assert.equal(moodLabel({ warmth: 0.5, consecutiveIgnored: 6 }), '很少说话');
});

// ---- motives ----

test('every hour of the day maps to exactly one phase', () => {
  for (let hour = 0; hour < 24; hour += 1) {
    const phase = phaseOf(at(hour, 30));
    assert.ok(DAY_PHASES.some((candidate) => candidate.id === phase.id), `hour ${hour}`);
  }
  assert.equal(phaseOf(at(23, 30)).id, 'late');
  assert.equal(phaseOf(at(3, 0)).id, 'deep-night');
  assert.equal(phaseOf(at(12, 30)).id, 'noon');
  assert.throws(() => phaseOf(new Date('nonsense')), /valid time/);
});

test('motive selection respects the phase and the image switch', () => {
  const night = pickMotive(at(2, 0), { random: () => 0.99 });
  assert.ok(night.phases.includes('deep-night'));
  // With images off, an image-only motive is never selected.
  for (let i = 0; i < 20; i += 1) {
    const motive = pickMotive(at(19, 0), { random: () => i / 20, allowImages: false });
    assert.notEqual(motive.allowsImages, true);
  }
});

test('the wake prompt states the time, the shape and the silence escape', () => {
  const motive = COMPANION_MOTIVES.find((item) => item.id === 'bored');
  const prompt = buildWakePrompt({ motive, now: at(15, 20), lastUserAt: at(14, 0).getTime() });
  assert.match(prompt, /15:20/);
  assert.match(prompt, /下午/);
  assert.match(prompt, /80 分钟/);
  assert.match(prompt, /SKIP/);
  assert.match(prompt, /不要提「提醒」/);
});

test('a cooled-down mood asks for shorter, more restrained messages', () => {
  const motive = COMPANION_MOTIVES.find((item) => item.id === 'bored');
  const warm = buildWakePrompt({ motive, now: at(15, 0), warmth: 1 });
  const cool = buildWakePrompt({ motive, now: at(15, 0), warmth: 0.3 });
  assert.doesNotMatch(warm, /更克制/);
  assert.match(cool, /更克制/);
});

test('SKIP is recognized in its usual shapes only', () => {
  assert.equal(isSkipReply('SKIP'), true);
  assert.equal(isSkipReply('  skip  '.toUpperCase()), true);
  assert.equal(isSkipReply(''), true);
  assert.equal(isSkipReply('`SKIP`'), true);
  assert.equal(isSkipReply('在想你'), false);
  assert.equal(isSkipReply('SKIP 但是我还是要说'), false);
});

// ---- scheduler ----

test('config normalization keeps usable values and repairs broken ones', () => {
  const defaults = normalizeCompanionConfig();
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.nightCap, 2);
  const custom = normalizeCompanionConfig({
    enabled: true, nightStart: '23:00', nightEnd: '07:30', dayCap: 8, nightCap: 0,
  });
  assert.equal(custom.enabled, true);
  assert.equal(custom.nightStart, '23:00');
  assert.equal(custom.dayCap, 8);
  assert.equal(custom.nightCap, 0);
  // Broken clock strings fall back instead of throwing.
  assert.equal(normalizeCompanionConfig({ nightStart: '25:99' }).nightStart, COMPANION_DEFAULTS.nightStart);
  // A reversed interval range is repaired to the defaults.
  const repaired = normalizeCompanionConfig({ dayIntervalMinMs: 600_000, dayIntervalMaxMs: 60_000 });
  assert.ok(repaired.dayIntervalMinMs < repaired.dayIntervalMaxMs);
});

test('the night window wraps past midnight', () => {
  const config = normalizeCompanionConfig({ nightStart: '22:30', nightEnd: '08:00' });
  assert.equal(isNight(at(23, 0), config), true);
  assert.equal(isNight(at(2, 0), config), true);
  assert.equal(isNight(at(7, 59), config), true);
  assert.equal(isNight(at(8, 0), config), false);
  assert.equal(isNight(at(15, 0), config), false);
  assert.equal(isNight(at(22, 29), config), false);
});

test('deep quiet only applies when switched on', () => {
  const off = normalizeCompanionConfig({ deepQuiet: false });
  assert.equal(isDeepQuiet(at(3, 0), off), false);
  const on = normalizeCompanionConfig({ deepQuiet: true, deepQuietStart: '02:30', deepQuietEnd: '07:00' });
  assert.equal(isDeepQuiet(at(3, 0), on), true);
  assert.equal(isDeepQuiet(at(8, 0), on), false);
});

test('night delays are much longer than daytime delays', () => {
  const config = normalizeCompanionConfig();
  const day = pickDelay(at(15, 0), { config, mood: createMood(), random: () => 0.5 });
  const night = pickDelay(at(3, 0), { config, mood: createMood(), random: () => 0.5 });
  assert.ok(night > day, `night ${night} should exceed day ${day}`);
  assert.ok(day >= 45 * 60_000);
});

test('an ignored streak stretches the wait, and deep night stretches it further', () => {
  const config = normalizeCompanionConfig();
  const calm = pickDelay(at(15, 0), { config, mood: createMood(), random: () => 0.5 });
  const cold = pickDelay(at(15, 0), {
    config, mood: createMood({ consecutiveIgnored: 3 }), random: () => 0.5,
  });
  assert.ok(cold > calm);
  const coldNight = pickDelay(at(3, 0), {
    config, mood: createMood({ consecutiveIgnored: 3 }), random: () => 0.5,
  });
  assert.ok(coldNight > cold);
});

test('a disabled companion never wakes', () => {
  const config = normalizeCompanionConfig({ enabled: false });
  assert.deepEqual(
    evaluateWake({ now: at(15, 0), config, mood: createMood(), counters: emptyDailyCounters(at(15, 0)) }),
    { allowed: false, reason: 'disabled' },
  );
});

test('deep quiet blocks a wake even when enabled', () => {
  const config = normalizeCompanionConfig({ enabled: true, deepQuiet: true });
  const result = evaluateWake({
    now: at(3, 0), config, mood: createMood(), counters: emptyDailyCounters(at(3, 0)),
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'deep-quiet');
});

test('the daily cap is counted per period and stops further reach-outs', () => {
  const config = normalizeCompanionConfig({ enabled: true, dayCap: 1, nightCap: 1 });
  let counters = emptyDailyCounters(at(15, 0));
  assert.equal(evaluateWake({ now: at(15, 0), config, mood: createMood(), counters }).allowed, true);
  counters = recordWake(counters, at(15, 0), { night: false });
  assert.equal(evaluateWake({ now: at(16, 0), config, mood: createMood(), counters }).reason, 'daily-cap');
  // The night budget is separate.
  assert.equal(evaluateWake({ now: at(23, 0), config, mood: createMood(), counters }).allowed, true);
});

test('counters reset on a new local day', () => {
  const config = normalizeCompanionConfig({ enabled: true, dayCap: 1 });
  let counters = recordWake(emptyDailyCounters(at(15, 0)), at(15, 0), { night: false });
  assert.equal(evaluateWake({ now: at(15, 0), config, mood: createMood(), counters }).reason, 'daily-cap');
  const tomorrow = evaluateWake({ now: at(15, 0), config, mood: createMood(), counters });
  // Same day still capped; a different date key rolls the counter.
  assert.equal(tomorrow.reason, 'daily-cap');
  counters = { ...counters, date: localDateKey(new Date(2026, 10, 6)) };
  assert.equal(evaluateWake({ now: at(15, 0), config, mood: createMood(), counters }).allowed, true);
});

test('the quiet window after the user writes suppresses a wake', () => {
  const config = normalizeCompanionConfig({
    enabled: true, quietAfterUserMinMs: 60 * 60_000, quietAfterUserMaxMs: 60 * 60_000,
  });
  const counters = emptyDailyCounters(at(15, 0));
  const early = evaluateWake({
    now: at(15, 30), config, mood: createMood(), counters, lastUserAt: at(15, 0).getTime(),
  });
  assert.equal(early.reason, 'quiet-after-user');
  const late = evaluateWake({
    now: at(16, 30), config, mood: createMood(), counters, lastUserAt: at(15, 0).getTime(),
  });
  assert.equal(late.allowed, true);
});

test('a long cold streak still checks in occasionally', () => {
  const config = normalizeCompanionConfig({ enabled: true });
  const counters = emptyDailyCounters(at(15, 0));
  const mood = createMood({ consecutiveIgnored: 10 });
  // random() > 0.35 → skipped, so silence dominates; random() <= 0.35 → allowed.
  assert.equal(evaluateWake({ now: at(15, 0), config, mood, counters, random: () => 0.9 }).reason, 'cooled-down');
  assert.equal(evaluateWake({ now: at(15, 0), config, mood, counters, random: () => 0.1 }).allowed, true);
});

test('remainingToday reports the current period budget', () => {
  const config = normalizeCompanionConfig({ enabled: true, dayCap: 3, nightCap: 1 });
  const counters = recordWake(emptyDailyCounters(at(15, 0)), at(15, 0), { night: false });
  assert.deepEqual(remainingToday(counters, at(16, 0), config), {
    cap: 3, used: 1, remaining: 2, night: false,
  });
  assert.deepEqual(remainingToday(counters, at(23, 0), config), {
    cap: 1, used: 0, remaining: 1, night: true,
  });
});

// The configured every range is the hard bound: no phase or mood may push the
// sampled wait outside it. Before the in-window bias this reached 17h in deep
// night and 28h once decay stacked on top.
test('sampled waits never leave the configured interval window', () => {
  const config = normalizeCompanionConfig();
  const moods = [createMood(), createMood({ consecutiveIgnored: 5 })];
  for (const [label, time, night] of [
    ['work-morning', at(10, 30), false],
    ['afternoon', at(15, 0), false],
    ['late', at(23, 0), true],
    ['deep-night', at(3, 0), true],
  ]) {
    const min = night ? config.nightIntervalMinMs : config.dayIntervalMinMs;
    const max = night ? config.nightIntervalMaxMs : config.dayIntervalMaxMs;
    for (const mood of moods) {
      for (const draw of [() => 0, () => 1, () => 0.37]) {
        const delay = pickDelay(time, { config, mood, random: draw });
        assert.ok(delay >= min && delay <= max,
          `${label} delay ${delay} left [${min}, ${max}]`);
      }
    }
  }
});

test('a calm noon draw keeps the old uniform distribution', () => {
  const config = normalizeCompanionConfig();
  // Noon carries no stretch and a fresh mood no decay: bias is zero, so the
  // position maps straight through and the endpoints are the configured
  // bounds exactly.
  assert.equal(pickDelay(at(13, 0), { config, mood: createMood(), random: () => 0 }),
    config.dayIntervalMinMs);
  assert.equal(pickDelay(at(13, 0), { config, mood: createMood(), random: () => 1 }),
    config.dayIntervalMaxMs);
});

test('deep night plus an ignored streak still caps at the night maximum', () => {
  const config = normalizeCompanionConfig();
  const delay = pickDelay(at(3, 0), {
    config, mood: createMood({ consecutiveIgnored: 5 }), random: () => 1,
  });
  assert.equal(delay, config.nightIntervalMaxMs);
});
