// Outbound artifacts arrive as in-memory bytes; stage them to a temporary file
// (keeping the original display name), send through the API, and always clean
// up — including when the provider call fails or is aborted.

import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

export async function sendOutboundArtifactBytes(api, target, file) {
  const bytes = Buffer.from(file?.bytes ?? new Uint8Array());
  if (!bytes.length) throw new TypeError('outbound file bytes are required');
  const name = basename(String(file?.fileName ?? 'file')) || 'file';
  const path = join(tmpdir(), `dsh-im-out-${process.pid}-${Date.now()}-${name}`);
  try {
    await writeFile(path, bytes);
    await api.sendFile({
      chatGuid: target.chatGuid,
      address: target.address,
      path,
    });
  } finally {
    await rm(path, { force: true }).catch(() => undefined);
  }
}
