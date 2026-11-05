// Normalizes raw chat.db message rows into bridge-ready messages: text from
// either column plus typedstream decoding, image attachment sources, and the
// self-chat/bot-echo filters.

import { cleanString, normalizeChatGuid } from './osascript-helpers.mjs';
import { decodeAttributedBodyText, OBJECT_REPLACEMENT_CHARACTER } from './imessage-decode.mjs';
import { imessageImageSources } from './imessage-attachments.mjs';

// Self-chat has no separate bot sender. Keep the reply marker in Messages itself
// so echoes are still recognizable after a Host restart or iCloud resync.
export const IMESSAGE_BOT_REPLY_PREFIX = '🤖 DSH\n';

export function normalizeIMessageTarget(value) {
  return normalizeChatGuid(value);
}

export function normalizeIMessage(value, { botId } = {}) {
  if (!value || typeof value !== 'object') return null;
  if (value.serviceName !== undefined && value.serviceName !== 'iMessage') return null;
  const guid = cleanString(value.guid ?? value.id);
  const chatGuid = cleanString(value.chatGuid ?? value.chat_guid);
  // The text column may embed U+FFFC attachment placeholders next to a caption;
  // strip them so image captions arrive as plain text.
  let text = cleanString(value.text)
    ?? decodeAttributedBodyText(value.attributedBodyHex ?? value.attributedBody);
  if (text) text = text.replaceAll(OBJECT_REPLACEMENT_CHARACTER, '').trim() || null;
  const sender = cleanString(value.sender ?? value.handle_id);
  const images = imessageImageSources(value.attachments);
  if (!guid || !chatGuid || !sender) return null;
  if (!text && images.length === 0) return null;
  if (text?.startsWith(IMESSAGE_BOT_REPLY_PREFIX)) return null;
  if (value.isFromMe === 1 || value.isFromMe === true) return null;
  if (botId && sender === botId) return null;
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
