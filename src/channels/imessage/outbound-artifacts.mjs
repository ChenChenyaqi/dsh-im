// Outbound artifacts arrive as in-memory bytes; stage them to a file (keeping
// the original display name) and send through the API.
//
// The staged file deliberately OUTLIVES the send call: AppleScript's send
// returns as soon as the message is composed, while Messages ingests, copies
// and uploads the attachment asynchronously. Deleting the file right after the
// call raced that ingestion — a 3.2MB GIF lost the race twice and stayed
// undelivered with transfer_state=0, no error, nothing on the phone. So files
// land in a stable directory under the bot workspace and old ones are swept at
// the next send, an hour later at the earliest.

import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { channelLog } from './channel-log.mjs';

const OUTBOUND_DIRECTORY = join(homedir(), '.dsh', 'im', '.dsh-im', 'outbound');
const OUTBOUND_PREFIX = 'dsh-im-out-';
const OUTBOUND_RETENTION_MS = 60 * 60_000;

/** Delete staged files old enough that Messages can no longer need them. */
export async function sweepStaleOutboundFiles(
  directory = OUTBOUND_DIRECTORY,
  { now = Date.now(), retentionMs = OUTBOUND_RETENTION_MS } = {},
) {
  let names;
  try {
    names = await readdir(directory);
  } catch {
    return { deleted: 0 }; // absent directory is the common case
  }
  let deleted = 0;
  for (const name of names) {
    if (!name.startsWith(OUTBOUND_PREFIX)) continue;
    const path = join(directory, name);
    try {
      const { mtimeMs } = await stat(path);
      if (now - mtimeMs < retentionMs) continue;
      await rm(path, { force: true });
      deleted += 1;
    } catch (error) {
      channelLog('outbound', 'sweep skipped', { name, error: String(error?.message ?? error).slice(0, 120) });
    }
  }
  if (deleted > 0) channelLog('outbound', 'swept', { deleted });
  return { deleted };
}

export async function sendOutboundArtifactBytes(api, target, file, { directory = OUTBOUND_DIRECTORY } = {}) {
  const bytes = Buffer.from(file?.bytes ?? new Uint8Array());
  if (!bytes.length) throw new TypeError('outbound file bytes are required');
  const name = basename(String(file?.fileName ?? 'file')) || 'file';
  const path = join(directory, `dsh-im-out-${process.pid}-${Date.now()}-${name}`);
  channelLog('outbound', 'stage', { name, bytes: bytes.length, to: target?.address ?? target?.chatGuid });
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Sweeping here keeps the directory bounded without a timer; failures are
    // cosmetic and never block the send.
    await sweepStaleOutboundFiles(directory).catch(() => undefined);
    await writeFile(path, bytes, { mode: 0o600 });
    await api.sendFile({
      chatGuid: target.chatGuid,
      address: target.address,
      path,
    });
    channelLog('outbound', 'sent', { name, bytes: bytes.length });
  } catch (error) {
    channelLog('outbound', 'send failed', { name, error: String(error?.message ?? error).slice(0, 200) });
    throw error;
  }
  // No cleanup on purpose: the file stays put until a later sweep. See the
  // header comment for why deleting here broke delivery of large GIFs.
}
