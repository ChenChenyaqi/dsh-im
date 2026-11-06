// Companion rhythm: when she may reach out on her own. The scheduler decides
// timing, quotas and quiet windows only — what she says (and whether she says
// anything at all) belongs to the motives module and the model.

import { intervalMultiplier, normalizeMood } from './companion-mood.mjs';
import { phaseOf } from './companion-motives.mjs';

const MINUTE = 60_000;

export const COMPANION_DEFAULTS = Object.freeze({
  enabled: false,
  /** Within this window the reach-out rate drops sharply but never to zero. */
  nightStart: '22:30',
  nightEnd: '08:00',
  /** Optional hard stop inside the night for the hours you must not be woken. */
  deepQuiet: false,
  deepQuietStart: '02:30',
  deepQuietEnd: '07:00',
  dayIntervalMinMs: 45 * MINUTE,
  dayIntervalMaxMs: 150 * MINUTE,
  nightIntervalMinMs: 180 * MINUTE,
  nightIntervalMaxMs: 420 * MINUTE,
  dayCap: 5,
  nightCap: 2,
  /** Silence after the user's own message, sampled per wait. */
  quietAfterUserMinMs: 40 * MINUTE,
  quietAfterUserMaxMs: 90 * MINUTE,
  decay: true,
  allowImages: true,
});

/** Phases where people are busy, so reach-outs stretch out. */
const PHASE_STRETCH = Object.freeze({
  'deep-night': 2.5,
  morning: 1,
  'work-morning': 1.6,
  noon: 1,
  'work-afternoon': 1.6,
  evening: 1,
  night: 1,
  late: 1.2,
});

function parseClock(value, fallback) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(String(value ?? '').trim());
  if (!match) return fallback;
  return Number(match[1]) * 60 + Number(match[2]);
}

function minutesOf(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/** True when `minutes` falls inside the inclusive-start/exclusive-end window. */
function inWindow(minutes, start, end) {
  if (start === end) return false;
  return start < end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end;
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
}

/** Merge user config over the defaults, rejecting unusable values. */
export function normalizeCompanionConfig(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const config = { ...COMPANION_DEFAULTS };
  for (const key of ['nightStart', 'nightEnd', 'deepQuietStart', 'deepQuietEnd']) {
    const parsed = parseClock(source[key], null);
    if (parsed !== null) config[key] = source[key];
  }
  config.enabled = source.enabled === true;
  config.deepQuiet = source.deepQuiet === true;
  config.decay = source.decay !== false;
  config.allowImages = source.allowImages !== false;
  config.dayCap = boundedNumber(source.dayCap, COMPANION_DEFAULTS.dayCap, 0, 24);
  config.nightCap = boundedNumber(source.nightCap, COMPANION_DEFAULTS.nightCap, 0, 24);
  for (const key of ['dayIntervalMinMs', 'dayIntervalMaxMs', 'nightIntervalMinMs', 'nightIntervalMaxMs']) {
    config[key] = boundedNumber(source[key], COMPANION_DEFAULTS[key], MINUTE, 24 * 60 * MINUTE);
  }
  // A reversed range would make pickDelay nonsensical; fall back to defaults.
  if (config.dayIntervalMinMs > config.dayIntervalMaxMs) {
    config.dayIntervalMinMs = COMPANION_DEFAULTS.dayIntervalMinMs;
    config.dayIntervalMaxMs = COMPANION_DEFAULTS.dayIntervalMaxMs;
  }
  if (config.nightIntervalMinMs > config.nightIntervalMaxMs) {
    config.nightIntervalMinMs = COMPANION_DEFAULTS.nightIntervalMinMs;
    config.nightIntervalMaxMs = COMPANION_DEFAULTS.nightIntervalMaxMs;
  }
  config.quietAfterUserMinMs = boundedNumber(
    source.quietAfterUserMinMs, COMPANION_DEFAULTS.quietAfterUserMinMs, 0, 12 * 60 * MINUTE,
  );
  config.quietAfterUserMaxMs = boundedNumber(
    source.quietAfterUserMaxMs, COMPANION_DEFAULTS.quietAfterUserMaxMs, 0, 12 * 60 * MINUTE,
  );
  if (config.quietAfterUserMinMs > config.quietAfterUserMaxMs) {
    config.quietAfterUserMinMs = COMPANION_DEFAULTS.quietAfterUserMinMs;
    config.quietAfterUserMaxMs = COMPANION_DEFAULTS.quietAfterUserMaxMs;
  }
  return Object.freeze(config);
}

/** Is this moment inside the configured night window? */
export function isNight(now, config = COMPANION_DEFAULTS) {
  const date = now instanceof Date ? now : new Date(now);
  const minutes = minutesOf(date);
  return inWindow(minutes, parseClock(config.nightStart, 1350), parseClock(config.nightEnd, 480));
}

/** Is this moment inside the optional hard-silence window? */
export function isDeepQuiet(now, config = COMPANION_DEFAULTS) {
  if (config.deepQuiet !== true) return false;
  const date = now instanceof Date ? now : new Date(now);
  return inWindow(
    minutesOf(date),
    parseClock(config.deepQuietStart, 150),
    parseClock(config.deepQuietEnd, 420),
  );
}

/**
 * Sample the wait before the next reach-out. Night uses its own wider window;
 * a busy phase or a cold-shoulder streak biases the draw toward the far end of
 * that window. The configured every range is the hard bound either way: the
 * wait never lands outside [intervalMin, intervalMax] however long the stretch
 * and decay stack up.
 */
export function pickDelay(now, { config = COMPANION_DEFAULTS, mood, random = Math.random } = {}) {
  const night = isNight(now, config);
  const min = night ? config.nightIntervalMinMs : config.dayIntervalMinMs;
  const max = night ? config.nightIntervalMaxMs : config.dayIntervalMaxMs;
  const phase = phaseOf(now);
  const stretch = PHASE_STRETCH[phase.id] ?? 1;
  const multiplier = intervalMultiplier(mood, { decay: config.decay });
  // Stretch and decay bend the draw toward `max`; they no longer multiply past
  // it, which used to turn a configured 45-150min day into a 17h deep-night
  // wait (28h once the decay cap stacked on top).
  const bias = 1 - (stretch * multiplier) ** -0.5;
  const position = random();
  const biased = Math.min(1, Math.max(0, position + (1 - position) * bias));
  return Math.round(min + (max - min) * biased);
}

/** Sample the silence kept after the user's own last message. */
export function pickQuietDelay({ config = COMPANION_DEFAULTS, random = Math.random } = {}) {
  const { quietAfterUserMinMs: min, quietAfterUserMaxMs: max } = config;
  return Math.round(min + random() * (max - min));
}

/** Daily counters keyed by local date so a new day resets them. */
export function emptyDailyCounters(now) {
  const date = now instanceof Date ? now : new Date(now);
  return { date: localDateKey(date), day: 0, night: 0 };
}

export function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function rollCounters(counters, now) {
  const key = localDateKey(now instanceof Date ? now : new Date(now));
  if (counters?.date === key) return counters;
  return { date: key, day: 0, night: 0 };
}

/**
 * Decide whether a reach-out may happen now. Returns `{ allowed, reason }` so
 * the caller can log exactly why she stayed quiet.
 */
export function evaluateWake({
  now, config = COMPANION_DEFAULTS, mood, counters, lastUserAt = null, random = Math.random,
} = {}) {
  const date = now instanceof Date ? now : new Date(now);
  if (config.enabled !== true) return { allowed: false, reason: 'disabled' };
  if (isDeepQuiet(date, config)) return { allowed: false, reason: 'deep-quiet' };
  const current = normalizeMood(mood);
  if (current.consecutiveIgnored >= 4) {
    // Even a long cold streak keeps a floor: she still checks in, rarely.
    const floor = 0.35;
    if (random() > floor) return { allowed: false, reason: 'cooled-down' };
  }
  const rolled = rollCounters(counters, date);
  const night = isNight(date, config);
  const cap = night ? config.nightCap : config.dayCap;
  const used = night ? rolled.night : rolled.day;
  if (used >= cap) return { allowed: false, reason: 'daily-cap' };
  if (typeof lastUserAt === 'number' && lastUserAt > 0) {
    const quiet = pickQuietDelay({ config, random });
    if (date.getTime() - lastUserAt < quiet) return { allowed: false, reason: 'quiet-after-user' };
  }
  return { allowed: true, reason: 'ok', night };
}

/** Record a delivered reach-out in the daily counters. */
export function recordWake(counters, now, { night }) {
  const date = now instanceof Date ? now : new Date(now);
  const rolled = rollCounters(counters, date);
  return night ? { ...rolled, night: rolled.night + 1 } : { ...rolled, day: rolled.day + 1 };
}

/** Remaining reach-outs today, for `/companion` status. */
export function remainingToday(counters, now, config = COMPANION_DEFAULTS) {
  const date = now instanceof Date ? now : new Date(now);
  const rolled = rollCounters(counters, date);
  const night = isNight(date, config);
  const cap = night ? config.nightCap : config.dayCap;
  const used = night ? rolled.night : rolled.day;
  return { cap, used, remaining: Math.max(0, cap - used), night };
}
