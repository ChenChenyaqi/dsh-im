import { createConnectionDiagnostics, atConnectionStage } from '../shared/connection-error.mjs';
import { sendRememberedConnectionTest } from '../shared/connection-test.mjs';
import { MacOSMessagesApi, normalizeIMessage } from './imessage-api.mjs';
import { createIMessageBridgeStatus, IMessageHarnessBridge } from './imessage-bridge.mjs';
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const DEFAULT_POLL_INTERVAL_MS = 2_000;

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

/**
 * Simulates human typing rhythm: longer replies wait longer, fenced code
 * blocks are treated as pastes with a short flat delay, and every value is
 * jittered and clamped so the pace never looks mechanical.
 */
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

function waitLineInterval(signal, ms) {
  return new Promise((resolve, reject) => {
    if (ms <= 0) { resolve(); return; }
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('iMessage line send aborted')); };
    if (signal?.aborted) { abort(); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export function splitIMessageReplyParts(text) {
  const raw = String(text ?? '');
  const parts = [];
  let block = null;
  for (const line of raw.split('\n')) {
    if (block) {
      block.push(line);
      if (block.length > 1 && line.trim().startsWith('```')) {
        parts.push(block.join('\n'));
        block = null;
      }
      continue;
    }
    if (line.trim().startsWith('```')) {
      block = [line];
      continue;
    }
    const plain = line.trim();
    if (plain) parts.push(plain);
  }
  if (block) parts.push(block.join('\n'));
  return parts.length > 0 ? parts : [raw.trim()];
}

class IMessageBotClient {
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
    for (let index = 0; index < parts.length; index += 1) {
      if (!this.#zeroDelay) {
        const delay = computeHumanTypingDelayMs(parts[index], {
          isFirst: index === 0,
          random: this.#typing.random,
        });
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
  // Outbound artifacts arrive as in-memory bytes; stage them to a temporary
  // file (keeping the original display name) and hand the path to Messages.
  async #sendArtifactBytes(target, file) {
    const bytes = Buffer.from(file?.bytes ?? new Uint8Array());
    if (!bytes.length) throw new TypeError('outbound file bytes are required');
    const name = basename(String(file?.fileName ?? 'file')) || 'file';
    const path = join(tmpdir(), `dsh-im-out-${process.pid}-${Date.now()}-${name}`);
    try {
      await writeFile(path, bytes);
      await this.#api.sendFile({
        chatGuid: target.chatGuid,
        address: target.address,
        path,
      });
    } finally {
      await rm(path, { force: true }).catch(() => undefined);
    }
  }
  sendFile(target, file) {
    return this.#sendArtifactBytes(target, file);
  }
  sendImage(target, file) {
    return this.#sendArtifactBytes(target, file);
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
  #replyTimeoutMs; #pollIntervalMs; #createApi; #status = createIMessageRuntimeStatus();
  #api; #bridge; #abortController; #timer; #polling; #stopped = true;
  constructor({ config, token, harness, state, contextEnhancement, accessPolicy, logger = console,
    replyTimeoutMs = 600_000, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    createApi = (options) => new MacOSMessagesApi(options) }) {
    if (!config || !token || !harness || !state) throw new TypeError('IMessageRuntime requires config, token, Harness, and state');
    this.#config = config; this.#token = token; this.#harness = harness; this.#state = state;
    this.#contextEnhancement = contextEnhancement; this.#accessPolicy = accessPolicy; this.#logger = logger; this.#diagnostics = createConnectionDiagnostics({ channel: 'imessage', logger });
    this.#replyTimeoutMs = replyTimeoutMs; this.#pollIntervalMs = pollIntervalMs; this.#createApi = createApi;
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
      if (permissions.database !== 'granted' || permissions.automation !== 'granted') {
        const error = new Error('macOS Messages permissions are required');
        error.code = 'messages-permission-required';
        error.permissions = permissions;
        throw error;
      }
      if (this.#state.cursor() === null && typeof this.#api.getLatestMessageRowId === 'function') {
        await this.#state.setCursor(await this.#api.getLatestMessageRowId());
      }
      const client = new IMessageBotClient(this.#api, this.#abortController.signal);
      this.#bridge = new IMessageHarnessBridge({ bot: client, harness: this.#harness, state: this.#state,
        contextEnhancement: this.#contextEnhancement, accessPolicy: this.#accessPolicy, status: this.#status,
        logger: this.#logger, replyTimeoutMs: this.#replyTimeoutMs, signal: this.#abortController.signal });
      this.#status.ready = true; this.#status.connectionState = 'connected'; this.#status.lastConnectedAt = Date.now();
      this.#schedulePoll(0); return this.status;
    } catch (error) { this.#status.ready = false; this.#status.connectionState = 'failed'; this.#status.error = this.#diagnostics.report(error, { operation: 'connection.restore', reuse: true, botId: this.#config?.botId, automatic: true }).publicError;
      this.#status.lastError = this.#status.error.message; await this.stop(); throw error; }
  }
  async stop() { this.#stopped = true; clearTimeout(this.#timer); this.#timer = null; this.#abortController?.abort(); await this.#polling?.catch(() => {}); this.#polling = null; this.#bridge = null; this.#api = null; this.#status.ready = false; }
  #schedulePoll(delay) { if (this.#stopped) return; this.#timer = setTimeout(() => { this.#polling = this.#poll().finally(() => this.#schedulePoll(this.#pollIntervalMs)); }, delay); this.#timer.unref?.(); }
  async #poll() {
    if (!this.#api || !this.#bridge || this.#stopped) return;
    try {
      const rows = await this.#api.listMessages({ after: this.#state.cursor() ?? 0, limit: 100 });
      const messages = Array.isArray(rows) ? rows : rows?.messages ?? rows?.data ?? [];
      for (const raw of messages) {
        const message = normalizeIMessage(raw, { botId: this.#config.platformId });
        if (message) await this.#bridge.accept(message);
        if (Number.isSafeInteger(raw.rowid)) await this.#state.setCursor(raw.rowid);
      }
      this.#status.lastCheckedAt = Date.now(); this.#status.lastError = null; this.#status.error = null; this.#diagnostics.clear();
    } catch (error) { if (!this.#stopped) { this.#status.error = this.#diagnostics.report(error, { operation: 'connection.monitor', botId: this.#config?.botId, automatic: true }).publicError;
      this.#status.lastError = this.#status.error.message;  } }
  }
}
