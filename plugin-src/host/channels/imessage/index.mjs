import { createProductionController } from './production.mjs';
import { installIMessageRpc } from './rpc.mjs';
import { createCompanionRpcHandler } from '../../companion-rpc.mjs';

export const name = 'dsh-im-imessage-host';
export const inject = ['connection', 'credentials', 'typertGateway'];

/**
 * Companion settings live on this channel's own RPC channel: the settings card
 * reaches it through the shared rpcCall bridge, so a separate channel would
 * never be addressed. A missing store simply leaves the endpoints unavailable.
 */
function companionHandlerFor(configStore, controller) {
  if (!configStore) return null;
  try {
    return createCompanionRpcHandler({
      configStore,
      onSaved: (botId, settings) => controller?.applyRuntimeSettings?.(botId, settings),
    });
  } catch {
    return null;
  }
}

export async function apply(ctx, config = {}) {
  if (config?.controller) return installIMessageRpc(ctx, config.controller, config.rpcAuthority);
  const production = await createProductionController(ctx, config, config.internals ?? {});
  const unregisterDelivery = config.deliveryService && production.deliveryAdapter
    ? config.deliveryService.registerAdapter(production.deliveryAdapter) : undefined;
  const disposeRpc = installIMessageRpc(ctx, production.controller, config.rpcAuthority, {
    companion: companionHandlerFor(production.configStore, production.controller),
  });
  ctx.effect(() => async () => {
    await unregisterDelivery?.(); await production.close();
  }, 'dsh-im: close iMessage connections');
  return disposeRpc;
}

export { createProductionController } from './production.mjs';
export { IMESSAGE_ENDPOINTS, IMESSAGE_RPC_CHANNEL, IMESSAGE_RPC_ENDPOINTS,
  createIMessageRpcHandler, installIMessageRpc } from './rpc.mjs';
