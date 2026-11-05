// Shared low-level helpers for the macOS Messages AppleScript surface:
// input normalization, AppleScript string escaping, and permission errors.

export function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function normalizeChatGuid(value) {
  const chatGuid = cleanString(value?.chatGuid ?? value);
  if (!chatGuid || chatGuid.length > 512 || /[\r\n]/.test(chatGuid)) {
    throw new TypeError('iMessage chatGuid is required');
  }
  return chatGuid;
}

export function normalizeAddress(value) {
  const address = cleanString(value);
  if (!address || address.length > 512 || /[\r\n]/.test(address)) {
    throw new TypeError('iMessage address is required');
  }
  return address;
}

export function permissionError(kind, message, cause) {
  const error = new Error(message, { cause });
  error.code = kind;
  return error;
}

export function appleScriptString(value) {
  return JSON.stringify(String(value));
}
