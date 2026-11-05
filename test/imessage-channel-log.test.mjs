import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createChannelLogger } from '../src/channels/imessage/channel-log.mjs';

async function tempLog(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-im-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'channel.log');
}

const fixedNow = () => new Date('2026-11-05T12:00:00.000Z');

test('writes one timestamped line per call with scope and JSON details', async (t) => {
  const path = await tempLog(t);
  const log = createChannelLogger({ path, enabled: true, now: fixedNow });
  log('api', 'sendText ok', { to: '+8613800000000', chars: 5 });
  const text = await readFile(path, 'utf8');
  assert.equal(text, '2026-11-05T12:00:00.000Z [imessage:api] sendText ok {"to":"+8613800000000","chars":5}\n');
});

test('omits details entirely when none were passed', async (t) => {
  const path = await tempLog(t);
  const log = createChannelLogger({ path, enabled: true, now: fixedNow });
  log('runtime', 'installed');
  assert.equal(await readFile(path, 'utf8'), '2026-11-05T12:00:00.000Z [imessage:runtime] installed\n');
});

test('appends multiple lines in call order across scopes', async (t) => {
  const path = await tempLog(t);
  const log = createChannelLogger({ path, enabled: true, now: fixedNow });
  log('normalize', 'accept', { rowid: 1 });
  log('client', 'part', { index: 1 });
  const lines = (await readFile(path, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\[imessage:normalize\] accept \{"rowid":1\}$/);
  assert.match(lines[1], /\[imessage:client\] part \{"index":1\}$/);
});

test('truncates oversized details so one line stays one line', async (t) => {
  const path = await tempLog(t);
  const log = createChannelLogger({ path, enabled: true, now: fixedNow, maxLine: 40 });
  log('api', 'fail', { error: 'x'.repeat(500) });
  const text = await readFile(path, 'utf8');
  assert.equal(text.split('\n').filter(Boolean).length, 1);
  assert.ok(text.endsWith('…\n'));
  assert.ok(text.length < 120);
});

test('unserializable details degrade to a bare line instead of throwing', async (t) => {
  const path = await tempLog(t);
  const log = createChannelLogger({ path, enabled: true, now: fixedNow });
  const circular = {};
  circular.self = circular;
  assert.doesNotThrow(() => log('api', 'weird', circular));
  const lines = (await readFile(path, 'utf8')).trim().split('\n');
  assert.deepEqual(lines, ['2026-11-05T12:00:00.000Z [imessage:api] weird']);
});

test('an unwritable path stays silent', async () => {
  const log = createChannelLogger({ path: '/definitely/missing/dir/x.log', enabled: true, now: fixedNow });
  assert.doesNotThrow(() => log('api', 'anything', { a: 1 }));
});

test('disabled logger writes nothing at all', async (t) => {
  const path = await tempLog(t);
  const log = createChannelLogger({ path, enabled: false, now: fixedNow });
  log('api', 'ignored', { a: 1 });
  await assert.rejects(() => stat(path), /ENOENT/);
});

test('rotates to .old once the file exceeds the size limit', async (t) => {
  const path = await tempLog(t);
  await writeFile(path, 'x'.repeat(64));
  const log = createChannelLogger({ path, enabled: true, now: fixedNow, maxBytes: 32 });
  log('api', 'after rotate');
  const rotated = await readFile(`${path}.old`, 'utf8');
  assert.equal(rotated, 'x'.repeat(64));
  // The fresh file starts empty: rotation happens before the first append.
  assert.equal(await readFile(path, 'utf8'), '2026-11-05T12:00:00.000Z [imessage:api] after rotate\n');
});

test('checks the size only once per logger instance', async (t) => {
  const path = await tempLog(t);
  const log = createChannelLogger({ path, enabled: true, now: fixedNow, maxBytes: 16 });
  log('api', 'first');
  log('api', 'second');
  // A second rotation would require a fresh instance; within one instance the
  // size check already ran, so the file keeps growing.
  const lines = (await readFile(path, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
});

test('the shared default logger is disabled under the test runner', async () => {
  const { channelLog } = await import('../src/channels/imessage/channel-log.mjs');
  assert.doesNotThrow(() => channelLog('api', 'never written'));
});
