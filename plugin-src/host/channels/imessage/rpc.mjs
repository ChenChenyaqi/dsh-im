import { createConnectionDiagnostics, diagnosticRpcResult } from '../../../../src/channels/shared/connection-error.mjs';
import { createTokenBotRpcHandler } from '../shared/rpc.mjs';
import { registerManagementRpc } from '../../../management-rpc.mjs';
import { resolveRpcAuthority } from '../../rpc-authority.mjs';
import { COMPANION_ENDPOINTS } from '../../companion-rpc.mjs';

export const IMESSAGE_RPC_CHANNEL = '/imessage';
export const IMESSAGE_ENDPOINTS = Object.freeze({
  status: 'connection.status',
  bindNative: 'bot.bind-native',
  bindCredentials: 'bot.bind-native',
  permissions: 'permissions.status',
  reconnectBot: 'bot.reconnect',
  deleteBot: 'bot.delete',
  setWorkspace: 'bot.workspace.set',
  setModel: 'bot.model.set',
  setAgentPreset: 'bot.agent-preset.set',
  setContextEnhancement: 'bot.context-enhancement.set',
  setBusyMessageMode: 'bot.message-mode.set',
  setAccessPolicy: 'bot.access-policy.set',
  setAlias: 'bot.alias.set',
});
export const IMESSAGE_RPC_ENDPOINTS = Object.freeze(Object.values(IMESSAGE_ENDPOINTS));

function withRpcDetails(result) {
  if (result?.ok !== false) return result;
  return {
    ...result,
    error: { ...result.error, details: result.error?.details ?? {} },
  };
}

export function createIMessageRpcHandler(controller, { companion = null } = {}) {
  const diagnostics = controller.diagnostics ?? createConnectionDiagnostics({ channel: 'imessage' });
  const tokenHandler = createTokenBotRpcHandler(controller, {
    channel: 'iMessage',
  });
  const companionEndpoints = new Set(Object.values(COMPANION_ENDPOINTS));
  return async (endpoint, payload, signal) => {
    // The settings card runs on this same RPC channel, so the companion
    // endpoints are answered here instead of falling through to the shared
    // token handler (which would report them as unknown).
    if (companionEndpoints.has(endpoint)) {
      if (!companion) {
        return withRpcDetails({
          ok: false,
          error: { code: 'companion-unavailable', message: '主动联系设置暂不可用。' },
        });
      }
      return withRpcDetails(await companion(endpoint, payload, signal));
    }
    if (endpoint === IMESSAGE_ENDPOINTS.status) {
      try {
        const value = await controller.status();
        return { ok: true, value: { ...value, permissions: await controller.permissions() } };
      } catch (error) {
        return diagnosticRpcResult(diagnostics, error, { ok: false, error: { code: 'status-failed' } },
          { operation: endpoint, untrustedPublicError: true });
      }
    }
    if (endpoint === IMESSAGE_ENDPOINTS.permissions) {
      try {
        return { ok: true, value: await controller.permissions() };
      } catch (error) {
        return diagnosticRpcResult(diagnostics, error, withRpcDetails({
          ok: false,
          error: { code: 'permissions-check-failed', message: error.message },
        }), { operation: endpoint, botId: payload?.botId, untrustedPublicError: true });
      }
    }
    if (endpoint === IMESSAGE_ENDPOINTS.bindNative) {
      try {
        return { ok: true, value: await controller.bindNative() };
      } catch (error) {
        return diagnosticRpcResult(diagnostics, error, withRpcDetails({
          ok: false,
          error: { code: error.code ?? 'imessage-bind-failed', message: error.message },
        }), { operation: endpoint, botId: payload?.botId, untrustedPublicError: true });
      }
    }
    const translated = endpoint === IMESSAGE_ENDPOINTS.setModel ? 'bot.model.set' : endpoint;
    return withRpcDetails(await tokenHandler(translated, payload, signal));
  };
}

export function installIMessageRpc(ctx, controller, authority, { companion = null } = {}) {
  return registerManagementRpc(
    ctx,
    IMESSAGE_RPC_CHANNEL,
    createIMessageRpcHandler(controller, { companion }),
    { authority: resolveRpcAuthority(authority) },
  );
}
