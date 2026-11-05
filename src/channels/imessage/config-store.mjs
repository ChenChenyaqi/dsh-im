import {
  deriveTokenBotIdentity,
  maskPlatformId,
  TokenBotConfigStore,
} from '../shared/token-config-store.mjs';
import { normalizeCompanionConfig } from './companion-scheduler.mjs';

const IDENTITY_OPTIONS = Object.freeze({
  botPrefix: 'imessage',
  tokenRefPrefix: 'DSH_IMESSAGE_PASSWORD',
});

/**
 * The companion block is stored per bot but normalized by the scheduler so a
 * hand-edited config can never produce an unusable rhythm.
 */
function normalizeCompanionExtension(value) {
  if (value.companion === undefined || value.companion === null) return {};
  if (typeof value.companion !== 'object' || Array.isArray(value.companion)) return null;
  return { companion: normalizeCompanionConfig(value.companion) };
}

export function deriveIMessageBotIdentity(platformId) {
  return deriveTokenBotIdentity(platformId, IDENTITY_OPTIONS);
}

export function maskIMessageBotId(platformId) {
  return maskPlatformId(platformId, 'iMessage 网关');
}

export class IMessageConfigStore extends TokenBotConfigStore {
  constructor(path) {
    super(path, {
      channel: 'iMessage',
      ...IDENTITY_OPTIONS,
      normalizeBotExtension: normalizeCompanionExtension,
    });
  }
}
