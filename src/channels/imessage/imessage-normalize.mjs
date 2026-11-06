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

/**
 * The reply reference for a threaded quote (Messages' reply-to-specific-
 * message). `thread_originator_guid` points at the quoted row; the API query
 * joins its text and author so normalization stays synchronous. Tapbacks live
 * in the `associated_message_*` columns instead and stay out of the bot by
 * design.
 */
function quotedReplyTo(value) {
  const originator = cleanString(value.threadOriginatorGuid);
  if (!originator) return null;
  // The quoted row can be pruned or older than the copy on this Mac.
  if (value.quotedRowId === null || value.quotedRowId === undefined) {
    return { messageId: originator, unavailableReason: 'not-found' };
  }
  const quotedText = cleanString(value.quotedText)
    ?? decodeAttributedBodyText(value.quotedAttributedBodyHex ?? value.quotedAttributedBody);
  const author = value.quotedFromMe === 1 || value.quotedFromMe === '1'
    // Her own earlier line: persona-neutral so the plugin never assumes a name.
    ? '机器人'
    : cleanString(value.quotedSender);
  return {
    messageId: originator,
    ...(author ? { authorName: author } : {}),
    // An image-only quote still tells her what kind of thing was pointed at.
    content: quotedText ?? '（图片或贴纸消息）',
  };
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
  const replyTo = quotedReplyTo(value);
  channelLog('normalize', 'accept', { rowid: value.rowid, sender, text: text?.slice(0, 50) ?? null, images: images.length,
    ...(replyTo ? { quoted: true } : {}) });
  return Object.freeze({
    messageId: guid,
    providerMessageId: guid,
    conversationId: chatGuid,
    kind: 'direct',
    senderId: sender,
    senderName: sender,
    content: text ?? (images.length > 0 ? '看这个' : ''),
    images,
    ...(replyTo ? { replyTo } : {}),
    addressed: true,
    replyTarget: { chatGuid, address: sender, serviceName: 'iMessage' },
    connectionTestTarget: { chatGuid, address: sender, serviceName: 'iMessage' },
    ...(value.receivedAt ? { receivedAt: value.receivedAt } : {}),
  });
}
