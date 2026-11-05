// Peer identity guidance for iMessage conversations.
//
// She is told who she is talking to: the sender's handle, plus an optional
// nickname kept in ~/.dsh/im/contacts.json. The note is published per Session
// and materialized as dynamic prompt context, the same shape the sticker note
// uses, so a conversation that is not bound to iMessage never sees it — and
// neither does a Session whose chat partner the bot has never heard from.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Prompt-context name the Host materializes this guidance under. */
export const IMESSAGE_PEER_CONTEXT = 'dsh-im:imessage-peer';

/** Joined in ascending order; identity precedes the source/sticker notes. */
export const IMESSAGE_PEER_ORDER = 124;

const DEFAULT_CONTACTS_FILE = join(homedir(), '.dsh', 'im', 'contacts.json');
const MAX_SESSIONS = 1_024;
const MAX_NAME_LENGTH = 64;

class PeerRegistry {
  #bySession = new Map();

  publish(sessionId, text) {
    if (typeof sessionId !== 'string' || !sessionId) return;
    this.#bySession.delete(sessionId);
    if (typeof text !== 'string' || !text.trim()) return;
    this.#bySession.set(sessionId, text);
    while (this.#bySession.size > MAX_SESSIONS) {
      this.#bySession.delete(this.#bySession.keys().next().value);
    }
  }

  get(sessionId) {
    return typeof sessionId === 'string' ? this.#bySession.get(sessionId) : undefined;
  }

  forget(sessionId) {
    if (typeof sessionId === 'string') this.#bySession.delete(sessionId);
  }

  clear() { this.#bySession.clear(); }
}

export const imessagePeers = new PeerRegistry();

/**
 * The display name a handle maps to, or null. A missing, corrupt or oddly
 * shaped contacts file degrades to the bare handle instead of failing the bot:
 * the operator or the bot herself may edit the file at any time.
 */
export function loadPeerName(handle, { file = DEFAULT_CONTACTS_FILE } = {}) {
  if (typeof handle !== 'string' || !handle.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const name = parsed[handle];
  if (typeof name !== 'string' || !name.trim()) return null;
  return name.trim().slice(0, MAX_NAME_LENGTH);
}

/**
 * The note she reads. Always names the handle; adds the recorded nickname when
 * one exists, and points her at the file so she can remember a name she learns
 * mid-conversation instead of asking again every Session.
 */
export function buildPeerGuidance({ handle, name = null } = {}) {
  if (typeof handle !== 'string' || !handle.trim()) return '';
  const who = typeof name === 'string' && name.trim()
    ? `${name.trim()}（${handle}）`
    : `${handle}（还不知道叫什么，可以问）`;
  return [
    `[对话来源]  你正在通过 iMessage 私聊跟一个人说话，对方是 ${who}。`,
    `记名字：把「"${handle}": "名字"」写进 ${DEFAULT_CONTACTS_FILE}，下次对话你就想得起来。`,
    '认不出是谁就直说，别瞎猜。',
  ].join('\n');
}

/** Publish the guidance for one Session; an unknown handle clears it. */
export function publishPeerGuidance(sessionId, handle, options) {
  imessagePeers.publish(sessionId, buildPeerGuidance({
    handle,
    name: loadPeerName(handle, options),
  }));
}

/**
 * Register the prompt context that carries the peer note. Returns the Cordis
 * disposer, or null when the context cannot listen.
 */
export function installPeerContext(ctx, { registry = imessagePeers } = {}) {
  if (typeof ctx?.systemPrompt?.context !== 'function') return null;
  return ctx.systemPrompt.context({
    name: IMESSAGE_PEER_CONTEXT,
    order: IMESSAGE_PEER_ORDER,
    text: (assembly) => registry.get(assembly?.agent?.session?.id) ?? '',
  });
}
