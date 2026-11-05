// Splits outbound replies into iMessage-sized parts: plain lines go out one by
// one while fenced code blocks stay intact so they are never cut mid-block.

export function splitIMessageReplyParts(text) {
  const raw = String(text ?? '');
  const parts = [];
  let block = null;
  for (const line of raw.split('\n')) {
    if (block) {
      block.push(line);
      if (block.length > 1 && line.trim().startsWith('```')) {
        parts.push(block.join('\n'));
        block = null;
      }
      continue;
    }
    if (line.trim().startsWith('```')) {
      block = [line];
      continue;
    }
    const plain = line.trim();
    if (plain) parts.push(plain);
  }
  if (block) parts.push(block.join('\n'));
  return parts.length > 0 ? parts : [raw.trim()];
}
