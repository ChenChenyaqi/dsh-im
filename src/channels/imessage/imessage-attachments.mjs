// Image attachments received from chat.db: SQL fan-out collapsing, HEIC/HEIF
// conversion via the always-available macOS `sips` tool, and bridge-compatible
// image source construction.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

// iPhone photos arrive as HEIC/HEIF while models accept JPEG/PNG/WebP.
const HEIC_MEDIA_TYPES = new Set(['image/heic', 'image/heif']);

function expandHomePath(value) {
  return value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
}

function jpegName(name) {
  const base = String(name ?? 'image').replace(/\.(heic|heif)$/i, '');
  return `${base || 'image'}.jpg`;
}

async function readIMessageAttachment(attachment, { readFileImpl = readFile, execFileImpl = execFileAsync, signal } = {}) {
  const path = expandHomePath(String(attachment?.path ?? ''));
  const mediaType = String(attachment?.mediaType ?? '').toLowerCase();
  const raw = Buffer.from(await readFileImpl(path));
  if (!HEIC_MEDIA_TYPES.has(mediaType)) return { data: raw, mediaType: attachment.mediaType };
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const input = join(tmpdir(), `dsh-im-${stamp}.heic`);
  const output = join(tmpdir(), `dsh-im-${stamp}.jpg`);
  try {
    await writeFile(input, raw);
    await execFileImpl('/usr/bin/sips', ['-s', 'format', 'jpeg', input, '--out', output], { signal });
    return { data: Buffer.from(await readFileImpl(output)), mediaType: 'image/jpeg' };
  } finally {
    await rm(input, { force: true }).catch(() => undefined);
    await rm(output, { force: true }).catch(() => undefined);
  }
}

/** Builds bridge-compatible image sources (`name/mediaType/size/load`) from chat.db attachment rows. */
export function imessageImageSources(attachments, loaders = {}) {
  if (!Array.isArray(attachments)) return [];
  return attachments.flatMap((attachment) => {
    const mediaType = typeof attachment?.mediaType === 'string' && attachment.mediaType ? attachment.mediaType : null;
    const path = typeof attachment?.path === 'string' && attachment.path ? attachment.path : null;
    if (!mediaType || !path || !mediaType.toLowerCase().startsWith('image/')) return [];
    const isHeic = HEIC_MEDIA_TYPES.has(mediaType.toLowerCase());
    return [Object.freeze({
      name: isHeic ? jpegName(attachment.name) : (attachment.name ?? path.split('/').pop() ?? 'image'),
      mediaType: isHeic ? 'image/jpeg' : mediaType,
      ...(Number.isFinite(attachment.size) ? { size: attachment.size } : {}),
      load: (options = {}) => readIMessageAttachment(
        { path, mediaType, name: attachment.name },
        { ...loaders, ...options },
      ),
    })];
  });
}

/** Collapses the SQL join fan-out so one message row carries all of its attachments. */
export function mergeAttachmentRows(rows) {
  if (!Array.isArray(rows)) return [];
  const ordered = [];
  const byRowid = new Map();
  for (const row of rows) {
    const rowid = row?.rowid;
    const attachment = typeof row?.attachmentPath === 'string' && row.attachmentPath
      ? {
        path: row.attachmentPath,
        mediaType: row.attachmentMime ?? null,
        name: row.attachmentName ?? null,
        ...(Number.isFinite(Number(row.attachmentBytes)) ? { size: Number(row.attachmentBytes) } : {}),
      } : null;
    const existing = byRowid.get(rowid);
    if (existing) {
      if (attachment) existing.attachments.push(attachment);
      continue;
    }
    const entry = { ...row, attachments: attachment ? [attachment] : [] };
    delete entry.attachmentPath;
    delete entry.attachmentMime;
    delete entry.attachmentName;
    delete entry.attachmentBytes;
    byRowid.set(rowid, entry);
    ordered.push(entry);
  }
  return ordered;
}
