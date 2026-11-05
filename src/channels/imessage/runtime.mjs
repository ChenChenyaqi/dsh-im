// iMessage runtime assembly: bot client (human-paced segmented replies,
// outbound artifact delivery) and the polling runtime that feeds the bridge.
// Reply pacing and splitting live in sibling modules; re-exported here so
// existing import paths keep working.

import { createConnectionDiagnostics, atConnectionStage } from '../shared/connection-error.mjs';
import { sendRememberedConnectionTest } from '../shared/connection-test.mjs';
import { MacOSMessagesApi, normalizeIMessage } from './imessage-api.mjs';
import { createIMessageBridgeStatus, IMessageHarnessBridge } from './imessage-bridge.mjs';
import { computeHumanTypingDelayMs, waitLineInterval } from './typing-delays.mjs';
import { splitIMessageReplyParts } from './reply-splitting.mjs';
import { sendOutboundArtifactBytes } from './outbound-artifacts.mjs';
import { channelLog } from './channel-log.mjs';
import { CompanionController } from './companion-controller.mjs';
import { imessageStickers, publishStickerGuidance } from './imessage-stickers.mjs';
import { runCompanionCommand } from '../shared/companion-command.mjs';

export { HUMAN_TYPING_DEFAULTS, computeHumanTypingDelayMs } from './typing-delays.mjs';
export { splitIMessageReplyParts } from './reply-splitting.mjs';

const DEFAULT_POLL_INTERVAL_MS = 2_000;

class IMessageBotClient {
  /** Optional control surface attached by the runtime (`/companion`). */
  companion = null;
  #api;
  #signal;
  #typing;
  #zeroDelay;
  constructor(api, signal, { lineSendIntervalMs, typing = {} } = {}) {
    this.#api = api; this.#signal = signal;
    this.#typing = { random: typing.random ?? Math.random };
    this.#zeroDelay = lineSendIntervalMs === 0;
  }
  async sendText(target, text) {
    const parts = splitIMessageReplyParts(text);
    channelLog('client', 'reply plan', { parts: parts.length, chars: String(text ?? '').length, to: target?.address ?? target?.chatGuid });
    for (let index = 0; index < parts.length; index += 1) {
      if (!this.#zeroDelay) {
        const delay = computeHumanTypingDelayMs(parts[index], {
          isFirst: index === 0,
          random: this.#typing.random,
        });
        channelLog('client', 'part', { index: index + 1, of: parts.length, chars: parts[index].length, delayMs: delay });
        await waitLineInterval(this.#signal, delay);
      }
      await this.#api.sendText({
        chatGuid: target.chatGuid,
        address: target.address,
        text: parts[index],
        signal: this.#signal,
      });
    }
  }
  sendTyping() { return Promise.resolve(); }
  sendFile(target, file) {
    return sendOutboundArtifactBytes(this.#api, target, file);
  }
  sendImage(target, file) {
    return sendOutboundArtifactBytes(this.#api, target, file);
  }
}

export { IMessageBotClient };

export function createIMessageRuntimeStatus() {
  return { startedAt: null, ready: false, connectionState: 'idle', harnessReachable: false,
    lastCheckedAt: null, lastConnectedAt: null, lastError: null, ...createIMessageBridgeStatus() };
}

export class IMessageRuntime {
  #config; #token; #harness; #state; #contextEnhancement; #accessPolicy; #logger;
  #diagnostics;
  #replyTimeoutMs; #pollIntervalMs; #createApi; #createClient; #status = createIMessageRuntimeStatus();
  #api; #client; #bridge; #abortController; #timer; #polling; #stopped = true;
  #companion = null; #persistBotConfig = null;
  constructor({ config, token, harness, state, contextEnhancement, accessPolicy, logger = console,
    replyTimeoutMs = 600_000, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    createApi = (options) => new MacOSMessagesApi(options),
    createClient = (api, signal) => new IMessageBotClient(api, signal),
    persistBotConfig = null }) {
    if (!config || !token || !harness || !state) throw new TypeError('IMessageRuntime requires config, token, Harness, and state');
    this.#config = config; this.#token = token; this.#harness = harness; this.#state = state;
    this.#contextEnhancement = contextEnhancement; this.#accessPolicy = accessPolicy; this.#logger = logger; this.#diagnostics = createConnectionDiagnostics({ channel: 'imessage', logger });
    this.#replyTimeoutMs = replyTimeoutMs; this.#pollIntervalMs = pollIntervalMs; this.#createApi = createApi;
    this.#createClient = createClient;
    this.#persistBotConfig = typeof persistBotConfig === 'function' ? persistBotConfig : null;
  }
  get status() { return structuredClone(this.#status); }
  async sendConnectionTest(text) {
    if (!this.#status.ready || !this.#api) { const error = new Error('iMessage gateway is not connected'); error.code = 'test-target-unavailable'; throw error; }
    await sendRememberedConnectionTest({
      state: this.#state,
      text,
      channelLabel: 'iMessage',
      send: (target, value) => this.#api.sendText({
        chatGuid: target.chatGuid, address: target.address, text: value,
      }),
    });
  }
  async sendProactiveText(target, text, options = {}) {
    if (!this.#status.ready || !this.#api) { const error = new Error('iMessage gateway is not connected'); error.code = 'bot-not-connected'; throw error; }
    const chatGuid = target?.route?.chatGuid;
    if (!chatGuid) { const error = new TypeError('Invalid iMessage proactive delivery target'); error.code = 'invalid-target'; throw error; }
    // Route proactive sends through the bot client so reminders get the same
    // segmented, human-paced delivery as conversational replies.
    if (this.#client) {
      await this.#client.sendText({ chatGuid }, text);
      return { sent: true };
    }
    await this.#api.sendText({ chatGuid, text, signal: options.signal });
    return { sent: true };
  }
  async start() {
    if (this.#status.ready) return this.status;
    await this.stop(); this.#stopped = false; this.#status.startedAt = new Date().toISOString(); this.#status.connectionState = 'connecting';
    this.#abortController = new AbortController();
    try {
      await atConnectionStage('harness.check', () => this.#harness.ensureRunning()); this.#status.harnessReachable = true;
      this.#api = this.#createApi({ signal: this.#abortController.signal });
      const permissions = await this.#api.getPermissions();
      channelLog('runtime', 'permissions', permissions);
      if (permissions.database !== 'granted' || permissions.automation !== 'granted') {
        const error = new Error('macOS Messages permissions are required');
        error.code = 'messages-permission-required';
        error.permissions = permissions;
        throw error;
      }
      if (this.#state.cursor() === null && typeof this.#api.getLatestMessageRowId === 'function') {
        await this.#state.setCursor(await this.#api.getLatestMessageRowId());
      }
      const client = this.#createClient(this.#api, this.#abortController.signal);
      this.#client = client;
      this.#bridge = new IMessageHarnessBridge({ bot: client, harness: this.#harness, state: this.#state,
        contextEnhancement: this.#contextEnhancement, accessPolicy: this.#accessPolicy, status: this.#status,
        logger: this.#logger, replyTimeoutMs: this.#replyTimeoutMs, signal: this.#abortController.signal });
      this.#status.ready = true; this.#status.connectionState = 'connected'; this.#status.lastConnectedAt = Date.now();
      this.#startCompanion();
      for (const { sessionId } of this.#companionConversations()) publishStickerGuidance(sessionId);
      channelLog('runtime', 'connected', { pollIntervalMs: this.#pollIntervalMs });
      this.#schedulePoll(0); return this.status;
    } catch (error) { channelLog('runtime', 'start failed', { error: String(error?.message ?? error).slice(0, 200) }); this.#status.ready = false; this.#status.connectionState = 'failed'; this.#status.error = this.#diagnostics.report(error, { operation: 'connection.restore', reuse: true, botId: this.#config?.botId, automatic: true }).publicError;
      this.#status.lastError = this.#status.error.message; await this.stop(); throw error; }
  }
  /**
   * Start the spontaneous reach-out scheduler. It reuses the same Harness and
   * bot client as ordinary replies, and persists warmth/counters inside the
   * channel state file under `imessageCompanion`.
   */
  #startCompanion() {
    if (this.#companion) return;
    const store = this.#state;
    try {
      this.#companion = new CompanionController({
        config: this.#config.companion ?? {},
        readState: () => store.extensionState?.()?.imessageCompanion ?? null,
        writeState: (value) => {
          const live = store.extensionState?.();
          if (!live) return;
          live.imessageCompanion = value;
          store.persist?.();
        },
        conversations: () => this.#companionConversations(),
        ask: (sessionId, prompt) => this.#harness.ask(sessionId, prompt, { timeoutMs: this.#replyTimeoutMs }),
        deliver: async (target, text) => {
          if (!this.#client) throw new Error('iMessage bot client is not connected');
          await this.#client.sendText({ chatGuid: target.chatGuid, address: target.address }, text);
        },
        logger: this.#logger,
      });
      this.#companion.start();
      // Expose the control surface on the bot so the bridge can run /companion.
      if (this.#client) {
        this.#client.companion = {
          handle: async (text, { conversationKey } = {}) => {
            if (conversationKey) this.#companion?.noteUserMessage?.(conversationKey);
            const before = JSON.stringify(this.#companion?.config ?? null);
            const reply = await runCompanionCommand(text, this.#companion);
            const after = JSON.stringify(this.#companion?.config ?? null);
            // `/companion on|off|quiet|rate|deep|every` changed the rhythm: persist
            // it so the settings page and a restart see the same values.
            if (before !== after && this.#persistBotConfig) {
              await this.#persistBotConfig({ companion: this.#companion.config }).catch((error) => {
                channelLog('companion', 'config persist failed', { error: String(error?.message ?? error).slice(0, 200) });
              });
            }
            return reply;
          },
          status: () => this.#companion?.status() ?? null,
        };
      }
    } catch (error) {
      channelLog('companion', 'start failed', { error: String(error?.message ?? error).slice(0, 200) });
      this.#companion = null;
    }
  }

  /** Bound chats the scheduler may address, newest binding first. */
  #companionConversations() {
    const sessions = this.#state.snapshot?.()?.sessions ?? {};
    return Object.entries(sessions)
      .filter(([key, sessionId]) => typeof key === 'string' && key && typeof sessionId === 'string' && sessionId)
      .map(([conversationKey, sessionId]) => {
        // direct:iMessage;-;+8613800000000 → chatGuid + address
        const chatGuid = conversationKey.startsWith('direct:')
          ? conversationKey.slice('direct:'.length)
          : conversationKey;
        const address = chatGuid.split(';-;').at(-1) || null;
        return { conversationKey, sessionId, chatGuid, address };
      });
  }

  /** Apply settings saved by the settings page to the running scheduler. */
  applySettings(settings = {}) {
    if (settings.companion && this.#companion) {
      this.#companion.updateConfig(settings.companion);
      channelLog('companion', 'settings applied from settings page', {
        enabled: settings.companion.enabled === true,
      });
    }
  }

  async stop() { this.#stopped = true; clearTimeout(this.#timer); this.#timer = null; this.#companion?.stop(); this.#companion = null; this.#abortController?.abort(); await this.#polling?.catch(() => {}); this.#polling = null; this.#bridge = null; this.#client = null; this.#api = null; this.#status.ready = false; }
  #schedulePoll(delay) { if (this.#stopped) return; this.#timer = setTimeout(() => { this.#polling = this.#poll().finally(() => this.#schedulePoll(this.#pollIntervalMs)); }, delay); this.#timer.unref?.(); }
  async #poll() {
    if (!this.#api || !this.#bridge || this.#stopped) return;
    try {
      const rows = await this.#api.listMessages({ after: this.#state.cursor() ?? 0, limit: 100 });
      const messages = Array.isArray(rows) ? rows : rows?.messages ?? rows?.data ?? [];
      let accepted = 0;
      for (const raw of messages) {
        const message = normalizeIMessage(raw, { botId: this.#config.platformId });
        if (message) {
          this.#companion?.noteUserMessage?.(`direct:${message.conversationId}`);
          // The sticker note is per Session: publish it the moment this chat is
          // known to be an iMessage conversation.
          const sessionId = this.#state.sessionFor?.(`direct:${message.conversationId}`);
          if (sessionId) publishStickerGuidance(sessionId);
          await this.#bridge.accept(message);
          accepted += 1;
        }
        if (Number.isSafeInteger(raw.rowid)) await this.#state.setCursor(raw.rowid);
      }
      if (messages.length > 0) channelLog('runtime', 'poll', { fetched: messages.length, accepted, cursor: this.#state.cursor() });
      this.#status.lastCheckedAt = Date.now(); this.#status.lastError = null; this.#status.error = null; this.#diagnostics.clear();
    } catch (error) { if (!this.#stopped) { channelLog('runtime', 'poll failed', { error: String(error?.message ?? error).slice(0, 200) }); this.#status.error = this.#diagnostics.report(error, { operation: 'connection.monitor', botId: this.#config?.botId, automatic: true }).publicError;
      this.#status.lastError = this.#status.error.message;  } }
  }
}
