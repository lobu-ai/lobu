import {
  ConnectorRuntime,
  type ActionContext,
  type ActionDefinition,
  type ActionResult,
  type RuntimeConnectorDefinition,
} from '@lobu/connector-sdk';

/**
 * iMessage/SMS over an existing os.shell connection.
 *
 * `run` is the only os.shell operation this connector uses: every command is
 * a fixed argv with user input quoted as one argument, and every SQL statement
 * carrying a value arrives on stdin (only the constant pre-send sentinel query
 * rides in argv). SQLite and osascript are macOS system binaries, so no
 * project install step is involved.
 */
const APPLE_EPOCH_OFFSET_SECONDS = 978307200;
const SQLITE_BINARY = '/usr/bin/sqlite3';
const OSASCRIPT_BINARY = '/usr/bin/osascript';
// Double quotes keep paths with spaces working; $HOME is expanded by the
// device shell (zsh -l on a Mac), not by this connector.
const CHAT_DB_PATH = '"$HOME/Library/Messages/chat.db"';
const READ_TIMEOUT_MS = 15000;
const WRITE_TIMEOUT_MS = 30000;
const MAX_SEARCH_LENGTH = 500;
const MAX_SEND_LENGTH = 4000;
// os.shell caps stdout at 1 MiB. Keep each text/blob column small and page
// sizes bounded so a full page stays below that cap; the SQL selects a
// truncated value only when the row is larger than this.
const MAX_STORED_TEXT_BYTES = 2048;
const MAX_SHELL_STDOUT_CHARS = 1_048_576;

const SEND_SCRIPT = `on run argv
  set targetKind to item 1 of argv
  set targetValue to item 2 of argv
  set body to item 3 of argv
  tell application "Messages"
    if targetKind is "chat" then
      set targetChat to chat id targetValue
      send body to targetChat
    else
      set targetService to first service whose service type is iMessage
      set targetBuddy to participant targetValue of targetService
      send body to targetBuddy
    end if
  end tell
  return "sent"
end run
`;

/** Shell only transports argv; quoting is the injection boundary. */
export function quoteShellArg(value: string): string {
  if (value.includes('\0')) throw new Error('Expected a string without NUL bytes');
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

/** A SQLite string literal. Values always travel on stdin, never in argv. */
export function sqlStringLiteral(value: string): string {
  if (value.includes('\0')) throw new Error('Expected a string without NUL bytes');
  return "'" + value.replaceAll("'", "''") + "'";
}

export function isoFromAppleDate(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const milliseconds = value / 1e6 + APPLE_EPOCH_OFFSET_SECONDS * 1000;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/** Exact nanosecond lower bound for `message.date`; seconds stay integral. */
export function appleNsSince(iso: string): string {
  const milliseconds = Date.parse(iso);
  if (!Number.isFinite(milliseconds)) throw new Error('since must be an ISO timestamp');
  const seconds = Math.floor(milliseconds / 1000) - APPLE_EPOCH_OFFSET_SECONDS;
  return `${seconds}000000000`;
}

function hexNibble(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  return -1;
}

function asciiAt(bytes: Uint8Array, start: number, text: string): boolean {
  if (start + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[start + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function decodeStringAt(
  bytes: Uint8Array,
  index: number,
  littleEndian: boolean,
): string | null {
  const head = bytes[index];
  if (head === undefined) return null;
  let length: number;
  let start = index + 1;
  if (head === 0x81 || head === 0x82) {
    const width = head === 0x81 ? 2 : 4;
    if (start + width > bytes.length) return null;
    length = 0;
    for (let offset = 0; offset < width; offset++) {
      const byte = bytes[start + offset] as number;
      const shift = (littleEndian ? offset : width - 1 - offset) * 8;
      length += byte * 2 ** shift;
    }
    start += width;
  } else if (head <= 0x7f) {
    length = head;
  } else {
    return null;
  }
  if (start + length > bytes.length) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, start + length));
  } catch {
    return null;
  }
}

/**
 * Apple archived attributed strings are typedstream object graphs. The plain
 * message body is the first NSString's bytes; there is no need to model the
 * attribute dictionaries that follow it. Public format description:
 * 0x04 0x0b "streamtyped", then object/type tags, then the string tag 0x01 0x2b,
 * a length (0x81 + u16 or 0x82 + u32 for longer bodies), and UTF-8 bytes.
 */
export function decodeTypedStream(bytes: Uint8Array): string | null {
  if (bytes.length < 14 || bytes[0] !== 0x04 || bytes[1] !== 0x0b) return null;
  let littleEndian: boolean;
  if (asciiAt(bytes, 2, 'streamtyped')) littleEndian = true;
  else if (asciiAt(bytes, 2, 'typedstream')) littleEndian = false;
  else return null;
  for (let index = 13; index + 1 < bytes.length; index++) {
    if (bytes[index] !== 0x01 || bytes[index + 1] !== 0x2b) continue;
    return decodeStringAt(bytes, index + 2, littleEndian);
  }
  return null;
}

/** Decode `hex(attributedBody)`; malformed blobs are data, not page failures. */
export function decodeAttributedBody(hex: unknown): string | null {
  if (typeof hex !== 'string' || hex.length === 0 || hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    const high = hexNibble(hex.charCodeAt(index * 2));
    const low = hexNibble(hex.charCodeAt(index * 2 + 1));
    if (high < 0 || low < 0) return null;
    bytes[index] = high * 16 + low;
  }
  return decodeTypedStream(bytes);
}

export interface MessageRowOutput {
  rowid: number;
  guid: string | null;
  chat_id: number | null;
  sender: string | null;
  is_from_me: boolean;
  service: string | null;
  text: string | null;
  text_source: 'text' | 'attributedBody' | null;
  text_truncated: boolean;
  has_attachments: boolean;
  sent_at: string | null;
  is_delivered: boolean;
  is_sent: boolean;
  error: number;
}

export interface ChatRowOutput {
  chat_id: number;
  guid: string | null;
  display_name: string | null;
  chat_identifier: string | null;
  participants: string[];
  service: string | null;
  last_message_at: string | null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function flag(value: unknown): boolean {
  return value === 1 || value === true;
}

export function mapMessageRow(row: Record<string, unknown>): MessageRowOutput {
  const fromMe = flag(row.is_from_me);
  const rawText = stringOrNull(row.text);
  let text = rawText !== null && rawText.length > 0 ? rawText : null;
  let textSource: 'text' | 'attributedBody' | null = text === null ? null : 'text';
  if (text === null) {
    const decoded = decodeAttributedBody(row.attributed_body_hex);
    if (decoded !== null) {
      text = decoded;
      textSource = 'attributedBody';
    }
  }
  return {
    rowid: numberOrNull(row.rowid) ?? 0,
    guid: stringOrNull(row.guid),
    chat_id: numberOrNull(row.chat_id),
    sender: fromMe ? 'me' : stringOrNull(row.sender),
    is_from_me: fromMe,
    service: stringOrNull(row.service),
    text,
    text_source: textSource,
    text_truncated:
      text === null && (flag(row.text_truncated) || flag(row.body_truncated)),
    has_attachments: flag(row.has_attachments),
    sent_at: isoFromAppleDate(row.date),
    is_delivered: flag(row.is_delivered),
    is_sent: flag(row.is_sent),
    error: numberOrNull(row.error) ?? 0,
  };
}

export function listChatsSql(limit: number): string {
  return `SELECT c.ROWID AS chat_id, c.guid AS guid, c.display_name AS display_name,
       c.chat_identifier AS chat_identifier, c.service_name AS service,
       MAX(m.date) AS last_message_date,
       (SELECT json_group_array(h.id)
        FROM chat_handle_join chj
        JOIN handle h ON h.ROWID = chj.handle_id
        WHERE chj.chat_id = c.ROWID) AS participants_json
FROM chat c
JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
JOIN message m ON m.ROWID = cmj.message_id
GROUP BY c.ROWID
ORDER BY last_message_date DESC, c.ROWID DESC
LIMIT ${limit};`;
}

export function participantsFromJson(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const handles = parsed.filter(
    (item): item is string => typeof item === 'string' && item.length > 0,
  );
  return [...new Set(handles)].sort();
}

function messageColumns(chatId: string): string {
  return `m.ROWID AS rowid, m.guid AS guid, ${chatId} AS chat_id,
       h.id AS sender, m.is_from_me AS is_from_me, m.service AS service,
       CASE WHEN length(CAST(m.text AS BLOB)) <= ${MAX_STORED_TEXT_BYTES}
            THEN m.text ELSE NULL END AS text,
       CASE WHEN length(CAST(m.text AS BLOB)) > ${MAX_STORED_TEXT_BYTES}
            THEN 1 ELSE 0 END AS text_truncated,
       CASE WHEN length(m.attributedBody) <= ${MAX_STORED_TEXT_BYTES}
            THEN hex(m.attributedBody) ELSE NULL END AS attributed_body_hex,
       CASE WHEN length(m.attributedBody) > ${MAX_STORED_TEXT_BYTES}
            THEN 1 ELSE 0 END AS body_truncated,
       m.has_attachments AS has_attachments, m.date AS date,
       m.is_delivered AS is_delivered, m.is_sent AS is_sent, m.error AS error`;
}

export function readChatSql(
  chatId: number,
  beforeRowid: number | null,
  limit: number,
): string {
  return `SELECT ${messageColumns('cmj.chat_id')}
FROM message m
JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
LEFT JOIN handle h ON h.ROWID = m.handle_id
WHERE cmj.chat_id = ${chatId}${beforeRowid === null ? '' : ` AND m.ROWID < ${beforeRowid}`}
ORDER BY m.ROWID DESC
LIMIT ${limit};`;
}

export function searchMessagesSql(
  query: string,
  chatId: number | null,
  since: string | null,
  beforeRowid: number | null,
  limit: number,
): string {
  const literal = sqlStringLiteral(query);
  // Byte-exact prefilter: most modern rows have text = NULL, and the body's
  // UTF-8 bytes are stored verbatim inside the attributedBody blob. This is
  // intentionally a superset: the blob also holds attribute key names, so the
  // caller post-filters on the decoded body text.
  const clauses = [
    `(instr(m.text, ${literal}) > 0 OR instr(m.attributedBody, CAST(${literal} AS BLOB)) > 0)`,
  ];
  if (chatId !== null) {
    clauses.push(
      `EXISTS (SELECT 1 FROM chat_message_join cmj WHERE cmj.message_id = m.ROWID AND cmj.chat_id = ${chatId})`,
    );
  }
  if (since !== null) clauses.push(`m.date >= ${since}`);
  if (beforeRowid !== null) clauses.push(`m.ROWID < ${beforeRowid}`);
  // A message can join multiple chats; report its canonical (lowest) chat id
  // once instead of duplicating the row per join.
  return `SELECT ${messageColumns('(SELECT MIN(cmj.chat_id) FROM chat_message_join cmj WHERE cmj.message_id = m.ROWID)')}
FROM message m
LEFT JOIN handle h ON h.ROWID = m.handle_id
WHERE ${clauses.join(' AND ')}
ORDER BY m.ROWID DESC
LIMIT ${limit};`;
}

export function outgoingSentinelSql(): string {
  return 'SELECT IFNULL(MAX(ROWID), 0) AS rowid FROM message WHERE is_from_me = 1;';
}

export function chatByGuidSql(guid: string): string {
  return `SELECT ROWID AS chat_id, guid AS guid
FROM chat
WHERE guid = ${sqlStringLiteral(guid)}
ORDER BY ROWID DESC
LIMIT 1;`;
}

export function chatByRecipientSql(recipient: string): string {
  const directGuid = `iMessage;-;${recipient}`;
  return `SELECT ROWID AS chat_id, guid AS guid
FROM chat
WHERE chat_identifier = ${sqlStringLiteral(recipient)}
   OR guid = ${sqlStringLiteral(directGuid)}
ORDER BY ROWID DESC
LIMIT 1;`;
}

export function confirmSentSql(
  target: { chatGuid: string } | { recipient: string },
  sentinel: number,
): string {
  const match =
    'chatGuid' in target
      ? `c.guid = ${sqlStringLiteral(target.chatGuid)}`
      : `(h.id = ${sqlStringLiteral(target.recipient)}
        OR c.chat_identifier = ${sqlStringLiteral(target.recipient)}
        OR c.guid = ${sqlStringLiteral(`iMessage;-;${target.recipient}`)})`;
  return `SELECT ${messageColumns('cmj.chat_id')}
FROM message m
LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
LEFT JOIN chat c ON c.ROWID = cmj.chat_id
LEFT JOIN handle h ON h.ROWID = m.handle_id
WHERE m.is_from_me = 1 AND m.ROWID > ${sentinel} AND (${match})
ORDER BY m.ROWID DESC
LIMIT 1;`;
}

type SendTarget = { kind: 'chat'; chatGuid: string } | { kind: 'recipient'; recipient: string };

function action(
  key: string,
  name: string,
  description: string,
  kind: 'read' | 'write',
  properties: Record<string, unknown> = {},
  required: string[] = [],
  schemaExtras: Record<string, unknown> = {},
): ActionDefinition {
  return {
    key,
    name,
    description,
    kind,
    inputSchema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
      ...schemaExtras,
    },
    annotations: {
      destructiveHint: kind === 'write',
      openWorldHint: kind === 'write',
      idempotentHint: kind === 'read',
    },
  };
}

function requiredString(
  input: Record<string, unknown>,
  key: string,
  maximum: number,
): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0'))
    throw new Error(`${key} is required and must be at most ${maximum} characters`);
  return value;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  maximum: number,
  minimum = 1,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`Invalid numeric value; expected ${minimum}..${maximum}`);
  return value;
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) < 0x20) return true;
  }
  return false;
}

function chatGuid(input: Record<string, unknown>): string {
  const value = requiredString(input, 'chat_guid', 255);
  if (hasControlCharacters(value)) throw new Error('chat_guid contains control characters');
  const parts = value.split(';');
  if (
    parts.length < 3 ||
    (parts[0] !== 'iMessage' && parts[0] !== 'SMS' && parts[0] !== 'any') ||
    (parts[1] !== '-' && parts[1] !== '+') ||
    parts.slice(2).join(';').length === 0
  )
    throw new Error('chat_guid must be a Messages chat GUID such as iMessage;-;+15550001001');
  return value;
}

function recipient(input: Record<string, unknown>): string {
  const value = requiredString(input, 'recipient', 255).trim();
  if (value.length === 0 || hasControlCharacters(value))
    throw new Error('recipient must be a phone number or email without control characters');
  return value;
}

function sendTarget(input: Record<string, unknown>): SendTarget {
  const hasGuid = input.chat_guid !== undefined;
  const hasRecipient = input.recipient !== undefined;
  if (hasGuid === hasRecipient)
    throw new Error('Provide exactly one of chat_guid or recipient');
  return hasGuid
    ? { kind: 'chat', chatGuid: chatGuid(input) }
    : { kind: 'recipient', recipient: recipient(input) };
}

function optionalChatId(input: Record<string, unknown>): number | null {
  if (input.chat_id === undefined) return null;
  return boundedInteger(input.chat_id, 0, Number.MAX_SAFE_INTEGER);
}

function assertChatId(input: Record<string, unknown>): number {
  const value = input.chat_id;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error('chat_id is required');
  return value;
}

function listLimit(input: Record<string, unknown>): number {
  return boundedInteger(input.limit, 20, 100);
}

function readLimit(input: Record<string, unknown>): number {
  return boundedInteger(input.limit, 50, 100);
}

function searchLimit(input: Record<string, unknown>): number {
  return boundedInteger(input.limit, 50, 50);
}

function beforeRowid(input: Record<string, unknown>): number | null {
  if (input.before_rowid === undefined) return null;
  return boundedInteger(input.before_rowid, 0, Number.MAX_SAFE_INTEGER);
}

type ShellOutput = {
  exit_code?: number;
  timed_out?: boolean;
  stdout?: string;
  stderr?: string;
};

type ShellResult =
  | { kind: 'receipt'; receipt: Record<string, unknown> }
  | { kind: 'completed'; runId: number | undefined; shell: ShellOutput }
  | { kind: 'error'; error: string };

type SqlResult =
  | { rows: Array<Record<string, unknown>> }
  | { receipt: Record<string, unknown> }
  | { error: string };

async function runShell(
  ctx: ActionContext,
  connectionId: number,
  command: string,
  stdin: string,
  timeoutMs: number,
  idempotencyKey: string,
): Promise<ShellResult> {
  const operations = ctx.operations;
  if (!operations)
    return { kind: 'error', error: 'Connector operation delegation is unavailable.' };
  const receipt = (await operations.execute({
    connection_id: connectionId,
    operation_key: 'run',
    idempotency_key: idempotencyKey,
    input: { command, stdin, timeout_ms: timeoutMs },
  })) as Record<string, unknown>;
  if (typeof receipt.error === 'string') return { kind: 'error', error: receipt.error };
  const status = receipt.status;
  if (status === 'pending_approval' || status === 'in_progress')
    return { kind: 'receipt', receipt };
  if (status !== 'completed') return { kind: 'error', error: JSON.stringify(receipt) };
  const shell = receipt.output as ShellOutput | undefined;
  if (!shell || shell.exit_code !== 0 || shell.timed_out)
    return {
      kind: 'error',
      error: JSON.stringify({
        run_id: receipt.run_id,
        exit_code: shell?.exit_code,
        timed_out: shell?.timed_out,
        stderr: shell?.stderr?.slice(-2000),
        stdout: shell?.stdout?.slice(-1000),
        stdout_head: shell?.stdout?.slice(0, 1000),
      }),
    };
  return { kind: 'completed', runId: numberOrNull(receipt.run_id) ?? undefined, shell };
}

async function runSql(
  ctx: ActionContext,
  connectionId: number,
  sql: string,
  idempotencyKey: string,
): Promise<SqlResult> {
  const result = await runShell(
    ctx,
    connectionId,
    `${quoteShellArg(SQLITE_BINARY)} -readonly -json ${CHAT_DB_PATH}`,
    sql,
    READ_TIMEOUT_MS,
    idempotencyKey,
  );
  if (result.kind === 'receipt') return { receipt: result.receipt };
  if (result.kind === 'error') return { error: result.error };
  const stdout = result.shell.stdout ?? '';
  if (stdout.length >= MAX_SHELL_STDOUT_CHARS)
    return {
      error: `sqlite3 output reached the shell's 1 MiB stdout cap; lower \`limit\` and retry (shell run ${result.runId}).`,
    };
  if (stdout.trim() === '') return { rows: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {
      error: `sqlite3 output could not be parsed, possibly because it was truncated by the shell's 1 MiB stdout cap; lower \`limit\` and retry (shell run ${result.runId}).`,
    };
  }
  if (!Array.isArray(parsed) || parsed.some((row) => typeof row !== 'object' || row === null))
    return {
      error: `sqlite3 returned an unexpected JSON shape; lower \`limit\` and retry (shell run ${result.runId}).`,
    };
  return { rows: parsed as Array<Record<string, unknown>> };
}

function resultFromSqlFailure(result: { receipt: Record<string, unknown> } | { error: string }): ActionResult {
  return 'receipt' in result
    ? { success: true, output: { ...result.receipt } }
    : { success: false, error: result.error };
}

/**
 * The sentinel query's one-row JSON line in the send `run`'s stdout. A Mac
 * endpoint runs commands under a login shell, so profile output may precede
 * it; every line is checked, not just the first.
 */
function parseSentinel(stdout: string): number | null {
  for (const line of stdout.split('\n')) {
    try {
      const rows = JSON.parse(line) as unknown;
      const row = Array.isArray(rows) ? rows[0] : undefined;
      const rowid =
        row && typeof row === 'object' ? numberOrNull((row as Record<string, unknown>).rowid) : null;
      if (rowid !== null) return rowid;
    } catch {
      // Not the sentinel line.
    }
  }
  return null;
}

type ShellErrorDetails = { stdout?: string; stdout_head?: string };

/** The shell's nonzero-exit error JSON, or null for a pre-run failure. */
function parseShellError(error: string): ShellErrorDetails | null {
  try {
    const parsed = JSON.parse(error) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const details = parsed as ShellErrorDetails;
    return typeof details.stdout === 'string' || typeof details.stdout_head === 'string'
      ? details
      : null;
  } catch {
    return null;
  }
}

function chatRow(row: Record<string, unknown>): ChatRowOutput {
  return {
    chat_id: numberOrNull(row.chat_id) ?? 0,
    guid: stringOrNull(row.guid),
    display_name: stringOrNull(row.display_name),
    chat_identifier: stringOrNull(row.chat_identifier),
    participants: participantsFromJson(row.participants_json),
    service: stringOrNull(row.service),
    last_message_at: isoFromAppleDate(row.last_message_date),
  };
}

export default class IMessageConnector extends ConnectorRuntime {
  readonly definition: RuntimeConnectorDefinition = {
    key: 'imessage',
    name: 'iMessage',
    version: '1.0.0',
    faviconDomain: 'apple.com',
    description:
      'Read and send iMessage and SMS on a Mac by delegating every command to an existing os.shell connection. Reads ~/Library/Messages/chat.db and sends through Messages.app automation. Needs an os.shell connection on a Mac where Lobu has Full Disk Access (reads) and Automation -> Messages permission (send).',
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {},
    optionsSchema: {
      type: 'object',
      required: ['shell_connection_id'],
      properties: {
        shell_connection_id: {
          type: 'integer',
          minimum: 1,
          title: 'Shell connection ID',
          description:
            'Discover the existing os.shell connection with operations.listAvailable. Its device and policies govern all commands.',
        },
      },
      additionalProperties: false,
    },
    actions: {
      list_chats: action(
        'list_chats',
        'List chats',
        'Recent chats ordered by last message time, with participants and service.',
        'read',
        { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
      ),
      read_chat: action(
        'read_chat',
        'Read chat',
        "Read one chat's messages newest first. Pass next_cursor as before_rowid for the next page. Bodies over 2 KiB return text: null with text_truncated: true.",
        'read',
        {
          chat_id: { type: 'integer', minimum: 1 },
          before_rowid: {
            type: 'integer',
            minimum: 1,
            description: 'Row cursor returned as next_cursor by a previous page.',
          },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        },
        ['chat_id'],
      ),
      search_messages: action(
        'search_messages',
        'Search messages',
        'Case-sensitive literal substring search over message text, including bodies stored only in attributedBody. Blob attribute names are ignored. Bodies over 2 KiB are not searched. Pass next_cursor as before_rowid for the next page.',
        'read',
        {
          query: { type: 'string', minLength: 1, maxLength: MAX_SEARCH_LENGTH },
          chat_id: {
            type: 'integer',
            minimum: 1,
            description: 'Optional chat scope; search every chat when omitted.',
          },
          since: {
            type: 'string',
            format: 'date-time',
            description: 'Optional ISO timestamp lower bound.',
          },
          before_rowid: {
            type: 'integer',
            minimum: 1,
            description: 'Row cursor returned as next_cursor by a previous page.',
          },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 50 },
        },
        ['query'],
      ),
      send_message: action(
        'send_message',
        'Send message',
        'Send a text message through Messages.app automation, then confirm the outgoing row in chat.db. Returns delivered, sent_unconfirmed or failed.',
        'write',
        {
          chat_guid: {
            type: 'string',
            minLength: 1,
            maxLength: 255,
            description: 'Existing Messages chat GUID, for example iMessage;-;+15550001001.',
          },
          recipient: {
            type: 'string',
            minLength: 1,
            maxLength: 255,
            description: 'Phone number or email for a direct iMessage participant.',
          },
          text: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_SEND_LENGTH,
            description: 'Message body to send.',
          },
        },
        ['text'],
        { oneOf: [{ required: ['chat_guid'] }, { required: ['recipient'] }] },
      ),
    },
  };

  async execute(ctx: ActionContext): Promise<ActionResult> {
    if (!ctx.operations)
      return {
        success: false,
        error:
          'This Lobu host does not support connector operation delegation. Update the Lobu server.',
      };
    const connectionId = ctx.config.shell_connection_id;
    if (typeof connectionId !== 'number' || !Number.isSafeInteger(connectionId) || connectionId < 1)
      return {
        success: false,
        error: 'Configure shell_connection_id with an existing os.shell connection.',
      };
    switch (ctx.actionKey) {
      case 'list_chats':
        return this.listChats(ctx, connectionId);
      case 'read_chat':
        return this.readChat(ctx, connectionId);
      case 'search_messages':
        return this.searchMessages(ctx, connectionId);
      case 'send_message':
        return this.sendMessage(ctx, connectionId);
      default:
        throw new Error(`Unknown iMessage action: ${ctx.actionKey}`);
    }
  }

  private async listChats(ctx: ActionContext, connectionId: number): Promise<ActionResult> {
    const limit = listLimit(ctx.input);
    const result = await runSql(ctx, connectionId, listChatsSql(limit), 'imessage-list-chats');
    if (!('rows' in result)) return resultFromSqlFailure(result);
    return {
      success: true,
      output: { chats: result.rows.map(chatRow) },
    };
  }

  private async readChat(ctx: ActionContext, connectionId: number): Promise<ActionResult> {
    const chatId = assertChatId(ctx.input);
    const limit = readLimit(ctx.input);
    const before = beforeRowid(ctx.input);
    const result = await runSql(
      ctx,
      connectionId,
      readChatSql(chatId, before, limit),
      'imessage-read-chat',
    );
    if (!('rows' in result)) return resultFromSqlFailure(result);
    const messages = result.rows.map(mapMessageRow);
    const last = messages.at(-1);
    return {
      success: true,
      output: {
        chat_id: chatId,
        messages,
        next_cursor: messages.length === limit && last ? last.rowid : null,
      },
    };
  }

  private async searchMessages(
    ctx: ActionContext,
    connectionId: number,
  ): Promise<ActionResult> {
    const query = requiredString(ctx.input, 'query', MAX_SEARCH_LENGTH);
    const limit = searchLimit(ctx.input);
    const before = beforeRowid(ctx.input);
    const chatId = optionalChatId(ctx.input);
    const sinceInput = ctx.input.since;
    let since: string | null = null;
    if (sinceInput !== undefined) {
      if (typeof sinceInput !== 'string') throw new Error('since must be an ISO timestamp');
      since = appleNsSince(sinceInput);
    }
    const overFetch = Math.min(limit * 2, 100);
    const result = await runSql(
      ctx,
      connectionId,
      searchMessagesSql(query, chatId, since, before, overFetch),
      'imessage-search-messages',
    );
    if (!('rows' in result)) return resultFromSqlFailure(result);
    const matched = result.rows
      .map(mapMessageRow)
      .filter((message) => message.text !== null && message.text.includes(query));
    const messages = matched.slice(0, limit);
    // A short SQL batch can still hold more decoded matches than the page
    // size; only the absence of further scanned rows *and* matches ends paging.
    const exhausted = result.rows.length < overFetch;
    const nextCursor =
      exhausted && matched.length <= limit
        ? null
        : (messages.at(-1)?.rowid ?? numberOrNull(result.rows.at(-1)?.rowid) ?? null);
    return { success: true, output: { messages, next_cursor: nextCursor } };
  }

  private async sendMessage(ctx: ActionContext, connectionId: number): Promise<ActionResult> {
    const target = sendTarget(ctx.input);
    const text = requiredString(ctx.input, 'text', MAX_SEND_LENGTH);

    // The send is the first and only effectful child: the sentinel read rides
    // in the same `run`, so an approval card shows (and approving executes)
    // the actual send. sqlite3 takes its constant SQL as an argument and never
    // reads stdin, which leaves the AppleScript on stdin for osascript.
    const command = [
      `${quoteShellArg(SQLITE_BINARY)} -readonly -json ${CHAT_DB_PATH} ${quoteShellArg(outgoingSentinelSql())}`,
      [
        OSASCRIPT_BINARY,
        '-',
        target.kind === 'chat' ? 'chat' : 'recipient',
        target.kind === 'chat' ? target.chatGuid : target.recipient,
        text,
      ]
        .map(quoteShellArg)
        .join(' '),
    ].join(' && ');
    const send = await runShell(
      ctx,
      connectionId,
      command,
      SEND_SCRIPT,
      WRITE_TIMEOUT_MS,
      'imessage-send',
    );
    if (send.kind === 'receipt') return { success: true, output: { ...send.receipt } };
    if (send.kind === 'error') {
      // The sentinel query always prints one row, so empty stdout proves
      // sqlite3 failed and `&&` never reached osascript. Any other stdout
      // (login-profile noise included) cannot rule out a send.
      const details = parseShellError(send.error);
      const notSent =
        details !== null &&
        (details.stdout_head ?? '').trim() === '' &&
        (details.stdout ?? '').trim() === '';
      return {
        success: false,
        error: `${send.error} ${
          notSent
            ? 'The message was not sent: the pre-send database read failed before osascript ran.'
            : 'The message may already have been sent; inspect this run before retrying.'
        }`,
      };
    }
    const sentinel = parseSentinel(send.shell.stdout ?? '');

    const chatResult = await runSql(
      ctx,
      connectionId,
      target.kind === 'chat'
        ? chatByGuidSql(target.chatGuid)
        : chatByRecipientSql(target.recipient),
      'imessage-send-chat',
    );
    const resolvedChat = 'rows' in chatResult ? chatResult.rows[0] : undefined;
    const chatId = numberOrNull(resolvedChat?.chat_id);
    const chatGuid =
      target.kind === 'chat' ? target.chatGuid : stringOrNull(resolvedChat?.guid);
    const base = {
      run_id: send.runId,
      chat_id: chatId,
      chat_guid: chatGuid,
      recipient: target.kind === 'recipient' ? target.recipient : null,
    };
    if (sentinel === null) {
      return {
        success: true,
        output: {
          ...base,
          status: 'sent_unconfirmed',
          message: null,
          note: 'The pre-send outgoing row id was unreadable, so the sent row cannot be confirmed.',
        },
      };
    }

    const confirm = await runSql(
      ctx,
      connectionId,
      confirmSentSql(target, sentinel),
      'imessage-send-confirm',
    );
    if (!('rows' in confirm)) {
      return {
        success: true,
        output: {
          ...base,
          status: 'sent_unconfirmed',
          message: null,
          ...('receipt' in confirm
            ? { confirmation_receipt: confirm.receipt }
            : { confirmation_error: confirm.error }),
        },
      };
    }
    const message = confirm.rows[0] ? mapMessageRow(confirm.rows[0]) : null;
    if (!message) {
      return {
        success: true,
        output: {
          ...base,
          status: 'sent_unconfirmed',
          message: null,
          note: 'Messages has not written an outgoing row for this chat yet.',
        },
      };
    }
    const output = {
      ...base,
      chat_id: message.chat_id ?? base.chat_id,
      status: message.error !== 0 ? 'failed' : message.is_delivered ? 'delivered' : 'sent_unconfirmed',
      message,
    };
    return output.status === 'failed'
      ? { success: false, error: JSON.stringify(output), output }
      : { success: true, output };
  }
}
