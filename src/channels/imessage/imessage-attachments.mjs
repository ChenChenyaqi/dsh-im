// Image attachments received from chat.db: SQL fan-out collapsing, HEIC/HEIF
// conversion via the always-available macOS `sips` tool, and bridge-compatible
// image source construction.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { channelLog } from './channel-log.mjs';

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
  channelLog('attachments', 'read', { path: path.slice(0, 100), bytes: raw.length, mediaType: attachment.mediaType });
  if (!HEIC_MEDIA_TYPES.has(mediaType)) return { data: raw, mediaType: attachment.mediaType };
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const input = join(tmpdir(), `dsh-im-${stamp}.heic`);
  const output = join(tmpdir(), `dsh-im-${stamp}.jpg`);
  try {
    await writeFile(input, raw);
    const convertStartedAt = Date.now();
    await execFileImpl('/usr/bin/sips', ['-s', 'format', 'jpeg', input, '--out', output], { signal });
    const jpeg = Buffer.from(await readFileImpl(output));
    channelLog('attachments', 'heic->jpeg', { bytes: raw.length, outBytes: jpeg.length, elapsedMs: Date.now() - convertStartedAt });
    return { data: jpeg, mediaType: 'image/jpeg' };
  } catch (error) {
    channelLog('attachments', 'heic->jpeg failed', { path: path.slice(0, 100), error: String(error?.stderr ?? error?.message ?? error).slice(0, 200) });
    throw error;
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
    if (!mediaType || !path || !mediaType.toLowerCase().startsWith('image/')) {
      if (path || mediaType) channelLog('attachments', 'skip', { mediaType, path: path?.slice(0, 80), reason: 'not-image' });
      return [];
    }
    const isHeic = HEIC_MEDIA_TYPES.has(mediaType.toLowerCase());
    channelLog('attachments', 'source', { name: attachment.name ?? null, mediaType, size: attachment.size ?? null, heic: isHeic });
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
  const sourceOf = (row, prefix) => {
    const path = row?.[`${prefix}Path`];
    return typeof path === 'string' && path
      ? {
        path,
        mediaType: row[`${prefix}Mime`] ?? null,
        name: row[`${prefix}Name`] ?? null,
        ...(Number.isFinite(Number(row[`${prefix}Bytes`])) ? { size: Number(row[`${prefix}Bytes`]) } : {}),
      }
      : null;
  };
  for (const row of rows) {
    const rowid = row?.rowid;
    // The quoted-message join multiplies the fan-out of the message's own
    // attachments, so collect by path instead of trusting one row per file.
    const attachment = sourceOf(row, 'attachment');
    const quotedAttachment = sourceOf(row, 'quotedAttachment');
    const existing = byRowid.get(rowid);
    if (existing) {
      if (attachment && !existing.attachments.some((item) => item.path === attachment.path)) {
        existing.attachments.push(attachment);
      }
      if (quotedAttachment && !existing.quotedAttachments.some((item) => item.path === quotedAttachment.path)) {
        existing.quotedAttachments.push(quotedAttachment);
      }
      continue;
    }
    const entry = { ...row, attachments: attachment ? [attachment] : [] };
    if (quotedAttachment) entry.quotedAttachments = [quotedAttachment];
    delete entry.attachmentPath;
    delete entry.attachmentMime;
    delete entry.attachmentName;
    delete entry.attachmentBytes;
    delete entry.quotedAttachmentPath;
    delete entry.quotedAttachmentMime;
    delete entry.quotedAttachmentName;
    delete entry.quotedAttachmentBytes;
    byRowid.set(rowid, entry);
    ordered.push(entry);
  }
  return ordered;
}
