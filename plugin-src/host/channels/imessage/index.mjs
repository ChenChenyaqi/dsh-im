import { createProductionController } from './production.mjs';
import { installIMessageRpc } from './rpc.mjs';
import { registerManagementRpc } from '../../../management-rpc.mjs';
import { createCompanionRpcHandler, COMPANION_ENDPOINTS } from '../../companion-rpc.mjs';

export const name = 'dsh-im-imessage-host';
export const inject = ['connection', 'credentials', 'typertGateway'];

export const COMPANION_RPC_CHANNEL = 'dsh-im/companion';

/** Settings-page endpoints for the companion block, over the bot config store. */
function installCompanionRpc(ctx, configStore, { authority } = {}) {
  if (!configStore) return () => {};
  let handler;
  try {
    handler = createCompanionRpcHandler({ configStore });
  } catch {
    return () => {};
  }
  return registerManagementRpc(ctx, COMPANION_RPC_CHANNEL,
    (endpoint, payload, signal) => (Object.values(COMPANION_ENDPOINTS).includes(endpoint)
      ? handler(endpoint, payload, signal)
      : { ok: false, error: { code: 'bad-request', message: '主动联系设置请求无效。' } }),
    { authority });
}

export async function apply(ctx, config = {}) {
  if (config?.controller) return installIMessageRpc(ctx, config.controller, config.rpcAuthority);
  const production = await createProductionController(ctx, config, config.internals ?? {});
  const unregisterDelivery = config.deliveryService && production.deliveryAdapter
    ? config.deliveryService.registerAdapter(production.deliveryAdapter) : undefined;
  const disposeRpc = installIMessageRpc(ctx, production.controller, config.rpcAuthority);
  const disposeCompanion = installCompanionRpc(ctx, production.configStore, {
    authority: config.rpcAuthority,
  });
  ctx.effect(() => async () => {
    disposeCompanion?.();
    await unregisterDelivery?.(); await production.close();
  }, 'dsh-im: close iMessage connections');
  return disposeRpc;
}

export { createProductionController } from './production.mjs';
export { IMESSAGE_ENDPOINTS, IMESSAGE_RPC_CHANNEL, IMESSAGE_RPC_ENDPOINTS,
  createIMessageRpcHandler, installIMessageRpc } from './rpc.mjs';
