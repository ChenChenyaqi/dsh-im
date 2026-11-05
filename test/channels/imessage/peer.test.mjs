import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IMESSAGE_PEER_CONTEXT,
  IMESSAGE_PEER_ORDER,
  buildPeerGuidance,
  imessagePeers,
  installPeerContext,
  loadPeerName,
  publishPeerGuidance,
} from '../../../src/channels/imessage/imessage-peer.mjs';

const HANDLE = '+8619829734218';

function contactsFile(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'im-peer-'));
  const file = join(dir, 'contacts.json');
  writeFileSync(file, JSON.stringify(entries), 'utf8');
  return file;
}

test('guidance names the handle and a recorded nickname', () => {
  const text = buildPeerGuidance({ handle: HANDLE, name: '陈亚琪' });
  assert.ok(text.includes('陈亚琪'));
  assert.ok(text.includes(HANDLE));
  assert.ok(text.includes('iMessage'));
});

test('guidance without a nickname says so and invites asking', () => {
  const text = buildPeerGuidance({ handle: HANDLE });
  assert.ok(text.includes(HANDLE));
  assert.match(text, /还不知道叫什么/u);
  // She must be able to find the memory file from the note itself.
  assert.ok(text.includes('contacts.json'));
});

test('an empty handle renders no guidance at all', () => {
  assert.equal(buildPeerGuidance({ handle: '' }), '');
  assert.equal(buildPeerGuidance({}), '');
});

test('loadPeerName reads the contacts file and survives bad input', () => {
  const file = contactsFile({ [HANDLE]: '陈亚琪', '+8613800000001': 42, '': 'x' });
  assert.equal(loadPeerName(HANDLE, { file }), '陈亚琪');
  assert.equal(loadPeerName('+8613800000001', { file }), null); // non-string value
  assert.equal(loadPeerName('+8615229293783', { file }), null); // unknown handle

  const corrupt = join(tmpdir(), `im-peer-corrupt-${Date.now()}.json`);
  writeFileSync(corrupt, '{not json', 'utf8');
  assert.equal(loadPeerName(HANDLE, { file: corrupt }), null);
  assert.equal(loadPeerName(HANDLE, { file: join(tmpdir(), 'im-peer-missing.json') }), null);
  assert.equal(loadPeerName('', { file }), null);
});

test('the registry serves text per session and forgets on demand', () => {
  try {
    publishPeerGuidance('session-a', HANDLE, { file: contactsFile({ [HANDLE]: '陈亚琪' }) });
    publishPeerGuidance('session-b', HANDLE);
    assert.match(imessagePeers.get('session-a'), /陈亚琪/u);
    assert.match(imessagePeers.get('session-b'), /还不知道叫什么/u);
    // An unknown handle clears the note instead of naming nobody.
    publishPeerGuidance('session-a', '');
    assert.equal(imessagePeers.get('session-a'), undefined);
    imessagePeers.forget('session-b');
    assert.equal(imessagePeers.get('session-b'), undefined);
  } finally {
    imessagePeers.clear();
  }
});

test('installPeerContext registers one context keyed by session', () => {
  const contexts = [];
  const disposers = [];
  const ctx = {
    systemPrompt: { context: (entry) => { contexts.push(entry); return () => disposers.push(entry.name); } },
  };
  const dispose = installPeerContext(ctx);
  assert.equal(typeof dispose, 'function');
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].name, IMESSAGE_PEER_CONTEXT);
  assert.equal(contexts[0].order, IMESSAGE_PEER_ORDER);
  try {
    imessagePeers.publish('session-x', 'note');
    assert.equal(contexts[0].text({ agent: { session: { id: 'session-x' } } }), 'note');
    assert.equal(contexts[0].text({ agent: { session: { id: 'session-y' } } }), '');
  } finally {
    imessagePeers.clear();
  }
  dispose();
  assert.deepEqual(disposers, [IMESSAGE_PEER_CONTEXT]);
  assert.equal(installPeerContext({}), null);
});
