import { beforeAll, describe, expect, mock, test } from 'bun:test';
// Both sync loops run through the cursor paginator; the shared mock provides a
// faithful generator rather than a throwing stub, so these tests exercise the
// real paging semantics.
import { connectorSdkMock } from './connector-sdk.mock';

mock.module('@lobu/connector-sdk', () => connectorSdkMock());

// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let GoogleDriveConnector: any;

beforeAll(async () => {
  const mod = await import('../google_drive');
  GoogleDriveConnector = mod.default;
});

const DOC_MIME = 'application/vnd.google-apps.document';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

interface RouteResponse {
  status?: number;
  body?: unknown;
  /** Raw body for media/export routes, which the connector reads via text(). */
  text?: string;
  /** Raw bytes for a binary media route, which `download_file` reads via arrayBuffer(). */
  bytes?: Uint8Array;
  /** Response `content-type`, which the byte path prefers over the metadata MIME. */
  contentType?: string;
}

type Route = (url: URL) => RouteResponse | undefined;

/**
 * Fake Drive HTTP client that dispatches on the request URL, so a test can
 * assert BOTH the response handling and the order in which endpoints were hit.
 */
function fakeDrive(routes: Route[]) {
  const urls: string[] = [];
  return {
    urls,
    /** Endpoint labels in call order — the invariant most tests assert on. */
    get trace(): string[] {
      return urls.map((raw) => {
        const u = new URL(raw);
        if (u.pathname.endsWith('/changes/startPageToken')) return 'startPageToken';
        if (u.pathname.endsWith('/changes')) return 'changes';
        if (u.pathname.endsWith('/export')) return 'export';
        if (u.pathname.endsWith('/files')) return 'files.list';
        if (u.searchParams.get('alt') === 'media') return 'media';
        return 'files.get';
      });
    },
    client: {
      raw: async (raw: string) => {
        urls.push(raw);
        const url = new URL(raw);
        for (const route of routes) {
          const hit = route(url);
          if (hit) {
            const status = hit.status ?? 200;
            // `bytes` lets a route serve a real binary body; otherwise the
            // text body is encoded, so the byte path sees exactly what the
            // text path would have decoded.
            const body =
              hit.bytes ??
              new TextEncoder().encode(hit.text ?? JSON.stringify(hit.body ?? {}));
            return {
              ok: status >= 200 && status < 300,
              status,
              headers: new Headers(
                hit.contentType ? { 'content-type': hit.contentType } : {}
              ),
              json: async () => hit.body ?? {},
              text: async () => hit.text ?? JSON.stringify(hit.body ?? {}),
              arrayBuffer: async () =>
                body.buffer.slice(
                  body.byteOffset,
                  body.byteOffset + body.byteLength
                ),
            } as unknown as Response;
          }
        }
        throw new Error(`unrouted Drive request: ${raw}`);
      },
    },
  };
}

function driveFile(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `${id}.txt`,
    mimeType: 'text/plain',
    webViewLink: `https://drive.google.com/file/${id}`,
    size: '12',
    createdTime: '2026-01-01T10:00:00Z',
    modifiedTime: '2026-01-02T10:00:00Z',
    owners: [{ emailAddress: 'owner@example.com', displayName: 'Owner' }],
    ...overrides,
  };
}

const startToken = (token: string): Route => (url) =>
  url.pathname.endsWith('/changes/startPageToken')
    ? { body: { startPageToken: token } }
    : undefined;

const filesList = (pages: Array<{ files?: unknown[]; nextPageToken?: string }>): Route => {
  let i = 0;
  return (url) =>
    url.pathname.endsWith('/files') ? { body: pages[i++] ?? { files: [] } } : undefined;
};

const changesList = (
  pages: Array<{ status?: number; changes?: unknown[]; nextPageToken?: string; newStartPageToken?: string }>
): Route => {
  let i = 0;
  return (url) => {
    if (!url.pathname.endsWith('/changes')) return undefined;
    const page = pages[i++] ?? { changes: [] };
    return { status: page.status, body: page };
  };
};

/** Serves every content route (export + alt=media) with one body. */
const contentBody = (text: string, status = 200): Route => (url) =>
  url.pathname.endsWith('/export') || url.searchParams.get('alt') === 'media'
    ? { status, text }
    : undefined;

const fileGet = (file: Record<string, unknown>): Route => (url) =>
  url.pathname.includes('/files/') &&
  !url.pathname.endsWith('/export') &&
  url.searchParams.get('alt') !== 'media'
    ? { body: file }
    : undefined;

// ---------------------------------------------------------------------------

describe('GoogleDriveConnector authorization and operation policy', () => {
  test('requests read-only Drive consent and exposes only read actions', () => {
    const definition = new GoogleDriveConnector().definition;
    const oauth = definition.authSchema.methods[0];

    expect(definition.key).toBe('google.drive');
    expect(oauth.provider).toBe('google');
    expect(oauth.requiredScopes).toEqual([
      'https://www.googleapis.com/auth/drive.readonly',
    ]);
    // Sensitive Drive scopes must never ride on the login consent — that is the
    // regression PR #1145 fixed for the whole google provider.
    expect(oauth.loginScopes).toEqual(['openid', 'email', 'profile']);

    for (const actionKey of Object.keys(definition.actions)) {
      expect(definition.actions[actionKey]).toMatchObject({
        kind: 'read',
        requiresApproval: false,
      });
    }
  });
});

describe('GoogleDriveConnector full sync', () => {
  test('takes the start page token BEFORE listing files', async () => {
    // The load-bearing ordering invariant: Drive's change log is a moving
    // cursor, so a token minted after the traversal would skip every file
    // written while it ran.
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      startToken('TOKEN_1'),
      filesList([{ files: [driveFile('a')] }]),
      contentBody('hello'),
    ]);
    connector.client = () => drive.client;

    const result = await connector.sync({
      feedKey: 'files',
      config: { include_content: false },
      credentials: { accessToken: 'tok' },
      checkpoint: {},
    });

    expect(drive.trace[0]).toBe('startPageToken');
    expect(drive.trace[1]).toBe('files.list');
    expect(result.checkpoint.page_token).toBe('TOKEN_1');
    expect(result.events).toHaveLength(1);
  });

  test('pages files.list until the page token is exhausted', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      startToken('T'),
      filesList([
        { files: [driveFile('a')], nextPageToken: 'p2' },
        { files: [driveFile('b')] },
      ]),
    ]);
    connector.client = () => drive.client;

    const result = await connector.sync({
      feedKey: 'files',
      config: { include_content: false },
      credentials: { accessToken: 'tok' },
      checkpoint: {},
    });

    expect(result.events).toHaveLength(2);
    expect(drive.trace.filter((t) => t === 'files.list')).toHaveLength(2);
  });

  test('stops at the first page boundary at or past max_results', async () => {
    // The cap bounds the RUN, not the page. A page is consumed whole because
    // Drive's list cursor cannot resume inside one, so overshooting is the
    // safe direction: the alternative drops the remainder permanently.
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      startToken('T'),
      filesList([
        { files: [driveFile('a'), driveFile('b'), driveFile('c')], nextPageToken: 'P2' },
        { files: [driveFile('d')] },
      ]),
    ]);
    connector.client = () => drive.client;

    const result = await connector.sync({
      feedKey: 'files',
      config: { include_content: false, max_results: 2 },
      credentials: { accessToken: 'tok' },
      checkpoint: {},
    });

    expect(result.events).toHaveLength(3);
    expect(result.checkpoint.list_page_token).toBe('P2');
    expect(result.checkpoint.page_token).toBeUndefined();
  });
});

describe('GoogleDriveConnector incremental sync', () => {
  test('advances the checkpoint to newStartPageToken from the LAST page', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      changesList([
        { changes: [{ fileId: 'a', file: driveFile('a') }], nextPageToken: 'c2' },
        { changes: [{ fileId: 'b', file: driveFile('b') }], newStartPageToken: 'TOKEN_2' },
      ]),
    ]);
    connector.client = () => drive.client;

    const result = await connector.sync({
      feedKey: 'files',
      config: { include_content: false },
      credentials: { accessToken: 'tok' },
      checkpoint: { page_token: 'TOKEN_1' },
    });

    expect(result.events).toHaveLength(2);
    expect(result.checkpoint.page_token).toBe('TOKEN_2');
    // Never re-listed: the incremental path succeeded.
    expect(drive.trace).not.toContain('files.list');
  });

  test('a removed change becomes a tombstone on the same origin_id', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      changesList([
        {
          changes: [{ fileId: 'gone', removed: true, time: '2026-02-01T00:00:00Z' }],
          newStartPageToken: 'T2',
        },
      ]),
    ]);
    connector.client = () => drive.client;

    const result = await connector.sync({
      feedKey: 'files',
      config: {},
      credentials: { accessToken: 'tok' },
      checkpoint: { page_token: 'T1' },
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      origin_id: 'gone',
      metadata: { change_type: 'removed' },
    });
  });

  test('a trashed file is tombstoned unless the feed opts into trash', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      changesList([
        {
          changes: [{ fileId: 'x', file: driveFile('x', { trashed: true }) }],
          newStartPageToken: 'T2',
        },
      ]),
    ]);
    connector.client = () => drive.client;

    const result = await connector.sync({
      feedKey: 'files',
      config: { include_content: false },
      credentials: { accessToken: 'tok' },
      checkpoint: { page_token: 'T1' },
    });

    expect(result.events[0].metadata).toMatchObject({ change_type: 'trashed' });
  });
});

describe('GoogleDriveConnector page-token recovery', () => {
  test('a 404 page token falls through to exactly ONE full re-list', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      changesList([{ status: 404 }]),
      startToken('FRESH'),
      filesList([{ files: [driveFile('a')] }]),
    ]);
    connector.client = () => drive.client;

    const result = await connector.sync({
      feedKey: 'files',
      config: { include_content: false },
      credentials: { accessToken: 'tok' },
      checkpoint: { page_token: 'DEAD' },
    });

    expect(result.checkpoint.page_token).toBe('FRESH');
    expect(result.events).toHaveLength(1);
    // Exactly one changes attempt, then recovery — never a resync loop.
    expect(drive.trace.filter((t) => t === 'changes')).toHaveLength(1);
    expect(drive.trace.filter((t) => t === 'files.list')).toHaveLength(1);
  });

  test('a 403 is a scope failure and must NOT trigger a re-list', async () => {
    // The distinction that keeps a missing-scope install from becoming an
    // unbounded full-resync loop against Drive.
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([changesList([{ status: 403 }])]);
    connector.client = () => drive.client;

    await expect(
      connector.sync({
        feedKey: 'files',
        config: {},
        credentials: { accessToken: 'tok' },
        checkpoint: { page_token: 'T1' },
      })
    ).rejects.toThrow(/changes.list error \(403\)/);

    expect(drive.trace).not.toContain('files.list');
  });

  test('a 401 is a credential failure and must NOT trigger a re-list', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([changesList([{ status: 401 }])]);
    connector.client = () => drive.client;

    await expect(
      connector.sync({
        feedKey: 'files',
        config: {},
        credentials: { accessToken: 'tok' },
        checkpoint: { page_token: 'T1' },
      })
    ).rejects.toThrow(/changes.list error \(401\)/);

    expect(drive.trace).not.toContain('files.list');
  });
});

describe('GoogleDriveConnector content routing', () => {
  test('a Google Doc is EXPORTED, never downloaded as bytes', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      fileGet(driveFile('doc', { mimeType: DOC_MIME, size: undefined })),
      contentBody('line one\nline two'),
    ]);
    connector.client = () => drive.client;

    const result = await connector.execute({
      actionKey: 'download_file',
      input: { file_id: 'doc' },
      credentials: { accessToken: 'tok' },
    });

    expect(result.success).toBe(true);
    expect(drive.trace).toContain('export');
    expect(drive.trace).not.toContain('media');
    expect(result.output.exported_as).toBe('text/plain');
    expect(result.output.line_count).toBe(2);
  });

  test('a Sheet exports as CSV', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      fileGet(driveFile('sheet', { mimeType: SHEET_MIME, size: undefined })),
      contentBody('a,b\n1,2'),
    ]);
    connector.client = () => drive.client;

    const result = await connector.execute({
      actionKey: 'download_file',
      input: { file_id: 'sheet' },
      credentials: { accessToken: 'tok' },
    });

    expect(result.output.exported_as).toBe('text/csv');
    const exportUrl = drive.urls.find((u) => u.includes('/export'))!;
    expect(new URL(exportUrl).searchParams.get('mimeType')).toBe('text/csv');
  });

  test('a plain text file is downloaded with alt=media, not exported', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      fileGet(driveFile('txt')),
      contentBody('alpha\nbeta\ngamma'),
    ]);
    connector.client = () => drive.client;

    const result = await connector.execute({
      actionKey: 'download_file',
      input: { file_id: 'txt' },
      credentials: { accessToken: 'tok' },
    });

    expect(drive.trace).toContain('media');
    expect(drive.trace).not.toContain('export');
    expect(result.output.line_count).toBe(3);
    expect(result.output.exported_as).toBeUndefined();
  });

  test('a folder has no text export and is refused with a specific reason', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      fileGet(driveFile('folder', { mimeType: FOLDER_MIME, size: undefined })),
    ]);
    connector.client = () => drive.client;

    const result = await connector.execute({
      actionKey: 'download_file',
      input: { file_id: 'folder' },
      credentials: { accessToken: 'tok' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no text export/);
  });

  test('a binary file downloads as an attachment instead of being refused', async () => {
    // The whole point of download_file: a PDF used to be rejected outright, so
    // no device could ever receive one. The bytes must survive intact — not be
    // decoded to text and back, which is what produced mojibake before.
    const connector = new GoogleDriveConnector();
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0xfe]);
    const drive = fakeDrive([
      fileGet(driveFile('pdf', { mimeType: 'application/pdf', name: 'a.pdf', size: '8' })),
      (url) =>
        url.searchParams.get('alt') === 'media'
          ? { bytes: pdfBytes, contentType: 'application/pdf' }
          : undefined,
    ]);
    connector.client = () => drive.client;

    const result = await connector.execute({
      actionKey: 'download_file',
      input: { file_id: 'pdf' },
      credentials: { accessToken: 'tok' },
    });

    expect(result.success).toBe(true);
    expect(drive.trace).toContain('media');

    const [attachment] = result.output.attachments as Array<Record<string, unknown>>;
    expect(attachment.filename).toBe('a.pdf');
    expect(attachment.mime_type).toBe('application/pdf');
    expect(attachment.size_bytes).toBe(8);
    // Byte-exact round trip, including the 0x00 and the invalid UTF-8 tail that
    // a text decode would have replaced with U+FFFD.
    expect(new Uint8Array(Buffer.from(attachment.data as string, 'base64'))).toEqual(
      pdfBytes
    );
    // `kind` is the gateway's to infer; emitting it here would be a second rule
    // that can disagree with inferKindFromMime.
    expect(attachment).not.toHaveProperty('kind');
    // Binary is never inlined — that is what the download_url is for.
    expect(result.output.content).toBeUndefined();
    expect(result.output.content_omitted_reason).toMatch(/binary/);
  });

  test('a text file is inlined AND published as an attachment', async () => {
    // Both, not either: the caller can read it without a second request, and a
    // device can still fetch the stored copy.
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([fileGet(driveFile('notes')), contentBody('alpha\nbeta')]);
    connector.client = () => drive.client;

    const result = await connector.execute({
      actionKey: 'download_file',
      input: { file_id: 'notes' },
      credentials: { accessToken: 'tok' },
    });

    expect(result.output.content).toBe('alpha\nbeta');
    expect(result.output.content_truncated).toBe(false);
    const [attachment] = result.output.attachments as Array<Record<string, unknown>>;
    expect(Buffer.from(attachment.data as string, 'base64').toString('utf-8')).toBe(
      'alpha\nbeta'
    );
  });

  test('a file above the download ceiling is refused BEFORE any bytes are fetched', async () => {
    // Refusing on the declared size matters: the isolate buffers the whole body
    // and then base64s it, so fetching first would be an OOM kill rather than
    // an error the caller can read.
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      fileGet(driveFile('huge', { size: String(11 * 1024 * 1024) })),
    ]);
    connector.client = () => drive.client;

    const result = await connector.execute({
      actionKey: 'download_file',
      input: { file_id: 'huge' },
      credentials: { accessToken: 'tok' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/download limit/);
    expect(drive.trace).not.toContain('media');
  });

  test('truncation never splits a multi-byte character', async () => {
    // A byte-slice that lands mid-sequence would decode to U+FFFD and store a
    // manufactured garbage character. Found against a real 377KB Google Doc.
    const connector = new GoogleDriveConnector();
    // 10 ASCII + 10 two-byte chars; cutting at 11 bytes splits the first "é".
    const drive = fakeDrive([
      fileGet(driveFile('multi')),
      contentBody('a'.repeat(10) + 'é'.repeat(10)),
    ]);
    connector.client = () => drive.client;

    const result = await connector.execute({
      actionKey: 'download_file',
      input: { file_id: 'multi', inline_max_bytes: 11 },
      credentials: { accessToken: 'tok' },
    });

    expect(result.output.content_truncated).toBe(true);
    expect(result.output.content).not.toContain('\uFFFD');
    expect(result.output.content).toBe('a'.repeat(10));
  });

  test('a legitimate replacement character in the source survives truncation', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([fileGet(driveFile('repl')), contentBody('ab\uFFFDcd')]);
    connector.client = () => drive.client;

    const result = await connector.execute({
      actionKey: 'download_file',
      // 'ab' (2) + U+FFFD (3 bytes) = 5 bytes, a clean boundary.
      input: { file_id: 'repl', inline_max_bytes: 5 },
      credentials: { accessToken: 'tok' },
    });

    expect(result.output.content).toBe('ab\uFFFD');
  });

  test('content is truncated at max_bytes and reports it', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([fileGet(driveFile('big')), contentBody('abcdefghij')]);
    connector.client = () => drive.client;

    const result = await connector.execute({
      actionKey: 'download_file',
      input: { file_id: 'big', inline_max_bytes: 4 },
      credentials: { accessToken: 'tok' },
    });

    expect(result.output.content).toBe('abcd');
    expect(result.output.content_truncated).toBe(true);
    // The INLINE text is truncated; the attachment still carries the whole file,
    // because a truncated attachment would be a corrupt download.
    expect(result.output.size_bytes).toBe(10);
    const [attachment] = result.output.attachments as Array<Record<string, unknown>>;
    expect(Buffer.from(attachment.data as string, 'base64').toString('utf-8')).toBe(
      'abcdefghij'
    );
  });
});

describe('GoogleDriveConnector sync content inlining', () => {
  test('inlines text content into payload_text when enabled', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      startToken('T'),
      filesList([{ files: [driveFile('a')] }]),
      contentBody('one\ntwo'),
    ]);
    connector.client = () => drive.client;

    const result = await connector.sync({
      feedKey: 'files',
      config: { include_content: true },
      credentials: { accessToken: 'tok' },
      checkpoint: {},
    });

    expect(result.events[0].payload_text).toBe('one\ntwo');
    expect(result.events[0].metadata.content_included).toBe(true);
  });

  test('a failed content fetch degrades to metadata rather than failing the sync', async () => {
    // One unreadable file must never take down a whole Drive sync.
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      startToken('T'),
      filesList([{ files: [driveFile('a')] }]),
      contentBody('nope', 500),
    ]);
    connector.client = () => drive.client;

    const result = await connector.sync({
      feedKey: 'files',
      config: { include_content: true },
      credentials: { accessToken: 'tok' },
      checkpoint: {},
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0].metadata.content_included).toBe(false);
  });

  test('include_content: false skips content requests entirely', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      startToken('T'),
      filesList([{ files: [driveFile('a'), driveFile('b')] }]),
    ]);
    connector.client = () => drive.client;

    await connector.sync({
      feedKey: 'files',
      config: { include_content: false },
      credentials: { accessToken: 'tok' },
      checkpoint: {},
    });

    expect(drive.trace).not.toContain('media');
    expect(drive.trace).not.toContain('export');
  });

  test('a large text file syncs as metadata only, below the embedding cap', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      startToken('T'),
      filesList([{ files: [driveFile('huge', { size: String(5 * 1024 * 1024) })] }]),
    ]);
    connector.client = () => drive.client;

    const result = await connector.sync({
      feedKey: 'files',
      config: { include_content: true },
      credentials: { accessToken: 'tok' },
      checkpoint: {},
    });

    expect(result.events[0].metadata.content_included).toBe(false);
    expect(drive.trace).not.toContain('media');
  });
});

describe('GoogleDriveConnector query construction', () => {
  test('excludes trashed files by default and merges a user query with AND', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([startToken('T'), filesList([{ files: [] }])]);
    connector.client = () => drive.client;

    await connector.sync({
      feedKey: 'files',
      config: { query: "mimeType = 'application/pdf'", include_content: false },
      credentials: { accessToken: 'tok' },
      checkpoint: {},
    });

    const listUrl = drive.urls.find((u) => u.includes('/files?'))!;
    const q = new URL(listUrl).searchParams.get('q');
    expect(q).toBe("mimeType != 'application/vnd.google-apps.folder' and trashed = false and (mimeType = 'application/pdf')");
  });

  test('include_trashed drops the trashed filter', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([startToken('T'), filesList([{ files: [] }])]);
    connector.client = () => drive.client;

    await connector.sync({
      feedKey: 'files',
      config: { include_trashed: true, include_content: false },
      credentials: { accessToken: 'tok' },
      checkpoint: {},
    });

    // The folder exclusion is unconditional, so the query never empties out.
    const listUrl = drive.urls.find((u) => u.includes('/files?'))!;
    expect(new URL(listUrl).searchParams.get('q')).toBe(
      "mimeType != 'application/vnd.google-apps.folder'"
    );
  });

  test('folder_id scopes the query to that parent', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([startToken('T'), filesList([{ files: [] }])]);
    connector.client = () => drive.client;

    await connector.sync({
      feedKey: 'files',
      config: { folder_id: 'FOLDER1', include_content: false },
      credentials: { accessToken: 'tok' },
      checkpoint: {},
    });

    const listUrl = drive.urls.find((u) => u.includes('/files?'))!;
    expect(new URL(listUrl).searchParams.get('q')).toBe(
      "mimeType != 'application/vnd.google-apps.folder' and trashed = false and 'FOLDER1' in parents"
    );
  });
});

describe('GoogleDriveConnector live read', () => {
  test('returns typed rows sorted by Drive and paginates by cursor', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      filesList([{ files: [driveFile('a')], nextPageToken: 'next' }]),
    ]);
    connector.client = () => drive.client;

    const result = await connector.read({
      feedKey: 'files',
      config: {},
      credentials: { accessToken: 'tok' },
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      id: 'a',
      name: 'a.txt',
      mime_type: 'text/plain',
      owner: 'Owner',
    });
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe('next');
    // A live read must never persist or advance the change cursor.
    expect(drive.trace).not.toContain('startPageToken');
  });
});

describe('GoogleDriveConnector view-churn guard', () => {
  const HOUR = 3600 * 1000;
  const iso = (ms: number) => new Date(ms).toISOString();

  test('a view-only change does NOT re-fetch content', async () => {
    // Verified against the live API: opening a Doc bumps viewedByMeTime and
    // version but leaves modifiedTime alone, so the file reappears in
    // changes.list with content we already have.
    const now = Date.now();
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      changesList([
        {
          changes: [
            { fileId: 'viewed', file: driveFile('viewed', { modifiedTime: iso(now - 48 * HOUR) }) },
          ],
          newStartPageToken: 'T2',
        },
      ]),
      contentBody('should not be fetched'),
    ]);
    connector.client = () => drive.client;

    const result = await connector.sync({
      feedKey: 'files',
      config: { include_content: true },
      credentials: { accessToken: 'tok' },
      checkpoint: { page_token: 'T1', last_sync_at: iso(now - HOUR) },
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0].metadata.content_included).toBe(false);
    expect(drive.trace).not.toContain('media');
    expect(drive.trace).not.toContain('export');
  });

  test('a genuine edit after the last sync DOES re-fetch content', async () => {
    const now = Date.now();
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      changesList([
        {
          changes: [
            { fileId: 'edited', file: driveFile('edited', { modifiedTime: iso(now) }) },
          ],
          newStartPageToken: 'T2',
        },
      ]),
      contentBody('fresh content'),
    ]);
    connector.client = () => drive.client;

    const result = await connector.sync({
      feedKey: 'files',
      config: { include_content: true },
      credentials: { accessToken: 'tok' },
      checkpoint: { page_token: 'T1', last_sync_at: iso(now - HOUR) },
    });

    expect(result.events[0].metadata.content_included).toBe(true);
    expect(result.events[0].payload_text).toBe('fresh content');
  });

  test('clock skew inside the grace window still re-fetches', async () => {
    // modifiedTime one minute before last_sync_at is inside the 5-minute grace,
    // so it must NOT be treated as stale — skew must never lose an edit.
    const now = Date.now();
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      changesList([
        {
          changes: [
            { fileId: 'skew', file: driveFile('skew', { modifiedTime: iso(now - 60 * 1000) }) },
          ],
          newStartPageToken: 'T2',
        },
      ]),
      contentBody('edge content'),
    ]);
    connector.client = () => drive.client;

    const result = await connector.sync({
      feedKey: 'files',
      config: { include_content: true },
      credentials: { accessToken: 'tok' },
      checkpoint: { page_token: 'T1', last_sync_at: iso(now) },
    });

    expect(result.events[0].metadata.content_included).toBe(true);
  });

  test('a full sync has no last_sync_at and always fetches', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      startToken('T'),
      filesList([{ files: [driveFile('old', { modifiedTime: '2020-01-01T00:00:00Z' })] }]),
      contentBody('bootstrap content'),
    ]);
    connector.client = () => drive.client;

    const result = await connector.sync({
      feedKey: 'files',
      config: { include_content: true },
      credentials: { accessToken: 'tok' },
      checkpoint: {},
    });

    expect(result.events[0].metadata.content_included).toBe(true);
  });
});

describe('GoogleDriveConnector get_file metadata action', () => {
  test('returns the typed row and never touches content', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      fileGet(
        driveFile('meta', {
          name: 'quarterly.pdf',
          mimeType: 'application/pdf',
          size: '2048',
          trashed: false,
          lastModifyingUser: { emailAddress: 'editor@example.com', displayName: 'Editor' },
        })
      ),
      // Content routes are wired but must stay unused — a metadata read that
      // silently downloads bytes would bill the caller for the whole file.
      contentBody('SHOULD NOT BE READ'),
    ]);
    connector.client = () => drive.client;

    const result = await connector.execute({
      actionKey: 'get_file',
      input: { file_id: 'meta' },
      credentials: { accessToken: 'tok' },
    });

    expect(result.success).toBe(true);
    expect(drive.trace).toContain('files.get');
    expect(drive.trace).not.toContain('export');
    expect(drive.trace).not.toContain('media');
    expect(result.output).toEqual({
      id: 'meta',
      name: 'quarterly.pdf',
      mime_type: 'application/pdf',
      size_bytes: 2048,
      owner: 'Owner',
      last_modified_by: 'Editor',
      created_at: '2026-01-01T10:00:00Z',
      modified_at: '2026-01-02T10:00:00Z',
      trashed: false,
      url: 'https://drive.google.com/file/meta',
    });
  });

  test('a missing file_id is rejected before any request', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([fileGet(driveFile('meta'))]);
    connector.client = () => drive.client;

    const result = await connector.execute({
      actionKey: 'get_file',
      input: {},
      credentials: { accessToken: 'tok' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('file_id is required.');
    expect(drive.trace).toHaveLength(0);
  });

  test('an unknown file id reports the id rather than a bare failure', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([(url) =>
      url.pathname.includes('/files/') ? { status: 404, body: {} } : undefined,
    ]);
    connector.client = () => drive.client;

    const result = await connector.execute({
      actionKey: 'get_file',
      input: { file_id: 'ghost' },
      credentials: { accessToken: 'tok' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('ghost');
  });

  test('an unknown action key is refused', async () => {
    const connector = new GoogleDriveConnector();
    connector.client = () => fakeDrive([]).client;

    const result = await connector.execute({
      actionKey: 'delete_file',
      input: { file_id: 'x' },
      credentials: { accessToken: 'tok' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('delete_file');
  });
});

describe('GoogleDriveConnector export ceiling', () => {
  test('an export past the ceiling is REFUSED, not silently clamped', async () => {
    // Drive omits `size` for native docs, so the export path only learns the
    // real size after the fetch. It must still refuse: an attachment holding
    // the first 10MB of a larger file is a corrupt download, and handing that
    // back as success is the same class of bug as dropping it silently.
    const EXPORT_CEILING = 10 * 1024 * 1024;
    const connector = new GoogleDriveConnector();
    const oversized = 'a'.repeat(EXPORT_CEILING + 1);
    const drive = fakeDrive([
      fileGet(driveFile('huge', { mimeType: DOC_MIME, size: undefined })),
      contentBody(oversized),
    ]);
    connector.client = () => drive.client;

    const result = await connector.execute({
      actionKey: 'download_file',
      input: { file_id: 'huge' },
      credentials: { accessToken: 'tok' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/download limit/);
    expect(result.error).toContain(String(EXPORT_CEILING + 1));
  });

  test('inline_max_bytes above the inline ceiling is clamped, not honoured', async () => {
    // The inline budget is separate from the download ceiling and much smaller:
    // inline text lands in an agent's context verbatim.
    const INLINE_CEILING = 1024 * 1024;
    const connector = new GoogleDriveConnector();
    const body = 'a'.repeat(INLINE_CEILING + 1024);
    const drive = fakeDrive([fileGet(driveFile('big')), contentBody(body)]);
    connector.client = () => drive.client;

    const result = await connector.execute({
      actionKey: 'download_file',
      input: { file_id: 'big', inline_max_bytes: 50 * 1024 * 1024 },
      credentials: { accessToken: 'tok' },
    });

    expect(result.success).toBe(true);
    expect(result.output.content_truncated).toBe(true);
    expect((result.output.content as string).length).toBe(INLINE_CEILING);
    // The attachment is unaffected by the inline budget — it carries all of it.
    expect(result.output.size_bytes).toBe(INLINE_CEILING + 1024);
  });
});

describe('GoogleDriveConnector time budget', () => {
  const manyFiles = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => driveFile(`${prefix}${i}`));

  /**
   * Jumps the clock past the budget once the first page has been consumed:
   * 0 when the deadline is computed, then far past it at the first boundary.
   * Patched on the instance rather than subclassed — the connector module is
   * mocked, so a module-scope `extends` runs before the mock is installed.
   */
  // biome-ignore lint/suspicious/noExplicitAny: the class is imported after the mock
  const withExhaustedClock = (connector: any) => {
    let calls = 0;
    connector.now = () => (calls++ === 0 ? 0 : 60 * 60 * 1000);
    return connector;
  };

  test('a bootstrap that runs out of time PARKS a checkpoint instead of being killed', async () => {
    const connector = withExhaustedClock(new GoogleDriveConnector());
    const drive = fakeDrive([
      startToken('TOK-1'),
      filesList([
        { files: manyFiles('a', 3), nextPageToken: 'PAGE-2' },
        { files: manyFiles('b', 3) },
      ]),
    ]);
    connector.client = () => drive.client;

    // The cap is far away: only the clock can stop this run.
    const result = await connector.sync({
      feedKey: 'files',
      config: { max_results: 2000, include_content: false },
      checkpoint: {},
      credentials: { accessToken: 'tok' },
    });

    expect(result.events).toHaveLength(3);
    // The whole point: a run killed by the host persists nothing and repeats
    // itself forever. Stopping ourselves leaves a resumable position.
    expect(result.checkpoint.list_page_token).toBe('PAGE-2');
    expect(result.checkpoint.pending_page_token).toBe('TOK-1');
    expect(result.checkpoint.page_token).toBeUndefined();
    expect(result.metadata?.bootstrap_complete).toBe(false);
  });

  test('an incremental run that runs out of time hands back its cursor', async () => {
    const connector = withExhaustedClock(new GoogleDriveConnector());
    const drive = fakeDrive([
      changesList([
        { changes: [{ fileId: 'x', time: '2026-01-01T00:00:00Z', file: { id: 'x', name: 'X', mimeType: 'text/plain' } }], nextPageToken: 'C2' },
        { changes: [], newStartPageToken: 'DONE' },
      ]),
    ]);
    connector.client = () => drive.client;

    const result = await connector.sync({
      feedKey: 'files',
      config: { max_results: 2000, include_content: false },
      checkpoint: { page_token: 'C1', last_sync_at: '2026-01-01T00:00:00.000Z' },
      credentials: { accessToken: 'tok' },
    });

    // Discarding the cursor would silently demote the next run to a full
    // re-list and restart the whole bootstrap.
    expect(result.checkpoint.page_token).toBe('C2');
    expect(result.metadata?.changes_pending).toBe(true);
  });
});

describe('GoogleDriveConnector query escaping', () => {
  test('a folder_id ending in a backslash cannot escape its own quote', async () => {
    // Escaping only `'` leaves the trailing backslash to escape the closing
    // quote, letting the rest of the value run on as query syntax.
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([startToken('T'), filesList([{ files: [] }])]);
    connector.client = () => drive.client;

    await connector.sync({
      feedKey: 'files',
      config: { folder_id: "EVIL\\", include_content: false },
      credentials: { accessToken: 'tok' },
      checkpoint: {},
    });

    const q = new URL(drive.urls.find((u) => u.includes('/files?'))!).searchParams.get('q')!;
    expect(q).toContain("'EVIL\\\\' in parents");
    // The literal closes where it should: an even number of backslashes runs
    // up to the quote, so the quote is a delimiter and not escaped content.
    expect(q.endsWith("in parents")).toBe(true);
  });

  test("a folder_id containing a quote stays inside its literal", async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([startToken('T'), filesList([{ files: [] }])]);
    connector.client = () => drive.client;

    await connector.sync({
      feedKey: 'files',
      config: { folder_id: "a' or '1'='1", include_content: false },
      credentials: { accessToken: 'tok' },
      checkpoint: {},
    });

    const q = new URL(drive.urls.find((u) => u.includes('/files?'))!).searchParams.get('q')!;
    expect(q).toContain("'a\\' or \\'1\\'=\\'1' in parents");
  });
});

describe('GoogleDriveConnector folder exclusion', () => {
  test('a folder arriving through changes.list is dropped, not stored', async () => {
    // `changes.list` takes no query, so the bootstrap's folder filter has to be
    // re-applied here or folders leak back in one edit at a time.
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      changesList([
        {
          changes: [
            {
              fileId: 'FOLD',
              time: '2026-01-01T00:00:00Z',
              file: {
                id: 'FOLD',
                name: 'Some Folder',
                mimeType: 'application/vnd.google-apps.folder',
              },
            },
            {
              fileId: 'DOC',
              time: '2026-01-01T00:00:00Z',
              file: { id: 'DOC', name: 'Real Doc', mimeType: 'text/plain' },
            },
          ],
          newStartPageToken: 'TOK-2',
        },
      ]),
      contentBody('hello'),
    ]);
    connector.client = () => drive.client;

    const result = await connector.sync({
      feedKey: 'files',
      config: { include_content: false },
      checkpoint: { page_token: 'TOK-1' },
      credentials: { accessToken: 'tok' },
    });

    expect(result.events.map((e) => e.origin_id)).toEqual(['DOC']);
  });
});

describe('GoogleDriveConnector bootstrap page-boundary', () => {
  const manyFiles = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => driveFile(`${prefix}${i}`));

  test('every file is collected across a resumed bootstrap', async () => {
    // Page 1 holds 5 files and the cap is 3: stopping mid-page and then
    // resuming at PAGE-2 would silently drop a3 and a4 forever, because the
    // change feed only ever reports what changes AFTER the bootstrap.
    const connector = new GoogleDriveConnector();
    const pages = [
      { files: manyFiles('a', 5), nextPageToken: 'PAGE-2' },
      { files: manyFiles('b', 2) },
    ];

    const seen = new Set<string>();
    let checkpoint: Record<string, unknown> = {};
    for (let run = 0; run < 5; run++) {
      let i = pages.findIndex((_, idx) =>
        checkpoint.list_page_token === undefined ? idx === 0 : idx === 1
      );
      const drive = fakeDrive([
        startToken('TOK-1'),
        (url) => (url.pathname.endsWith('/files') ? { body: pages[i++] ?? { files: [] } } : undefined),
      ]);
      connector.client = () => drive.client;

      const result = await connector.sync({
        feedKey: 'files',
        config: { max_results: 3, include_content: false },
        checkpoint,
        credentials: { accessToken: 'tok' },
      });
      for (const e of result.events) seen.add(e.origin_id);
      checkpoint = result.checkpoint;
      if (result.metadata?.bootstrap_complete === true) break;
    }

    expect([...seen].sort()).toEqual(['a0', 'a1', 'a2', 'a3', 'a4', 'b0', 'b1']);
  });
});

describe('GoogleDriveConnector resumable bootstrap', () => {
  const manyFiles = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => driveFile(`${prefix}${i}`));

  test('a Drive larger than max_results does NOT go incremental', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      startToken('TOK-1'),
      filesList([{ files: manyFiles('a', 3), nextPageToken: 'PAGE-2' }]),
    ]);
    connector.client = () => drive.client;

    const result = await connector.sync({
      feedKey: 'files',
      config: { max_results: 3, include_content: false },
      checkpoint: {},
      credentials: { accessToken: 'tok' },
    });

    expect(result.events).toHaveLength(3);
    // The change token must stay parked: promoting it here would strand every
    // file the traversal never reached, permanently.
    expect(result.checkpoint.page_token).toBeUndefined();
    expect(result.checkpoint.pending_page_token).toBe('TOK-1');
    expect(result.checkpoint.list_page_token).toBe('PAGE-2');
    expect(result.metadata?.bootstrap_complete).toBe(false);
  });

  test('a listing stopped by MAX_PAGES parks the token instead of completing', async () => {
    const connector = new GoogleDriveConnector();
    // Endless listing: every page yields one file and another cursor, so the
    // traversal is bounded by the paginator's MAX_PAGES rather than by
    // max_results or the clock. That is still an unfinished bootstrap — the
    // only proof of exhaustion is Drive withholding a nextPageToken.
    let page = 0;
    const endlessFiles: Route = (url) =>
      url.pathname.endsWith('/files')
        ? { body: { files: [driveFile(`f${page}`)], nextPageToken: `P${++page}` } }
        : undefined;
    const drive = fakeDrive([startToken('TOK-1'), endlessFiles]);
    connector.client = () => drive.client;

    const result = await connector.sync({
      feedKey: 'files',
      config: { max_results: 2000, include_content: false },
      checkpoint: {},
      credentials: { accessToken: 'tok' },
    });

    expect(result.events).toHaveLength(200);
    expect(result.checkpoint.page_token).toBeUndefined();
    expect(result.checkpoint.pending_page_token).toBe('TOK-1');
    expect(result.checkpoint.list_page_token).toBe('P200');
    expect(result.metadata?.bootstrap_complete).toBe(false);
  });

  test('the next run resumes the listing instead of re-minting a token', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      startToken('TOK-FRESH'),
      filesList([{ files: manyFiles('b', 2) }]),
    ]);
    connector.client = () => drive.client;

    const result = await connector.sync({
      feedKey: 'files',
      config: { max_results: 10, include_content: false },
      checkpoint: { pending_page_token: 'TOK-1', list_page_token: 'PAGE-2' },
      credentials: { accessToken: 'tok' },
    });

    // Resuming must NOT call startPageToken — a fresh token would open a gap
    // covering everything changed since the bootstrap began.
    expect(drive.trace).not.toContain('startPageToken');
    expect(drive.urls.some((u) => u.includes('pageToken=PAGE-2'))).toBe(true);
    // Listing exhausted, so the parked token is promoted and incremental opens.
    expect(result.checkpoint.page_token).toBe('TOK-1');
    expect(result.checkpoint.list_page_token).toBeUndefined();
    expect(result.metadata?.bootstrap_complete).toBe(true);
  });

  test('a bootstrap that exactly exhausts the listing completes immediately', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      startToken('TOK-1'),
      filesList([{ files: manyFiles('c', 3) }]),
    ]);
    connector.client = () => drive.client;

    const result = await connector.sync({
      feedKey: 'files',
      config: { max_results: 3, include_content: false },
      checkpoint: {},
      credentials: { accessToken: 'tok' },
    });

    // Hitting the cap on the LAST page is not an unfinished bootstrap.
    expect(result.checkpoint.page_token).toBe('TOK-1');
    expect(result.checkpoint.list_page_token).toBeUndefined();
    expect(result.metadata?.bootstrap_complete).toBe(true);
  });

  test('an unfinished bootstrap outranks a stale page_token', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      filesList([{ files: manyFiles('d', 2) }]),
      changesList([{ changes: [], newStartPageToken: 'SHOULD-NOT-BE-USED' }]),
    ]);
    connector.client = () => drive.client;

    const result = await connector.sync({
      feedKey: 'files',
      config: { max_results: 10, include_content: false },
      checkpoint: {
        page_token: 'OLD',
        pending_page_token: 'TOK-1',
        list_page_token: 'PAGE-2',
      },
      credentials: { accessToken: 'tok' },
    });

    expect(drive.trace).not.toContain('changes');
    expect(result.checkpoint.page_token).toBe('TOK-1');
  });
});

describe('GoogleDriveConnector feed scope on the incremental axis', () => {
  // `changes.list` takes no `q`, so every filter the bootstrap applies at the
  // listing has to be re-applied here or the feed silently widens to the whole
  // Drive the moment the bootstrap completes.

  test('a folder-scoped feed ignores changes outside that folder', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      changesList([
        {
          changes: [
            {
              fileId: 'outside',
              time: '2026-02-01T10:00:00Z',
              file: driveFile('outside', { parents: ['SOME_OTHER_FOLDER'] }),
            },
          ],
          newStartPageToken: 'FINAL',
        },
      ]),
    ]);
    connector.client = () => drive.client;

    const result = await connector.sync({
      feedKey: 'files',
      config: { folder_id: 'FOLDER1', include_content: false },
      checkpoint: { page_token: 'T1', last_sync_at: '2026-01-01T00:00:00Z' },
      credentials: { accessToken: 'tok' },
    });

    expect(result.events).toHaveLength(0);
  });

  test('a folder-scoped feed still collects changes inside that folder', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      changesList([
        {
          changes: [
            {
              fileId: 'inside',
              time: '2026-02-01T10:00:00Z',
              file: driveFile('inside', { parents: ['FOLDER1'] }),
            },
          ],
          newStartPageToken: 'FINAL',
        },
      ]),
    ]);
    connector.client = () => drive.client;

    const result = await connector.sync({
      feedKey: 'files',
      config: { folder_id: 'FOLDER1', include_content: false },
      checkpoint: { page_token: 'T1', last_sync_at: '2026-01-01T00:00:00Z' },
      credentials: { accessToken: 'tok' },
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.origin_id).toBe('inside');
  });

  test('an out-of-scope file is dropped WITHOUT a tombstone', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      changesList([
        {
          changes: [
            {
              fileId: 'moved',
              time: '2026-02-01T10:00:00Z',
              file: driveFile('moved', { parents: ['ELSEWHERE'] }),
            },
          ],
          newStartPageToken: 'FINAL',
        },
      ]),
    ]);
    connector.client = () => drive.client;

    const result = await connector.sync({
      feedKey: 'files',
      config: { folder_id: 'FOLDER1', include_content: false },
      checkpoint: { page_token: 'T1', last_sync_at: '2026-01-01T00:00:00Z' },
      credentials: { accessToken: 'tok' },
    });

    // No row at all, not even a tombstone: a file that moved OUT of the folder
    // is indistinguishable from one that was never in it, so tombstoning would
    // write a row for every changed file in the Drive and leak the existence of
    // out-of-scope files into the corpus the scope exists to bound.
    expect(result.events).toHaveLength(0);
  });

  test('a custom query feed never promotes to the change stream', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      startToken('TOK-1'),
      filesList([{ files: [driveFile('q0')] }]),
    ]);
    connector.client = () => drive.client;

    const result = await connector.sync({
      feedKey: 'files',
      config: { query: "mimeType = 'application/pdf'", include_content: false },
      checkpoint: {},
      credentials: { accessToken: 'tok' },
    });

    // A Drive `q` cannot be re-evaluated against a changes.list record, so the
    // only way to keep honouring it is to keep listing. Promoting here would
    // widen the feed to every changed file in the Drive.
    expect(result.checkpoint.page_token).toBeUndefined();
  });
});

describe('GoogleDriveConnector bounded incremental sync', () => {
  const changeFor = (id: string) => ({
    fileId: id,
    time: '2026-02-01T10:00:00Z',
    file: driveFile(id),
  });
  const manyChanges = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => changeFor(`${prefix}${i}`));

  test('a change burst larger than max_results parks the cursor, never re-lists', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      changesList([
        { changes: manyChanges('x', 4), nextPageToken: 'CHANGES-P2' },
        { changes: manyChanges('y', 4), newStartPageToken: 'FINAL' },
      ]),
    ]);
    connector.client = () => drive.client;

    const result = await connector.sync({
      feedKey: 'files',
      config: { max_results: 3, include_content: false },
      checkpoint: { page_token: 'START', last_sync_at: '2026-01-01T00:00:00Z' },
      credentials: { accessToken: 'tok' },
    });

    // The cursor, not a dropped token: the next run resumes the change stream.
    expect(result.checkpoint.page_token).toBe('CHANGES-P2');
    // Falling back to files.list here would restart the entire bootstrap.
    expect(drive.trace).not.toContain('files.list');
    expect(drive.trace).not.toContain('startPageToken');
  });

  test('a partial run does NOT advance last_sync_at', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      changesList([{ changes: manyChanges('z', 4), nextPageToken: 'CHANGES-P2' }]),
    ]);
    connector.client = () => drive.client;

    const result = await connector.sync({
      feedKey: 'files',
      config: { max_results: 3, include_content: false },
      checkpoint: { page_token: 'START', last_sync_at: '2026-01-01T00:00:00Z' },
      credentials: { accessToken: 'tok' },
    });

    // Advancing the stamp would make the view-churn guard treat the unread
    // backlog as already-stored and silently skip its content next run.
    expect(result.checkpoint.last_sync_at).toBe('2026-01-01T00:00:00Z');
    expect(result.metadata?.changes_pending).toBe(true);
  });

  test('a drained change stream advances the stamp and clears the pending flag', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      changesList([{ changes: manyChanges('w', 2), newStartPageToken: 'FINAL' }]),
    ]);
    connector.client = () => drive.client;

    const result = await connector.sync({
      feedKey: 'files',
      config: { max_results: 100, include_content: false },
      checkpoint: { page_token: 'START', last_sync_at: '2026-01-01T00:00:00Z' },
      credentials: { accessToken: 'tok' },
    });

    expect(result.checkpoint.page_token).toBe('FINAL');
    expect(result.checkpoint.last_sync_at).not.toBe('2026-01-01T00:00:00Z');
    expect(result.metadata?.changes_pending).toBeUndefined();
  });

  test('a completed bootstrap keeps its stamp WITHOUT claiming changes are pending', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      startToken('TOK-1'),
      filesList([{ files: [driveFile('u0')] }]),
    ]);
    connector.client = () => drive.client;

    const result = await connector.sync({
      feedKey: 'files',
      config: { max_results: 100, include_content: false },
      checkpoint: {},
      credentials: { accessToken: 'tok' },
    });

    // A bootstrap pins `last_sync_at` to the moment it began so the view-churn
    // guard cannot skip edits made while it ran. That is a stamp decision, not
    // a backlog: nothing is left unread, so the pending flag must stay off or
    // an operator reads a finished feed as perpetually behind.
    expect(result.checkpoint.page_token).toBe('TOK-1');
    expect(result.metadata?.bootstrap_complete).toBe(true);
    expect(result.metadata?.changes_pending).toBeUndefined();
  });

  test('the parked cursor is a real resume point, not a restart', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      changesList([{ changes: manyChanges('v', 1), newStartPageToken: 'FINAL' }]),
    ]);
    connector.client = () => drive.client;

    await connector.sync({
      feedKey: 'files',
      config: { max_results: 100, include_content: false },
      checkpoint: { page_token: 'CHANGES-P2', last_sync_at: '2026-01-01T00:00:00Z' },
      credentials: { accessToken: 'tok' },
    });

    expect(drive.urls.some((u) => u.includes('pageToken=CHANGES-P2'))).toBe(true);
  });
});

describe('GoogleDriveConnector content failure visibility', () => {
  test('a failed export is recorded, not silently indistinguishable from no-text', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      startToken('TOK'),
      filesList([{ files: [driveFile('doc', { mimeType: DOC_MIME, size: undefined })] }]),
      contentBody('upstream exploded', 500),
    ]);
    connector.client = () => drive.client;

    const result = await connector.sync({
      feedKey: 'files',
      config: {},
      checkpoint: {},
      credentials: { accessToken: 'tok' },
    });

    const meta = result.events[0].metadata;
    expect(meta.content_included).toBe(false);
    // A file that never changes again is never revisited, so without this the
    // miss is permanent AND invisible.
    expect(meta.content_error).toContain('500');
  });

  test('a file with no text by design carries no content_error', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      startToken('TOK'),
      filesList([{ files: [driveFile('img', { mimeType: 'image/jpeg' })] }]),
    ]);
    connector.client = () => drive.client;

    const result = await connector.sync({
      feedKey: 'files',
      config: {},
      checkpoint: {},
      credentials: { accessToken: 'tok' },
    });

    const meta = result.events[0].metadata;
    expect(meta.content_included).toBe(false);
    expect(meta.content_error).toBeUndefined();
  });
});

describe('GoogleDriveConnector bootstrap window', () => {
  const manyFiles = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => driveFile(`${prefix}${i}`));

  test('every bootstrap slice carries the SAME start timestamp', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      startToken('TOK-1'),
      filesList([{ files: manyFiles('a', 5), nextPageToken: 'PAGE-2' }]),
    ]);
    connector.client = () => drive.client;

    const pinned = '2026-01-01T00:00:00.000Z';
    const result = await connector.sync({
      feedKey: 'files',
      config: { max_results: 3, include_content: false },
      checkpoint: {
        pending_page_token: 'TOK-1',
        list_page_token: 'PAGE-EARLIER',
        last_sync_at: pinned,
      },
      credentials: { accessToken: 'tok' },
    });

    // Advancing this per-slice would push the stamp past edits made while the
    // bootstrap ran, and the view-churn guard would skip their content.
    expect(result.checkpoint.last_sync_at).toBe(pinned);
  });

  test('a completed bootstrap keeps the start stamp, not the finish time', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([filesList([{ files: manyFiles('b', 2) }])]);
    connector.client = () => drive.client;

    const pinned = '2026-01-01T00:00:00.000Z';
    const result = await connector.sync({
      feedKey: 'files',
      config: { max_results: 10, include_content: false },
      checkpoint: {
        pending_page_token: 'TOK-1',
        list_page_token: 'PAGE-2',
        last_sync_at: pinned,
      },
      credentials: { accessToken: 'tok' },
    });

    expect(result.checkpoint.page_token).toBe('TOK-1');
    // An edit made DURING the bootstrap is newer than this stamp, so the first
    // incremental run re-fetches its content instead of trusting stale text.
    expect(result.checkpoint.last_sync_at).toBe(pinned);
  });
});

describe('GoogleDriveConnector incomplete search', () => {
  test('an incomplete allDrives search is recorded, not passed off as complete', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      startToken('TOK'),
      filesList([{ files: [driveFile('a')], incompleteSearch: true }]),
    ]);
    connector.client = () => drive.client;

    const result = await connector.sync({
      feedKey: 'files',
      config: { include_content: false },
      checkpoint: {},
      credentials: { accessToken: 'tok' },
    });

    // Without this a partial traversal is indistinguishable from a complete
    // one, and files it never reached look like files that do not exist.
    expect(result.metadata?.search_incomplete).toBe(true);
  });

  test('a complete search carries no incomplete flag', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([
      startToken('TOK'),
      filesList([{ files: [driveFile('a')] }]),
    ]);
    connector.client = () => drive.client;

    const result = await connector.sync({
      feedKey: 'files',
      config: { include_content: false },
      checkpoint: {},
      credentials: { accessToken: 'tok' },
    });

    expect(result.metadata?.search_incomplete).toBeUndefined();
    expect(result.metadata?.bootstrap_complete).toBe(true);
  });

  test('the sync traversal actually asks Drive for the flag', async () => {
    const connector = new GoogleDriveConnector();
    const drive = fakeDrive([startToken('TOK'), filesList([{ files: [] }])]);
    connector.client = () => drive.client;

    await connector.sync({
      feedKey: 'files',
      config: { include_content: false },
      checkpoint: {},
      credentials: { accessToken: 'tok' },
    });

    // Requesting it is load-bearing: Drive omits the field unless asked, so
    // without this the flag above could never fire.
    expect(drive.urls.some((u) => u.includes('incompleteSearch'))).toBe(true);
  });
});
