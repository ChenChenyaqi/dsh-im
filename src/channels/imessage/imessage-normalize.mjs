// Normalizes raw chat.db message rows into bridge-ready messages: text from
// either column plus typedstream decoding, image attachment sources, and the
// self-chat/bot-echo filters.

import { cleanString, normalizeChatGuid } from './osascript-helpers.mjs';
import { decodeAttributedBodyText, OBJECT_REPLACEMENT_CHARACTER } from './imessage-decode.mjs';
import { imessageImageSources } from './imessage-attachments.mjs';
import { channelLog } from './channel-log.mjs';

// Self-chat has no separate bot sender. Keep the reply marker in Messages itself
// so echoes are still recognizable after a Host restart or iCloud resync.
export const IMESSAGE_BOT_REPLY_PREFIX = '🤖 DSH\n';

export function normalizeIMessageTarget(value) {
  return normalizeChatGuid(value);
}

export function normalizeIMessage(value, { botId } = {}) {
  if (!value || typeof value !== 'object') return null;
  if (value.serviceName !== undefined && value.serviceName !== 'iMessage') {
    channelLog('normalize', 'skip', { rowid: value.rowid, reason: 'not-imessage' });
    return null;
  }
  const guid = cleanString(value.guid ?? value.id);
  const chatGuid = cleanString(value.chatGuid ?? value.chat_guid);
  // The text column may embed U+FFFC attachment placeholders next to a caption;
  // strip them so image captions arrive as plain text.
  let text = cleanString(value.text)
    ?? decodeAttributedBodyText(value.attributedBodyHex ?? value.attributedBody);
  if (text) text = text.replaceAll(OBJECT_REPLACEMENT_CHARACTER, '').trim() || null;
  const sender = cleanString(value.sender ?? value.handle_id);
  const images = imessageImageSources(value.attachments);
  if (!guid || !chatGuid || !sender) {
    channelLog('normalize', 'skip', { rowid: value.rowid, reason: 'missing-ids' });
    return null;
  }
  // Messages.app names a one-to-one chat `iMessage;-;<handle>` and a group chat
  // `iMessage;+;chat<id>`. This bot serves a single owner, not rooms, so group
  // traffic is dropped before it can reach the bridge at all.
  if (chatGuid.includes(';+;')) {
    channelLog('normalize', 'skip', { rowid: value.rowid, reason: 'group-chat', chatGuid });
    return null;
  }
  if (!text && images.length === 0) {
    channelLog('normalize', 'skip', { rowid: value.rowid, reason: 'empty' });
    return null;
  }
  if (text?.startsWith(IMESSAGE_BOT_REPLY_PREFIX)) {
    channelLog('normalize', 'skip', { rowid: value.rowid, reason: 'bot-prefix' });
    return null;
  }
  if (value.isFromMe === 1 || value.isFromMe === true) {
    channelLog('normalize', 'skip', { rowid: value.rowid, reason: 'from-me' });
    return null;
  }
  if (botId && sender === botId) {
    channelLog('normalize', 'skip', { rowid: value.rowid, reason: 'self' });
    return null;
  }
  channelLog('normalize', 'accept', { rowid: value.rowid, sender, text: text?.slice(0, 50) ?? null, images: images.length });
  return Object.freeze({
    messageId: guid,
    providerMessageId: guid,
    conversationId: chatGuid,
    kind: 'direct',
    senderId: sender,
    senderName: sender,
    content: text ?? (images.length > 0 ? '看这个' : ''),
    images,
    addressed: true,
    replyTarget: { chatGuid, address: sender, serviceName: 'iMessage' },
    connectionTestTarget: { chatGuid, address: sender, serviceName: 'iMessage' },
    ...(value.receivedAt ? { receivedAt: value.receivedAt } : {}),
  });
}
