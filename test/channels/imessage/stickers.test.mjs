import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  listStickers, buildStickerGuidance, publishStickerGuidance, installStickerContext,
  imessageStickers, IMESSAGE_STICKERS_CONTEXT, IMESSAGE_STICKERS_ORDER,
} from '../../../src/channels/imessage/imessage-stickers.mjs';

async function stickerDir(t, names) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-stickers-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of names) await writeFile(join(dir, name), 'gif');
  return dir;
}

test('lists only image files, sorted, ignoring dotfiles and junk', async (t) => {
  const dir = await stickerDir(t, ['b.gif', 'a.png', '.hidden.gif', 'notes.txt', 'C.JPEG']);
  // Plain lexicographic order: uppercase sorts before lowercase.
  assert.deepEqual(listStickers(dir), ['C.JPEG', 'a.png', 'b.gif']);
});

test('a missing directory yields no stickers and no guidance', () => {
  const missing = '/definitely/not/a/dir';
  assert.deepEqual(listStickers(missing), []);
  assert.equal(buildStickerGuidance({ directory: missing, stickers: [] }), '');
});

test('the guidance names the directory, the files and the rules', async (t) => {
  const dir = await stickerDir(t, ['摸头.gif', '生气.gif']);
  const text = buildStickerGuidance({ directory: dir });
  assert.match(text, /\[表情包\]/);
  assert.ok(text.includes(dir));
  assert.match(text, /摸头\.gif/);
  assert.match(text, /生气\.gif/);
  assert.match(text, /什么时候发/);
  assert.match(text, /什么时候不发/);
  assert.match(text, /dsh_im_return_file/);
  assert.match(text, /一次最多一张/);
  assert.match(text, /加引号/);
});

test('guidance is published per session and cleared with an empty collection', async (t) => {
  const dir = await stickerDir(t, ['爱心1.gif']);
  imessageStickers.clear();
  publishStickerGuidance('session-a', { directory: dir });
  assert.match(imessageStickers.get('session-a'), /爱心1\.gif/);
  assert.equal(imessageStickers.get('session-b'), undefined);
  // An empty collection publishes nothing, so the conversation stops seeing it.
  publishStickerGuidance('session-a', { directory: dir, stickers: [] });
  assert.equal(imessageStickers.get('session-a'), undefined);
  imessageStickers.clear();
});

test('the prompt context is registered with the shared ordering', async (t) => {
  const dir = await stickerDir(t, ['问号.gif']);
  imessageStickers.clear();
  publishStickerGuidance('session-c', { directory: dir });
  let registration = null;
  const ctx = { systemPrompt: { context: (value) => { registration = value; return () => {}; } } };
  const dispose = installStickerContext(ctx);
  assert.equal(typeof dispose, 'function');
  assert.equal(registration.name, IMESSAGE_STICKERS_CONTEXT);
  assert.equal(registration.order, IMESSAGE_STICKERS_ORDER);
  // Resolved from the assembly's session, so other channels stay unaffected.
  assert.match(registration.text({ agent: { session: { id: 'session-c' } } }), /问号\.gif/);
  assert.equal(registration.text({ agent: { session: { id: 'other' } } }), '');
  assert.equal(registration.text(undefined), '');
  imessageStickers.clear();
});

test('a host without prompt context simply gets no disposer', () => {
  assert.equal(installStickerContext({}), null);
  assert.equal(installStickerContext(null), null);
});

test('the real sticker directory is picked up', () => {
  // The user copied the collection into the IM workspace; the guidance follows.
  const stickers = listStickers();
  assert.ok(stickers.length > 0, 'expected stickers in ~/.dsh/im/stickers');
  assert.ok(stickers.every((name) => /\.(gif|png|jpe?g|webp)$/iu.test(name)));
});
