import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  sendOutboundArtifactBytes,
  sweepStaleOutboundFiles,
} from '../../../src/channels/imessage/outbound-artifacts.mjs';

function stagedDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'im-outbound-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the staged file outlives the send call', async (t) => {
  const dir = stagedDir(t);
  const sentPaths = [];
  const api = {
    async sendFile(payload) { sentPaths.push(payload.path); return { sent: true }; },
  };
  await sendOutboundArtifactBytes(api, { chatGuid: 'c', address: 'a' }, {
    fileName: '吃(爆米花).gif', bytes: Buffer.from('GIF89a...'),
  }, { directory: dir });
  assert.equal(sentPaths.length, 1);
  // The race fix itself: the file Messages reads asynchronously still exists.
  const { statSync } = await import('node:fs');
  assert.ok(statSync(sentPaths[0]).size > 0, 'staged file must remain after send');
  assert.match(sentPaths[0], /outbound/u);
});

test('a failed send still throws and still leaves the file', async (t) => {
  const dir = stagedDir(t);
  const api = { async sendFile() { throw new Error('Messages rejected it'); } };
  await assert.rejects(
    () => sendOutboundArtifactBytes(api, { chatGuid: 'c', address: 'a' }, {
      fileName: 'a.gif', bytes: Buffer.from('x'),
    }, { directory: dir }),
    /Messages rejected it/u,
  );
});

test('sweeping removes only old dsh-im-out files', async (t) => {
  const dir = stagedDir(t);
  const now = Date.now();
  const old = join(dir, 'dsh-im-out-1-1000-old.gif');
  const fresh = join(dir, `dsh-im-out-${process.pid}-${now}-fresh.gif`);
  const foreign = join(dir, 'unrelated.txt');
  writeFileSync(old, 'x');
  writeFileSync(fresh, 'x');
  writeFileSync(foreign, 'x');
  utimesSync(old, new Date(now - 2 * 60 * 60_000), new Date(now - 2 * 60 * 60_000));

  const { deleted } = await sweepStaleOutboundFiles(dir, { now });
  assert.equal(deleted, 1);
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(fresh), true, 'recent staged files survive');
  assert.equal(existsSync(foreign), true, 'foreign files are never touched');
});

test('sweeping a missing directory is a no-op', async () => {
  assert.deepEqual(
    await sweepStaleOutboundFiles(join(tmpdir(), `absent-${Date.now()}`), {}),
    { deleted: 0 },
  );
});
