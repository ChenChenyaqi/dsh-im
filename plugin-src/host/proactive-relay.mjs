// Background-turn relay: when a session turn that no channel initiated (for
// example a schedule/reminder injection) finishes, forward the final assistant
// text to the IM conversation that session is bound to. Channel-initiated
// turns keep their request/response delivery and are never re-sent here.

const SKIP_MARKER = 'SKIP';

function sessionIdOf(session) {
  if (typeof session === 'string') return session || null;
  const sessionId = session?.id ?? session?.header?.id;
  return typeof sessionId === 'string' && sessionId ? sessionId : null;
}

/** Extract the plain text of an `assistant/message` event payload. */
function assistantTextOf(data) {
  const content = data?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text')
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('\n')
    .trim();
}

/**
 * Relay finished background turns through the delivery service. Returns true
 * when the listener was installed. Never throws for a single turn: failures
 * are logged and the text stays available in the receiving session.
 */
export function installProactiveRelay(ctx, deliveryService, { logger = console } = {}) {
  if (typeof ctx?.on !== 'function' || !deliveryService
    || typeof deliveryService.relaySessionText !== 'function') {
    return false;
  }
  // sessionId → tracked turn { turn, background, text }
  const tracked = new Map();

  ctx.on('session/event', (session, event) => {
    const sessionId = sessionIdOf(session);
    if (!sessionId || !event || typeof event !== 'object') return;
    if (event.type === 'turn/start') {
      const turn = event.data?.turn;
      tracked.set(sessionId, Number.isInteger(turn) && turn >= 0
        ? { turn, background: false, text: '' }
        : null);
      return;
    }
    const entry = tracked.get(sessionId);
    if (!entry) return;
    if (event.type === 'user/message') {
      const source = event.data?.source;
      // Channel bridges submit prompts with an rpcId; schedule injections carry
      // source.kind === 'schedule' without one. Only those turns are relayed.
      if (source?.kind === 'schedule' && !source.rpcId) entry.background = true;
      return;
    }
    if (event.type === 'assistant/message') {
      if (!entry.background) return;
      const text = assistantTextOf(event.data);
      if (text) entry.text = entry.text ? `${entry.text}\n${text}` : text;
      return;
    }
    if (event.type === 'turn/end') {
      tracked.delete(sessionId);
      if (!entry.background || event.data?.turn !== entry.turn) return;
      const text = entry.text.trim();
      // A reminder that deliberately has nothing to say stays silent.
      if (!text || text === SKIP_MARKER) return;
      deliveryService.relaySessionText(sessionId, text).catch((error) => {
        logger.warn?.('[dsh-im] proactive relay failed for', sessionId, error);
      });
    }
  });
  return true;
}
