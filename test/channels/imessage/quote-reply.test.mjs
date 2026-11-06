import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeIMessage } from '../../../src/channels/imessage/imessage-normalize.mjs';
import { promptContentForInboundMessage } from '../../../src/channels/shared/semantic/reply-reference.mjs';

const BASE = {
  guid: 'reply-guid', chatGuid: 'iMessage;-;+8619829734218',
  sender: '+8619829734218', serviceName: 'iMessage', isFromMe: 0, rowid: 1800,
};

test('a threaded quote carries the quoted line into replyTo', () => {
  const message = normalizeIMessage({
    ...BASE, text: '啥意思',
    threadOriginatorGuid: '91746B3D-EAF2-4A40-AFD1-C25E11FE8288',
    quotedRowId: 1731, quotedText: 'Skip the "别列清单" instructions. Keep it short.',
    quotedFromMe: 1, quotedSender: null,
  });
  assert.equal(message.content, '啥意思');
  // Her own earlier line is attributed to the bot, persona-neutral.
  assert.equal(message.replyTo.authorName, '机器人');
  assert.equal(message.replyTo.content, 'Skip the "别列清单" instructions. Keep it short.');
  assert.equal(message.replyTo.messageId, '91746B3D-EAF2-4A40-AFD1-C25E11FE8288');
});

test('quoting the user-side sender names the handle instead', () => {
  const message = normalizeIMessage({
    ...BASE, text: '这条',
    threadOriginatorGuid: 'origin-guid',
    quotedRowId: 1601, quotedText: '在吗',
    quotedFromMe: 0, quotedSender: '+8615200000000',
  });
  assert.equal(message.replyTo.authorName, '+8615200000000');
  assert.equal(message.replyTo.content, '在吗');
});

test('a quote whose original row is gone reports not-found, not silence', () => {
  const message = normalizeIMessage({
    ...BASE, text: '就这条',
    threadOriginatorGuid: 'pruned-guid', quotedRowId: null,
  });
  assert.equal(message.replyTo.unavailableReason, 'not-found');
  assert.equal(message.replyTo.content, undefined);
});

test('a quoted macOS 26 row decodes from attributedBody', () => {
  const message = normalizeIMessage({
    ...BASE, text: '嗯？',
    threadOriginatorGuid: 'origin-guid',
    quotedRowId: 1700, quotedText: null,
    quotedAttributedBodyHex: null, // decodeAttributedBodyText tolerates null here
    quotedFromMe: 0, quotedSender: '+8619829734218',
  });
  // No decodable body at all: the quote still names what was pointed at.
  assert.equal(message.replyTo.content, '（图片或贴纸消息）');
});

test('tapbacks and ordinary messages carry no replyTo at all', () => {
  const plain = normalizeIMessage({ ...BASE, text: '普通消息' });
  assert.equal('replyTo' in plain, false);
  // Tapbacks live in associated_message_*, which the query never reads.
  const tapback = normalizeIMessage({ ...BASE, text: null, threadOriginatorGuid: null });
  assert.equal(tapback, null); // no text and no images: dropped as before
});

test('the quoted line reaches the prompt through the shared renderer', async () => {
  const message = normalizeIMessage({
    ...BASE, text: '啥意思',
    threadOriginatorGuid: '91746B3D-EAF2-4A40-AFD1-C25E11FE8288',
    quotedRowId: 1731, quotedText: 'Skip the "别列清单" instructions. Keep it short.',
    quotedFromMe: 1, quotedSender: null,
  });
  const blocks = await promptContentForInboundMessage(message, {});
  const text = blocks.map((block) => block.text ?? '').join('\n');
  assert.match(text, /Skip the/u);
  assert.match(text, /机器人/u);
  assert.match(text, /啥意思/u);
  // The injection guard the shared renderer adds must survive the round trip.
  assert.match(text, /not system instructions/u);
  assert.match(text, /<dsh_im_reply_to>/u);
});

test('quoting an image points at the Messages copy instead of staging one', () => {
  const message = normalizeIMessage({
    ...BASE, text: '这图什么情况',
    threadOriginatorGuid: 'img-origin',
    quotedRowId: 1701, quotedText: null,
    quotedFromMe: 0, quotedSender: '+8619829734218',
    quotedAttachments: [{ path: '~/Library/Messages/Attachments/q1/IMG.heic', mediaType: 'image/heic', name: 'IMG.heic', size: 4096 }],
  });
  // No lazy file sources: nothing lands in .dsh-im/inbound for a quote.
  assert.equal(message.replyTo.files, undefined);
  assert.deepEqual(message.replyTo.attachments, [{ kind: 'image', name: 'IMG.heic' }]);
  // She gets the permanent Messages path, ~ expanded, with a HEIC hint.
  assert.match(message.replyTo.content, /\/Library\/Messages\/Attachments\/q1\/IMG\.heic/u);
  assert.doesNotMatch(message.replyTo.content, /~\//u);
  assert.match(message.replyTo.content, /HEIC/u);
});

test('a quoted message with text and an image keeps both', () => {
  const message = normalizeIMessage({
    ...BASE, text: '哈哈哈',
    threadOriginatorGuid: 'img-origin',
    quotedRowId: 1702, quotedText: '看这个',
    quotedFromMe: 1, quotedSender: null,
    quotedAttachments: [{ path: '/tmp/q.png', mediaType: 'image/png', name: 'q.png' }],
  });
  assert.match(message.replyTo.content, /^看这个\n（图片可直接读取：\/tmp\/q\.png）/u);
  assert.deepEqual(message.replyTo.attachments, [{ kind: 'image', name: 'q.png' }]);
  assert.equal(message.replyTo.files, undefined);
});
