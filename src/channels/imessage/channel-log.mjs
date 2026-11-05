// Uniform file-backed diagnostics for the whole iMessage channel pipeline.
// The packaged desktop host has no visible console, so every hop of the
// receive/send/relay flow appends one line here for on-device debugging.

import { appendFileSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_CHANNEL_LOG_PATH = join(process.env.HOME ?? '', '.dsh', 'im', 'imessage-channel.log');
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_LINE = 600;

/**
 * Build a logger writing `time [imessage:scope] message {details}` lines.
 * Every failure is swallowed: diagnostics must never disturb the channel.
 * `enabled` defaults to off under the test runner so unit tests never append
 * to the real user log; inject a temporary `path` with `enabled: true` to test.
 */
export function createChannelLogger({
  path = DEFAULT_CHANNEL_LOG_PATH,
  maxBytes = DEFAULT_MAX_BYTES,
  maxLine = DEFAULT_MAX_LINE,
  enabled = !process.env.NODE_TEST_CONTEXT,
  now = () => new Date(),
} = {}) {
  let sizeChecked = false;
  function rotateIfLarge() {
    try {
      if (statSync(path).size > maxBytes) renameSync(path, `${path}.old`);
    } catch {}
    sizeChecked = true;
  }
  return function channelLog(scope, message, details) {
    if (!enabled) return;
    if (!sizeChecked) rotateIfLarge();
    let extra = '';
    if (details !== undefined) {
      try {
        extra = ` ${JSON.stringify(details)}`;
        if (extra.length > maxLine) extra = `${extra.slice(0, maxLine)}…`;
      } catch {
        extra = '';
      }
    }
    try {
      appendFileSync(path, `${now().toISOString()} [imessage:${scope}] ${message}${extra}\n`);
    } catch {}
  };
}

/** The shared logger for runtime code paths. */
export const channelLog = createChannelLogger();
