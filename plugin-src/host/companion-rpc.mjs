// Settings-page RPC for the iMessage companion block. The settings page edits
// the persisted config.json entry; `/companion` edits the same entry through the
// runtime, so both surfaces always agree.

import { normalizeCompanionConfig } from '../../src/channels/imessage/companion-scheduler.mjs';

export const COMPANION_ENDPOINTS = Object.freeze({
  get: 'settings.companion.get',
  set: 'settings.companion.set',
});

const FIELD_KEYS = new Set([
  'enabled', 'nightStart', 'nightEnd', 'deepQuiet', 'deepQuietStart', 'deepQuietEnd',
  'dayCap', 'nightCap', 'quietAfterUserMinMs', 'quietAfterUserMaxMs',
  'dayIntervalMinMs', 'dayIntervalMaxMs', 'nightIntervalMinMs', 'nightIntervalMaxMs',
  'decay', 'allowImages',
  // The settings page edits intervals in minutes; the runtime stores them in
  // milliseconds, so both spellings are accepted and the minute form converts.
  'dayIntervalMinutes', 'dayIntervalMaxMinutes',
  'nightIntervalMinutes', 'nightIntervalMaxMinutes',
]);

/** The settings payload: rhythm only, never the bot identity. */
function viewOf(config) {
  const normalized = normalizeCompanionConfig(config);
  return {
    enabled: normalized.enabled,
    nightStart: normalized.nightStart,
    nightEnd: normalized.nightEnd,
    deepQuiet: normalized.deepQuiet,
    deepQuietStart: normalized.deepQuietStart,
    deepQuietEnd: normalized.deepQuietEnd,
    dayCap: normalized.dayCap,
    nightCap: normalized.nightCap,
    dayIntervalMinutes: Math.round(normalized.dayIntervalMinMs / 60_000),
    dayIntervalMaxMinutes: Math.round(normalized.dayIntervalMaxMs / 60_000),
    nightIntervalMinutes: Math.round(normalized.nightIntervalMinMs / 60_000),
    nightIntervalMaxMinutes: Math.round(normalized.nightIntervalMaxMs / 60_000),
    decay: normalized.decay,
    allowImages: normalized.allowImages,
  };
}

/**
 * Build the handler over one bot's config store. `botId` comes from the payload
 * so the settings card of any bot edits its own block.
 */
export function createCompanionRpcHandler({ configStore, onSaved = null }) {
  if (!configStore || typeof configStore.get !== 'function' || typeof configStore.save !== 'function') {
    throw new TypeError('createCompanionRpcHandler requires a config store');
  }
  return async (endpoint, payload, signal) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || signal?.aborted) {
      return { ok: false, error: { code: 'bad-request', message: '主动联系设置请求无效。' } };
    }
    const botId = typeof payload.botId === 'string' ? payload.botId : '';
    if (!botId) {
      return { ok: false, error: { code: 'bad-request', message: '缺少机器人标识。' } };
    }
    const bot = configStore.get(botId);
    if (!bot) {
      return { ok: false, error: { code: 'unknown-bot', message: '找不到该机器人。' } };
    }
    if (endpoint === COMPANION_ENDPOINTS.get) {
      if (Object.keys(payload).length !== 1) {
        return { ok: false, error: { code: 'bad-request', message: '主动联系设置请求无效。' } };
      }
      return { ok: true, value: viewOf(bot.companion) };
    }
    if (endpoint !== COMPANION_ENDPOINTS.set) {
      return { ok: false, error: { code: 'bad-request', message: '主动联系设置请求无效。' } };
    }
    const patch = {};
    for (const [key, value] of Object.entries(payload)) {
      if (key === 'botId') continue;
      if (!FIELD_KEYS.has(key)) {
        return { ok: false, error: { code: 'bad-request', message: `无法识别的字段：${key}` } };
      }
      patch[key] = value;
    }
    // The page sends minutes; the runtime stores milliseconds.
    for (const [minutesKey, msKey] of [
      ['dayIntervalMinutes', 'dayIntervalMinMs'],
      ['dayIntervalMaxMinutes', 'dayIntervalMaxMs'],
      ['nightIntervalMinutes', 'nightIntervalMinMs'],
      ['nightIntervalMaxMinutes', 'nightIntervalMaxMs'],
    ]) {
      if (patch[minutesKey] !== undefined) {
        patch[msKey] = Number(patch[minutesKey]) * 60_000;
        delete patch[minutesKey];
      }
    }
    const merged = normalizeCompanionConfig({ ...bot.companion, ...patch });
    try {
      await configStore.save({ ...bot, companion: merged });
    } catch {
      return { ok: false, error: { code: 'companion-unavailable', message: '无法保存主动联系设置，请稍后重试。' } };
    }
    // Push the saved rhythm into the running scheduler; without this the page
    // would save successfully but only take effect after a restart.
    try {
      onSaved?.(botId, { companion: merged });
    } catch {}
    return { ok: true, value: viewOf(merged) };
  };
}
