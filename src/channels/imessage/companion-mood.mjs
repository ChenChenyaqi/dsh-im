// Companion "warmth": how eagerly she reaches out. A real person who keeps
// getting no answer becomes quieter instead of repeating themselves, and a
// reply restores the previous eagerness. All state is plain data so the
// scheduler can persist it across restarts.

export const MOOD_DEFAULTS = Object.freeze({
  warmth: 1,
  consecutiveIgnored: 0,
  /** Interval multiplier grows with each unanswered reach-out. */
  decayStep: 0.6,
  maxDecayMultiplier: 2.5,
  /** A reply restores the warmth before the first ignored reach-out. */
  replyRestore: 0.25,
  minWarmth: 0.2,
});

export function createMood(overrides = {}) {
  return {
    warmth: MOOD_DEFAULTS.warmth,
    consecutiveIgnored: MOOD_DEFAULTS.consecutiveIgnored,
    ...overrides,
  };
}

/** Normalize persisted mood data, dropping anything unusable. */
export function normalizeMood(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return createMood();
  const warmth = Number(value.warmth);
  const ignored = Number(value.consecutiveIgnored);
  return {
    warmth: Number.isFinite(warmth) && warmth >= MOOD_DEFAULTS.minWarmth && warmth <= 2
      ? warmth
      : MOOD_DEFAULTS.warmth,
    consecutiveIgnored: Number.isSafeInteger(ignored) && ignored >= 0 && ignored <= 100
      ? ignored
      : 0,
  };
}

/**
 * Apply one outcome. `ignored` means she reached out and the user stayed
 * silent; `replied` means the user answered at any point afterwards.
 */
export function nextMood(mood, outcome, { decay = true } = {}) {
  const current = normalizeMood(mood);
  if (outcome === 'replied') {
    return {
      warmth: Math.min(1, current.warmth + MOOD_DEFAULTS.replyRestore),
      consecutiveIgnored: 0,
    };
  }
  if (outcome !== 'ignored') return current;
  const consecutiveIgnored = decay ? current.consecutiveIgnored + 1 : 0;
  return {
    warmth: Math.max(MOOD_DEFAULTS.minWarmth, current.warmth - 0.2),
    consecutiveIgnored,
  };
}

/** How much longer she waits before the next reach-out, given her mood. */
export function intervalMultiplier(mood, { decay = true } = {}) {
  const current = normalizeMood(mood);
  if (!decay || current.consecutiveIgnored === 0) return 1;
  return Math.min(
    MOOD_DEFAULTS.maxDecayMultiplier,
    1 + MOOD_DEFAULTS.decayStep * current.consecutiveIgnored,
  );
}

/** Short human label used by `/companion` status output. */
export function moodLabel(mood) {
  const current = normalizeMood(mood);
  if (current.consecutiveIgnored === 0) return '正常';
  if (current.consecutiveIgnored <= 1) return '略收敛';
  if (current.consecutiveIgnored <= 3) return '安静了些';
  return '很少说话';
}
