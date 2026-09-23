import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { connectorSdkMock } from './connector-sdk.mock';
import { runSync } from './sync-harness';

mock.module('@lobu/connector-sdk', () => connectorSdkMock());

// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let MicrosoftOutlookConnector: any;

beforeAll(async () => {
  MicrosoftOutlookConnector = (await import('../microsoft_outlook')).default;
});

// `folder` is free-form connection config interpolated into the Graph path, and
// Graph takes an opaque folder id there as well as a well-known name. Reserved
// characters must survive as one path segment: a raw '/' retargets the request.
const FOLDER_ID = 'AQMkAGI2/Ly8+Zm9sZGVy=';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function graphMessage(id: string) {
  return {
    id,
    conversationId: `conversation-${id}`,
    subject: `Subject ${id}`,
    bodyPreview: `Preview ${id}`,
    from: { emailAddress: { name: 'Sender', address: 'sender@example.com' } },
    toRecipients: [{ emailAddress: { name: 'Recipient', address: 'to@example.com' } }],
    ccRecipients: [],
    receivedDateTime: '2026-08-20T10:00:00Z',
    sentDateTime: '2026-08-20T09:59:00Z',
    hasAttachments: false,
    importance: 'normal',
    isRead: true,
    webLink: `https://outlook.office.com/mail/${id}`,
  };
}

function graphEvent(id: string) {
  return {
    id,
    subject: `Event ${id}`,
    bodyPreview: `Agenda ${id}`,
    organizer: { emailAddress: { name: 'Organizer', address: 'owner@example.com' } },
    attendees: [{ emailAddress: { name: 'Guest', address: 'guest@example.com' } }],
    start: { dateTime: '2026-08-28T10:00:00Z', timeZone: 'UTC' },
    end: { dateTime: '2026-08-28T11:00:00Z', timeZone: 'UTC' },
    location: { displayName: 'Room 1' },
    isAllDay: false,
    isCancelled: false,
    webLink: `https://outlook.office.com/calendar/${id}`,
    createdDateTime: '2026-08-01T10:00:00Z',
  };
}

describe('MicrosoftOutlookConnector runtime', () => {
  test('requires OAuth before issuing a Graph request', async () => {
    globalThis.fetch = (async () => {
      throw new Error('Graph was called without credentials');
    }) as typeof fetch;

    const connector = new MicrosoftOutlookConnector();

    await expect(
      runSync(connector, { feedKey: 'messages', config: {}, credentials: null, checkpoint: {} })
    ).rejects.toThrow('Microsoft Outlook requires OAuth authentication');
  });

  test('encodes an opaque mail-folder id and stores whole pages until max_results', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      urls.push(url);
      const page = urls.length === 1
        ? { value: [graphMessage('one')], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/page-2' }
        : { value: [graphMessage('two'), graphMessage('three')], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/page-3' };
      return Response.json(page);
    }) as typeof fetch;

    const connector = new MicrosoftOutlookConnector();
    const result = await runSync(connector, {
      feedKey: 'messages',
      config: { folder: FOLDER_ID, max_results: 2, lookback_days: 30 },
      credentials: { accessToken: 'token' },
      checkpoint: {},
    });

    expect(new URL(urls[0]).pathname).toContain(
      '/mailFolders/AQMkAGI2%2FLy8%2BZm9sZGVy%3D/messages'
    );
    expect(urls[1]).toBe('https://graph.microsoft.com/v1.0/page-2');
    // The cap is checked between pages: page 2 is stored whole, not cut at two.
    expect(result.events.map((event: { origin_id: string }) => event.origin_id)).toEqual([
      'outlook_msg_one',
      'outlook_msg_two',
      'outlook_msg_three',
    ]);
    expect(result.events[0]).toMatchObject({
      origin_type: 'email',
      author_name: 'Sender',
      metadata: { from: 'sender@example.com', to: 'Recipient', is_read: true },
    });
    // Each page commits with the link to the first page it did not read.
    expect(result.commits.map((c) => (c.checkpoint as { pending?: { next_link: string } }).pending?.next_link)).toEqual([
      'https://graph.microsoft.com/v1.0/page-2',
      'https://graph.microsoft.com/v1.0/page-3',
    ]);
    expect(result.status).toBe('more');
  });

  test('resumes a capped traversal from its saved link and closes the window at its end', async () => {
    const window = { start: '2026-09-01T00:00:00.000Z', end: '2026-09-02T00:00:00.000Z' };
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(typeof input === 'string' ? input : input.toString());
      return Response.json({ value: [graphMessage('four')] });
    }) as typeof fetch;

    const result = await runSync(new MicrosoftOutlookConnector(), {
      feedKey: 'messages',
      config: { max_results: 50 },
      credentials: { accessToken: 'token' },
      checkpoint: { pending: { window, next_link: 'https://graph.microsoft.com/v1.0/page-3' } },
    });

    expect(urls).toEqual(['https://graph.microsoft.com/v1.0/page-3']);
    expect(result.events.map((e: { origin_id: string }) => e.origin_id)).toEqual(['outlook_msg_four']);
    expect(result.checkpoint).toEqual({ last_sync_at: window.end });
    expect(result.status).toBe('complete');
  });

  test('restarts the saved window from its first page when Graph retires the link', async () => {
    const window = { start: '2026-09-01T00:00:00.000Z', end: '2026-09-02T00:00:00.000Z' };
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      urls.push(url);
      if (urls.length === 1) return new Response('expired', { status: 410 });
      return Response.json({ value: [graphMessage('again')] });
    }) as typeof fetch;

    const result = await runSync(new MicrosoftOutlookConnector(), {
      feedKey: 'messages',
      config: { max_results: 50 },
      credentials: { accessToken: 'token' },
      checkpoint: { pending: { window, next_link: 'https://graph.microsoft.com/v1.0/stale' } },
    });

    expect(urls[0]).toBe('https://graph.microsoft.com/v1.0/stale');
    const restarted = decodeURIComponent(urls[1]);
    expect(restarted).toContain(`receivedDateTime ge ${window.start} and receivedDateTime lt ${window.end}`);
    expect(result.checkpoint).toEqual({ last_sync_at: window.end });
  });

  test('emits an origin_type the feed declares as an event kind', async () => {
    globalThis.fetch = (async () => Response.json({ value: [graphEvent('meeting')] })) as typeof fetch;

    const connector = new MicrosoftOutlookConnector();
    const result = await runSync(connector, {
      feedKey: 'calendar',
      config: { max_results: 10, lookback_days: 7, lookahead_days: 30 },
      credentials: { accessToken: 'token' },
      checkpoint: {},
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      origin_id: 'outlook_evt_meeting',
      origin_type: 'calendar_event',
      metadata: {
        organizer: 'owner@example.com',
        attendee_count: 1,
        start_time: '2026-08-28T10:00:00Z',
      },
    });
    expect(
      Object.keys(connector.definition.feeds.calendar.eventKinds)
    ).toContain(result.events[0].origin_type);
  });
});

describe('Outlook attachment download', () => {
  const PDF = Buffer.from('%PDF-1.7\nbinary\x00bytes');
  const CSV = 'sku,qty\nA1,3\n';

  const FILE_ATTACHMENT = {
    id: 'att-file',
    name: 'invoice.pdf',
    contentType: 'application/pdf',
    size: PDF.length,
    isInline: false,
    '@odata.type': '#microsoft.graph.fileAttachment',
    contentBytes: PDF.toString('base64'),
  };
  const TEXT_ATTACHMENT = {
    id: 'att-csv',
    name: 'rows.csv',
    contentType: 'text/csv',
    size: CSV.length,
    isInline: false,
    '@odata.type': '#microsoft.graph.fileAttachment',
    contentBytes: Buffer.from(CSV).toString('base64'),
  };
  // A OneDrive link: listed like any other attachment but with no bytes at all.
  const REFERENCE_ATTACHMENT = {
    id: 'att-ref',
    name: 'shared-deck.pptx',
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    size: 1024,
    isInline: false,
    '@odata.type': '#microsoft.graph.referenceAttachment',
  };

  function setup(attachments = [FILE_ATTACHMENT, TEXT_ATTACHMENT, REFERENCE_ATTACHMENT]) {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      const single = url.match(/\/attachments\/([^/?]+)/);
      const body = single
        ? attachments.find((a) => a.id === single[1])
        : { value: attachments.map(({ contentBytes: _drop, ...rest }) => rest) };
      return new Response(JSON.stringify(body ?? {}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const connector = new MicrosoftOutlookConnector();
    const run = (actionKey: string, input: Record<string, unknown>) =>
      connector.execute({
        actionKey,
        input,
        credentials: { accessToken: 'synthetic-token' },
      });
    return { run, urls };
  }

  test('list_attachments names every attachment, bytes excluded', async () => {
    const { run, urls } = setup();
    const result = await run('list_attachments', { message_id: 'msg-1' });

    expect(result.success).toBe(true);
    expect(result.output.attachments).toEqual([
      { attachment_id: 'att-file', filename: 'invoice.pdf', mime_type: 'application/pdf', size_bytes: PDF.length, is_inline: false, type: '#microsoft.graph.fileAttachment' },
      { attachment_id: 'att-csv', filename: 'rows.csv', mime_type: 'text/csv', size_bytes: CSV.length, is_inline: false, type: '#microsoft.graph.fileAttachment' },
      { attachment_id: 'att-ref', filename: 'shared-deck.pptx', mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', size_bytes: 1024, is_inline: false, type: '#microsoft.graph.referenceAttachment' },
    ]);
    // Graph inlines contentBytes into the LIST response unless $select excludes
    // it — a 20 MB reply the caller never asked for, and an OOM on the isolate.
    expect(urls[0]).toContain('$select=id,name,contentType,size,isInline');
    expect(urls[0]).not.toContain('contentBytes');
  });

  test('a binary attachment is published byte-identical and not inlined', async () => {
    const { run } = setup();
    const result = await run('download_attachment', {
      message_id: 'msg-1',
      attachment_id: 'att-file',
    });

    expect(result.success).toBe(true);
    const [attachment] = result.output.attachments;
    expect(Buffer.from(attachment.data, 'base64')).toEqual(PDF);
    expect(attachment.filename).toBe('invoice.pdf');
    expect(attachment.mime_type).toBe('application/pdf');
    expect(result.output).not.toHaveProperty('content');
  });

  test('a text attachment is attached AND inlined', async () => {
    const { run } = setup();
    const result = await run('download_attachment', {
      message_id: 'msg-1',
      attachment_id: 'att-csv',
    });
    expect(result.output.content).toBe(CSV);
    expect(Buffer.from(result.output.attachments[0].data, 'base64').toString()).toBe(CSV);
  });

  test('a reference attachment is refused with the reason, not an empty file', async () => {
    const { run } = setup();
    const result = await run('download_attachment', {
      message_id: 'msg-1',
      attachment_id: 'att-ref',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('shared-deck.pptx');
    expect(result.error).toContain('referenceAttachment');
  });

  test('an oversized attachment is refused on its declared size', async () => {
    const { run } = setup([{ ...FILE_ATTACHMENT, size: 64 * 1024 * 1024 }]);
    const result = await run('download_attachment', {
      message_id: 'msg-1',
      attachment_id: 'att-file',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('download limit');
  });

  test('missing identifiers are refused before any request', async () => {
    const { run, urls } = setup();
    expect((await run('download_attachment', { attachment_id: 'att-file' })).error).toContain('message_id');
    expect((await run('download_attachment', { message_id: 'msg-1' })).error).toContain('attachment_id');
    expect((await run('list_attachments', {})).error).toContain('message_id');
    expect(urls).toHaveLength(0);
  });

  test('an unknown action is reported, not silently ignored', async () => {
    const { run } = setup();
    expect((await run('send_email', {})).error).toContain('Unknown action');
  });
});
