import { TextHarnessBridge, createTextBridgeStatus } from '../shared/text-harness-bridge.mjs';
import { channelLog } from './channel-log.mjs';

export const IMESSAGE_DESCRIPTOR = Object.freeze({
  key: 'imessage',
  label: 'iMessage',
  connectionLabel: ' macOS Messages 连接',
  reactions: Object.freeze({ processing: '👀', success: '✅', error: '❌' }),
});

export class IMessageHarnessBridge extends TextHarnessBridge {
  constructor(options) {
    super({ ...options, descriptor: IMESSAGE_DESCRIPTOR, diagnostics: options?.diagnostics ?? channelLog });
  }
}

export { createTextBridgeStatus as createIMessageBridgeStatus };
