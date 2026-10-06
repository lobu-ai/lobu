import { describe, expect, test } from 'bun:test';
import { createAjv } from '@lobu/core/ajv';
// From source, not '@lobu/connector-sdk': other files in the same bun process
// replace that module with a stub whose client throws on use.
import { createHttpClient } from '../../../connector-sdk/src/http-client';
import { compileGoogleActions, executeGoogleAction } from '../_google/actions';
import {
  buildGoogleRequest,
  type DiscoveryDocument,
  discoveryMethods,
  findMethod,
} from '../_google/discovery';
import { classifyGoogleError } from '../_google/errors';
import { GOOGLE_API_POLICIES } from '../_google/policies';
import GoogleCalendarConnector from '../google_calendar';
import GoogleDriveConnector from '../google_drive';
import GmailConnector from '../google_gmail';

const docs: Record<string, DiscoveryDocument> = Object.fromEntries(
  await Promise.all(
    Object.keys(GOOGLE_API_POLICIES).map(async (api) => [
      api,
      (await import(`../_google/discovery/${api}.json`)).default as DiscoveryDocument,
    ])
  )
);
const compiledApis = Object.fromEntries(
  Object.entries(docs).map(([api, doc]) => [api, compileGoogleActions(doc, GOOGLE_API_POLICIES[api])])
);

// Same construction as packages/server/src/operations/input-validation.ts.
const serverAjv = createAjv({ allErrors: false, strict: false, coerceTypes: false });

describe('Discovery-compiled Google actions', () => {
  test('coverage report', () => {
    const rows = Object.entries(compiledApis).map(([api, c]) => {
      const methods = discoveryMethods(c.doc).length;
      const sizes = Object.values(c.actions)
        .map((a) => JSON.stringify(a.inputSchema).length)
        .sort((a, b) => a - b);
      const reasons: Record<string, number> = {};
      for (const s of c.skipped) reasons[s.reason] = (reasons[s.reason] ?? 0) + 1;
      return {
        api,
        methods,
        exposed: methods - c.skipped.length,
        actions: Object.keys(c.actions).length,
        reads: Object.values(c.actions).filter((a) => a.kind === 'read').length,
        skipped: JSON.stringify(reasons),
        uploadOnly: discoveryMethods(c.doc).filter((m) => m.supportsMediaUpload).length,
        schemaP50: sizes[Math.floor(sizes.length / 2)],
        schemaMax: sizes[sizes.length - 1],
      };
    });
    console.table(rows);
    expect(rows.length).toBe(9);
  });

  test('every method is either an action or skipped with a reason, never silently lost', () => {
    for (const c of Object.values(compiledApis)) {
      const exposed = new Set([...c.targets.values()].map((t) => t.method.id));
      const skipped = new Set(c.skipped.map((s) => s.methodId));
      for (const method of discoveryMethods(c.doc)) {
        expect(exposed.has(method.id) !== skipped.has(method.id)).toBe(true);
      }
    }
  });

  test('push notification setup and teardown stay outside agent actions', () => {
    for (const [api, ids] of Object.entries({
      calendar_v3: ['calendar.events.watch', 'calendar.channels.stop'],
      drive_v3: ['drive.files.watch', 'drive.channels.stop'],
      gmail_v1: ['gmail.users.watch', 'gmail.users.stop'],
    })) {
      const exposed = [...compiledApis[api].targets.values()].map((target) => target.method.id);
      for (const id of ids) expect(exposed).not.toContain(id);
    }
  });

  test.each(['events_insert', 'events_patch', 'events_update'])(
    'Calendar %s accepts a local dateTime with a timeZone, as Google does',
    (key) => {
      // Google: "A time zone offset is required unless a time zone is
      // explicitly specified in timeZone." Strict RFC 3339 would refuse it.
      const validate = serverAjv.compile(compiledApis.calendar_v3.actions[key].inputSchema as object);
      const body = {
        summary: 'Standup',
        start: { dateTime: '2026-10-07T10:00:00', timeZone: 'Europe/London' },
        end: { dateTime: '2026-10-07T10:15:00', timeZone: 'Europe/London' },
      };
      expect(validate({ eventId: 'E1', body }), JSON.stringify(validate.errors)).toBe(true);
    }
  );

  test('every input schema compiles under the server operation validator', () => {
    const failures: string[] = [];
    for (const c of Object.values(compiledApis)) {
      for (const action of Object.values(c.actions)) {
        try {
          serverAjv.compile(action.inputSchema as object);
        } catch (error) {
          failures.push(`${c.doc.name}.${action.key}: ${(error as Error).message}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  test('Gmail message and draft schemas accept base64url, including omitted padding', () => {
    for (const raw of ['-w==', '_w', 'SGVsbG8']) {
      for (const key of ['users_messages_send', 'users_messages_insert', 'users_messages_import']) {
        const validate = serverAjv.compile(compiledApis.gmail_v1.actions[key].inputSchema as object);
        expect(validate({ body: { raw } })).toBe(true);
      }
      for (const key of ['users_drafts_create', 'users_drafts_update', 'users_drafts_send']) {
        const validate = serverAjv.compile(compiledApis.gmail_v1.actions[key].inputSchema as object);
        expect(validate({ id: 'D1', body: { message: { raw } } })).toBe(true);
      }
    }
  });

  test('input schemas fit the listing budget, degrading nested types before the body itself', () => {
    const over = Object.values(compiledApis).flatMap((c) =>
      Object.values(c.actions)
        .filter((a) => JSON.stringify(a.inputSchema).length > 12 * 1024)
        .map((a) => `${c.doc.name}.${a.key}`)
    ).sort();
    // Drive's `File` has ~70 writable fields of its own; collapsing stops at the
    // request type rather than hiding the fields a caller actually sets.
    expect(over).toEqual(['drive.files_copy', 'drive.files_create', 'drive.files_update']);

    const insert = compiledApis.calendar_v3.actions.events_insert.inputSchema as {
      $defs: Record<string, { properties?: Record<string, { description?: string }> }>;
    };
    expect(Object.keys(insert.$defs)).toEqual(expect.arrayContaining(['Event', 'EventDateTime', 'EventAttendee']));
    expect(insert.$defs.Event.properties?.start).toEqual({
      $ref: '#/$defs/EventDateTime',
      description: 'The (inclusive) start time of the event.',
    });

    const batch = JSON.stringify(compiledApis.sheets_v4.actions.spreadsheets_batchUpdate.inputSchema);
    expect(batch).toContain('"title":"AddSheetRequest"');
  });

  test('a reads-only scope ladder rung authorizes reads, writes need the narrowest write scope', () => {
    const cal = compiledApis.calendar_v3.actions;
    expect(cal.events_list).toMatchObject({
      kind: 'read',
      requiredScopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    });
    for (const key of ['events_insert', 'events_patch', 'events_delete']) {
      expect(cal[key]).toMatchObject({
        kind: 'write',
        requiredScopes: ['https://www.googleapis.com/auth/calendar.events'],
      });
    }
    expect(cal.events_delete.annotations).toMatchObject({ destructiveHint: true });
    expect(cal.freebusy_query.kind).toBe('read');
    // `gmail.send` is narrower, but every connection already holds compose,
    // which also authorizes send: requiring send would demand a needless upgrade.
    expect(compiledApis.gmail_v1.actions.users_messages_send.requiredScopes).toEqual([
      'https://www.googleapis.com/auth/gmail.compose',
    ]);
    expect(compiledApis.gmail_v1.actions.users_labels_create.requiredScopes).toEqual([
      'https://www.googleapis.com/auth/gmail.labels',
    ]);
  });

  test.each([
    ['google.calendar', GoogleCalendarConnector],
    ['google.gmail', GmailConnector],
    ['google.drive', GoogleDriveConnector],
  ])('%s: every scope an action requires can be granted', (_, Connector) => {
    // The server requests an upgrade only for scopes the auth method lists as
    // optional, so a required scope outside both lists can never be granted.
    const definition = new Connector().definition;
    const oauth = definition.authSchema.methods[0] as { requiredScopes: string[]; optionalScopes?: string[] };
    const grantable = new Set([...oauth.requiredScopes, ...(oauth.optionalScopes ?? [])]);
    const ungrantable = Object.values(definition.actions).flatMap((action) =>
      (action.requiredScopes ?? []).filter((scope) => !grantable.has(scope)).map((scope) => `${action.key}: ${scope}`)
    );
    expect(ungrantable).toEqual([]);
  });
});

/**
 * Differential: the requests today's hand-written actions send, rebuilt from
 * Discovery. Each expected URL is copied from the connector source it replaces.
 */
describe('Discovery requests match the hand-written connectors', () => {
  const cal = docs.calendar_v3;
  const calBase = 'https://www.googleapis.com/calendar/v3';

  test('calendar get/patch/delete/insert', () => {
    const input = { calendarId: 'team@example.com', eventId: 'ev 1' };
    expect(buildGoogleRequest(cal, findMethod(cal, 'calendar.events.get'), input)).toMatchObject({
      method: 'GET',
      url: `${calBase}/calendars/${encodeURIComponent('team@example.com')}/events/${encodeURIComponent('ev 1')}`,
    });
    expect(
      buildGoogleRequest(cal, findMethod(cal, 'calendar.events.patch'), { ...input, body: { summary: 'x' } })
    ).toMatchObject({ method: 'PATCH', body: '{"summary":"x"}' });
    expect(buildGoogleRequest(cal, findMethod(cal, 'calendar.events.delete'), input).method).toBe('DELETE');
    expect(
      buildGoogleRequest(cal, findMethod(cal, 'calendar.events.insert'), {
        calendarId: 'primary',
        body: { summary: 's', start: { dateTime: 'a' }, end: { dateTime: 'b' } },
      })
    ).toMatchObject({ method: 'POST', url: `${calBase}/calendars/primary/events` });
  });

  test('drive get_file and download_file', () => {
    const drive = docs.drive_v3;
    const req = buildGoogleRequest(drive, findMethod(drive, 'drive.files.get'), {
      fileId: 'F1',
      supportsAllDrives: true,
    });
    expect(req.url).toBe('https://www.googleapis.com/drive/v3/files/F1?supportsAllDrives=true');
    const media = buildGoogleRequest(drive, findMethod(drive, 'drive.files.get'), { fileId: 'F1' }, { media: 'download' });
    expect(new URL(media.url).searchParams.get('alt')).toBe('media');
    expect(compiledApis.drive_v3.actions.files_get_media.kind).toBe('read');
  });

  test('gmail get_thread with the userId default and repeated query params', () => {
    const gmail = docs.gmail_v1;
    const req = buildGoogleRequest(gmail, findMethod(gmail, 'gmail.users.threads.get'), {
      userId: 'me',
      id: 'T1',
      format: 'metadata',
      metadataHeaders: ['From', 'Subject'],
    });
    expect(req.url).toBe(
      'https://gmail.googleapis.com/gmail/v1/users/me/threads/T1?format=metadata&metadataHeaders=From&metadataHeaders=Subject'
    );
  });

  test('reserved expansion keeps resource-name slashes (People, Chat)', () => {
    const people = docs.people_v1;
    const chat = docs.chat_v1;
    expect(
      buildGoogleRequest(people, findMethod(people, 'people.people.get'), {
        resourceName: 'people/c123',
        personFields: 'names',
      }).url
    ).toBe('https://people.googleapis.com/v1/people/c123?personFields=names');
    expect(
      buildGoogleRequest(chat, findMethod(chat, 'chat.spaces.messages.get'), { name: 'spaces/AAA/messages/B.C' }).url
    ).toBe('https://chat.googleapis.com/v1/spaces/AAA/messages/B.C');
  });

  test('a missing path parameter fails before any request', () => {
    expect(() => buildGoogleRequest(cal, findMethod(cal, 'calendar.events.get'), { calendarId: 'p' })).toThrow(
      /requires path parameter "eventId"/
    );
  });
});

describe('generic execute', () => {
  const response = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

  test.each([[429, 'rate_limited'], [503, 'server_error']] as const)(
    'classifies SDK-thrown HTTP %i without starting another retry loop', async (status, code) => {
      const realFetch = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return response(status, { error: { message: 'Temporary failure' } });
      }) as typeof fetch;
      try {
        const result = await executeGoogleAction(
          compiledApis.calendar_v3,
          { actionKey: 'events_insert', input: { body: {} }, credentials: null, config: {} },
          createHttpClient({ retry: false })
        );
        expect(result).toMatchObject({ success: false, output: { error_code: code, http_status: status, retryable: true } });
        expect(calls).toBe(1);
      } finally {
        globalThis.fetch = realFetch;
      }
    }
  );

  test('returns an ActionResult when transport fails', async () => {
    const result = await executeGoogleAction(
      compiledApis.calendar_v3,
      { actionKey: 'events_insert', input: { body: {} }, credentials: null, config: {} },
      { raw: async () => { throw new TypeError('fetch failed'); } } as never
    );
    expect(result).toEqual({ success: false, error: 'fetch failed' });
  });

  test('applies policy defaults and returns the JSON body', async () => {
    const seen: string[] = [];
    const http = {
      raw: async (url: string) => {
        seen.push(url);
        return response(200, { id: 'T1', messages: [] });
      },
    };
    const result = await executeGoogleAction(
      compiledApis.gmail_v1,
      { actionKey: 'users_threads_get', input: { id: 'T1' }, credentials: null, config: {} },
      http as never
    );
    expect(result).toEqual({ success: true, output: { id: 'T1', messages: [] } });
    expect(seen[0]).toBe('https://gmail.googleapis.com/gmail/v1/users/me/threads/T1');
  });

  test('passes the caller field selector and reaches shared drives by default', async () => {
    const seen: URL[] = [];
    const http = { raw: async (url: string) => (seen.push(new URL(url)), response(200, { id: 'F1' })) };
    await executeGoogleAction(
      compiledApis.drive_v3,
      { actionKey: 'files_get', input: { fileId: 'F1', fields: 'id,name,modifiedTime' }, credentials: null, config: {} },
      http as never
    );
    expect(seen[0].pathname).toBe('/drive/v3/files/F1');
    expect(seen[0].searchParams.get('fields')).toBe('id,name,modifiedTime');
    expect(seen[0].searchParams.get('supportsAllDrives')).toBe('true');
    expect(compiledApis.drive_v3.actions.files_get.inputSchema).toMatchObject({
      properties: { fields: { type: 'string' }, supportsAllDrives: { default: true } },
    });
  });

  test('retries a 403 rateLimitExceeded, then reports the typed code', async () => {
    let calls = 0;
    const body = { error: { code: 403, message: 'Rate Limit Exceeded', errors: [{ reason: 'rateLimitExceeded' }] } };
    const http = { raw: async () => (calls++, response(403, body)) };
    const result = await executeGoogleAction(
      compiledApis.calendar_v3,
      { actionKey: 'events_list', input: {}, credentials: null, config: {} },
      http as never,
      async () => {}
    );
    expect(calls).toBe(3);
    expect(result.success).toBe(false);
    expect(result.output).toMatchObject({ error_code: 'rate_limited', http_status: 403 });
  });

  test('media download returns an attachment, not JSON', async () => {
    const http = {
      raw: async (url: string) => {
        expect(new URL(url).searchParams.get('alt')).toBe('media');
        return response(200, 'hello', { 'content-type': 'text/plain' });
      },
    };
    const result = await executeGoogleAction(
      compiledApis.drive_v3,
      { actionKey: 'files_get_media', input: { fileId: 'F1' }, credentials: null, config: {} },
      http as never
    );
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ size_bytes: 5 });
  });
});

describe('file upload and download', () => {
  // Bytes that break any text round trip: NUL, invalid UTF-8, a CRLF and a
  // dash run that looks like a multipart delimiter.
  const bytes = Uint8Array.from([0x00, 0xff, 0xfe, 0x0d, 0x0a, 0x2d, 0x2d, 0x41, 0x80]);
  const file = { base64: Buffer.from(bytes).toString('base64'), filename: 'blob.bin', content_type: 'application/octet-stream' };
  const capture = (status = 200, body: unknown = { id: 'F9' }, headers: Record<string, string> = {}) => {
    const seen: Array<{ url: URL; init: { method?: string; headers?: Record<string, string>; body?: unknown } }> = [];
    const http = {
      raw: async (url: string, init: never) => {
        seen.push({ url: new URL(url), init });
        return new Response(typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body), { status, headers });
      },
    };
    return { seen, http: http as never };
  };
  const run = (api: string, actionKey: string, input: Record<string, unknown>, http: never) =>
    executeGoogleAction(compiledApis[api], { actionKey, input, credentials: null, config: {} }, http);

  test('a Drive create sends the request object and the exact file bytes as multipart/related', async () => {
    const { seen, http } = capture();
    const result = await run('drive_v3', 'files_create', { body: { name: 'blob.bin', parents: ['P1'] }, media: file }, http);
    expect(result).toEqual({ success: true, output: { id: 'F9' } });

    const { url, init } = seen[0];
    expect(`${url.origin}${url.pathname}`).toBe('https://www.googleapis.com/upload/drive/v3/files');
    expect(url.searchParams.get('uploadType')).toBe('multipart');
    expect(url.searchParams.get('supportsAllDrives')).toBe('true');
    expect(init.method).toBe('POST');
    const boundary = init.headers?.['Content-Type']?.match(/^multipart\/related; boundary=(\S+)$/)?.[1];
    expect(boundary).toBeDefined();

    const body = Buffer.from(init.body as Uint8Array);
    const head = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: 'blob.bin', parents: ['P1'] })}\r\n` +
        `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    expect(body.equals(Buffer.concat([head, Buffer.from(bytes), tail]))).toBe(true);
  });

  test('an update uploads to its own upload path with the method verb', async () => {
    const { seen, http } = capture();
    await run('drive_v3', 'files_update', { fileId: 'F1', media: { ...file, content_type: 'text/plain' } }, http);
    expect(seen[0].url.pathname).toBe('/upload/drive/v3/files/F1');
    expect(seen[0].init.method).toBe('PATCH');
    expect(Buffer.from(seen[0].init.body as Uint8Array).toString('latin1')).toContain('{}\r\n');
  });

  test('a method with no request object takes the bytes alone (uploadType=media)', async () => {
    const { seen, http } = capture(200, { items: [] });
    await run('youtube_v3', 'thumbnails_set', { videoId: 'V1', media: { ...file, content_type: 'image/png' } }, http);
    expect(seen[0].url.pathname).toBe('/upload/youtube/v3/thumbnails/set');
    expect(seen[0].url.searchParams.get('uploadType')).toBe('media');
    expect(seen[0].init.headers?.['Content-Type']).toBe('image/png');
    expect(Buffer.from(seen[0].init.body as Uint8Array).equals(Buffer.from(bytes))).toBe(true);
  });

  test('metadata-only calls are unchanged, and media is refused where Google takes none', async () => {
    const { seen, http } = capture();
    await run('drive_v3', 'files_create', { body: { name: 'folder', mimeType: 'application/vnd.google-apps.folder' } }, http);
    expect(seen[0].url.pathname).toBe('/drive/v3/files');
    expect(seen[0].init.headers?.['Content-Type']).toBe('application/json');

    const refused = await run('drive_v3', 'files_copy', { fileId: 'F1', media: file }, http);
    expect(refused).toMatchObject({ success: false, error: 'drive.files.copy does not accept a file upload.' });
    const unresolved = await run('drive_v3', 'files_create', { media: { $file: 'lobu://file/x' } }, http);
    expect(unresolved.success).toBe(false);
    expect(seen).toHaveLength(1);
  });

  test('upload fields carry the Lobu file contract with the lower of both size caps', () => {
    const media = (api: string, key: string) =>
      (compiledApis[api].actions[key].inputSchema as { properties: Record<string, { 'x-lobu-file'?: { maxBytes: number } }> })
        .properties.media?.['x-lobu-file'];
    expect(media('drive_v3', 'files_create')).toEqual({ maxBytes: 12 * 1024 * 1024 });
    expect(media('gmail_v1', 'users_drafts_create')).toEqual({ maxBytes: 12 * 1024 * 1024 });
    expect(media('youtube_v3', 'channelBanners_insert')).toEqual({ maxBytes: 6291456 });
    expect(media('drive_v3', 'files_copy')).toBeUndefined();
    const uploads = Object.values(compiledApis).flatMap((c) =>
      Object.values(c.actions).filter((a) => (a.inputSchema as { properties: Record<string, unknown> }).properties.media)
    );
    // Every Discovery upload method: Gmail 6, Drive 2, YouTube 8, Chat 1.
    expect(uploads).toHaveLength(17);
  });

  test('a bytes-only method (Drive export) is a download, without alt=media', async () => {
    const csv = 'a,b\n1,2\n';
    const { seen, http } = capture(200, csv, { 'content-type': 'text/csv' });
    const result = await run('drive_v3', 'files_export', { fileId: 'S1', mimeType: 'text/csv' }, http);
    expect(seen[0].url.pathname).toBe('/drive/v3/files/S1/export');
    expect(seen[0].url.searchParams.has('alt')).toBe(false);
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      size_bytes: csv.length,
      content: csv,
      attachments: [{ filename: 'S1', mime_type: 'text/csv', data: Buffer.from(csv).toString('base64') }],
    });
    expect(compiledApis.drive_v3.actions.files_export_media).toBeUndefined();
  });

  test('a download Google declares over the connector limit is refused before it is read', async () => {
    let cancelled = false;
    const body = new ReadableStream({ cancel: () => { cancelled = true; } });
    const http = { raw: async () => new Response(body, { headers: { 'content-length': String(64 * 1024 * 1024) } }) };
    const result = await run('drive_v3', 'files_get_media', { fileId: 'BIG' }, http as never);
    expect(result.success).toBe(false);
    expect(result.error).toContain('above the 10485760-byte download limit');
    expect(cancelled).toBe(true);
  });
});

describe('Google error classification reads the structured reason', () => {
  const body = (reason: string, field: 'details' | 'errors' = 'details') =>
    JSON.stringify({ error: { code: 403, message: reason, [field]: [{ reason }] } });

  test.each([
    [403, body('SERVICE_DISABLED'), 'api_disabled'],
    [403, body('ACCESS_TOKEN_SCOPE_INSUFFICIENT'), 'scope_insufficient'],
    [403, body('insufficientPermissions', 'errors'), 'scope_insufficient'],
    [403, body('rateLimitExceeded', 'errors'), 'rate_limited'],
    [403, body('dailyLimitExceeded', 'errors'), 'quota_exhausted'],
    [403, body('forbidden', 'errors'), 'permission_denied'],
    [401, '{"error":"invalid_grant"}', 'auth_expired'],
    [410, body('fullSyncRequired', 'errors'), 'cursor_expired'],
    [502, '<html>bad gateway</html>', 'server_error'],
    [502, 'null', 'server_error'],
  ])('%i %s → %s', (status, text, code) => {
    expect(classifyGoogleError(status, text).code).toBe(code as never);
  });
});
