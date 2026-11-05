import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionContext } from '@lobu/connector-sdk';
import IMessageConnector, {
  appleNsSince,
  decodeAttributedBody,
  isoFromAppleDate,
  quoteShellArg,
  type MessageRowOutput,
} from '../imessage';

// Generated on macOS with NSArchiver.archivedData(withRootObject:
// NSAttributedString(string: ...)) and committed as hex only. All strings are
// synthetic; no row from a real chat.db is used here.
const ASCII_BODY_HEX = [
  '040b73747265616d747970656481e803840140848484124e5341747472696275746564537472696e67008484084e534f626a',
  '656374008592848484084e53537472696e67019484012b1748656c6c6f2c2073796e74686574696320776f726c6421868402',
  '69490117928484840c4e5344696374696f6e6172790094840169008686',
].join('');
const EMOJI_BODY_HEX = [
  '040b73747265616d747970656481e803840140848484124e5341747472696275746564537472696e67008484084e534f626a',
  '656374008592848484084e53537472696e67019484012b14656d6f6a6920f09f9982f09f9a80207061727479868402694901',
  '10928484840c4e5344696374696f6e6172790094840169008686',
].join('');
const LONG_TEXT = 'long-synthetic-'.repeat(20);
const LONG_BODY_HEX = [
  '040b73747265616d747970656481e803840140848484124e5341747472696275746564537472696e67008484084e534f626a',
  '656374008592848484084e53537472696e67019484012b812c016c6f6e672d73796e7468657469632d6c6f6e672d73796e74',
  '68657469632d6c6f6e672d73796e7468657469632d6c6f6e672d73796e7468657469632d6c6f6e672d73796e746865746963',
  '2d6c6f6e672d73796e7468657469632d6c6f6e672d73796e7468657469632d6c6f6e672d73796e7468657469632d6c6f6e67',
  '2d73796e7468657469632d6c6f6e672d73796e7468657469632d6c6f6e672d73796e7468657469632d6c6f6e672d73796e74',
  '68657469632d6c6f6e672d73796e7468657469632d6c6f6e672d73796e7468657469632d6c6f6e672d73796e746865746963',
  '2d6c6f6e672d73796e7468657469632d6c6f6e672d73796e7468657469632d6c6f6e672d73796e7468657469632d6c6f6e67',
  '2d73796e7468657469632d6c6f6e672d73796e7468657469632d868402694901812c01928484840c4e5344696374696f6e61',
  '72790094840169008686',
].join('');

const APPLE_EPOCH_OFFSET_SECONDS = 978307200;
const OSASCRIPT = '/usr/bin/osascript';

const connector = new IMessageConnector();
let home: string;
let db: Database;
let osascriptStub: string;

function appleNs(iso: string): number {
  return (Date.parse(iso) / 1000 - APPLE_EPOCH_OFFSET_SECONDS) * 1e9;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function insertMessage(row: {
  id: number;
  chatId: number;
  guid: string;
  text: string | null;
  bodyHex?: string;
  handleId?: number;
  fromMe?: number;
  service: string;
  date: number;
  isDelivered?: number;
  isSent?: number;
  error?: number;
}): void {
  db.run(
    `INSERT INTO message
      (ROWID, guid, text, attributedBody, handle_id, is_from_me, service, has_attachments,
       date, is_delivered, is_sent, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [
      row.id,
      row.guid,
      row.text,
      row.bodyHex === undefined ? null : hexToBytes(row.bodyHex),
      row.handleId ?? null,
      row.fromMe ?? 0,
      row.service,
      row.date,
      row.isDelivered ?? 0,
      row.isSent ?? 0,
      row.error ?? 0,
    ],
  );
  db.run(
    'INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)',
    [row.chatId, row.id, row.date],
  );
}

function resetDb(): void {
  db.exec(`
    DELETE FROM chat_message_join;
    DELETE FROM chat_handle_join;
    DELETE FROM message;
    DELETE FROM handle;
    DELETE FROM chat;
  `);
  db.run("INSERT INTO chat VALUES (1, 'iMessage;-;+15550001001', '+15550001001', 'Synthetic One', 'iMessage')");
  db.run("INSERT INTO chat VALUES (2, 'SMS;-;+15550001002', '+15550001002', NULL, 'SMS')");
  db.run("INSERT INTO handle VALUES (1, '+15550001001')");
  db.run("INSERT INTO handle VALUES (2, '+15550001002')");
  db.run("INSERT INTO handle VALUES (3, '+15550001003')");
  db.run('INSERT INTO chat_handle_join VALUES (1, 1)');
  db.run('INSERT INTO chat_handle_join VALUES (1, 3)');
  db.run('INSERT INTO chat_handle_join VALUES (2, 2)');
  insertMessage({
    id: 1,
    chatId: 1,
    guid: 'synthetic-msg-1',
    text: 'Hello synthetic',
    handleId: 1,
    service: 'iMessage',
    date: appleNs('2026-01-01T10:00:00Z'),
  });
  insertMessage({
    id: 2,
    chatId: 1,
    guid: 'synthetic-msg-2',
    text: null,
    bodyHex: ASCII_BODY_HEX,
    fromMe: 1,
    service: 'iMessage',
    date: appleNs('2026-01-02T10:00:00Z'),
    isDelivered: 1,
    isSent: 1,
  });
  insertMessage({
    id: 3,
    chatId: 2,
    guid: 'synthetic-msg-3',
    text: '100% synthetic_real',
    handleId: 2,
    service: 'SMS',
    date: appleNs('2026-01-03T10:00:00Z'),
  });
  insertMessage({
    id: 4,
    chatId: 2,
    guid: 'synthetic-msg-4',
    text: '100 done',
    handleId: 2,
    service: 'SMS',
    date: appleNs('2026-01-03T11:00:00Z'),
  });
  insertMessage({
    id: 5,
    chatId: 1,
    guid: 'synthetic-msg-5',
    text: 'a_b',
    handleId: 1,
    service: 'iMessage',
    date: appleNs('2026-01-04T10:00:00Z'),
  });
  insertMessage({
    id: 6,
    chatId: 2,
    guid: 'synthetic-msg-6',
    text: 'axb',
    handleId: 2,
    service: 'SMS',
    date: appleNs('2026-01-04T12:00:00Z'),
  });
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'imessage-connector-test-'));
  await mkdir(join(home, 'Library/Messages'), { recursive: true });
  osascriptStub = join(home, 'osascript-stub');
  await writeFile(
    osascriptStub,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "$HOME/osascript-argv"\ncat > "$HOME/osascript-stdin"\necho sent\n`,
    { mode: 0o755 },
  );
  db = new Database(join(home, 'Library/Messages/chat.db'), { create: true });
  db.exec(`
    CREATE TABLE chat (
      ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT,
      display_name TEXT, service_name TEXT
    );
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER);
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB,
      handle_id INTEGER, is_from_me INTEGER, service TEXT, has_attachments INTEGER,
      date INTEGER, is_delivered INTEGER, is_sent INTEGER, error INTEGER
    );
    CREATE INDEX message_rowid ON message (ROWID);
    CREATE INDEX chat_message_join_chat ON chat_message_join (chat_id, message_id);
  `);
});
beforeEach(resetDb);
afterAll(async () => {
  db.close();
  await rm(home, { recursive: true, force: true });
});

type RequestLog = {
  connection_id: number;
  operation_key: string;
  idempotency_key: string;
  input: { command: string; stdin?: string; timeout_ms?: number };
};

type InvokeOptions = {
  receipt?: Record<string, unknown>;
  onSend?: () => void;
};

const completed = (output: unknown) => ({
  action: 'execute',
  status: 'completed',
  run_id: 789,
  output,
});

async function invoke(
  actionKey: string,
  input: Record<string, unknown>,
  options: InvokeOptions = {},
): Promise<{ result: Awaited<ReturnType<typeof connector.execute>>; requests: RequestLog[] }> {
  const requests: RequestLog[] = [];
  const ctx = {
    actionKey,
    input,
    config: { shell_connection_id: 123 },
    credentials: null,
    operations: {
      execute: async (request: RequestLog) => {
        requests.push(request);
        if (options.receipt) return options.receipt;
        // The real command runs; only the Messages automation binary is
        // swapped for a stub that records the argv and script it received.
        const isSend = request.input.command.includes(quoteShellArg(OSASCRIPT));
        const command = request.input.command.replace(
          quoteShellArg(OSASCRIPT),
          quoteShellArg(osascriptStub),
        );
        const child = Bun.spawn(['bash', '--noprofile', '--norc', '-c', command], {
          env: { ...process.env, HOME: home } as Record<string, string>,
          stdin:
            request.input.stdin === undefined
              ? 'ignore'
              : new Blob([request.input.stdin]),
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const stdout = await new Response(child.stdout).text();
        const stderr = await new Response(child.stderr).text();
        const exitCode = await child.exited;
        if (isSend && exitCode === 0) options.onSend?.();
        return completed({
          exit_code: exitCode,
          stdout,
          stderr,
          timed_out: false,
        });
      },
    },
  } as unknown as ActionContext;
  return { result: await connector.execute(ctx), requests };
}

describe('typedstream attributedBody decoding', () => {
  it('decodes ASCII, emoji and bodies longer than 255 bytes', () => {
    expect(decodeAttributedBody(ASCII_BODY_HEX)).toBe('Hello, synthetic world!');
    expect(decodeAttributedBody(EMOJI_BODY_HEX)).toBe('emoji 🙂🚀 party');
    expect(decodeAttributedBody(LONG_BODY_HEX)).toBe(LONG_TEXT);
  });
  it('accepts the uppercase hex SQLite hex() returns', () => {
    expect(decodeAttributedBody(ASCII_BODY_HEX.toUpperCase())).toBe(
      'Hello, synthetic world!',
    );
  });
  it('returns null for unknown or malformed blobs instead of throwing', () => {
    expect(decodeAttributedBody(ASCII_BODY_HEX.slice(0, 60))).toBeNull();
    expect(decodeAttributedBody('00'.repeat(32))).toBeNull();
    expect(decodeAttributedBody('zz')).toBeNull();
    expect(decodeAttributedBody('abc')).toBeNull();
    expect(decodeAttributedBody(null)).toBeNull();
    expect(decodeAttributedBody('')).toBeNull();
  });
  it('converts Apple epoch nanoseconds to ISO timestamps', () => {
    expect(isoFromAppleDate(0)).toBeNull();
    expect(isoFromAppleDate(null)).toBeNull();
    expect(isoFromAppleDate(appleNs('2026-01-04T12:00:00Z'))).toBe(
      '2026-01-04T12:00:00.000Z',
    );
    expect(appleNsSince('2026-01-04T12:00:00Z')).toBe('789220800000000000');
  });
});

describe('iMessage connector over the existing shell operation', () => {
  it('lists chats and participants in one shell run', async () => {
    const { result, requests } = await invoke('list_chats', { limit: 20 });
    expect(result.success).toBe(true);
    expect(requests).toHaveLength(1);
    const chats = result.output?.chats as Array<Record<string, unknown>>;
    expect(chats).toHaveLength(2);
    expect(chats[0]).toMatchObject({
      chat_id: 2,
      guid: 'SMS;-;+15550001002',
      display_name: null,
      participants: ['+15550001002'],
      service: 'SMS',
      last_message_at: '2026-01-04T12:00:00.000Z',
    });
    expect(chats[1]).toMatchObject({
      chat_id: 1,
      guid: 'iMessage;-;+15550001001',
      display_name: 'Synthetic One',
      participants: ['+15550001001', '+15550001003'],
      service: 'iMessage',
      last_message_at: '2026-01-04T10:00:00.000Z',
    });
  });

  it('pages messages newest first and decodes an attributedBody-only row', async () => {
    const first = await invoke('read_chat', { chat_id: 1, limit: 2 });
    expect(first.result.success).toBe(true);
    const page = first.result.output?.messages as MessageRowOutput[];
    expect(page.map((message) => message.rowid)).toEqual([5, 2]);
    expect(first.result.output?.next_cursor).toBe(2);
    expect(page[0]).toMatchObject({
      chat_id: 1,
      sender: '+15550001001',
      is_from_me: false,
      service: 'iMessage',
      text: 'a_b',
      text_source: 'text',
      has_attachments: false,
      sent_at: '2026-01-04T10:00:00.000Z',
    });
    expect(page[1]).toMatchObject({
      chat_id: 1,
      sender: 'me',
      is_from_me: true,
      text: 'Hello, synthetic world!',
      text_source: 'attributedBody',
      is_delivered: true,
      is_sent: true,
      error: 0,
    });

    const second = await invoke('read_chat', {
      chat_id: 1,
      before_rowid: 2,
      limit: 2,
    });
    expect(second.result.success).toBe(true);
    const rest = second.result.output?.messages as MessageRowOutput[];
    expect(rest.map((message) => message.rowid)).toEqual([1]);
    expect(second.result.output?.next_cursor).toBeNull();
  });

  it('searches attributedBody bodies without matching blob attribute names', async () => {
    const percent = await invoke('search_messages', { query: '100%' });
    expect(percent.result.success).toBe(true);
    expect(
      (percent.result.output?.messages as MessageRowOutput[]).map((message) => message.rowid),
    ).toEqual([3]);

    const underscore = await invoke('search_messages', { query: 'a_b' });
    expect(
      (underscore.result.output?.messages as MessageRowOutput[]).map((message) => message.rowid),
    ).toEqual([5]);

    // Row 2 has text = NULL; its body exists only in attributedBody.
    const body = await invoke('search_messages', { query: 'synthetic' });
    expect(
      (body.result.output?.messages as MessageRowOutput[]).map((message) => message.rowid),
    ).toEqual([3, 2, 1]);

    // The blob contains "NSAttributedString", but the decoded body does not.
    const attributeName = await invoke('search_messages', { query: 'Attribute' });
    expect(attributeName.result.success).toBe(true);
    expect(attributeName.result.output?.messages).toEqual([]);

    // instr() is byte/codepoint exact, so matching is case-sensitive.
    const capital = await invoke('search_messages', { query: 'Hello' });
    expect(
      (capital.result.output?.messages as MessageRowOutput[]).map((message) => message.rowid),
    ).toEqual([2, 1]);
    const lower = await invoke('search_messages', { query: 'hello' });
    expect(lower.result.output?.messages).toEqual([]);

    const scoped = await invoke('search_messages', { query: 'synthetic', chat_id: 2 });
    expect(
      (scoped.result.output?.messages as MessageRowOutput[]).map((message) => message.rowid),
    ).toEqual([3]);

    const since = await invoke('search_messages', {
      query: 'synthetic',
      since: '2026-01-03T00:00:00Z',
    });
    expect(
      (since.result.output?.messages as MessageRowOutput[]).map((message) => message.rowid),
    ).toEqual([3]);
  });

  it('pages search results and resumes a full prefilter batch from the last scanned row', async () => {
    const first = await invoke('search_messages', { query: 'synthetic', limit: 1 });
    expect(
      (first.result.output?.messages as MessageRowOutput[]).map((message) => message.rowid),
    ).toEqual([3]);
    expect(first.result.output?.next_cursor).toBe(3);

    const second = await invoke('search_messages', {
      query: 'synthetic',
      limit: 1,
      before_rowid: 3,
    });
    expect(
      (second.result.output?.messages as MessageRowOutput[]).map((message) => message.rowid),
    ).toEqual([2]);
    expect(second.result.output?.next_cursor).toBe(2);

    const third = await invoke('search_messages', {
      query: 'synthetic',
      limit: 1,
      before_rowid: 2,
    });
    expect(
      (third.result.output?.messages as MessageRowOutput[]).map((message) => message.rowid),
    ).toEqual([1]);
    expect(third.result.output?.next_cursor).toBeNull();

    // Two newer rows match only on attribute key names, so the first batch is
    // post-filtered to empty; the cursor still advances past the scanned rows.
    insertMessage({
      id: 10,
      chatId: 2,
      guid: 'synthetic-attribute-10',
      text: null,
      bodyHex: ASCII_BODY_HEX,
      handleId: 2,
      service: 'SMS',
      date: appleNs('2026-01-10T10:00:00Z'),
    });
    insertMessage({
      id: 9,
      chatId: 2,
      guid: 'synthetic-attribute-9',
      text: null,
      bodyHex: ASCII_BODY_HEX,
      handleId: 2,
      service: 'SMS',
      date: appleNs('2026-01-09T10:00:00Z'),
    });
    insertMessage({
      id: 8,
      chatId: 2,
      guid: 'synthetic-attribute-8',
      text: 'Attribute eight',
      handleId: 2,
      service: 'SMS',
      date: appleNs('2026-01-08T10:00:00Z'),
    });

    const emptyFirstBatch = await invoke('search_messages', { query: 'Attribute', limit: 1 });
    expect(emptyFirstBatch.result.success).toBe(true);
    expect(emptyFirstBatch.result.output?.messages).toEqual([]);
    expect(emptyFirstBatch.result.output?.next_cursor).toBe(9);

    const resumed = await invoke('search_messages', {
      query: 'Attribute',
      limit: 1,
      before_rowid: 9,
    });
    expect(
      (resumed.result.output?.messages as MessageRowOutput[]).map((message) => message.rowid),
    ).toEqual([8]);
    expect(resumed.result.output?.next_cursor).toBe(8);

    const afterResume = await invoke('search_messages', {
      query: 'Attribute',
      limit: 1,
      before_rowid: 8,
    });
    expect(afterResume.result.output?.messages).toEqual([]);
    expect(afterResume.result.output?.next_cursor).toBeNull();
  });

  it('keeps the cursor when a short batch still has more matches than the page', async () => {
    const first = await invoke('search_messages', { query: 'synthetic', limit: 2 });
    expect(
      (first.result.output?.messages as MessageRowOutput[]).map((message) => message.rowid),
    ).toEqual([3, 2]);
    expect(first.result.output?.next_cursor).toBe(2);

    const rest = await invoke('search_messages', {
      query: 'synthetic',
      limit: 2,
      before_rowid: 2,
    });
    expect(
      (rest.result.output?.messages as MessageRowOutput[]).map((message) => message.rowid),
    ).toEqual([1]);
    expect(rest.result.output?.next_cursor).toBeNull();
  });

  it('keeps SQL injection attempts literal and runs no shell substitution', async () => {
    const marker = join(home, 'sql-injection-marker');
    const injected = `'; CREATE TABLE pwned(x); -- $(touch ${marker})`;
    const first = await invoke('search_messages', { query: injected });
    expect(first.result.success).toBe(true);
    expect(first.result.output?.messages).toEqual([]);

    const wildcard = await invoke('search_messages', {
      query: "x%' OR 1=1 --",
    });
    expect(wildcard.result.output?.messages).toEqual([]);

    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pwned'")
      .all();
    expect(tables).toEqual([]);
    expect(existsSync(marker)).toBe(false);

    const stillThere = await invoke('list_chats', {});
    expect(stillThere.result.success).toBe(true);
  });

  it('returns a pending approval receipt without inventing a result', async () => {
    const receipt = {
      action: 'execute',
      status: 'pending_approval',
      run_id: 456,
      approval_url: 'https://gateway.test/approval',
      message: 'Approval needed',
    };
    const { result, requests } = await invoke('list_chats', {}, { receipt });
    expect(result).toEqual({ success: true, output: receipt });
    expect(requests).toHaveLength(1);
  });

  it('gates the send itself, so approving the one pending child sends the message', async () => {
    const receipt = {
      action: 'execute',
      status: 'pending_approval',
      run_id: 457,
      approval_url: 'https://gateway.test/approval',
    };
    const { result, requests } = await invoke(
      'send_message',
      { chat_guid: 'iMessage;-;+15550001001', text: 'synthetic gated' },
      { receipt },
    );
    expect(result).toEqual({ success: true, output: receipt });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.idempotency_key).toBe('imessage-send');
    expect(requests[0]?.input.command).toContain(quoteShellArg(OSASCRIPT));
    expect(requests[0]?.input.command).toContain(quoteShellArg('synthetic gated'));
    expect(requests[0]?.input.stdin).toContain('on run argv');
  });

  it('reports a shell failure with the run id and stderr', async () => {
    const { result } = await invoke('list_chats', {}, {
      receipt: completed({
        exit_code: 1,
        stdout: '',
        stderr: 'Error: unable to open database file',
        timed_out: false,
      }),
    });
    expect(result.success).toBe(false);
    expect(JSON.parse(String(result.error))).toMatchObject({
      run_id: 789,
      exit_code: 1,
      stderr: 'Error: unable to open database file',
    });
  });

  it('reports a truncated shell page as a lower-limit error', async () => {
    const { result } = await invoke('read_chat', { chat_id: 1, limit: 10 }, {
      receipt: completed({
        exit_code: 0,
        stdout: 'x'.repeat(1_100_000),
        stderr: '',
        timed_out: false,
      }),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('lower');
    expect(result.error).toContain('limit');
    expect(result.error).not.toContain('invalid JSON');
  });

  it('marks an oversized body as truncated instead of returning it', async () => {
    insertMessage({
      id: 11,
      chatId: 1,
      guid: 'synthetic-huge-body',
      text: null,
      bodyHex: ASCII_BODY_HEX + '00'.repeat(4096),
      handleId: 1,
      service: 'iMessage',
      date: appleNs('2026-01-11T10:00:00Z'),
    });
    const { result } = await invoke('read_chat', { chat_id: 1, limit: 1 });
    expect(result.success).toBe(true);
    const [message] = result.output?.messages as MessageRowOutput[];
    expect(message).toMatchObject({
      rowid: 11,
      text: null,
      text_source: null,
      text_truncated: true,
    });
  });

  it('rejects unsafe identifiers, missing targets and invalid bounds before dispatch', async () => {
    await expect(invoke('read_chat', { chat_id: 0 })).rejects.toThrow('chat_id');
    await expect(invoke('read_chat', { chat_id: '1' })).rejects.toThrow('chat_id');
    await expect(invoke('read_chat', { chat_id: 1, limit: 101 })).rejects.toThrow('1..100');
    await expect(invoke('search_messages', { query: 'x', limit: 51 })).rejects.toThrow('1..50');
    await expect(invoke('list_chats', { limit: 101 })).rejects.toThrow('1..100');
    await expect(
      invoke('send_message', { text: 'hello' }),
    ).rejects.toThrow('exactly one');
    await expect(
      invoke('send_message', {
        chat_guid: 'iMessage;-;+15550001001',
        recipient: '+15550001001',
        text: 'hello',
      }),
    ).rejects.toThrow('exactly one');
    await expect(
      invoke('send_message', { chat_guid: '--help', text: 'hello' }),
    ).rejects.toThrow('chat GUID');
    await expect(
      invoke('send_message', { recipient: '+15550001001', text: '' }),
    ).rejects.toThrow('text is required');
    await expect(
      invoke('search_messages', { query: 'x', since: 'not-a-date' }),
    ).rejects.toThrow('ISO timestamp');

    expect(
      await connector.execute({
        actionKey: 'list_chats',
        input: {},
        config: {},
        credentials: null,
      }),
    ).toMatchObject({ success: false, error: expect.stringContaining('host') });

    expect(
      await connector.execute({
        actionKey: 'list_chats',
        input: {},
        config: { shell_connection_id: 0 },
        credentials: null,
        operations: { execute: async () => completed({}) },
      } as ActionContext),
    ).toMatchObject({ success: false, error: expect.stringContaining('shell_connection_id') });
  });

  it('sends through a fixed AppleScript with quoted argv and confirms the row', async () => {
    const marker = join(home, 'send-injection-marker');
    const text = `hello 'synthetic' "$(touch ${marker})"; \`touch ${marker}\``;
    const { result, requests } = await invoke(
      'send_message',
      { chat_guid: 'iMessage;-;+15550001001', text },
      {
        onSend: () => {
          insertMessage({
            id: 7,
            chatId: 1,
            guid: 'synthetic-sent-7',
            text,
            fromMe: 1,
            service: 'iMessage',
            date: appleNs('2026-01-05T10:00:00Z'),
            isDelivered: 1,
            isSent: 1,
          });
        },
      },
    );
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      status: 'delivered',
      chat_id: 1,
      chat_guid: 'iMessage;-;+15550001001',
      recipient: null,
      message: {
        rowid: 7,
        chat_id: 1,
        sender: 'me',
        is_from_me: true,
        text,
        is_delivered: true,
        error: 0,
      },
    });

    const send = requests.find((request) => request.input.command.includes(OSASCRIPT));
    expect(send).toBeDefined();
    expect(send?.input.stdin).toContain('on run argv');
    expect(send?.input.command).toContain(
      "'chat' 'iMessage;-;+15550001001'",
    );
    expect(send?.input.command).toContain(quoteShellArg(text));
    expect(await readFile(join(home, 'osascript-stdin'), 'utf8')).toContain('on run argv');
    expect(await readFile(join(home, 'osascript-argv'), 'utf8')).toBe(
      `-\nchat\niMessage;-;+15550001001\n${text}\n`,
    );
    expect(requests[0]).toBe(send);
    expect(existsSync(marker)).toBe(false);
  });

  it('sends to a direct recipient and reports sent_unconfirmed without delivery', async () => {
    const { result, requests } = await invoke(
      'send_message',
      { recipient: '+15550001001', text: 'synthetic outbound' },
      {
        onSend: () => {
          insertMessage({
            id: 8,
            chatId: 1,
            guid: 'synthetic-sent-8',
            text: 'synthetic outbound',
            fromMe: 1,
            service: 'iMessage',
            date: appleNs('2026-01-05T10:00:00Z'),
          });
        },
      },
    );
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      status: 'sent_unconfirmed',
      chat_id: 1,
      chat_guid: 'iMessage;-;+15550001001',
      recipient: '+15550001001',
      message: { rowid: 8, is_delivered: false },
    });
    const send = requests.find((request) => request.input.command.includes(OSASCRIPT));
    expect(send?.input.command).toContain("'recipient' '+15550001001'");
  });

  it('reports a failed row as a failed action', async () => {
    const { result } = await invoke(
      'send_message',
      { chat_guid: 'iMessage;-;+15550001001', text: 'synthetic failed' },
      {
        onSend: () => {
          insertMessage({
            id: 9,
            chatId: 1,
            guid: 'synthetic-sent-9',
            text: 'synthetic failed',
            fromMe: 1,
            service: 'iMessage',
            date: appleNs('2026-01-05T10:00:00Z'),
            error: 22,
          });
        },
      },
    );
    expect(result.success).toBe(false);
    const failure = JSON.parse(String(result.error));
    expect(failure).toMatchObject({
      status: 'failed',
      chat_id: 1,
      message: { rowid: 9, error: 22 },
    });
  });

  it('says the message was not sent when the pre-send read failed', async () => {
    const { result } = await invoke(
      'send_message',
      { chat_guid: 'iMessage;-;+15550001001', text: 'synthetic not sent' },
      {
        receipt: completed({
          exit_code: 1,
          stdout: '',
          stderr: 'Error: no such table: message',
          timed_out: false,
        }),
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('was not sent');
    expect(result.error).not.toContain('may already have been sent');
  });

  it('warns about a possible send when osascript ran and failed', async () => {
    const { result } = await invoke(
      'send_message',
      { chat_guid: 'iMessage;-;+15550001001', text: 'synthetic maybe sent' },
      {
        receipt: completed({
          exit_code: 1,
          stdout: '[{"rowid":2}]\n',
          stderr: 'osascript: not authorized',
          timed_out: false,
        }),
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('may already have been sent');
    expect(result.error).not.toContain('was not sent');
  });

  it('warns about a possible send when login-profile output precedes the sentinel', async () => {
    const { result } = await invoke(
      'send_message',
      { chat_guid: 'iMessage;-;+15550001001', text: 'synthetic profile noise' },
      {
        receipt: completed({
          exit_code: 1,
          stdout: 'synthetic profile banner\n[{"rowid":2}]\n',
          stderr: 'osascript: timed out',
          timed_out: false,
        }),
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('may already have been sent');
    expect(result.error).not.toContain('was not sent');
  });

  it('quotes an injection recipient and body as single argv values', async () => {
    const marker = join(home, 'recipient-injection-marker');
    const recipient = `+1555'; touch ${marker}; echo '@example.test`;
    const text = `body \`touch ${marker}\``;
    const { result, requests } = await invoke('send_message', { recipient, text });
    expect(result.success).toBe(true);
    expect(result.output?.status).toBe('sent_unconfirmed');
    const send = requests.find((request) => request.input.command.includes(OSASCRIPT));
    expect(send?.input.command).toContain(quoteShellArg(recipient));
    expect(send?.input.command).toContain(quoteShellArg(text));
    expect(existsSync(marker)).toBe(false);
  });

  it('quotes arbitrary argv as one literal shell argument', async () => {
    const marker = join(home, 'quote-injection-marker');
    const value = `a'b\n"$(touch ${marker})" \`touch ${marker}\`; touch ${marker}`;
    const child = Bun.spawn(
      ['bash', '--noprofile', '--norc', '-c', `printf '%s' ${quoteShellArg(value)}`],
      { stdout: 'pipe' },
    );
    const stdout = await new Response(child.stdout).text();
    expect(stdout).toBe(value);
    expect(await child.exited).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });
});
