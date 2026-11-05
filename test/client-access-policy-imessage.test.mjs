import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCESS_CHANNEL_DEFINITIONS,
  accessPolicyForSave,
} from '../plugin-src/client/access-policy-settings.js';

const openPolicy = () => ({
  direct: {
    mode: 'open',
    open: { defaultCanExecuteCommands: true, commandPermissionOverrides: [] },
    allowlist: { users: [] },
  },
  group: {
    mode: 'open',
    open: { defaultCanExecuteCommands: true, commandPermissionOverrides: [] },
    allowlist: { users: [] },
  },
});

test('iMessage asks for a sender number, not a chat GUID', () => {
  const definition = ACCESS_CHANNEL_DEFINITIONS.imessage;
  assert.equal(definition.groupSupported, false);
  assert.match(definition.directUserLabel, /号码|Apple ID/u);
  assert.doesNotMatch(definition.directUserLabel, /Chat GUID/u);
  assert.doesNotMatch(definition.directPlaceholder, /chat123/u);
});

test('saving an iMessage policy locks the group scope even when the draft is open', () => {
  // The group editor is disabled for iMessage, so it still holds whatever was
  // stored — an open scope must not survive the save.
  const saved = accessPolicyForSave('imessage', openPolicy());
  assert.equal(saved.group.mode, 'allowlist');
  assert.deepEqual(saved.group.allowlist.users, []);
  assert.equal(saved.group.open.defaultCanExecuteCommands, false);
});

test('the private-chat choice is preserved as the operator left it', () => {
  const draft = openPolicy();
  draft.direct.mode = 'allowlist';
  draft.direct.allowlist.users = [{ id: '+8613800000000', canExecuteCommands: true }];
  const saved = accessPolicyForSave('imessage', draft);
  assert.equal(saved.direct.mode, 'allowlist');
  assert.deepEqual(saved.direct.allowlist.users, [{ id: '+8613800000000', canExecuteCommands: true }]);
});

test('a channel that supports groups keeps its group scope', () => {
  const saved = accessPolicyForSave('telegram', openPolicy());
  assert.equal(saved.group.mode, 'open');
  assert.equal(saved.group.open.defaultCanExecuteCommands, true);
});

test('an invalid draft still fails instead of being written', () => {
  const draft = openPolicy();
  draft.direct.mode = 'nonsense';
  assert.throws(() => accessPolicyForSave('imessage', draft));
});
