// Simulates human typing rhythm for outbound iMessage replies: longer replies
// wait longer, fenced code blocks are treated as pastes with a short flat
// delay, and every value is jittered and clamped so the pace never looks
// mechanical.

export const HUMAN_TYPING_DEFAULTS = Object.freeze({
  firstReplyMinMs: 600,
  firstReplyMaxMs: 1_800,
  baseDelayMs: 250,
  charsPerSecond: 4,
  minDelayMs: 250,
  maxDelayMs: 5_000,
  jitterRatio: 0.25,
  pasteMinMs: 300,
  pasteMaxMs: 800,
});

export function computeHumanTypingDelayMs(nextText, { isFirst = false, random = Math.random } = {}) {
  const options = HUMAN_TYPING_DEFAULTS;
  const rand = (min, max) => min + random() * (max - min);
  const text = String(nextText ?? '');
  let base;
  if (text.trim().startsWith('```')) {
    base = rand(options.pasteMinMs, options.pasteMaxMs);
  } else {
    base = (isFirst ? rand(options.firstReplyMinMs, options.firstReplyMaxMs) : options.baseDelayMs)
      + (Array.from(text).length / options.charsPerSecond) * 1_000;
  }
  const jitter = 1 + rand(-options.jitterRatio, options.jitterRatio);
  return Math.min(options.maxDelayMs, Math.max(options.minDelayMs, Math.round(base * jitter)));
}

export function waitLineInterval(signal, ms) {
  return new Promise((resolve, reject) => {
    if (ms <= 0) { resolve(); return; }
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('iMessage line send aborted')); };
    if (signal?.aborted) { abort(); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
