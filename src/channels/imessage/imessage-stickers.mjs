// Sticker guidance for iMessage conversations.
//
// She can send one of the collected reaction GIFs when the mood actually calls
// for it. The text is published per Session and materialized as dynamic prompt
// context, the same shape `im-source-guidance.mjs` uses, so a conversation that
// is not bound to iMessage never sees it.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Prompt-context name the Host materializes this guidance under. */
export const IMESSAGE_STICKERS_CONTEXT = 'dsh-im:imessage-stickers';

/** Joined in ascending order; the sticker note follows the policy facts. */
export const IMESSAGE_STICKERS_ORDER = 126;

const DEFAULT_STICKER_DIRECTORY = join(process.env.HOME ?? '', '.dsh', 'im', 'stickers');
const MAX_SESSIONS = 1_024;
const MAX_STICKERS = 40;

class StickerRegistry {
  #bySession = new Map();

  publish(sessionId, text) {
    if (typeof sessionId !== 'string' || !sessionId) return;
    this.#bySession.delete(sessionId);
    if (typeof text !== 'string' || !text.trim()) return;
    this.#bySession.set(sessionId, text);
    while (this.#bySession.size > MAX_SESSIONS) {
      this.#bySession.delete(this.#bySession.keys().next().value);
    }
  }

  get(sessionId) {
    return typeof sessionId === 'string' ? this.#bySession.get(sessionId) : undefined;
  }

  forget(sessionId) {
    if (typeof sessionId === 'string') this.#bySession.delete(sessionId);
  }

  clear() { this.#bySession.clear(); }
}

export const imessageStickers = new StickerRegistry();

/** Sticker file names in the directory, or an empty list when it is missing. */
export function listStickers(directory = DEFAULT_STICKER_DIRECTORY) {
  try {
    return readdirSync(directory)
      .filter((name) => /\.(gif|png|jpe?g|webp)$/iu.test(name) && !name.startsWith('.'))
      .sort()
      .slice(0, MAX_STICKERS);
  } catch {
    return [];
  }
}

/**
 * The instruction she reads. Empty when the directory holds no stickers, so a
 * bot without the collection is never told about a feature it cannot use.
 */
export function buildStickerGuidance({
  directory = DEFAULT_STICKER_DIRECTORY, stickers = listStickers(directory),
} = {}) {
  if (stickers.length === 0) return '';
  const names = stickers.map((name) => `  - ${name}`).join('\n');
  return [
    `[表情包]  你有 ${stickers.length} 个表情包，放在 ${directory} 里：`,
    names,
    '什么时候发：情绪真的到了的时候——被逗笑、想撒娇、无语、困了、馋了、想安慰他、想给他鼓掌。',
    '什么时候不发：他在问正经问题、你在解释正事、这条刚发过表情包、或者你上一句已经是图。',
    '怎么发：先用一句话说点什么，再用 dsh_im_return_file 把表情包路径发出去；表情包是补充，不能代替说话。一次最多一张。',
    '别解释「我发个表情包」，也别问他喜不喜欢。文件名里有中文和括号，整条路径要加引号。',
  ].join('\n');
}

/** Publish the guidance for one Session; an empty collection clears it. */
export function publishStickerGuidance(sessionId, options) {
  imessageStickers.publish(sessionId, buildStickerGuidance(options));
}

/**
 * Register the prompt context that carries the sticker note. Returns the
 * Cordis disposer, or null when the context cannot listen.
 */
export function installStickerContext(ctx, { registry = imessageStickers } = {}) {
  if (typeof ctx?.systemPrompt?.context !== 'function') return null;
  return ctx.systemPrompt.context({
    name: IMESSAGE_STICKERS_CONTEXT,
    order: IMESSAGE_STICKERS_ORDER,
    text: (assembly) => registry.get(assembly?.agent?.session?.id) ?? '',
  });
}
