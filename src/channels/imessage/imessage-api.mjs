// macOS Messages API: chat.db polling via sqlite3 plus AppleScript-based
// send (text and, on macOS 26+, file attachments). Domain logic lives in the
// sibling modules (decode / attachments / normalize); this file re-exports
// them so existing import paths keep working.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cleanString, normalizeChatGuid, normalizeAddress, permissionError, appleScriptString } from './osascript-helpers.mjs';
import { mergeAttachmentRows } from './imessage-attachments.mjs';
import { channelLog } from './channel-log.mjs';

export { decodeAttributedBodyText } from './imessage-decode.mjs';
export { imessageImageSources, mergeAttachmentRows } from './imessage-attachments.mjs';
export { IMESSAGE_BOT_REPLY_PREFIX, normalizeIMessage, normalizeIMessageTarget } from './imessage-normalize.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_DB_PATH = `${process.env.HOME ?? ''}/Library/Messages/chat.db`;
const DEFAULT_TIMEOUT_MS = 15_000;

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function decodeRows(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return [];
  try {
    const rows = JSON.parse(text);
    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    throw new Error('macOS Messages returned invalid database output', { cause: error });
  }
}

export class MacOSMessagesApi {
  // getPermissions is polled by the settings page; only report transitions so
  // the channel log tracks problems instead of repeating the same line.
  #lastPermissionKey = null;
  #dbPath;
  #execFile;
  #execFileOptions;
  #osascript;

  constructor({ dbPath = DEFAULT_DB_PATH, execFileImpl = execFileAsync, osascriptImpl } = {}) {
    this.#dbPath = dbPath;
    this.#execFile = execFileImpl;
    this.#execFileOptions = { timeout: DEFAULT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 };
    this.#osascript = osascriptImpl ?? ((script) => this.#execFile('/usr/bin/osascript', ['-e', script], this.#execFileOptions));
    if (typeof this.#execFile !== 'function' || typeof this.#osascript !== 'function') {
      throw new TypeError('MacOSMessagesApi requires command runners');
    }
  }

  async getPermissions() {
    const result = { platform: process.platform, database: 'unknown', automation: 'unknown' };
    if (process.platform !== 'darwin') {
      const unsupported = { ...result, database: 'unsupported', automation: 'unsupported' };
      channelLog('api', 'permissions', unsupported);
      return unsupported;
    }
    try {
      await this.#execFile('/usr/bin/sqlite3', ['-json', this.#dbPath, 'SELECT 1 AS ok LIMIT 1;'], this.#execFileOptions);
      result.database = 'granted';
    } catch (error) {
      result.database = /authorization denied|not authorized|unable to open database/i.test(String(error?.stderr ?? error))
        ? 'required' : 'error';
    }
    try {
      await this.#osascript('tell application "Messages" to get name');
      result.automation = 'granted';
    } catch (error) {
      result.automation = /not authorized|(-1743)|assistive/i.test(String(error?.stderr ?? error))
        ? 'required' : 'error';
    }
    const key = `${result.database}/${result.automation}`;
    if (key !== this.#lastPermissionKey) {
      this.#lastPermissionKey = key;
      channelLog('api', 'permissions', result);
    }
    return result;
  }

  async listMessages({ after = 0, limit = 50, chatGuid } = {}) {
    const cursor = Number.isSafeInteger(after) && after >= 0 ? after : 0;
    const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    const chatFilter = chatGuid ? ` AND c.guid = ${sqlString(normalizeChatGuid(chatGuid))}` : '';
    // Messages delivers self-chat back as an incoming copy. Read that copy once,
    // keeping all outgoing rows excluded, and filter bot replies by their marker.
    // macOS 26 (Tahoe) stores received iMessage bodies only in attributedBody, so
    // accept either text column and decode the blob when text is empty. Image
    // attachments join in per message; stickers and unfinished transfers stay out.
    const query = `SELECT m.ROWID AS rowid, m.guid AS guid, m.text AS text,
      hex(m.attributedBody) AS attributedBodyHex,
      h.id AS sender, c.guid AS chatGuid, c.service_name AS serviceName,
      m.is_from_me AS isFromMe,
      a.filename AS attachmentPath, a.mime_type AS attachmentMime,
      a.transfer_name AS attachmentName, a.total_bytes AS attachmentBytes,
      m.thread_originator_guid AS threadOriginatorGuid,
      q.ROWID AS quotedRowId, q.text AS quotedText,
      hex(q.attributedBody) AS quotedAttributedBodyHex,
      q.is_from_me AS quotedFromMe, qh.id AS quotedSender,
      qa.filename AS quotedAttachmentPath, qa.mime_type AS quotedAttachmentMime,
      qa.transfer_name AS quotedAttachmentName, qa.total_bytes AS quotedAttachmentBytes,
      datetime((m.date / 1000000000) + 978307200, 'unixepoch') AS receivedAt
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      JOIN chat c ON c.ROWID = cmj.chat_id
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      LEFT JOIN message q ON q.guid = m.thread_originator_guid
      LEFT JOIN handle qh ON qh.ROWID = q.handle_id
      LEFT JOIN message_attachment_join qmaj ON qmaj.message_id = q.ROWID
      LEFT JOIN attachment qa ON qa.ROWID = qmaj.attachment_id
        AND qa.is_sticker = 0 AND qa.transfer_state = 5 AND qa.filename IS NOT NULL
      LEFT JOIN message_attachment_join maj ON maj.message_id = m.ROWID
      LEFT JOIN attachment a ON a.ROWID = maj.attachment_id
        AND a.is_sticker = 0 AND a.transfer_state = 5 AND a.filename IS NOT NULL
      WHERE m.ROWID > ${cursor} AND m.is_from_me = 0
        AND ((m.text IS NOT NULL AND m.text != '') OR m.attributedBody IS NOT NULL
          OR (a.filename IS NOT NULL AND a.mime_type LIKE 'image/%'))
        AND c.service_name = 'iMessage'${chatFilter}
      ORDER BY m.ROWID ASC LIMIT ${boundedLimit};`;
    try {
      const { stdout } = await this.#execFile('/usr/bin/sqlite3', ['-json', this.#dbPath, query], this.#execFileOptions);
      const rows = mergeAttachmentRows(decodeRows(stdout));
      if (rows.length > 0) channelLog('api', 'listMessages', { rows: rows.length, after: cursor });
      return rows;
    } catch (error) {
      channelLog('api', 'listMessages failed', { after: cursor, error: String(error?.stderr ?? error?.message ?? error).slice(0, 200) });
      if (/authorization denied|not authorized|unable to open database/i.test(String(error?.stderr ?? error))) {
        throw permissionError('messages-database-permission-required', '请在系统设置中授予 DeepSeek Harness 完全磁盘访问权限。', error);
      }
      throw error;
    }
  }

  async getLatestMessageRowId() {
    if (process.platform !== 'darwin') return 0;
    const query = `SELECT COALESCE(MAX(m.ROWID), 0) AS rowid
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      JOIN chat c ON c.ROWID = cmj.chat_id
      WHERE c.service_name = 'iMessage';`;
    const { stdout } = await this.#execFile(
      '/usr/bin/sqlite3', ['-json', this.#dbPath, query], this.#execFileOptions,
    );
    const rows = decodeRows(stdout);
    const rowid = Number(rows[0]?.rowid ?? 0);
    return Number.isSafeInteger(rowid) && rowid >= 0 ? rowid : 0;
  }

  async sendText({ chatGuid, address, text } = {}) {
    const target = normalizeChatGuid(chatGuid);
    const recipient = address ? normalizeAddress(address) : target.split(';').at(-1) || target;
    const content = cleanString(text);
    if (!content) throw new TypeError('iMessage text is required');
    const reply = content;
    const script = `tell application "Messages"
      set serviceList to every service whose service type = iMessage
      if (count of serviceList) is 0 then error "No iMessage service is available"
      set targetService to item 1 of serviceList
      set targetBuddy to buddy ${appleScriptString(recipient)} of targetService
      send ${appleScriptString(reply)} to targetBuddy
    end tell`;
    try {
      const startedAt = Date.now();
      await this.#osascript(script);
      channelLog('api', 'sendText ok', { to: recipient, chars: reply.length, elapsedMs: Date.now() - startedAt });
      return { sent: true };
    } catch (error) {
      channelLog('api', 'sendText failed', { to: recipient, chars: reply.length, error: String(error?.stderr ?? error?.message ?? error).slice(0, 200) });
      if (/not authorized|(-1743)|assistive/i.test(String(error?.stderr ?? error))) {
        throw permissionError('messages-automation-permission-required', '请在系统设置中允许 DeepSeek Harness 自动化控制 Messages。', error);
      }
      throw error;
    }
  }

  // macOS 26 (Tahoe) extends the Messages `send` command with a file direct
  // parameter, so attachments go out through the same automation channel as
  // text — no clipboard or UI scripting required.
  async sendFile({ chatGuid, address, path } = {}) {
    const target = normalizeChatGuid(chatGuid);
    const recipient = address ? normalizeAddress(address) : target.split(';').at(-1) || target;
    const filePath = cleanString(path);
    if (!filePath) throw new TypeError('iMessage file path is required');
    const script = `tell application "Messages"
      set serviceList to every service whose service type = iMessage
      if (count of serviceList) is 0 then error "No iMessage service is available"
      set targetService to item 1 of serviceList
      set targetBuddy to buddy ${appleScriptString(recipient)} of targetService
      send POSIX file ${appleScriptString(filePath)} to targetBuddy
    end tell`;
    try {
      const startedAt = Date.now();
      await this.#osascript(script);
      channelLog('api', 'sendFile ok', { to: recipient, path: filePath, elapsedMs: Date.now() - startedAt });
      return { sent: true };
    } catch (error) {
      channelLog('api', 'sendFile failed', { to: recipient, path: filePath, error: String(error?.stderr ?? error?.message ?? error).slice(0, 200) });
      if (/not authorized|(-1743)|assistive/i.test(String(error?.stderr ?? error))) {
        throw permissionError('messages-automation-permission-required', '请在系统设置中允许 DeepSeek Harness 自动化控制 Messages。', error);
      }
      throw error;
    }
  }
}

export { DEFAULT_DB_PATH };
