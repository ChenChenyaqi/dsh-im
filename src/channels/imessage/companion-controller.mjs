// Companion controller: owns the wake timer, the persisted mood/counters, and
// the `/companion` control surface. It asks the Harness for one short turn and
// forwards the answer through the channel only when the model chose to speak.

import { channelLog } from './channel-log.mjs';
import { createMood, nextMood, normalizeMood, moodLabel } from './companion-mood.mjs';
import { buildWakePrompt, isSkipReply, pickMotive, phaseOf } from './companion-motives.mjs';
import {
  COMPANION_DEFAULTS, evaluateWake, isNight, normalizeCompanionConfig, pickDelay,
  recordWake, remainingToday,
} from './companion-scheduler.mjs';

const MAX_TRACKED_CONVERSATIONS = 20;

/** Persisted shape; every field is optional so an old file still loads. */
function normalizeCompanionState(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const conversations = {};
  if (source.conversations && typeof source.conversations === 'object' && !Array.isArray(source.conversations)) {
    for (const [key, entry] of Object.entries(source.conversations)) {
      if (typeof key !== 'string' || !key || !entry || typeof entry !== 'object') continue;
      conversations[key] = {
        mood: normalizeMood(entry.mood),
        counters: entry.counters && typeof entry.counters === 'object'
          ? { date: String(entry.counters.date ?? ''), day: Number(entry.counters.day) || 0, night: Number(entry.counters.night) || 0 }
          : null,
        lastUserAt: Number.isFinite(entry.lastUserAt) ? entry.lastUserAt : null,
        lastWakeAt: Number.isFinite(entry.lastWakeAt) ? entry.lastWakeAt : null,
        lastDeliveredAt: Number.isFinite(entry.lastDeliveredAt) ? entry.lastDeliveredAt : null,
        pendingSince: Number.isFinite(entry.pendingSince) ? entry.pendingSince : null,
      };
      if (Object.keys(conversations).length >= MAX_TRACKED_CONVERSATIONS) break;
    }
  }
  return { conversations, nextWakeAt: Number.isFinite(source.nextWakeAt) ? source.nextWakeAt : null };
}

function emptyEntry() {
  return { mood: createMood(), counters: null, lastUserAt: null, lastWakeAt: null, lastDeliveredAt: null, pendingSince: null };
}

/**
 * Drives spontaneous reach-outs for one bot. `conversations()` returns the
 * currently bound chats so the timer can pick a target; `ask(sessionId, prompt)`
 * runs one Harness turn; `deliver(target, text)` sends through the channel.
 */
export class CompanionController {
  #options;
  #state;
  #config;
  #timer = null;
  #running = false;
  #waking = false;
  #lastDecision = null;
  #stopped = true;

  constructor({
    readState, writeState, conversations, ask, deliver,
    config = {}, now = () => new Date(), random = Math.random, logger = console,
  } = {}) {
    if (typeof readState !== 'function' || typeof writeState !== 'function') {
      throw new TypeError('CompanionController requires state accessors');
    }
    if (typeof conversations !== 'function' || typeof ask !== 'function' || typeof deliver !== 'function') {
      throw new TypeError('CompanionController requires conversations, ask and deliver');
    }
    this.#options = { conversations, ask, deliver, now, random, logger };
    this.#state = readState;
    this.#writeState = writeState;
    this.#config = normalizeCompanionConfig(config);
  }

  #writeState;

  get config() { return this.#config; }

  /** Re-read the persisted block, so a restart keeps warmth and counters. */
  #persisted() {
    return normalizeCompanionState(this.#state());
  }

  #commit(next) {
    this.#writeState(next);
  }

  #entryFor(conversations, key) {
    const persisted = this.#persisted();
    return { persisted, entry: persisted.conversations[key] ?? emptyEntry() };
  }

  /** Record that the user wrote: cancels the ignored streak she may be in. */
  noteUserMessage(conversationKey, at = this.#options.now()) {
    if (typeof conversationKey !== 'string' || !conversationKey) return;
    const persisted = this.#persisted();
    const entry = persisted.conversations[conversationKey] ?? emptyEntry();
    const wasWaiting = entry.pendingSince !== null;
    persisted.conversations[conversationKey] = {
      ...entry,
      lastUserAt: at.getTime(),
      pendingSince: null,
      mood: wasWaiting ? nextMood(entry.mood, 'replied', { decay: this.#config.decay }) : entry.mood,
    };
    this.#commit(persisted);
    if (wasWaiting) channelLog('companion', 'user replied, warmth restored', { conversationKey, mood: persisted.conversations[conversationKey].mood });
  }

  updateConfig(patch = {}) {
    const merged = normalizeCompanionConfig({ ...this.#config, ...patch });
    const wasEnabled = this.#config.enabled;
    this.#config = merged;
    channelLog('companion', 'config updated', {
      enabled: merged.enabled, dayCap: merged.dayCap, nightCap: merged.nightCap,
      nightStart: merged.nightStart, nightEnd: merged.nightEnd, deepQuiet: merged.deepQuiet,
    });
    if (this.#running) {
      if (!wasEnabled && merged.enabled) this.#arm();
      else if (wasEnabled && !merged.enabled) this.#disarm();
      else if (merged.enabled) this.#arm();
    }
    return merged;
  }

  start() {
    this.#stopped = false;
    this.#running = true;
    if (this.#config.enabled) this.#arm();
    channelLog('companion', 'started', { enabled: this.#config.enabled });
  }

  stop() {
    this.#stopped = true;
    this.#running = false;
    this.#disarm();
  }

  #disarm() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** Choose the next conversation and arm one timer for it. */
  #arm() {
    this.#disarm();
    if (this.#stopped || !this.#config.enabled) return;
    const now = this.#options.now();
    const targets = this.#options.conversations();
    if (targets.length === 0) {
      channelLog('companion', 'no bound conversation yet; retrying later');
      this.#timer = setTimeout(() => this.#arm(), 10 * 60_000);
      this.#timer.unref?.();
      return;
    }
    const target = targets[0];
    const { entry } = this.#entryFor(targets, target.conversationKey);
    const delay = pickDelay(now, { config: this.#config, mood: entry.mood, random: this.#options.random });
    const nextWakeAt = now.getTime() + delay;
    const persisted = this.#persisted();
    persisted.nextWakeAt = nextWakeAt;
    this.#commit(persisted);
    channelLog('companion', 'armed', {
      conversationKey: target.conversationKey, delayMs: delay, at: new Date(nextWakeAt).toISOString(),
      night: isNight(now, this.#config),
    });
    this.#timer = setTimeout(() => { void this.#wake(); }, delay);
    this.#timer.unref?.();
  }

  /** Force one reach-out attempt, ignoring the timer but not the quotas. */
  async triggerNow() {
    return this.#wake({ forced: true });
  }

  async #wake({ forced = false } = {}) {
    if (this.#stopped || this.#waking) return { delivered: false, reason: 'busy' };
    this.#waking = true;
    const now = this.#options.now();
    try {
      const targets = this.#options.conversations();
      if (targets.length === 0) {
        if (!forced) this.#arm();
        return { delivered: false, reason: 'no-target' };
      }
      const target = targets[0];
      const persisted = this.#persisted();
      const entry = persisted.conversations[target.conversationKey] ?? emptyEntry();
      const decision = evaluateWake({
        now, config: this.#config, mood: entry.mood, counters: entry.counters,
        lastUserAt: entry.lastUserAt,
        // A forced run from `/companion now` skips the probabilistic gates but
        // still respects the switch, deep quiet and the daily cap.
        random: forced ? () => 0 : this.#options.random,
      });
      this.#lastDecision = { at: now.toISOString(), ...decision };
      if (!decision.allowed) {
        channelLog('companion', 'wake skipped', { reason: decision.reason, forced });
        if (!forced) this.#arm();
        return { delivered: false, reason: decision.reason };
      }
      if (!target.sessionId) {
        channelLog('companion', 'wake skipped: conversation has no session');
        if (!forced) this.#arm();
        return { delivered: false, reason: 'no-session' };
      }
      const motive = pickMotive(now, {
        random: this.#options.random, allowImages: this.#config.allowImages,
      });
      const prompt = buildWakePrompt({
        motive, now, lastUserAt: entry.lastUserAt, warmth: entry.mood.warmth,
        allowImages: this.#config.allowImages,
      });
      channelLog('companion', 'wake', {
        conversationKey: target.conversationKey, sessionId: target.sessionId,
        motive: motive.id, phase: phaseOf(now).id, warmth: entry.mood.warmth, forced,
      });
      let reply = '';
      try {
        const result = await this.#options.ask(target.sessionId, prompt);
        reply = replyTextOf(result);
      } catch (error) {
        channelLog('companion', 'wake failed', { error: String(error?.message ?? error).slice(0, 300) });
        if (!forced) this.#arm();
        return { delivered: false, reason: 'ask-failed' };
      }
      const counters = recordWake(entry.counters, now, { night: decision.night === true });
      if (isSkipReply(reply)) {
        channelLog('companion', 'she stayed silent', { motive: motive.id });
        persisted.conversations[target.conversationKey] = {
          ...entry, counters, lastWakeAt: now.getTime(),
        };
        this.#commit(persisted);
        if (!forced) this.#arm();
        return { delivered: false, reason: 'skipped' };
      }
      try {
        await this.#options.deliver(target, reply);
      } catch (error) {
        channelLog('companion', 'delivery failed', { error: String(error?.message ?? error).slice(0, 300) });
        if (!forced) this.#arm();
        return { delivered: false, reason: 'deliver-failed' };
      }
      persisted.conversations[target.conversationKey] = {
        ...entry,
        counters,
        lastWakeAt: now.getTime(),
        lastDeliveredAt: now.getTime(),
        // She spoke and the user has not answered yet: a later silence weakens
        // the next reach-out.
        pendingSince: now.getTime(),
        mood: nextMood(entry.mood, 'ignored', { decay: this.#config.decay }),
      };
      this.#commit(persisted);
      channelLog('companion', 'delivered', { motive: motive.id, chars: reply.length });
      if (!forced) this.#arm();
      return { delivered: true, motive: motive.id };
    } finally {
      this.#waking = false;
    }
  }

  /** Everything `/companion` reports. */
  status() {
    const now = this.#options.now();
    const persisted = this.#persisted();
    const targets = this.#options.conversations();
    const target = targets[0] ?? null;
    const entry = target ? (persisted.conversations[target.conversationKey] ?? emptyEntry()) : emptyEntry();
    const remaining = remainingToday(entry.counters, now, this.#config);
    return {
      enabled: this.#config.enabled,
      running: this.#running,
      night: isNight(now, this.#config),
      phase: phaseOf(now).id,
      remaining,
      mood: entry.mood,
      moodLabel: moodLabel(entry.mood),
      lastUserAt: entry.lastUserAt,
      lastDeliveredAt: entry.lastDeliveredAt,
      nextWakeAt: persisted.nextWakeAt,
      lastDecision: this.#lastDecision,
      conversationKey: target?.conversationKey ?? null,
      config: this.#config,
    };
  }
}

/** Plain text of a Harness answer, ignoring reasoning parts. */
export function replyTextOf(result) {
  if (typeof result === 'string') return result.trim();
  const message = result?.message ?? result?.messages?.at?.(-1) ?? null;
  const content = message?.content ?? result?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

export { COMPANION_DEFAULTS, normalizeCompanionConfig };
