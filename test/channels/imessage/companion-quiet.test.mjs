import test from 'node:test';
import assert from 'node:assert/strict';

import { IMessageRuntime } from '../../../src/channels/imessage/runtime.mjs';

const KEY = 'direct:iMessage;-;+8619829734218';

/**
 * A runtime whose api returns exactly one inbound message, so a poll cycle can
 * be observed end to end: what the companion recorded about the conversation.
 */
function makeRuntime(t, { text, attachments } = {}) {
  const sent = [];
  const extension = {};
  const raw = {
    guid: `guid-${Math.random().toString(36).slice(2)}`,
    chatGuid: 'iMessage;-;+8619829734218',
    sender: '+8619829734218',
    rowid: 2000 + Math.floor(Math.random() * 100),
    serviceName: 'iMessage',
    isFromMe: 0,
    text,
    ...(attachments === undefined ? {} : { attachments }),
  };
  const runtime = new IMessageRuntime({
    config: { botId: 'imessage_test', platformId: 'me@example.com' },
    token: 'token',
    harness: {
      ensureRunning: async () => true,
      sessionExists: async () => true,
      ask: async () => ({ message: '嗯嗯' }),
    },
    state: {
      cursor: () => 1999,
      setCursor: async () => {},
      sessionFor: () => 'session-bound',
      hasSeen: () => false,
      markSeen: async () => {},
      setSession: async () => {},
      snapshot: () => ({ sessions: { [KEY]: 'session-bound' } }),
      extensionState: () => extension,
      persist: () => {},
    },
    logger: { warn() {}, error() {}, info() {} },
    pollIntervalMs: 10,
    createApi: () => ({
      async getPermissions() { return { platform: 'darwin', database: 'granted', automation: 'granted' }; },
      async listMessages() { return [raw]; },
      async getLatestMessageRowId() { return raw.rowid; },
      async sendText(payload) { sent.push(payload.text); return { sent: true }; },
    }),
    createClient: () => ({ sendText: async (target, text) => { sent.push(text); } }),
  });
  t.after(() => runtime.stop());
  return { runtime, extension, sent };
}

async function settle() { await new Promise((resolve) => setTimeout(resolve, 80)); }

function companionEntry(extension) {
  return extension.imessageCompanion?.conversations?.[KEY] ?? null;
}

test('a slash command does not restart the quiet clock', async (t) => {
  // /companion was the exact trap today: a status check pushed her next
  // reach-out past a whole freshly drawn quiet window.
  const { runtime, extension } = makeRuntime(t, { text: '/companion' });
  await runtime.start();
  await settle();
  assert.equal(companionEntry(extension)?.lastUserAt ?? null, null);
});

test('/help and /status are equally exempt', async (t) => {
  for (const command of ['/help', '/status']) {
    const { runtime, extension } = makeRuntime(t, { text: command });
    await runtime.start();
    await settle();
    await runtime.stop();
    assert.equal(companionEntry(extension)?.lastUserAt ?? null, null, command);
  }
});

test('an ordinary message still restarts it', async (t) => {
  const { runtime, extension } = makeRuntime(t, { text: '在干嘛' });
  await runtime.start();
  await settle();
  assert.equal(typeof companionEntry(extension)?.lastUserAt, 'number');
});

test('a photo with a command-looking caption counts as conversation', async (t) => {
  const { runtime, extension } = makeRuntime(t, {
    text: '/help',
    attachments: [{ path: '/tmp/a.jpg', mediaType: 'image/jpeg' }],
  });
  await runtime.start();
  await settle();
  assert.equal(typeof companionEntry(extension)?.lastUserAt, 'number');
});
