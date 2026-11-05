import test from 'node:test';
import assert from 'node:assert/strict';

import {
  accessPolicyProvider,
  initialAccessPolicyFor,
} from '../../../plugin-src/host/channels/shared/access-policy-production.mjs';
import { evaluateAccessPolicy } from '../../../src/channels/shared/access-policy.mjs';
import { normalizeIMessage } from '../../../src/channels/imessage/imessage-normalize.mjs';

const OWNER = '+8619829734218';
const STRANGER = '+8613800000001';

test('a new iMessage bot starts locked, not open', () => {
  const policy = initialAccessPolicyFor('imessage');
  assert.equal(policy.direct.mode, 'allowlist');
  assert.deepEqual(policy.direct.allowlist.users, []);
  // Group chat is not supported at all, so its scope is locked too.
  assert.equal(policy.group.mode, 'allowlist');
  assert.deepEqual(policy.group.allowlist.users, []);

  // With no owner exemption, an empty allowlist rejects everyone — including
  // the operator, which is why the settings page says so explicitly.
  for (const sender of [OWNER, STRANGER]) {
    assert.equal(evaluateAccessPolicy(policy, {
      conversationType: 'direct', senderIds: [sender],
    }).allowed, false);
  }
});

test('other channels keep their previous defaults', () => {
  // Only iMessage was tightened; a regression here would lock out users of the
  // channels that rely on open access.
  const dingtalk = initialAccessPolicyFor('dingtalk');
  assert.equal(dingtalk.direct.mode, 'open');
  assert.equal(dingtalk.direct.open.defaultCanExecuteCommands, true);
});

test('iMessage has no privileged sender', () => {
  const stored = initialAccessPolicyFor('imessage');
  const provider = accessPolicyProvider({
    accessPolicyFor: () => stored,
  }, 'bot-1', { channel: 'imessage', config: {} });
  assert.equal(provider.isPrivileged([OWNER], 'direct'), false);
});

test('only the allowlisted sender gets in, and commands follow the entry', () => {
  const policy = {
    direct: {
      mode: 'allowlist',
      open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] },
      allowlist: { users: [{ id: OWNER, canExecuteCommands: true }] },
    },
    group: {
      mode: 'allowlist',
      open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] },
      allowlist: { users: [] },
    },
  };
  assert.equal(evaluateAccessPolicy(policy, {
    conversationType: 'direct', senderIds: [OWNER], isCommand: true,
  }).allowed, true);
  assert.equal(evaluateAccessPolicy(policy, {
    conversationType: 'direct', senderIds: [STRANGER], isCommand: false,
  }).allowed, false);
  assert.equal(evaluateAccessPolicy(policy, {
    conversationType: 'direct', senderIds: [STRANGER], isCommand: true,
  }).allowed, false);
});

test('a group message is dropped before it reaches the bridge', () => {
  const row = {
    guid: 'group-guid', chatGuid: 'iMessage;+;chat1234567890',
    sender: STRANGER, text: '大家好', serviceName: 'iMessage', isFromMe: 0,
  };
  assert.equal(normalizeIMessage(row, { botId: 'bot-1' }), null);
});

test('a one-to-one message still normalizes', () => {
  const message = normalizeIMessage({
    guid: 'direct-guid', chatGuid: 'iMessage;-;+8619829734218',
    sender: OWNER, text: '在吗', serviceName: 'iMessage', isFromMe: 0,
  }, { botId: 'bot-1' });
  assert.equal(message?.senderId, OWNER);
  assert.equal(message?.content, '在吗');
});
